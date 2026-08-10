/**
 * Dynamic Specialist Factory — create specialist workers on-the-fly.
 *
 * The orchestrator can create new specialist agents dynamically based on
 * the task at hand. Instead of being limited to 5 hardcoded specialists,
 * it can spawn a "SEO Specialist", "Legal Review Worker", "Data Migration
 * Worker", or any other role it decides is needed.
 *
 * Architecture:
 *
 *     Orchestrator
 *       ├── delegate_research (hardcoded)
 *       ├── delegate_analysis (hardcoded)
 *       ├── delegate_writing (hardcoded)
 *       ├── delegate_pricing (hardcoded)
 *       ├── delegate_action (hardcoded)
 *       ├── create_specialist(name, role, tools) → spawns new agent
 *       └── delegate_to_specialist(name, task) → invokes any specialist
 *
 * Dynamically created specialists are:
 * - Memoized by name (same specialist reused across the conversation)
 * - Given a curated subset of tools from the shared tool pool
 * - Backed by the same checkpointer/store (shared memory)
 * - Tracked in the dynamic registry for visibility
 */
import { z } from "zod"
import { tool } from "@langchain/core/tools"
import {
  createDeepAgent,
  CompositeBackend,
} from "deepagents"
import { ChatOpenRouter } from "@langchain/openrouter"
import type { InterruptOnConfig } from "langchain"
import process from "node:process"

import type { Agent } from "./supervisor-types.js"
import { queryOntologyTool } from "./tools.js"
import { proposeActionTool } from "./tools.js"
import { executeTool } from "./sandbox.js"
import { evalTool } from "./interpreter.js"
import { semanticSearchTool } from "./semantic-search-tool.js"
import { executeActionTool } from "./execute-action-tool.js"
import { queryFeedbackTool } from "./query-feedback-tool.js"
import { createTempObjectTool } from "./create-temp-object-tool.js"
import { queryInterfaceTool, proposeInterfaceActionTool } from "./interface-tools.js"
import { queryDecisionPatternsTool } from "./decision-pattern-tool.js"
import { generateExperienceSeed } from "./experience-seeder.js"

// ---------------------------------------------------------------------------
// Tool pool — all available tools, keyed by name
// ---------------------------------------------------------------------------

interface ToolEntry {
  tool: ReturnType<typeof tool>
  name: string
  description: string
  requires_hitl: boolean
}

const TOOL_POOL: Record<string, ToolEntry> = {
  query_ontology: {
    tool: queryOntologyTool,
    name: "query_ontology",
    description: "Search ontology objects by display name or external ID",
    requires_hitl: false,
  },
  semantic_search: {
    tool: semanticSearchTool,
    name: "semantic_search",
    description: "Semantic search over ontology using vector embeddings",
    requires_hitl: false,
  },
  create_temp_object: {
    tool: createTempObjectTool,
    name: "create_temp_object",
    description: "Create temporary/draft objects in the Ontology",
    requires_hitl: false,
  },
  eval: {
    tool: evalTool,
    name: "eval",
    description: "Run JavaScript code in a QuickJS sandbox",
    requires_hitl: true,
  },
  run_shell: {
    tool: executeTool,
    name: "run_shell",
    description: "Execute shell commands in a restricted sandbox",
    requires_hitl: true,
  },
  propose_action: {
    tool: proposeActionTool,
    name: "propose_action",
    description: "Propose an action for human approval",
    requires_hitl: false,
  },
  execute_action: {
    tool: executeActionTool,
    name: "execute_action",
    description: "Execute an approved action (write-back)",
    requires_hitl: true,
  },
  query_feedback: {
    tool: queryFeedbackTool,
    name: "query_feedback",
    description: "Query past decisions and user feedback",
    requires_hitl: false,
  },
  query_interface: {
    tool: queryInterfaceTool,
    name: "query_interface",
    description: "Query ontology through an access-controlled Interface view",
    requires_hitl: false,
  },
  propose_interface_action: {
    tool: proposeInterfaceActionTool,
    name: "propose_interface_action",
    description: "Propose action through an Interface (access-scoped write)",
    requires_hitl: false,
  },
  query_decision_patterns: {
    tool: queryDecisionPatternsTool,
    name: "query_decision_patterns",
    description: "Query the user's decision patterns (approval/rejection trends)",
    requires_hitl: false,
  },
}

export const AVAILABLE_TOOL_NAMES = Object.keys(TOOL_POOL)

export function getToolDescriptions(): string {
  return Object.entries(TOOL_POOL)
    .map(([key, entry]) => `- ${key}: ${entry.description}${entry.requires_hitl ? " (HITL-gated)" : ""}`)
    .join("\n")
}

// ---------------------------------------------------------------------------
// Shared infrastructure (injected from supervisor.ts)
// ---------------------------------------------------------------------------

interface SharedInfra {
  backend: CompositeBackend
  checkpointer: unknown
  store: unknown
  interruptOn: Record<string, boolean | InterruptOnConfig>
  model: string
}

let infraRef: SharedInfra | null = null

export function setSharedInfra(infra: SharedInfra): void {
  infraRef = infra
}

function getInfra(): SharedInfra {
  if (!infraRef) {
    throw new Error("Shared infra not initialized — call setSharedInfra first")
  }
  return infraRef
}

// ---------------------------------------------------------------------------
// Dynamic specialist registry
// ---------------------------------------------------------------------------

const dynamicSpecialists = new Map<string, Agent>()
const dynamicSpecialistMeta = new Map<
  string,
  { name: string; role: string; tools: string[]; created_at: string }
>()

/**
 * List all dynamically created specialists.
 */
export function listDynamicSpecialists(): Array<{
  name: string
  role: string
  tools: string[]
  created_at: string
}> {
  return Array.from(dynamicSpecialistMeta.values())
}

/**
 * Create a new specialist agent on-the-fly.
 *
 * Called by the orchestrator via the create_specialist tool.
 * The specialist is memoized by name — creating the same specialist
 * twice returns the existing one.
 */
export async function createDynamicSpecialist(params: {
  name: string
  role: string
  tools: string[]
  system_prompt: string
}): Promise<Agent> {
  const slug = params.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

  // Return existing if already created
  const existing = dynamicSpecialists.get(slug)
  if (existing) return existing

  const infra = getInfra()

  // Validate + collect tools from the pool
  const selectedTools: ReturnType<typeof tool>[] = []
  for (const toolName of params.tools) {
    const entry = TOOL_POOL[toolName]
    if (!entry) {
      throw new Error(
        `Unknown tool '${toolName}'. Available: ${AVAILABLE_TOOL_NAMES.join(", ")}`
      )
    }
    selectedTools.push(entry.tool)
  }

  // Build HITL config — only gate tools that require it
  const specialistInterruptOn: Record<string, boolean | InterruptOnConfig> = {}
  for (const toolName of params.tools) {
    const entry = TOOL_POOL[toolName]
    if (entry.requires_hitl) {
      specialistInterruptOn[toolName] = infra.interruptOn[toolName] ?? true
    }
  }

  // Build the system prompt: combine the orchestrator-provided role
  // with a standard wrapper + the user's decision profile (expertise cloning)
  const experienceSeed = await generateExperienceSeed(
    // We don't have workspace_id here, but the auth context has it.
    // The experience seed is best-effort — if it fails, the specialist
    // still works, just without the decision history context.
    ""
  ).catch(() => "")

  const experienceSection =
    experienceSeed.length > 0
      ? `\n\n${experienceSeed}`
      : ""

  const fullPrompt = `${params.system_prompt}

## Context

You are a specialist digital worker created on-the-fly by the Primary Digital Worker (Orchestrator).
You operate within the Clone multi-agent system. All data lives in the Ontology (Supabase PostgreSQL).

## Guidelines
- Ground your work in Ontology data — use your tools to search and read
- If you produce an artifact, write it to the Ontology using create_temp_object
- Do not make up data — if something is missing, say so
- Return structured, clear output for the orchestrator to synthesize
- You are part of a team — other specialists may have written temp objects you can read
- If you have query_decision_patterns, use it to understand the user's decision style${experienceSection}`

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set")

  const chatModel = new ChatOpenRouter({
    model: infra.model,
    apiKey,
    siteUrl: process.env.OPENROUTER_APP_URL,
    siteName: process.env.OPENROUTER_APP_TITLE,
    maxRetries: 0,
  })

  const agent = createDeepAgent({
    model: chatModel,
    tools: selectedTools,
    systemPrompt: fullPrompt,
    backend: infra.backend,
    store: infra.store as never,
    ...(Object.keys(specialistInterruptOn).length > 0
      ? { interruptOn: specialistInterruptOn }
      : {}),
    checkpointer: infra.checkpointer as never,
  })

  dynamicSpecialists.set(slug, agent)
  dynamicSpecialistMeta.set(slug, {
    name: params.name,
    role: params.role,
    tools: params.tools,
    created_at: new Date().toISOString(),
  })

  return agent
}

/**
 * Get a dynamically created specialist by name.
 */
export function getDynamicSpecialist(name: string): Agent | undefined {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return dynamicSpecialists.get(slug)
}

// ---------------------------------------------------------------------------
// Tools exposed to the orchestrator
// ---------------------------------------------------------------------------

export const createSpecialistTool = tool(
  async ({ name, role, tools, system_prompt }) => {
    // Validate tool names
    const invalid = tools.filter((t) => !TOOL_POOL[t])
    if (invalid.length > 0) {
      return `Error: Unknown tools: ${invalid.join(", ")}. Available tools:\n${getToolDescriptions()}`
    }

    await createDynamicSpecialist({ name, role, tools, system_prompt })

    return JSON.stringify({
      status: "created",
      name,
      role,
      tools,
      message: `Specialist '${name}' created with tools: ${tools.join(", ")}. ` +
        `Invoke it using delegate_to_specialist with name '${name}'.`,
    })
  },
  {
    name: "create_specialist",
    description:
      "Create a new specialist digital worker on-the-fly. " +
      "Use this when the task needs a specialist that doesn't exist yet " +
      "(e.g. 'SEO Specialist', 'Legal Review Worker', 'Data Migration Worker'). " +
      "The specialist is reusable — once created, you can delegate to it multiple times. " +
      "Choose tools carefully: only give the specialist what it needs.",
    schema: z.object({
      name: z
        .string()
        .describe("Short name for the specialist, e.g. 'SEO Specialist' or 'Legal Reviewer'"),
      role: z
        .string()
        .describe("One-line description of the specialist's role"),
      tools: z
        .array(z.string())
        .describe(
          "Tool names to give this specialist. Available: " +
            AVAILABLE_TOOL_NAMES.join(", ")
        ),
      system_prompt: z
        .string()
        .describe("Detailed system prompt for the specialist — its instructions, approach, and constraints"),
    }),
  }
)

export const delegateToSpecialistTool = tool(
  async ({ name, task }) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

    // Check dynamic specialists first
    let agent = getDynamicSpecialist(name)

    // Fall back to hardcoded specialists (so this tool can also invoke them)
    if (!agent) {
      const registry = getHardcodedRegistry()
      if (registry) {
        const hardcoded: Record<string, Agent | undefined> = {
          research: registry.research,
          analysis: registry.analysis,
          writing: registry.writing,
          pricing: registry.pricing,
          action: registry.action,
        }
        agent = hardcoded[slug]
      }
    }

    if (!agent) {
      const available = [
        ...Array.from(dynamicSpecialistMeta.keys()).map((k) => dynamicSpecialistMeta.get(k)!.name),
        "research",
        "analysis",
        "writing",
        "pricing",
        "action",
      ]
      return `Error: Specialist '${name}' not found. Available specialists: ${available.join(", ")}`
    }

    const result = await agent.invoke({
      messages: [{ role: "user", content: task }],
    })

    const last = (result.messages as Array<{ content?: unknown }>).at(-1)
    const content =
      typeof last?.content === "string"
        ? last.content
        : JSON.stringify(last?.content ?? null)

    return `${name} output:\n${content}`
  },
  {
    name: "delegate_to_specialist",
    description:
      "Delegate a sub-task to any specialist by name. " +
      "Works with both hardcoded specialists (research, analysis, writing, pricing, action) " +
      "and dynamically created specialists (via create_specialist). " +
      "The task should be specific and include the workspace_id when relevant.",
    schema: z.object({
      name: z
        .string()
        .describe("Name of the specialist to invoke (e.g. 'SEO Specialist' or 'research')"),
      task: z.string().describe("Specific task for the specialist"),
    }),
  }
)

// ---------------------------------------------------------------------------
// Hardcoded registry reference (for fallback delegation)
// ---------------------------------------------------------------------------

interface AgentRegistry {
  orchestrator: Agent
  research: Agent
  analysis: Agent
  writing: Agent
  pricing: Agent
  action: Agent
}

let hardcodedRegistryRef: AgentRegistry | null = null

export function setHardcodedRegistry(registry: AgentRegistry): void {
  hardcodedRegistryRef = registry
}

function getHardcodedRegistry(): AgentRegistry | null {
  return hardcodedRegistryRef
}

/**
 * All dynamic specialist tools, exported as an array.
 */
export const dynamicSpecialistTools = [createSpecialistTool, delegateToSpecialistTool]
