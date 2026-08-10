import { z } from "zod"
import { tool } from "@langchain/core/tools"
import { getSupabaseClient } from "./supabase.js"
import { getCurrentUserId } from "./auth.js"
import { withRetry, isTransientError } from "./fault-tolerance.js"

const DEFAULT_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffFactor: 2,
  retryOn: isTransientError,
}

async function verifyWorkspaceMembership(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string
) {
  const userId = getCurrentUserId()
  if (!userId) throw new Error("Unauthorized: no current user")
  const { data, error } = await supabase
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .single()
  if (error || !data) throw new Error("Workspace access denied")
}

/**
 * Query past feedback and decisions from the Ontology.
 *
 * This tool lets the agent learn from history — before proposing an action,
 * it can check whether similar actions in the past received positive or
 * negative feedback. This is the "Clone jadi semakin ahli" mechanism:
 * the agent consults its own track record.
 */
export const queryFeedbackTool = tool(
  withRetry(async ({ workspace_id, limit, min_score, action_type }) => {
    const supabase = getSupabaseClient()
    await verifyWorkspaceMembership(supabase, workspace_id)

    // Query decisions joined with their action type
    let query = supabase
      .from("decisions")
      .select(
        "id, action_id, outcome, feedback_score, created_at, executed_at, actions(type, payload)"
      )
      .eq("workspace_id", workspace_id)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(1, limit ?? 10), 50))

    if (typeof min_score === "number") {
      query = query.gte("feedback_score", min_score)
    }

    const { data: decisions, error } = await query

    if (error) throw new Error(error.message)

    // Filter by action type if specified (post-filter since join select
    // doesn't support where on the joined table easily)
    const filtered = action_type
      ? decisions.filter(
          (d: { actions?: { type?: string }[] }) =>
            d.actions?.[0]?.type === action_type
        )
      : decisions

    return JSON.stringify(filtered)
  }, DEFAULT_RETRY),
  {
    name: "query_feedback",
    description:
      "Query past decisions and user feedback from the Ontology. " +
      "Use this to learn from history — check whether similar actions " +
      "received positive or negative feedback before proposing a new action. " +
      "This is how the agent learns from its track record.",
    schema: z.object({
      workspace_id: z.string().uuid(),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (default 10)"),
      min_score: z
        .number()
        .min(1)
        .max(5)
        .optional()
        .describe("Filter to decisions with feedback_score >= this value"),
      action_type: z
        .string()
        .optional()
        .describe("Filter by action type (e.g. 'update_object', 'create_object')"),
    }),
  }
)
