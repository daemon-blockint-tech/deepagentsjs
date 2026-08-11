/**
 * Ingest Pipeline — connector framework for pulling external data
 * into the Ontology.
 *
 * Connectors implement the `IngestConnector` interface. Each connector
 * knows how to read from a specific source (CSV file, JSON API, …),
 * map rows/items to ontology objects, and insert them into
 * `ontology_objects` + `ontology_properties`.
 *
 * `ingestPipeline` runs multiple connectors in sequence and aggregates
 * results. `runIngestJob` wraps a pipeline run with an action-log entry
 * so the ingest is auditable alongside other workspace actions.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import { getSupabaseClient } from "./supabase.js";
import { withRetry, isTransientError } from "./fault-tolerance.js";
import { safeFetch, assertSafeLocalPath } from "./source-validation.js";
import { embedText } from "./embeddings.js";
import { getErrorMessage } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestResult {
  ingested: number;
  errors: string[];
}

export interface IngestConnector {
  name: string;
  ingest(workspaceId: string): Promise<IngestResult>;
}

/**
 * Mapping from a source field name to an ontology attribute name.
 * If a source field is not listed in the mapping it is still carried
 * through under its original key (pass-through), so no data is lost.
 */
export type FieldMapping = Record<string, string>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffFactor: 2,
  retryOn: isTransientError,
};

/**
 * Determine the ontology `value_type` for a property value.
 */
function valueTypeOf(value: unknown): string {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

/**
 * Insert a single ontology object + its normalized properties.
 * Returns the new object id, or throws on error.
 */
async function insertOntologyObject(
  workspaceId: string,
  objectType: string,
  externalId: string,
  displayName: string,
  attributes: Record<string, unknown>,
  skipEmbeddings: boolean,
): Promise<string> {
  const supabase = getSupabaseClient();

  // Guard against silently changing object_type on re-ingest. The unique
  // constraint is (workspace_id, external_id) without object_type, so a
  // naive upsert would overwrite the type. That is almost always a mistake
  // (wrong source mapped to an existing external_id), so surface it as an
  // explicit error instead of silently mutating the object's type.
  const { data: existing, error: lookupError } = await supabase
    .from("ontology_objects")
    .select("id, object_type")
    .eq("workspace_id", workspaceId)
    .eq("external_id", externalId)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message);
  if (existing && existing.object_type !== objectType) {
    throw new Error(
      `Object with external_id "${externalId}" already exists in workspace "${workspaceId}" ` +
        `with object_type "${existing.object_type}", cannot re-ingest as "${objectType}". ` +
        `Use a different external_id or delete the existing object first.`,
    );
  }

  // Upsert on (workspace_id, external_id) so re-ingesting the same
  // source is idempotent rather than producing duplicates or unique-
  // constraint violations.
  const { data, error } = await supabase
    .from("ontology_objects")
    .upsert(
      {
        workspace_id: workspaceId,
        object_type: objectType,
        external_id: externalId,
        display_name: displayName,
        attributes,
      },
      { onConflict: "workspace_id, external_id" },
    )
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  const objectId = data.id as string;

  // Compute the set of property keys that should exist for this object
  // after this ingest. Keys starting with "_" and null/undefined values
  // are skipped (matching the upsert loop below).
  const currentKeys = Object.entries(attributes)
    .filter(([k, v]) => !k.startsWith("_") && v !== null && v !== undefined)
    .map(([k]) => k);

  // Remove normalized properties that are no longer present in the
  // current attributes, so re-ingesting a source with fewer/different
  // fields doesn't leave stale rows. This keeps `ontology_properties`
  // consistent with the denormalized `attributes` jsonb on re-ingest.
  let staleDelete = supabase
    .from("ontology_properties")
    .delete()
    .eq("object_id", objectId);
  if (currentKeys.length > 0) {
    staleDelete = staleDelete.notIn("key", currentKeys);
  }
  const { error: staleError } = await staleDelete;
  if (staleError) throw new Error(staleError.message);

  // Insert normalized properties for searchability
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("_")) continue;
    if (value === null || value === undefined) continue;
    const { error: propError } = await supabase
      .from("ontology_properties")
      .upsert(
        {
          workspace_id: workspaceId,
          object_id: objectId,
          key,
          value: value as unknown,
          value_type: valueTypeOf(value),
        },
        { onConflict: "workspace_id, object_id, key" },
      );
    if (propError) throw new Error(propError.message);
  }

  // Generate an embedding and upsert a chunk into ontology_chunks so the
  // object is semantically searchable via semantic_search (pgvector).
  // Embedding failure is graceful: the object is already in the ontology,
  // so we record a warning but don't fail the ingest. The caller can
  // re-ingest later to retry the embedding.
  if (!skipEmbeddings) {
    try {
      const embeddableAttrs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(attributes)) {
        if (k.startsWith("_")) continue;
        if (v === null || v === undefined) continue;
        embeddableAttrs[k] = v;
      }
      const chunkText = `${displayName}\n${JSON.stringify(embeddableAttrs)}`;
      const embedding = await embedText(chunkText);
      const { error: chunkError } = await supabase
        .from("ontology_chunks")
        .upsert(
          {
            workspace_id: workspaceId,
            object_id: objectId,
            content: chunkText,
            embedding: JSON.stringify(embedding),
          },
          { onConflict: "workspace_id, object_id" },
        );
      if (chunkError) throw new Error(chunkError.message);
    } catch (embedErr) {
      // Graceful: object is ingested but not semantically searchable.
      // Re-throw as a soft error so the connector records it in
      // result.errors without aborting the whole ingest.
      throw new EmbeddingError(
        `Embedding failed for ${externalId}: ${getErrorMessage(embedErr)}`,
      );
    }
  }

  return objectId;
}

/**
 * Soft error class for embedding failures. The connector catches this
 * separately from hard errors: the object IS in the ontology, it's just
 * not semantically searchable. The row is counted as ingested.
 */
class EmbeddingError extends Error {
  readonly isEmbeddingError = true;
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/**
 * Type guard for EmbeddingError without using instanceof.
 * Checks for the `isEmbeddingError` marker property.
 */
function isEmbeddingError(err: unknown): err is EmbeddingError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { isEmbeddingError?: unknown }).isEmbeddingError === true
  );
}

// ---------------------------------------------------------------------------
// CSV parsing (no external dependency)
// ---------------------------------------------------------------------------

/**
 * Parse a single CSV line, respecting double-quoted fields and
 * embedded quotes/commas.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        // Escaped quote?
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        fields.push(current);
        current = "";
      } else {
        current += char;
      }
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Parse CSV text into an array of row objects keyed by header.
 */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (values[j] ?? "").trim();
    }
    rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// CsvConnector
// ---------------------------------------------------------------------------

export interface CsvConnectorOptions {
  /** Path to a local CSV file or a URL pointing to one. */
  source: string;
  /** Ontology object_type to assign to every row. */
  objectType: string;
  /**
   * Mapping from CSV column names to ontology attribute names.
   * Columns not in the mapping are still carried through under
   * their original name.
   */
  fieldMapping?: FieldMapping;
  /**
   * CSV column to use as the display_name. Falls back to the first
   * mapped column or the object_type + index.
   */
  displayNameColumn?: string;
  /**
   * CSV column to use as the external_id. Falls back to a generated id.
   */
  externalIdColumn?: string;
  /**
   * Skip embedding generation. The object is ingested but not
   * semantically searchable. Useful for tests or when the embedding
   * API is unavailable.
   */
  skipEmbeddings?: boolean;
}

export class CsvConnector implements IngestConnector {
  name = "csv";

  constructor(private opts: CsvConnectorOptions) {}

  async ingest(workspaceId: string): Promise<IngestResult> {
    const {
      source,
      objectType,
      fieldMapping = {},
      displayNameColumn,
      externalIdColumn,
      skipEmbeddings = false,
    } = this.opts;

    let text: string;
    if (source.startsWith("http://") || source.startsWith("https://")) {
      const res = await safeFetch(source);
      if (!res.ok)
        throw new Error(`Failed to fetch CSV: ${res.status} ${res.statusText}`);
      text = await res.text();
    } else {
      const safePath = await assertSafeLocalPath(source);
      text = await readFile(safePath, "utf-8");
    }

    const rows = parseCsv(text);
    let ingested = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Build attributes with mapping
        const attributes: Record<string, unknown> = {};
        for (const [sourceKey, rawValue] of Object.entries(row)) {
          const targetKey = fieldMapping[sourceKey] ?? sourceKey;
          // Try to coerce numbers
          const num = Number(rawValue);
          attributes[targetKey] =
            rawValue !== "" && !Number.isNaN(num) && rawValue.trim() !== ""
              ? num
              : rawValue;
        }

        // Determine display name
        const displayName =
          (displayNameColumn && row[displayNameColumn]) ||
          (externalIdColumn && row[externalIdColumn]) ||
          `${objectType}-${i}`;

        // Determine external id
        const externalId =
          (externalIdColumn && row[externalIdColumn]) ||
          `csv-${objectType}-${Date.now()}-${i}`;

        await withRetry(
          () =>
            insertOntologyObject(
              workspaceId,
              objectType,
              externalId,
              displayName,
              attributes,
              skipEmbeddings,
            ),
          DEFAULT_RETRY,
        )();
        ingested++;
      } catch (err) {
        // Embedding errors are soft: the object was ingested, it's just
        // not semantically searchable. Count it as ingested but record
        // a warning so the operator knows to re-ingest.
        if (isEmbeddingError(err)) {
          ingested++;
        }
        errors.push(`Row ${i + 1}: ${getErrorMessage(err)}`);
      }
    }

    return { ingested, errors };
  }
}

// ---------------------------------------------------------------------------
// JsonApiConnector
// ---------------------------------------------------------------------------

export interface JsonApiConnectorOptions {
  /** URL that returns a JSON array (or an object with an `items`/`data` array). */
  url: string;
  /** Ontology object_type to assign to every item. */
  objectType: string;
  /**
   * Mapping from JSON field paths (top-level keys) to ontology
   * attribute names. Fields not in the mapping are carried through
   * under their original key.
   */
  fieldMapping?: FieldMapping;
  /** JSON field to use as the display_name. */
  displayNameField?: string;
  /** JSON field to use as the external_id. Falls back to a generated id. */
  externalIdField?: string;
  /** Optional headers to send with the fetch request. */
  headers?: Record<string, string>;
  /**
   * Skip embedding generation. The object is ingested but not
   * semantically searchable. Useful for tests or when the embedding
   * API is unavailable.
   */
  skipEmbeddings?: boolean;
}

export class JsonApiConnector implements IngestConnector {
  name = "json_api";

  constructor(private opts: JsonApiConnectorOptions) {}

  async ingest(workspaceId: string): Promise<IngestResult> {
    const {
      url,
      objectType,
      fieldMapping = {},
      displayNameField,
      externalIdField,
      headers = {},
      skipEmbeddings = false,
    } = this.opts;

    const res = await safeFetch(url, { headers });
    if (!res.ok)
      throw new Error(`Failed to fetch JSON: ${res.status} ${res.statusText}`);
    const json = await res.json();

    // Support { items: [...] }, { data: [...] }, or a bare array
    let items: Record<string, unknown>[];
    if (Array.isArray(json)) {
      items = json;
    } else if (Array.isArray((json as Record<string, unknown>).items)) {
      items = (json as Record<string, unknown[]>).items as Record<
        string,
        unknown
      >[];
    } else if (Array.isArray((json as Record<string, unknown>).data)) {
      items = (json as Record<string, unknown[]>).data as Record<
        string,
        unknown
      >[];
    } else {
      throw new Error(
        "JSON response is not an array and has no `items` or `data` array",
      );
    }

    let ingested = 0;
    const errors: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        // Build attributes with mapping
        const attributes: Record<string, unknown> = {};
        for (const [sourceKey, rawValue] of Object.entries(item)) {
          const targetKey = fieldMapping[sourceKey] ?? sourceKey;
          attributes[targetKey] = rawValue;
        }

        // Determine display name
        const displayName =
          (displayNameField && (item[displayNameField] as string)) ||
          (externalIdField && (item[externalIdField] as string)) ||
          `${objectType}-${i}`;

        // Determine external id
        const externalId =
          (externalIdField && String(item[externalIdField])) ||
          `jsonapi-${objectType}-${Date.now()}-${i}`;

        await withRetry(
          () =>
            insertOntologyObject(
              workspaceId,
              objectType,
              externalId,
              String(displayName),
              attributes,
              skipEmbeddings,
            ),
          DEFAULT_RETRY,
        )();
        ingested++;
      } catch (err) {
        // Embedding errors are soft: the object was ingested, it's just
        // not semantically searchable. Count it as ingested but record
        // a warning so the operator knows to re-ingest.
        if (isEmbeddingError(err)) {
          ingested++;
        }
        errors.push(`Item ${i + 1}: ${getErrorMessage(err)}`);
      }
    }

    return { ingested, errors };
  }
}

// ---------------------------------------------------------------------------
// Pipeline orchestration
// ---------------------------------------------------------------------------

/**
 * Run multiple connectors in sequence and aggregate results.
 */
export async function ingestPipeline(
  workspaceId: string,
  connectors: IngestConnector[],
): Promise<IngestResult> {
  let totalIngested = 0;
  const allErrors: string[] = [];

  for (const connector of connectors) {
    try {
      const result = await connector.ingest(workspaceId);
      totalIngested += result.ingested;
      for (const err of result.errors) {
        allErrors.push(`[${connector.name}] ${err}`);
      }
    } catch (err) {
      allErrors.push(`[${connector.name}] ${getErrorMessage(err)}`);
    }
  }

  return { ingested: totalIngested, errors: allErrors };
}

// ---------------------------------------------------------------------------
// Action-log wrapper
// ---------------------------------------------------------------------------

/**
 * Run an ingest pipeline and record an action-log entry for auditability.
 *
 * The action is created with status "running" (ingest is a read-from-
 * external-source + write operation, not a destructive action) and
 * transitions to "completed" or "failed" when the pipeline finishes.
 * The full result is stored in the payload alongside the `started_at`
 * timestamp captured at creation time.
 */
export async function runIngestJob(
  workspaceId: string,
  connectors: IngestConnector[],
): Promise<IngestResult> {
  const supabase = getSupabaseClient();
  const connectorNames = connectors.map((c) => c.name);
  const startedAt = new Date().toISOString();

  const { data: actionData, error: actionError } = await supabase
    .from("actions")
    .insert({
      workspace_id: workspaceId,
      type: "ingest",
      payload: {
        connectors: connectorNames,
        started_at: startedAt,
      },
      requires_approval: false,
      status: "running",
    })
    .select("id")
    .single();

  if (actionError) throw new Error(actionError.message);

  const actionId = actionData.id as string;

  let result: IngestResult;
  try {
    result = await ingestPipeline(workspaceId, connectors);
  } catch (err) {
    // Mark the action as failed and rethrow so the caller sees the error.
    // Log (but don't mask) a failure to update the action row — otherwise
    // the action would be silently stuck in "running" with no audit trail.
    const { error: failUpdateError } = await supabase
      .from("actions")
      .update({
        status: "failed",
        payload: {
          connectors: connectorNames,
          started_at: startedAt,
          error: getErrorMessage(err),
          completed_at: new Date().toISOString(),
        },
      })
      .eq("id", actionId);
    if (failUpdateError) {
      process.stderr.write(
        `runIngestJob: failed to mark action ${actionId} as failed: ${failUpdateError.message}\n`,
      );
    }
    throw err;
  }

  // Update the action log with the result. Log a failure to update so
  // operators can detect actions stuck in "running".
  const { error: doneUpdateError } = await supabase
    .from("actions")
    .update({
      status:
        result.errors.length > 0 && result.ingested === 0
          ? "failed"
          : "completed",
      payload: {
        connectors: connectorNames,
        started_at: startedAt,
        ingested: result.ingested,
        errors: result.errors,
        completed_at: new Date().toISOString(),
      },
    })
    .eq("id", actionId);
  if (doneUpdateError) {
    process.stderr.write(
      `runIngestJob: failed to mark action ${actionId} as completed: ${doneUpdateError.message}\n`,
    );
  }

  return result;
}
