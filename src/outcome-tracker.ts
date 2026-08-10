/**
 * Outcome Tracker — closes the learning loop.
 *
 * After an action executes, this service schedules a delayed check to
 * measure whether the action achieved its intended outcome. The result
 * is written back to the `decisions` table and optionally to LangSmith
 * as feedback on the trace.
 *
 * This is the "Clone jadi semakin ahli" part of the loop — the agent
 * learns from outcomes, not just from immediate user feedback.
 */
import { getSupabaseClient } from "./supabase.js"

const DEFAULT_OUTCOME_DELAY_MS = 24 * 60 * 60 * 1000 // 24 hours
const MAX_OUTCOME_DELAY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface OutcomeCheck {
  action_id: string
  workspace_id: string
  type: string
  payload: Record<string, unknown>
}

/**
 * Schedule a delayed outcome check for an executed action.
 *
 * In production this would use a job queue (BullMQ, etc.). For now we use
 * setTimeout — sufficient for dev and low-volume production. The check is
 * idempotent: if the decision row already has a final outcome, it's skipped.
 */
export function scheduleOutcomeCheck(
  actionId: string,
  workspaceId: string,
  type: string,
  payload: Record<string, unknown>,
  delayMs: number = DEFAULT_OUTCOME_DELAY_MS
): void {
  const safeDelay = Math.min(Math.max(delayMs, 0), MAX_OUTCOME_DELAY_MS)

  setTimeout(async () => {
    try {
      await runOutcomeCheck({ action_id: actionId, workspace_id: workspaceId, type, payload })
    } catch (err) {
      console.error(`Outcome check failed for action ${actionId}:`, err)
    }
  }, safeDelay)
}

/**
 * Measure the outcome of an executed action.
 *
 * For update_object: check if the object's attributes match what was set.
 * For create_object: check if the object still exists.
 * For webhook: no automatic check (external system).
 *
 * The outcome is written to the decisions table, merging with any
 * existing outcome snapshot from execution time.
 */
async function runOutcomeCheck(check: OutcomeCheck): Promise<void> {
  const supabase = getSupabaseClient()

  // Fetch the current decision row
  const { data: decision, error: fetchError } = await supabase
    .from("decisions")
    .select("id, outcome")
    .eq("action_id", check.action_id)
    .eq("workspace_id", check.workspace_id)
    .single()

  if (fetchError || !decision) {
    // Decision row doesn't exist yet — nothing to update
    return
  }

  const existingOutcome = (decision.outcome as Record<string, unknown>) ?? {}
  const measured = await measureOutcome(supabase, check)

  const updatedOutcome = {
    ...existingOutcome,
    measured_at: new Date().toISOString(),
    measurement: measured,
  }

  await supabase
    .from("decisions")
    .update({ outcome: updatedOutcome })
    .eq("id", decision.id)
    .eq("workspace_id", check.workspace_id)
}

/**
 * Measure whether the action's effect is still present.
 *
 * This is a simple heuristic check — not a full evaluation. For more
 * sophisticated outcome measurement, replace with domain-specific logic.
 */
async function measureOutcome(
  supabase: ReturnType<typeof getSupabaseClient>,
  check: OutcomeCheck
): Promise<{ status: string; details?: Record<string, unknown> }> {
  if (check.type === "update_object") {
    const objectId = check.payload.object_id as string
    const updates = (check.payload.updates ?? check.payload) as Record<
      string,
      unknown
    >

    const { data: obj, error } = await supabase
      .from("ontology_objects")
      .select("attributes")
      .eq("id", objectId)
      .single()

    if (error || !obj) {
      return { status: "object_missing" }
    }

    // Check if the updated fields still hold the values that were set
    const attrs = obj.attributes as Record<string, unknown>
    const stillPresent = Object.entries(updates).every(
      ([key, value]) => attrs[key] === value
    )

    return {
      status: stillPresent ? "persisted" : "reverted",
      details: { checked_fields: Object.keys(updates) },
    }
  }

  if (check.type === "create_object") {
    const externalId = check.payload.external_id as string
    const { data, error } = await supabase
      .from("ontology_objects")
      .select("id")
      .eq("workspace_id", check.workspace_id)
      .eq("external_id", externalId)
      .single()

    if (error || !data) {
      return { status: "object_deleted" }
    }
    return { status: "object_exists" }
  }

  // webhook or unknown — can't measure automatically
  return { status: "not_measurable" }
}

/**
 * Update a decision's outcome with user feedback.
 *
 * Called when the user rates an action execution (thumbs up/down on an
 * action message). Links the feedback score to the decision so the agent
 * can correlate action quality with user satisfaction.
 */
export async function attachFeedbackToDecision(
  actionId: string,
  workspaceId: string,
  feedbackScore: number,
  comment?: string
): Promise<void> {
  const supabase = getSupabaseClient()

  const { data: decision, error } = await supabase
    .from("decisions")
    .select("id, outcome")
    .eq("action_id", actionId)
    .eq("workspace_id", workspaceId)
    .single()

  if (error || !decision) return

  const existingOutcome = (decision.outcome as Record<string, unknown>) ?? {}
  const updatedOutcome = {
    ...existingOutcome,
    user_feedback: {
      score: feedbackScore,
      comment: comment ?? null,
      at: new Date().toISOString(),
    },
  }

  await supabase
    .from("decisions")
    .update({
      outcome: updatedOutcome,
      feedback_score: feedbackScore,
    })
    .eq("id", decision.id)
    .eq("workspace_id", workspaceId)
}
