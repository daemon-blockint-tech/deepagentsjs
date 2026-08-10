import { z } from "zod"
import { tool } from "@langchain/core/tools"
import { getSupabaseClient } from "./supabase.js"
import { getCurrentUserId } from "./auth.js"
import { executeAction } from "./actions.js"
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
 * Execute an approved action.
 *
 * This tool is HITL-gated: the agent calls it, the human approves,
 * and then the action executor runs the write-back (update_object,
 * create_object, webhook, etc.).
 *
 * The flow is:
 * 1. Agent calls execute_action with an action_id
 * 2. HITL interrupt pauses for human approval
 * 3. Human approves → executeAction() runs the write-back
 * 4. Result returned to agent
 */
export const executeActionTool = tool(
  withRetry(async ({ workspace_id, action_id }) => {
    const supabase = getSupabaseClient()
    await verifyWorkspaceMembership(supabase, workspace_id)

    // Check the action is in an executable state
    const { data: action, error } = await supabase
      .from("actions")
      .select("id, status, type, payload")
      .eq("id", action_id)
      .eq("workspace_id", workspace_id)
      .single()

    if (error || !action) {
      throw new Error("Action not found")
    }

    if (action.status === "executed") {
      return JSON.stringify({ action_id, status: "already_executed", type: action.type })
    }

    if (action.status === "rejected") {
      return JSON.stringify({ action_id, status: "rejected", type: action.type })
    }

    // Execute the action (write-back to ontology or external system)
    await executeAction(supabase, action_id, workspace_id)

    return JSON.stringify({
      action_id,
      status: "executed",
      type: action.type,
      payload: action.payload,
    })
  }, DEFAULT_RETRY),
  {
    name: "execute_action",
    description:
      "Execute an approved action to write changes back to the ontology or external systems. " +
      "The action must have been proposed first (via propose_action) and approved by a human. " +
      "This is the write-back step that closes the operational loop.",
    schema: z.object({
      workspace_id: z.string().uuid(),
      action_id: z.string().uuid().describe("ID of the approved action to execute"),
    }),
  }
)
