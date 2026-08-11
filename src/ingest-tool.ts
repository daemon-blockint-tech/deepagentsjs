/**
 * Ingest Data Tool — lets the agent trigger an ingest job to pull
 * external data into the Ontology.
 *
 * The agent specifies a source type ("csv" or "json_api"), a source
 * URL/path, the target object_type, and an optional field mapping.
 * The tool builds the appropriate connector and runs it via the
 * ingest pipeline, returning a summary of what was ingested.
 */
import { z } from "zod";
import { tool } from "@langchain/core/tools";

import { getSupabaseClient } from "./supabase.js";
import { verifyWorkspaceMembership } from "./auth.js";
import { withRetry, isTransientError } from "./fault-tolerance.js";
import {
  CsvConnector,
  JsonApiConnector,
  runIngestJob,
  type IngestConnector,
  type FieldMapping,
} from "./ingest-pipeline.js";

const DEFAULT_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffFactor: 2,
  retryOn: isTransientError,
};

/**
 * Build the appropriate connector from the tool parameters.
 */
function buildConnector(params: {
  source_type: "csv" | "json_api";
  source_url: string;
  object_type: string;
  field_mapping?: Record<string, string>;
}): IngestConnector {
  const { source_type, source_url, object_type, field_mapping } = params;

  if (source_type === "csv") {
    return new CsvConnector({
      source: source_url,
      objectType: object_type,
      fieldMapping: field_mapping as FieldMapping | undefined,
    });
  }

  if (source_type === "json_api") {
    return new JsonApiConnector({
      url: source_url,
      objectType: object_type,
      fieldMapping: field_mapping as FieldMapping | undefined,
    });
  }

  throw new Error(`Unsupported source_type: ${source_type}`);
}

export const ingestDataTool = tool(
  withRetry(
    async ({
      workspace_id,
      source_type,
      source_url,
      object_type,
      field_mapping,
    }) => {
      const supabase = getSupabaseClient();
      await verifyWorkspaceMembership(supabase, workspace_id);

      const connector = buildConnector({
        source_type,
        source_url,
        object_type,
        field_mapping,
      });

      const result = await runIngestJob(workspace_id, [connector]);

      return JSON.stringify({
        source_type,
        object_type,
        ingested: result.ingested,
        errors: result.errors,
        error_count: result.errors.length,
        message:
          result.errors.length === 0
            ? `Successfully ingested ${result.ingested} ${object_type} object(s) from ${source_type} source.`
            : `Ingested ${result.ingested} ${object_type} object(s) with ${result.errors.length} error(s).`,
      });
    },
    DEFAULT_RETRY,
  ),
  {
    name: "ingest_data",
    description:
      "Ingest external data into the Ontology. " +
      "Supports CSV files (local path or URL) and JSON APIs. " +
      "Each row/item becomes an ontology object with normalized properties. " +
      "Use this to import data from external sources — CRM exports, " +
      "APIs, spreadsheets — so other specialists can query and analyze it.",
    schema: z.object({
      workspace_id: z.string().uuid(),
      source_type: z
        .enum(["csv", "json_api"])
        .describe(
          "Type of data source: 'csv' for CSV files, 'json_api' for JSON API endpoints",
        ),
      source_url: z
        .string()
        .describe(
          "CSV file path or URL (for csv), or JSON API URL (for json_api)",
        ),
      object_type: z
        .string()
        .describe(
          "Ontology object_type to assign, e.g. 'company', 'contact', 'product'",
        ),
      field_mapping: z
        .record(z.string())
        .optional()
        .describe(
          "Mapping from source field names to ontology attribute names. " +
            "Unmapped fields are carried through under their original name.",
        ),
    }),
  },
);
