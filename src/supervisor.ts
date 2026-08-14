/**
 * Supervisor Graph — hierarchical multi-agent system.
 *
 * Architecture:
 *
 *     Human Worker
 *         │
 *     ┌───┴───────────────────────┐
 *     │  Primary Digital Worker     │  ← Orchestrator (decompose + delegate)
 *     │  (Supervisor Agent)         │
 *     └───┬───────────────────────┘
 *         │
 *     ┌───┴───┬────────┬─────────┬─────────┬───────────┐
 *     ▼       ▼        ▼         ▼         ▼
 *   Research  Analysis  Writing  Pricing  Action
 *   Agent     Agent     Agent    Agent    Agent
 *     │       │        │         │         │
 *     └───┬───┴────────┴─────────┴─────────┘
 *         ▼
 *   Ontology (Shared World)
 *         │
 *   Propose → Approve → Execute → Write-back → Feedback → Learn
 *
 * The orchestrator decomposes complex requests into sub-tasks, delegates
 * each to the appropriate specialist via delegation tools, collects results,
 * and synthesizes them into a unified response with proposed actions.
 *
 * Specialists can write temp objects to the Ontology (create_temp_object),
 * so downstream specialists can read what upstream specialists produced.
 *
 * All agents share the same checkpointer and store, so memory and
 * paused-approval state persist across the conversation.
 */
import process from "node:process";
import fs from "node:fs";
import { ChatOpenRouter } from "@langchain/openrouter";
import {
  createDeepAgent,
  CompositeBackend,
  StateBackend,
  StoreBackend,
} from "deepagents";
import {
  InMemoryStore,
  MemorySaver,
  Command,
  type LangGraphRunnableConfig,
  type StateSnapshot,
} from "@langchain/langgraph";
import {
  getCheckpointer,
  type Checkpointer,
} from "./persistent-checkpointer.js";
import type { Decision, HITLRequest, InterruptOnConfig } from "langchain";

import { queryOntologyTool, proposeActionTool } from "./tools.js";
import { executeTool } from "./sandbox.js";
import { evalTool } from "./interpreter.js";
import { semanticSearchTool } from "./semantic-search-tool.js";
import { queryRelationsTool } from "./relations-tool.js";
import { executeActionTool } from "./execute-action-tool.js";
import { queryFeedbackTool } from "./query-feedback-tool.js";
import { createTempObjectTool } from "./create-temp-object-tool.js";
import { ingestDataTool } from "./ingest-tool.js";
import {
  queryInterfaceTool,
  proposeInterfaceActionTool,
} from "./interface-tools.js";
import { queryDecisionPatternsTool } from "./decision-pattern-tool.js";
import { setAgentRegistry } from "./delegation-tools.js";
import { setSharedInfra, setHardcodedRegistry } from "./dynamic-specialist.js";
import { setCurrentUserId } from "./auth.js";
import { selectModel } from "./model-router.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Agent = ReturnType<typeof createDeepAgent>;

export const DEFAULT_MODEL = "openai/gpt-4o";
export const AGENT_VERSION = "2.0.0";

// ---------------------------------------------------------------------------
// Shared infrastructure (process-wide, reused across all agents)
// ---------------------------------------------------------------------------

// Checkpointer is initialized async in buildRegistry() — uses PostgresSaver
// when DATABASE_URL is available, falls back to MemorySaver otherwise.
let checkpointer: Checkpointer = new MemorySaver();
const store = new InMemoryStore();

const backend = new CompositeBackend(new StateBackend(), {
  "/memories/": new StoreBackend({
    namespace: () => ["memories"],
  }),
});

/**
 * Tools that require human approval before they run.
 *
 * Only the Analysis and Action specialists have HITL-gated tools.
 * Research is read-only — no gating needed.
 */
const INTERRUPT_ON: Record<string, boolean | InterruptOnConfig> = {
  run_shell: { allowedDecisions: ["approve", "edit", "reject"] },
  eval: { allowedDecisions: ["approve", "reject"] },
  execute_action: { allowedDecisions: ["approve", "reject"] },
};

// ---------------------------------------------------------------------------
// Model factory
// ---------------------------------------------------------------------------

function createModel(model: string): ChatOpenRouter {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  return new ChatOpenRouter({
    model,
    apiKey,
    siteUrl: process.env.OPENROUTER_APP_URL,
    siteName: process.env.OPENROUTER_APP_TITLE,
    maxRetries: 0,
  });
}

// ---------------------------------------------------------------------------
// Prompt loader
// ---------------------------------------------------------------------------

function loadPrompt(name: string): string {
  return fs.readFileSync(
    new URL(`./prompts/${name}.txt`, import.meta.url),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Specialist agent factories
// ---------------------------------------------------------------------------

/**
 * Research Specialist — ontology query + semantic search.
 * Read-only: no HITL gating needed.
 */
function createResearchAgent(model: string): Agent {
  return createDeepAgent({
    model: createModel(model),
    tools: [
      queryOntologyTool,
      semanticSearchTool,
      queryRelationsTool,
      ingestDataTool,
    ],
    systemPrompt: loadPrompt("research"),
    backend,
    store,
    checkpointer,
  });
}

/**
 * Analysis Specialist — sandboxed code execution + shell.
 * HITL-gated: run_shell and eval require approval.
 */
function createAnalysisAgent(model: string): Agent {
  return createDeepAgent({
    model: createModel(model),
    tools: [evalTool, executeTool],
    systemPrompt: loadPrompt("analysis"),
    backend,
    store,
    interruptOn: INTERRUPT_ON,
    checkpointer,
  });
}

/**
 * Action Specialist — propose + execute changes.
 * HITL-gated: execute_action requires approval.
 * Has query_feedback + query_decision_patterns so it can learn from
 * past action outcomes AND understand the user's decision style.
 */
function createActionAgent(model: string): Agent {
  return createDeepAgent({
    model: createModel(model),
    tools: [
      proposeActionTool,
      executeActionTool,
      queryFeedbackTool,
      queryDecisionPatternsTool,
      proposeInterfaceActionTool,
    ],
    systemPrompt: loadPrompt("action"),
    backend,
    store,
    interruptOn: INTERRUPT_ON,
    checkpointer,
  });
}

/**
 * Writing Specialist — drafts reports and documents.
 * Can read ontology (direct + via interface) + write temp objects.
 */
function createWritingAgent(model: string): Agent {
  return createDeepAgent({
    model: createModel(model),
    tools: [
      queryOntologyTool,
      semanticSearchTool,
      queryRelationsTool,
      queryInterfaceTool,
      createTempObjectTool,
    ],
    systemPrompt: loadPrompt("writing"),
    backend,
    store,
    checkpointer,
  });
}

/**
 * Pricing Strategy Specialist — pricing analysis + recommendations.
 * Can read ontology (direct + via interface), run calculations,
 * and write temp pricing models.
 */
function createPricingAgent(model: string): Agent {
  return createDeepAgent({
    model: createModel(model),
    tools: [
      queryOntologyTool,
      semanticSearchTool,
      queryRelationsTool,
      queryInterfaceTool,
      evalTool,
      createTempObjectTool,
    ],
    systemPrompt: loadPrompt("pricing"),
    backend,
    store,
    interruptOn: INTERRUPT_ON,
    checkpointer,
  });
}

/**
 * Orchestrator — the primary digital worker.
 *
 * In the workflow-driven architecture, the orchestrator is only used for
 * direct responses (greetings, follow-ups, simple lookups). Complex task
 * routing is handled by the workflow engine (workflow-router.ts + control-gates.ts),
 * which invokes specialists directly — not through the orchestrator.
 *
 * The orchestrator retains read-only tools for simple queries.
 * Delegation tools and dynamic specialist creation are no longer needed
 * here because the workflow executor calls specialists directly.
 */
function createOrchestratorAgent(model: string): Agent {
  return createDeepAgent({
    model: createModel(model),
    // Orchestrator only gets direct read tools — no delegation tools.
    // The workflow executor calls specialists directly, bypassing the orchestrator.
    tools: [queryOntologyTool, semanticSearchTool, queryRelationsTool],
    systemPrompt: loadPrompt("orchestrator"),
    backend,
    store,
    checkpointer,
  });
}

// ---------------------------------------------------------------------------
// Agent registry (memoized by model)
// ---------------------------------------------------------------------------

interface AgentRegistry {
  orchestrator: Agent;
  research: Agent;
  analysis: Agent;
  writing: Agent;
  pricing: Agent;
  action: Agent;
}

const registries = new Map<string, AgentRegistry>();
const pendingRegistries = new Map<string, Promise<AgentRegistry>>();

function registryKey(model: string): string {
  return `${model}@${AGENT_VERSION}`;
}

async function buildRegistry(model: string): Promise<AgentRegistry> {
  // Initialize persistent checkpointer (PostgresSaver or MemorySaver fallback)
  checkpointer = await getCheckpointer();

  const registry: AgentRegistry = {
    orchestrator: createOrchestratorAgent(selectModel("orchestrator", model)),
    research: createResearchAgent(selectModel("research", model)),
    analysis: createAnalysisAgent(selectModel("analysis", model)),
    writing: createWritingAgent(selectModel("writing", model)),
    pricing: createPricingAgent(selectModel("pricing", model)),
    action: createActionAgent(selectModel("action", model)),
  };

  // Inject the registry into the delegation tools so the orchestrator
  // can invoke specialists via delegate_research, delegate_writing, etc.
  setAgentRegistry(registry);

  // Inject the registry into the dynamic specialist module so
  // delegate_to_specialist can fall back to hardcoded specialists.
  setHardcodedRegistry(registry);

  // Inject shared infrastructure (backend, checkpointer, store, model)
  // so dynamically created specialists get the same shared state.
  setSharedInfra({
    backend,
    checkpointer,
    store,
    interruptOn: INTERRUPT_ON,
    model,
  });

  return registry;
}

/**
 * Get (or lazily build) the full agent registry for a model.
 * Memoized — the same compiled agents are reused across runs.
 */
export async function getAgentRegistry(
  model = DEFAULT_MODEL,
): Promise<AgentRegistry> {
  const key = registryKey(model);
  const existing = registries.get(key);
  if (existing) return existing;

  const inFlight = pendingRegistries.get(key);
  if (inFlight) return inFlight;

  const promise = buildRegistry(model);
  pendingRegistries.set(key, promise);

  try {
    const registry = await promise;
    registries.set(key, registry);
    return registry;
  } finally {
    pendingRegistries.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Supervisor graph factory — exposed to langgraph.json
// ---------------------------------------------------------------------------

/**
 * LangGraph Agent Server entry point.
 *
 * Returns the orchestrator agent as the primary graph. The orchestrator
 * delegates to specialist agents internally via tool calls or sub-graph
 * invocation. All agents share the same checkpointer and store, so
 * thread state (including paused HITL approvals) persists across
 * the conversation.
 *
 * The frontend connects to this via the standard /threads and /runs/stream
 * API — it doesn't know or care that there are multiple agents behind
 * the scenes.
 */
export async function graph(config: LangGraphRunnableConfig) {
  const userId =
    (config.configurable?.user_id as string | undefined) ??
    process.env.DEFAULT_USER_ID ??
    null;
  setCurrentUserId(userId);

  const model =
    (config.configurable?.model as string | undefined) ?? DEFAULT_MODEL;

  const registry = await getAgentRegistry(model);
  return registry.orchestrator;
}

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility (server.ts still uses these)
// ---------------------------------------------------------------------------

export { checkpointer, store, backend, INTERRUPT_ON as CLONE_INTERRUPT_ON };

// Backward-compatible exports used by server.ts and other legacy code.
// These delegate to the orchestrator agent from the default registry.
export async function getCloneAgent(
  model = DEFAULT_MODEL,
  _version = AGENT_VERSION,
): Promise<Agent> {
  const registry = await getAgentRegistry(model);
  return registry.orchestrator;
}

export function threadConfig(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

// ---------------------------------------------------------------------------
// HITL interrupt helpers (migrated from agent.ts)
// ---------------------------------------------------------------------------

export interface PendingApproval {
  status: "interrupt";
  thread_id: string;
  model: string;
  action_requests: HITLRequest["actionRequests"];
  review_configs: HITLRequest["reviewConfigs"];
}

function toPendingApproval(
  request: HITLRequest,
  threadId: string,
  model: string,
): PendingApproval {
  return {
    status: "interrupt",
    thread_id: threadId,
    model,
    action_requests: request.actionRequests,
    review_configs: request.reviewConfigs,
  };
}

export function extractInterrupt(
  result: unknown,
  threadId: string,
  model: string,
): PendingApproval | null {
  const interrupts = (
    result as { __interrupt__?: Array<{ value: HITLRequest }> }
  )?.__interrupt__;
  const request = interrupts?.[0]?.value;
  if (!request) return null;
  return toPendingApproval(request, threadId, model);
}

export async function getPendingApproval(
  threadId: string,
  model = DEFAULT_MODEL,
): Promise<PendingApproval | null> {
  const activeAgent = (await getCloneAgent(model)) as unknown as {
    graph?: { getState: (config: unknown) => Promise<StateSnapshot> };
  };
  if (!activeAgent.graph?.getState) return null;

  const snapshot = await activeAgent.graph.getState(threadConfig(threadId));
  const request = snapshot?.tasks
    ?.flatMap((task) => task.interrupts ?? [])
    .find((entry) => entry?.value)?.value as HITLRequest | undefined;
  if (!request?.actionRequests?.length) return null;

  return toPendingApproval(request, threadId, model);
}

export async function resumeAgent(
  threadId: string,
  decisions: Decision[],
  model = DEFAULT_MODEL,
): Promise<{ result: unknown; interrupt: PendingApproval | null }> {
  const activeAgent = await getCloneAgent(model);
  const result = await activeAgent.invoke(
    new Command({ resume: { decisions } }) as never,
    threadConfig(threadId),
  );
  return { result, interrupt: extractInterrupt(result, threadId, model) };
}

// ---------------------------------------------------------------------------
// Evaluation & orchestration (migrated from agent.ts)
// ---------------------------------------------------------------------------

export interface AgentEvaluationInput {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  rubric?: string[];
}

export async function evaluateAgent(input: AgentEvaluationInput) {
  const activeAgent = await getCloneAgent(input.model);
  const evalPrompt = `Evaluate the conversation below. Return JSON with "score" (1-5), "criteria" array, and "summary".\n\nRubric:\n${(input.rubric ?? ["Correctness", "Clarity"]).join("\n")}`;

  const result = await activeAgent.invoke({
    messages: [...input.messages, { role: "system", content: evalPrompt }],
  });

  const last = (result.messages as { content?: unknown }[]).at(-1);
  const raw =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? null);

  let parsed: { score?: number; criteria?: unknown[]; summary?: string } = {};
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = match
      ? (JSON.parse(match[0]) as typeof parsed)
      : { score: 0, summary: "No JSON found" };
  } catch {
    parsed = { score: 0, summary: raw };
  }

  return {
    score: Number(parsed.score ?? 0),
    criteria: parsed.criteria ?? [],
    summary: parsed.summary ?? "",
    raw,
  };
}

export interface OrchestrationInput {
  model?: string;
  goal: string;
  context?: string;
  max_steps?: number;
}

export async function orchestrateAgent(input: OrchestrationInput) {
  const activeAgent = await getCloneAgent(input.model);

  const planPrompt =
    `Goal: ${input.goal}\n\n${input.context ? `Context: ${input.context}\n\n` : ""}` +
    `Create a concise step-by-step plan. Return a JSON array of strings.`;

  const planResult = await activeAgent.invoke({
    messages: [{ role: "user", content: planPrompt }],
  });

  const last = (planResult.messages as { content?: unknown }[]).at(-1);
  const raw =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? null);

  let steps: string[] = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    steps = match ? (JSON.parse(match[0]) as string[]) : [];
  } catch {
    steps = ["Proceed with the goal"];
  }

  const maxSteps = Math.min(input.max_steps ?? 5, steps.length || 1);
  const conversation: Array<{ role: string; content: string }> = [
    { role: "user", content: `Goal: ${input.goal}` },
  ];

  for (let i = 0; i < maxSteps; i++) {
    const step = steps[i] ?? `Step ${i + 1}`;
    conversation.push({ role: "user", content: `Execute this step: ${step}` });
    const stepResult = await activeAgent.invoke({ messages: conversation });
    const stepLast = (stepResult.messages as { content?: unknown }[]).at(-1);
    const stepContent =
      typeof stepLast?.content === "string"
        ? stepLast.content
        : JSON.stringify(stepLast?.content ?? null);
    conversation.push({ role: "assistant", content: stepContent });
  }

  return {
    plan: steps,
    conversation,
    final: conversation.at(-1)?.content ?? "",
  };
}
