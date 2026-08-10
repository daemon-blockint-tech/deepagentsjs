/**
 * Workflow Graph — LangGraph state graph that runs predefined workflows.
 *
 * This replaces the single-agent orchestrator with a code-driven
 * workflow engine. The graph:
 *
 * 1. Receives the user message
 * 2. Routes it to a predefined workflow (code, not LLM)
 * 3. Runs each step in order, checking control gates between steps
 * 4. Each step invokes a specialist agent (LLM) for interpretation
 * 5. Returns the synthesized output
 *
 * Architecture:
 *
 *     User Message
 *         │
 *     ┌───▼───┐
 *     │ Route │  ← code-based classifier (workflow-router.ts)
 *     └───┬───┘
 *         │
 *     ┌───▼──────────────────────────┐
 *     │ For each step in workflow:    │
 *     │  1. Check control gate (code) │
 *     │  2. Invoke specialist (LLM)   │
 *     │  3. Record output             │
 *     └───┬──────────────────────────┘
 *         │
 *     ┌───▼──────────┐
 *     │ Synthesize    │  ← code-based formatting
 *     │ Response      │
 *     └───────────────┘
 *
 * The LLM is only used WITHIN steps (specialist interpretation),
 * never for deciding WHICH steps to run or in what order.
 */

import {
  StateGraph,
  START,
  END,
  Annotation,
  MemorySaver,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { getAgentRegistry, DEFAULT_MODEL } from "./supervisor.js"
import { executeWorkflow } from "./workflow-executor.js"
import { routeMessage } from "./workflow-router.js"
import { setCurrentUserId } from "./auth.js"

// ---------------------------------------------------------------------------
// State definition
// ---------------------------------------------------------------------------

const WorkflowState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  // Internal: the workflow execution result (not sent to client)
  _workflowResult: Annotation<unknown>({
    reducer: (_, y) => y,
    default: () => null,
  }),
})

type WorkflowStateType = typeof WorkflowState.State

// ---------------------------------------------------------------------------
// Graph nodes
// ---------------------------------------------------------------------------

/**
 * Route node: classifies the message and determines the workflow.
 * This is a code-only node — no LLM call.
 */
async function routeNode(
  state: WorkflowStateType,
  _config: LangGraphRunnableConfig
): Promise<Partial<WorkflowStateType>> {
  // Get the last human message
  // Messages may be BaseMessage instances or raw objects from the server
  const lastMessage = [...state.messages]
    .reverse()
    .find((m) => {
      const role = typeof m._getType === "function" ? m._getType() : (m as { role?: string }).role
      return role === "human" || role === "user"
    })

  if (!lastMessage) {
    return {
      _workflowResult: {
        response: "I didn't receive a message.",
        routing: { direct: true, workflow: null, reasoning: "No message", confidence: 1 },
        stepOutputs: [],
        completed: true,
        skippedSteps: [],
      },
    }
  }

  const content = (lastMessage as { content?: unknown }).content
  const userMessage =
    typeof content === "string"
      ? content
      : JSON.stringify(content ?? "")

  // Build history for the router (just roles, not content)
  const history = state.messages.map((m) => {
    const role = typeof m._getType === "function" ? m._getType() : (m as { role?: string }).role
    return { role: role ?? "unknown" }
  })

  // Route — this is code, not LLM
  const routing = routeMessage(userMessage, history)

  return {
    _workflowResult: { routing, userMessage },
  }
}

/**
 * Execute node: runs the workflow steps with control gates.
 * This is where specialists (LLMs) are invoked — but only within
 * the predefined steps, not for routing decisions.
 */
async function executeNode(
  state: WorkflowStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<WorkflowStateType>> {
  const result = state._workflowResult as
    | { routing: unknown; userMessage?: string; response?: string }
    | null

  if (!result) {
    return {
      messages: [
        new AIMessage("I encountered an error processing your request."),
      ],
    }
  }

  // If direct response, use the orchestrator LLM
  if (result.response) {
    return {
      messages: [new AIMessage(result.response)],
    }
  }

  const userMessage = result.userMessage ?? ""
  const model = (config.configurable?.model as string) ?? DEFAULT_MODEL
  const registry = await getAgentRegistry(model)

  // Build history for the executor
  const history = state.messages.map((m) => {
    const role = typeof m._getType === "function" ? m._getType() : (m as { role?: string }).role
    return { role: role ?? "unknown" }
  })

  // Execute the workflow (code-driven step sequencing + gates)
  const execution = await executeWorkflow(userMessage, history, registry)

  return {
    _workflowResult: execution,
    messages: [new AIMessage(execution.response)],
  }
}

// ---------------------------------------------------------------------------
// Graph factory
// ---------------------------------------------------------------------------

let compiledGraph: ReturnType<typeof buildWorkflowGraph> | null = null

function buildWorkflowGraph() {
  const graph = new StateGraph(WorkflowState)
    .addNode("route", routeNode)
    .addNode("execute", executeNode)
    .addEdge(START, "route")
    .addEdge("route", "execute")
    .addEdge("execute", END)

  return graph.compile({
    checkpointer: new MemorySaver(),
  })
}

/**
 * Get the compiled workflow graph.
 * Memoized — the same graph is reused across runs.
 */
export function getWorkflowGraph() {
  if (!compiledGraph) {
    compiledGraph = buildWorkflowGraph()
  }
  return compiledGraph
}

/**
 * LangGraph Agent Server entry point.
 *
 * Returns the workflow graph instead of the raw orchestrator agent.
 * The workflow graph uses code-driven routing + control gates,
 * with LLM specialists only for interpretation within steps.
 */
export async function workflowGraph(config: LangGraphRunnableConfig) {
  const userId =
    (config.configurable?.user_id as string | undefined) ??
    process.env.DEFAULT_USER_ID ??
    null
  setCurrentUserId(userId)

  // Ensure the agent registry is built (specialists are needed by the executor)
  const model =
    (config.configurable?.model as string | undefined) ?? DEFAULT_MODEL
  await getAgentRegistry(model)

  return getWorkflowGraph()
}
