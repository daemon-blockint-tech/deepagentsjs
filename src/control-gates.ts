/**
 * Control Gates — hard validation checks between workflow steps.
 *
 * Each gate is a pure function that examines the workflow state
 * (accumulated outputs from previous steps) and returns pass/fail.
 * Gates are NOT LLM calls — they are deterministic code checks.
 *
 * If a gate fails:
 * - Required step: the workflow stops and reports what was missing
 * - Optional step: the step is skipped and the workflow continues
 *
 * Gates enforce the "Control Gates" principle:
 *   "Hard checks (like data type validation or schema matching) verify
 *    outputs between steps."
 */

import type { ControlGateName } from "./workflow-router.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Output from a single specialist step. */
export interface StepOutput {
  specialist: string
  /** The text response from the specialist. */
  content: string
  /** Whether the specialist reported it had enough data to work with. */
  hasData: boolean
  /** Structured data extracted from the response (if any). */
  structured?: Record<string, unknown>
}

/** Accumulated state across all completed workflow steps. */
export interface WorkflowState {
  /** The original user message. */
  userMessage: string
  /** Workspace ID (if detected in the message or context). */
  workspaceId?: string
  /** Outputs from completed steps, in order. */
  stepOutputs: StepOutput[]
  /** Which step we're currently on (0-indexed). */
  currentStep: number
}

export interface GateResult {
  passed: boolean
  /** If failed, what was missing (for error reporting). */
  reason?: string
}

// ---------------------------------------------------------------------------
// Gate implementations
// ---------------------------------------------------------------------------

type GateFn = (state: WorkflowState) => GateResult

const gates: Record<ControlGateName, GateFn> = {
  /**
   * Check that the message contains or implies a workspace context.
   * In practice, the workspace ID comes from the auth context, so this
   * gate verifies the message isn't empty or too vague to act on.
   */
  has_workspace_context: (state) => {
    if (!state.userMessage || state.userMessage.trim().length < 5) {
      return {
        passed: false,
        reason: "Message is too short to determine what to search for",
      }
    }
    return { passed: true }
  },

  /**
   * Check that the research step actually found data.
   * The research specialist sets `hasData: false` if it found nothing.
   */
  has_research_findings: (state) => {
    const researchOutput = state.stepOutputs.find(
      (o) => o.specialist === "research"
    )
    if (!researchOutput) {
      return {
        passed: false,
        reason: "No research step has run yet",
      }
    }
    if (!researchOutput.hasData) {
      return {
        passed: false,
        reason: "Research step found no relevant data in the ontology",
      }
    }
    if (researchOutput.content.trim().length < 20) {
      return {
        passed: false,
        reason: "Research output is too short to be useful",
      }
    }
    return { passed: true }
  },

  /**
   * Check that the analysis step produced results.
   */
  has_analysis_results: (state) => {
    const analysisOutput = state.stepOutputs.find(
      (o) => o.specialist === "analysis"
    )
    if (!analysisOutput) {
      return {
        passed: false,
        reason: "No analysis step has run yet",
      }
    }
    if (!analysisOutput.hasData) {
      return {
        passed: false,
        reason: "Analysis step did not produce results",
      }
    }
    return { passed: true }
  },

  /**
   * Check that the writing step produced a draft.
   */
  has_writing_draft: (state) => {
    const writingOutput = state.stepOutputs.find(
      (o) => o.specialist === "writing"
    )
    if (!writingOutput) {
      return {
        passed: false,
        reason: "No writing step has run yet",
      }
    }
    if (writingOutput.content.trim().length < 50) {
      return {
        passed: false,
        reason: "Writing output is too short to be a meaningful draft",
      }
    }
    return { passed: true }
  },

  /**
   * Check that the user's message implies a write/update operation.
   * This prevents the action specialist from running on read-only requests.
   */
  is_write_request: (state) => {
    const writePatterns = /(update|change|ubah|create|buat|delete|hapus|set|propose|execute|rekomendasi|recommend|suggest)/i
    if (writePatterns.test(state.userMessage)) {
      return { passed: true }
    }
    // Also check if any prior step suggested an action
    const actionSuggested = state.stepOutputs.some(
      (o) => /propose|recommend|suggest|should|action/i.test(o.content)
    )
    if (actionSuggested) {
      return { passed: true }
    }
    return {
      passed: false,
      reason: "Message does not appear to request a write/action",
    }
  },

  /**
   * Check that the request is read-only (no write operations).
   * Used to prevent action steps from running on pure queries.
   */
  is_read_only: (state) => {
    const writePatterns = /(update|change|ubah|create|buat|delete|hapus|set|propose|execute)/i
    if (writePatterns.test(state.userMessage)) {
      return {
        passed: false,
        reason: "Message contains write keywords — not read-only",
      }
    }
    return { passed: true }
  },

  /**
   * Check that the task is pricing-related.
   */
  is_pricing_task: (state) => {
    const pricingPatterns = /(harga|price|pricing|margin|competit)/i
    if (pricingPatterns.test(state.userMessage)) {
      return { passed: true }
    }
    // Also check if research found pricing data
    const researchOutput = state.stepOutputs.find(
      (o) => o.specialist === "research"
    )
    if (researchOutput && pricingPatterns.test(researchOutput.content)) {
      return { passed: true }
    }
    return {
      passed: false,
      reason: "Task does not appear to be pricing-related",
    }
  },

  /**
   * Check that the task requires analysis (computation, comparison).
   */
  is_analysis_task: (state) => {
    const analysisPatterns = /(analisis|analyze|calculate|hitung|compute|simulat|evaluasi|evaluate|compare|banding)/i
    if (analysisPatterns.test(state.userMessage)) {
      return { passed: true }
    }
    return {
      passed: false,
      reason: "Task does not appear to require analysis",
    }
  },
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a control gate against the current workflow state.
 */
export function evaluateGate(
  gateName: ControlGateName,
  state: WorkflowState
): GateResult {
  const gate = gates[gateName]
  if (!gate) {
    return {
      passed: false,
      reason: `Unknown gate: ${gateName}`,
    }
  }
  return gate(state)
}

/**
 * Check if a step should run, given the current workflow state.
 * Returns { run: true } if the step should execute, or
 * { run: false, reason } if the gate blocked it.
 */
export function checkStepGate(
  step: { gate?: ControlGateName; optional?: boolean; specialist: string },
  state: WorkflowState
): { run: boolean; reason?: string; skipped?: boolean } {
  if (!step.gate) return { run: true }

  const result = evaluateGate(step.gate, state)

  if (result.passed) return { run: true }

  // Optional step — skip but continue
  if (step.optional) {
    return {
      run: false,
      skipped: true,
      reason: result.reason,
    }
  }

  // Required step — stop the workflow
  return {
    run: false,
    reason: result.reason,
  }
}
