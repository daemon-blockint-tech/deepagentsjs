/**
 * Workflow Executor — runs predefined workflow paths with control gates.
 *
 * This is the "Separation of Concerns" layer:
 * - The workflow router (code) decides WHICH steps to run
 * - The workflow executor (code) runs them in order, checking gates
 * - The specialists (LLM) handle interpretation within each step
 *
 * The executor:
 * 1. Receives a Workflow + user message + conversation history
 * 2. For each step: checks the gate, invokes the specialist, records output
 * 3. Returns the accumulated outputs + a synthesis
 *
 * If a gate fails on a required step, the workflow stops and returns
 * what it has so far + the reason for stopping.
 */

import { routeMessage, type RoutingResult, type WorkflowStep } from "./workflow-router.js"
import {
  checkStepGate,
  type WorkflowState,
  type StepOutput,
} from "./control-gates.js"
import type { Agent } from "./supervisor-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentRegistry {
  orchestrator: Agent
  research: Agent
  analysis: Agent
  writing: Agent
  pricing: Agent
  action: Agent
}

export interface WorkflowExecutionResult {
  /** The routing decision that was made. */
  routing: RoutingResult
  /** Outputs from each completed step. */
  stepOutputs: StepOutput[]
  /** Whether all steps completed successfully. */
  completed: boolean
  /** If the workflow stopped early, why. */
  stoppedReason?: string
  /** Which steps were skipped (optional gates that failed). */
  skippedSteps: string[]
  /** The final synthesized response for the user. */
  response: string
}

// ---------------------------------------------------------------------------
// Specialist invocation
// ---------------------------------------------------------------------------

/**
 * Invoke a specialist agent with a single-turn sub-task.
 * Returns the agent's text response + whether it found data.
 */
async function invokeSpecialist(
  agent: Agent,
  task: string
): Promise<StepOutput> {
  const result = await agent.invoke({
    messages: [{ role: "user", content: task }],
  })

  const last = (result.messages as Array<{ content?: unknown }>).at(-1)
  const content =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? null)

  // Heuristic: did the specialist find data?
  // If the response contains "no results" / "not found" / "tidak ditemukan",
  // we mark hasData: false so downstream gates can catch it.
  const noDataPatterns = /(no results|not found|tidak ditemukan|no data|no matching|couldn't find|no objects)/i
  const hasData = !noDataPatterns.test(content) && content.trim().length > 20

  return {
    specialist: "",
    content,
    hasData,
  }
}

/**
 * Build the task description for a specialist, including context
 * from previous steps.
 */
function buildTaskDescription(
  step: WorkflowStep,
  userMessage: string,
  state: WorkflowState
): string {
  const parts: string[] = [userMessage]

  // Include prior step outputs as context
  for (const output of state.stepOutputs) {
    parts.push(`\n--- ${output.specialist} findings ---\n${output.content}`)
  }

  parts.push(`\nYour specific task: ${step.description}`)

  return parts.join("\n")
}

// ---------------------------------------------------------------------------
// Workflow executor
// ---------------------------------------------------------------------------

/**
 * Execute a workflow: route the message, run steps in order, check gates.
 *
 * This is the main entry point for workflow-driven execution.
 * It replaces the LLM orchestrator's delegation logic with code-driven
 * step sequencing + hard validation gates.
 */
export async function executeWorkflow(
  userMessage: string,
  history: Array<{ role: string }>,
  registry: AgentRegistry
): Promise<WorkflowExecutionResult> {
  // Step 1: Route the message to a workflow
  const routing = routeMessage(userMessage, history)

  // Direct response — no workflow needed
  if (routing.direct || !routing.workflow) {
    const result = await invokeSpecialist(
      registry.orchestrator,
      userMessage
    )
    return {
      routing,
      stepOutputs: [{ ...result, specialist: "orchestrator" }],
      completed: true,
      skippedSteps: [],
      response: result.content,
    }
  }

  const workflow = routing.workflow
  const state: WorkflowState = {
    userMessage,
    stepOutputs: [],
    currentStep: 0,
  }

  const skippedSteps: string[] = []
  let stoppedReason: string | undefined

  // Step 2: Run each step in order
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]
    state.currentStep = i

    // Check the control gate
    const gateResult = checkStepGate(step, state)
    if (!gateResult.run) {
      if (gateResult.skipped) {
        skippedSteps.push(step.specialist)
        continue
      }
      // Required gate failed — stop the workflow
      stoppedReason = `Step ${i + 1} (${step.specialist}) blocked: ${gateResult.reason}`
      break
    }

    // Invoke the specialist
    const task = buildTaskDescription(step, userMessage, state)
    const agent = registry[step.specialist]
    if (!agent) {
      stoppedReason = `Specialist '${step.specialist}' not found in registry`
      break
    }

    const output = await invokeSpecialist(agent, task)
    output.specialist = step.specialist
    state.stepOutputs.push(output)
  }

  // Step 3: Synthesize the response
  const completed = !stoppedReason
  const response = synthesizeResponse(state, stoppedReason)

  return {
    routing,
    stepOutputs: state.stepOutputs,
    completed,
    stoppedReason,
    skippedSteps,
    response,
  }
}

/**
 * Synthesize the final response from step outputs.
 *
 * If the workflow completed, this is a structured summary.
 * If it stopped early, this includes the reason + partial results.
 *
 * Note: this is a code-based synthesis, NOT an LLM call.
 * The synthesis formats the outputs deterministically.
 * An LLM can be used for final polish, but the structure is fixed.
 */
function synthesizeResponse(
  state: WorkflowState,
  stoppedReason?: string
): string {
  if (state.stepOutputs.length === 0) {
    return stoppedReason
      ? `I couldn't complete this request: ${stoppedReason}`
      : "I wasn't able to process this request."
  }

  // If only one step ran, return its output directly
  if (state.stepOutputs.length === 1) {
    return state.stepOutputs[0].content
  }

  // Multi-step: format as structured summary
  const sections: string[] = []

  for (const output of state.stepOutputs) {
    const label = specialistLabel(output.specialist)
    sections.push(`**${label}**\n${output.content}`)
  }

  if (stoppedReason) {
    sections.push(`\n*Note: ${stoppedReason}*`)
  }

  return sections.join("\n\n---\n\n")
}

function specialistLabel(specialist: string): string {
  const labels: Record<string, string> = {
    research: "Research Findings",
    analysis: "Analysis Results",
    writing: "Draft Report",
    pricing: "Pricing Analysis",
    action: "Proposed Actions",
    orchestrator: "Response",
  }
  return labels[specialist] ?? specialist
}
