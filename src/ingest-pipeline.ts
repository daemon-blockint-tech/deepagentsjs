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

import { getSupabaseClient } from "./supabase.js";
import { withRetry, isTransientError } from "./fault-tolerance.js";

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
  attributes: Record<string, unknown>
): Promise<string> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("ontology_objects")
    .insert({
      workspace_id: workspaceId,
      object_type: objectType,
      external_id: externalId,
      display_name: displayName,
      attributes,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  const objectId = data.id as string;

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
        { onConflict: "workspace_id, object_id, key" }
      );
    if (propError) throw new Error(propError.message);
  }

  return objectId;
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
}

export class CsvConnector implements IngestConnector {
  name = "csv";

  constructor(private opts: CsvConnectorOptions) {}

  async ingest(workspaceId: string): Promise<IngestResult> {
    const { source, objectType, fieldMapping = {}, displayNameColumn, externalIdColumn } = this.opts;

    let text: string;
    if (source.startsWith("http://") || source.startsWith("https://")) {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Failed to fetch CSV: ${res.status} ${res.statusText}`);
      text = await res.text();
    } else {
      text = await readFile(source, "utf-8");
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
            rawValue !== "" && !Number.isNaN(num) && rawValue.trim() !== "" ? num : rawValue;
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
          () => insertOntologyObject(workspaceId, objectType, externalId, displayName, attributes),
          DEFAULT_RETRY
        )();
        ingested++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Row ${i + 1}: ${msg}`);
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
    } = this.opts;

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Failed to fetch JSON: ${res.status} ${res.statusText}`);
    const json = await res.json();

    // Support { items: [...] }, { data: [...] }, or a bare array
    let items: Record<string, unknown>[];
    if (Array.isArray(json)) {
      items = json;
    } else if (Array.isArray((json as Record<string, unknown>).items)) {
      items = (json as Record<string, unknown[]>).items as Record<string, unknown>[];
    } else if (Array.isArray((json as Record<string, unknown>).data)) {
      items = (json as Record<string, unknown[]>).data as Record<string, unknown>[];
    } else {
      throw new Error("JSON response is not an array and has no `items` or `data` array");
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
              attributes
            ),
          DEFAULT_RETRY
        )();
        ingested++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Item ${i + 1}: ${msg}`);
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
  connectors: IngestConnector[]
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
      const msg = err instanceof Error ? err.message : String(err);
      allErrors.push(`[${connector.name}] ${msg}`);
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
 * The action is created with status "completed" (ingest is a read-from-
 * external-source + write operation, not a destructive action) and the
 * full result is stored in the payload.
 */
export async function runIngestJob(
  workspaceId: string,
  connectors: IngestConnector[]
): Promise<IngestResult> {
  const supabase = getSupabaseClient();

  const { data: actionData, error: actionError } = await supabase
    .from("actions")
    .insert({
      workspace_id: workspaceId,
      type: "ingest",
      payload: {
        connectors: connectors.map((c) => c.name),
        started_at: new Date().toISOString(),
      },
      requires_approval: false,
      status: "running",
    })
    .select("id")
    .single();

  if (actionError) throw new Error(actionError.message);

  const actionId = actionData.id as string;

  const result = await ingestPipeline(workspaceId, connectors);

  // Update the action log with the result
  await supabase
    .from("actions")
    .update({
      status: result.errors.length > 0 && result.ingested === 0 ? "failed" : "completed",
      payload: {
        connectors: connectors.map((c) => c.name),
        ingested: result.ingested,
        errors: result.errors,
        completed_at: new Date().toISOString(),
      },
    })
    .eq("id", actionId);

  return result;
}
