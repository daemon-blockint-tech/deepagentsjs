import { z } from "zod"
import { tool } from "@langchain/core/tools"
import { getUserDecisionProfile } from "./experience-seeder.js"
import { getSupabaseClient } from "./supabase.js"
import { verifyWorkspaceMembership } from "./auth.js"
import { withRetry, isTransientError } from "./fault-tolerance.js"

const DEFAULT_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffFactor: 2,
  retryOn: isTransientError,
}

/**
 * Query the current user's decision patterns.
 *
 * This tool lets the agent understand HOW the user makes decisions:
 * - Which action types they tend to approve
 * - Which they tend to reject
 * - Their recent feedback trend
 * - Average feedback scores by action type
 *
 * This is the "Expertise Cloning" mechanism — the agent learns the
 * user's decision style and adapts its proposals accordingly.
 */
export const queryDecisionPatternsTool = tool(
  withRetry(async ({ workspace_id }) => {
    const supabase = getSupabaseClient()
    await verifyWorkspaceMembership(supabase, workspace_id)

    const profile = await getUserDecisionProfile(workspace_id)
    if (!profile) {
      return JSON.stringify({
        status: "no_history",
        message:
          "No past decisions found. This appears to be a new user — " +
          "decision patterns will emerge as the user approves/rejects actions over time.",
      })
    }

    return JSON.stringify(profile)
  }, DEFAULT_RETRY),
  {
    name: "query_decision_patterns",
    description:
      "Query the current user's decision patterns — which action types they " +
      "tend to approve vs reject, their feedback scores, and recent trends. " +
      "Use this BEFORE proposing actions to calibrate your proposals to the " +
      "user's decision style. This is how the Clone learns your preferences.",
    schema: z.object({
      workspace_id: z.string().uuid(),
    }),
  }
)
