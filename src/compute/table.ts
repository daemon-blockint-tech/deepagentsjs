import process from "node:process";

export interface TableQueryInput {
  source: string; // Iceberg catalog, Parquet URL, DuckDB file, or CSV path
  sql: string;
  workspace_id: string;
  limit?: number;
}

export interface TableQueryResult {
  columns: string[];
  rows: unknown[];
  metadata: Record<string, unknown>;
}

/**
 * Compute module: query tabular data through an external DuckDB / Polars / Iceberg endpoint.
 * If no COMPUTE_ENDPOINT is set, returns a stub result so the interface can still respond.
 */
export async function queryTable(input: TableQueryInput): Promise<TableQueryResult> {
  const endpoint = process.env.COMPUTE_ENDPOINT;
  if (!endpoint) {
    return {
      columns: ["source", "sql"],
      rows: [{ source: input.source, sql: input.sql }],
      metadata: {
        stub: true,
        message:
          "No COMPUTE_ENDPOINT configured. Set it to a DuckDB/Polars/Iceberg service for real table queries.",
      },
    };
  }

  const res = await fetch(`${endpoint}/query-table`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: input.source,
      sql: input.sql,
      workspace_id: input.workspace_id,
      limit: input.limit ?? 1000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Compute table query failed: ${res.status} ${body}`);
  }

  return (await res.json()) as TableQueryResult;
}
