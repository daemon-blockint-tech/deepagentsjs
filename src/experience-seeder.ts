/**
 * Experience Seeder + Decision Pattern Learning
 *
 * "Semakin sering dipakai, semakin ahli" — this module implements
 * the expertise cloning mechanism:
 *
 * 1. Experience Seeding: When a dynamic specialist is created, it gets
 *    seeded with the user's past decision patterns (what was approved,
 *    what was rejected, what was edited). This gives the specialist
 *    context about how this specific user makes decisions.
 *
 * 2. Decision Pattern Learning: The agent can query patterns like
 *    "this user approves 90% of update_object actions but rejects 70%
 *    of create_object actions" — and adjust its proposals accordingly.
 *
 * 3. Expertise Cloning: Over time, a Sales Manager's Clone will have
 *    very different decision patterns than a Finance Manager's Clone,
 *    even though the technology is the same.
 */
import { getSupabaseClient } from "./supabase.js"
import { getCurrentUserId } from "./auth.js"

export interface DecisionPattern {
  action_type: string
  total: number
  approved: number
  rejected: number
  executed: number
  approval_rate: number
  rejection_rate: number
  common_edit_fields: string[]
  avg_feedback_score: number | null
}

export interface UserDecisionProfile {
  user_id: string
  total_decisions: number
  overall_approval_rate: number
  patterns_by_type: DecisionPattern[]
  preferred_action_types: string[]
  avoided_action_types: string[]
  recent_feedback_trend: "improving" | "stable" | "declining"
}

/**
 * Build a decision profile for the current user.
 *
 * This is the core of "Expertise Cloning" — the agent learns the user's
 * decision patterns and adjusts its behavior accordingly.
 */
export async function getUserDecisionProfile(
  workspaceId: string
): Promise<UserDecisionProfile | null> {
  const supabase = getSupabaseClient()
  const userId = getCurrentUserId()
  if (!userId) return null

  // Fetch all actions proposed by this user's agents
  const { data: actions, error } = await supabase
    .from("actions")
    .select("id, type, status, approved_by, payload")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(500)

  if (error || !actions || actions.length === 0) {
    return null
  }

  // Group by action type and compute patterns
  const byType = new Map<string, DecisionPattern>()
  for (const action of actions) {
    const type = action.type
    if (!byType.has(type)) {
      byType.set(type, {
        action_type: type,
        total: 0,
        approved: 0,
        rejected: 0,
        executed: 0,
        approval_rate: 0,
        rejection_rate: 0,
        common_edit_fields: [],
        avg_feedback_score: null,
      })
    }
    const pattern = byType.get(type)!
    pattern.total++

    if (action.status === "approved" || action.status === "executed") {
      pattern.approved++
    }
    if (action.status === "rejected") {
      pattern.rejected++
    }
    if (action.status === "executed") {
      pattern.executed++
    }
  }

  // Compute rates
  for (const pattern of byType.values()) {
    pattern.approval_rate = pattern.total > 0 ? pattern.approved / pattern.total : 0
    pattern.rejection_rate = pattern.total > 0 ? pattern.rejected / pattern.total : 0
  }

  // Fetch feedback scores for decisions
  const { data: decisions } = await supabase
    .from("decisions")
    .select("feedback_score, action_id")
    .eq("workspace_id", workspaceId)
    .not("feedback_score", "is", null)

  if (decisions && decisions.length > 0) {
    // Map feedback to action types
    const actionIdToType = new Map(
      actions.map((a) => [a.id, a.type])
    )
    const feedbackByType = new Map<string, number[]>()
    for (const dec of decisions) {
      const type = actionIdToType.get(dec.action_id)
      if (!type) continue
      if (!feedbackByType.has(type)) feedbackByType.set(type, [])
      feedbackByType.get(type)!.push(dec.feedback_score)
    }
    for (const [type, scores] of feedbackByType) {
      const pattern = byType.get(type)
      if (pattern) {
        pattern.avg_feedback_score =
          scores.reduce((a, b) => a + b, 0) / scores.length
      }
    }
  }

  const patterns = Array.from(byType.values())
  const totalDecisions = patterns.reduce((sum, p) => sum + p.total, 0)
  const totalApproved = patterns.reduce((sum, p) => sum + p.approved, 0)
  const overallApprovalRate =
    totalDecisions > 0 ? totalApproved / totalDecisions : 0

  // Preferred = high approval rate + high volume
  // Avoided = high rejection rate
  const preferred = patterns
    .filter((p) => p.total >= 3 && p.approval_rate >= 0.7)
    .sort((a, b) => b.approval_rate - a.approval_rate)
    .map((p) => p.action_type)
  const avoided = patterns
    .filter((p) => p.total >= 3 && p.rejection_rate >= 0.5)
    .sort((a, b) => b.rejection_rate - a.rejection_rate)
    .map((p) => p.action_type)

  // Compute recent feedback trend (last 10 vs previous 10)
  const recentFeedback = (decisions ?? [])
    .sort((a, b) => (b.feedback_score ?? 0) - (a.feedback_score ?? 0))
    .slice(0, 10)
    .map((d) => d.feedback_score ?? 0)
  const olderFeedback = (decisions ?? [])
    .slice(10, 20)
    .map((d) => d.feedback_score ?? 0)

  let trend: "improving" | "stable" | "declining" = "stable"
  if (recentFeedback.length >= 3 && olderFeedback.length >= 3) {
    const recentAvg = recentFeedback.reduce((a, b) => a + b, 0) / recentFeedback.length
    const olderAvg = olderFeedback.reduce((a, b) => a + b, 0) / olderFeedback.length
    if (recentAvg > olderAvg + 0.3) trend = "improving"
    else if (recentAvg < olderAvg - 0.3) trend = "declining"
  }

  return {
    user_id: userId,
    total_decisions: totalDecisions,
    overall_approval_rate: overallApprovalRate,
    patterns_by_type: patterns,
    preferred_action_types: preferred,
    avoided_action_types: avoided,
    recent_feedback_trend: trend,
  }
}

/**
 * Generate an experience seed string for a dynamic specialist.
 *
 * This is injected into the specialist's system prompt so it starts
 * with context about the user's decision patterns — "Expertise Cloning".
 */
export async function generateExperienceSeed(
  workspaceId: string
): Promise<string> {
  const profile = await getUserDecisionProfile(workspaceId)
  if (!profile) {
    return "" // No history yet — fresh start
  }

  const lines: string[] = [
    "## Your User's Decision Profile (from past interactions)",
    "",
    `Total past decisions: ${profile.total_decisions}`,
    `Overall approval rate: ${(profile.overall_approval_rate * 100).toFixed(0)}%`,
    `Recent feedback trend: ${profile.recent_feedback_trend}`,
    "",
    "### Patterns by Action Type:",
  ]

  for (const p of profile.patterns_by_type) {
    const feedback = p.avg_feedback_score
      ? ` | avg feedback: ${p.avg_feedback_score.toFixed(1)}/5`
      : ""
    lines.push(
      `- ${p.action_type}: ${p.total} actions, ` +
        `${(p.approval_rate * 100).toFixed(0)}% approved, ` +
        `${(p.rejection_rate * 100).toFixed(0)}% rejected${feedback}`
    )
  }

  if (profile.preferred_action_types.length > 0) {
    lines.push("")
    lines.push(
      `### User tends to APPROVE: ${profile.preferred_action_types.join(", ")}`
    )
  }

  if (profile.avoided_action_types.length > 0) {
    lines.push(
      `### User tends to REJECT: ${profile.avoided_action_types.join(", ")}`
    )
  }

  lines.push("")
  lines.push(
    "Use this profile to calibrate your proposals — " +
      "lean toward action types the user approves, " +
      "be extra careful with types they reject, " +
      "and include more justification for avoided types."
  )

  return lines.join("\n")
}
