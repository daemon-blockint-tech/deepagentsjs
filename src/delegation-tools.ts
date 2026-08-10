/**
 * Delegation Tools — let the orchestrator invoke specialist agents as sub-tasks.
 *
 * Architecture:
 *
 *     Orchestrator (DeepAgent)
 *       ├── delegate_research(task)  → invokes Research Agent
 *       ├── delegate_analysis(task)  → invokes Analysis Agent
 *       ├── delegate_writing(task)   → invokes Writing Agent
 *       ├── delegate_pricing(task)   → invokes Pricing Agent
 *       └── delegate_action(task)    → invokes Action Agent
 *
 * Each delegation tool:
 * 1. Gets the specialist agent from the registry
 * 2. Invokes it with a single-turn message containing the sub-task
 * 3. Returns the specialist's output as a string to the orchestrator
 *
 * The orchestrator can call multiple delegation tools in one turn
 * (parallel tool calls), collecting results from multiple specialists.
 * It then synthesizes the results and proposes actions.
 *
 * Specialists share the same checkpointer/store, so they can read
 * temp objects that other specialists wrote to the Ontology.
 */
import { z } from "zod"
import { tool } from "@langchain/core/tools"
import type { Agent } from "./supervisor-types.js"

interface AgentRegistry {
  orchestrator: Agent
  research: Agent
  analysis: Agent
  writing: Agent
  pricing: Agent
  action: Agent
}

/**
 * The registry is injected at graph build time.
 * This avoids circular imports — supervisor.ts builds the registry,
 * then passes it to createDelegationTools().
 */
let registryRef: AgentRegistry | null = null

export function setAgentRegistry(registry: AgentRegistry): void {
  registryRef = registry
}

function getRegistry(): AgentRegistry {
  if (!registryRef) {
    throw new Error("Agent registry not initialized — call setAgentRegistry first")
  }
  return registryRef
}

/**
 * Invoke a specialist agent with a single-turn sub-task.
 * Returns the agent's text response.
 */
async function invokeSpecialist(
  agent: Agent,
  task: string
): Promise<string> {
  const result = await agent.invoke({
    messages: [{ role: "user", content: task }],
  })

  const last = (result.messages as Array<{ content?: unknown }>).at(-1)
  const content =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? null)

  return content
}

// ---------------------------------------------------------------------------
// Delegation tool definitions
// ---------------------------------------------------------------------------

export const delegateResearchTool = tool(
  async ({ task }) => {
    const registry = getRegistry()
    const result = await invokeSpecialist(registry.research, task)
    return `Research Specialist output:\n${result}`
  },
  {
    name: "delegate_research",
    description:
      "Delegate a research sub-task to the Research Specialist. " +
      "The specialist will search the Ontology (keyword + semantic) and return findings. " +
      "Use for: finding data, looking up objects, gathering context. " +
      "The task should be specific: 'Find all competitor objects in workspace X with pricing data'.",
    schema: z.object({
      task: z.string().describe("Specific research task for the Research Specialist"),
    }),
  }
)

export const delegateAnalysisTool = tool(
  async ({ task }) => {
    const registry = getRegistry()
    const result = await invokeSpecialist(registry.analysis, task)
    return `Analysis Specialist output:\n${result}`
  },
  {
    name: "delegate_analysis",
    description:
      "Delegate an analysis sub-task to the Analysis Specialist. " +
      "The specialist will run computations (eval, shell) and return results. " +
      "Use for: calculations, data analysis, code evaluation, simulations. " +
      "The task should be specific: 'Calculate the price elasticity for product X'.",
    schema: z.object({
      task: z.string().describe("Specific analysis task for the Analysis Specialist"),
    }),
  }
)

export const delegateWritingTool = tool(
  async ({ task }) => {
    const registry = getRegistry()
    const result = await invokeSpecialist(registry.writing, task)
    return `Writing Specialist output:\n${result}`
  },
  {
    name: "delegate_writing",
    description:
      "Delegate a writing sub-task to the Writing Specialist. " +
      "The specialist will search the Ontology, draft a document, and write it as a temp object. " +
      "Use for: drafting reports, creating documents, writing summaries. " +
      "The task should be specific: 'Draft a Q3 competitor report covering CompetitorX and CompetitorY'.",
    schema: z.object({
      task: z.string().describe("Specific writing task for the Writing Specialist"),
    }),
  }
)

export const delegatePricingTool = tool(
  async ({ task }) => {
    const registry = getRegistry()
    const result = await invokeSpecialist(registry.pricing, task)
    return `Pricing Strategy Specialist output:\n${result}`
  },
  {
    name: "delegate_pricing",
    description:
      "Delegate a pricing strategy sub-task to the Pricing Strategy Specialist. " +
      "The specialist will analyze competitor pricing, compute margins, and recommend price changes. " +
      "Use for: pricing analysis, price recommendations, margin calculations, competitive positioning. " +
      "The task should be specific: 'Recommend price changes for product X based on competitor Y pricing'.",
    schema: z.object({
      task: z.string().describe("Specific pricing task for the Pricing Strategy Specialist"),
    }),
  }
)

export const delegateActionTool = tool(
  async ({ task }) => {
    const registry = getRegistry()
    const result = await invokeSpecialist(registry.action, task)
    return `Action Specialist output:\n${result}`
  },
  {
    name: "delegate_action",
    description:
      "Delegate an action sub-task to the Action Specialist. " +
      "The specialist will propose actions (update_object, create_object, webhook) for human approval. " +
      "Use for: proposing changes, creating objects, executing write-backs. " +
      "The task should include the workspace_id and specific change details. " +
      "Example: 'Propose updating CompetitorX pricing in workspace X to match the pricing model recommendations'.",
    schema: z.object({
      task: z.string().describe("Specific action task for the Action Specialist"),
    }),
  }
)

/**
 * All delegation tools, exported as an array for easy inclusion in the orchestrator.
 */
export const delegationTools = [
  delegateResearchTool,
  delegateAnalysisTool,
  delegateWritingTool,
  delegatePricingTool,
  delegateActionTool,
]
