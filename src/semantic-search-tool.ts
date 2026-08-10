import { z } from "zod"
import { tool } from "@langchain/core/tools"
import { semanticQueryOntology } from "./semantic.js"
import { withRetry, isTransientError } from "./fault-tolerance.js"

const DEFAULT_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffFactor: 2,
  retryOn: isTransientError,
}

/**
 * Semantic search over ontology chunks using pgvector.
 *
 * Unlike `query_ontology` (which does ILIKE substring matching),
 * this tool embeds the query and finds conceptually similar chunks —
 * so "customer churn" matches objects tagged "retention risk" even
 * without shared words.
 */
export const semanticSearchTool = tool(
  withRetry(async ({ workspace_id, query, limit, threshold }) => {
    const results = await semanticQueryOntology({
      workspace_id,
      query,
      limit,
      threshold,
    })
    return JSON.stringify(results)
  }, DEFAULT_RETRY),
  {
    name: "semantic_search",
    description:
      "Semantically search ontology objects by meaning, not just keywords. " +
      "Uses vector embeddings to find conceptually related objects. " +
      "Use this when query_ontology's substring search isn't finding what you need.",
    schema: z.object({
      workspace_id: z.string().uuid(),
      query: z.string().describe("Natural language query to embed and search with"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results to return (default 10)"),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Cosine similarity threshold (default 0.5)"),
    }),
  }
)
