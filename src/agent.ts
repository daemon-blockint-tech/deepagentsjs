import process from "node:process";
import fs from "node:fs";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createDeepAgent, CompositeBackend, StateBackend, StoreBackend } from "deepagents";
import {
  InMemoryStore,
  MemorySaver,
  Command,
  type StateSnapshot,
} from "@langchain/langgraph";
import type { Decision, HITLRequest, InterruptOnConfig } from "langchain";
import { queryOntologyTool, proposeActionTool } from "./tools.js";
import { executeTool } from "./sandbox.js";
import { evalTool } from "./interpreter.js";
import { withRetry, withFallback, isTransientError } from "./fault-tolerance.js";

type Agent = ReturnType<typeof createDeepAgent>;

const agents = new Map<string, Agent>();
const pending = new Map<string, Promise<Agent>>();

/**
 * Tools paused for human approval before they run.
 *
 * `run_shell` executes on the host via execFile. Its allowlist includes `node`
 * and `python`, so `node -e "..."` reaches arbitrary code regardless of the
 * blocked-pattern filter — approval is the real gate, not the allowlist.
 * `eval` is QuickJS-sandboxed, so reject-or-approve is enough; there is no
 * argument worth hand-editing.
 *
 * Read-only `query_ontology` is not gated. Neither is `propose_action`: it
 * only writes a proposal row that already carries its own durable approval
 * via /api/actions/:id/approve.
 */
export const CLONE_INTERRUPT_ON: Record<string, boolean | InterruptOnConfig> = {
  run_shell: { allowedDecisions: ["approve", "edit", "reject"] },
  eval: { allowedDecisions: ["approve", "reject"] },
};

/**
 * Checkpointer backing the interrupt/resume cycle. A thread's paused state
 * must still be here when the approval comes back, so it is process-wide
 * rather than per-agent.
 *
 * ponytail: in-memory, so a restart drops pending approvals and a second
 * instance cannot resume the first one's threads. Swap for a persistent
 * checkpointer (Postgres/Redis) before running more than one node.
 */
const checkpointer = new MemorySaver();
export const DEFAULT_MODEL = "openai/gpt-4o";
const DEFAULT_FALLBACK_MODEL = "openai/gpt-4o-mini";
export const AGENT_VERSION = "1.0.0";

const CLONE_SYSTEM_PROMPT = fs.readFileSync(
  new URL("./system-prompt.txt", import.meta.url),
  "utf-8"
);

function agentKey(model: string, version: string): string {
  return `${model}@${version}`;
}

export async function getCloneAgent(model = DEFAULT_MODEL, version = AGENT_VERSION): Promise<Agent> {
  const key = agentKey(model, version);
  const existing = agents.get(key);
  if (existing) return existing;

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<Agent> => {
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterApiKey) {
      throw new Error("OPENROUTER_API_KEY is not set");
    }

    const store = new InMemoryStore();
    const backend = new CompositeBackend(
      new StateBackend(),
      { "/memories/": new StoreBackend({
          namespace: () => ["memories"],
        }) },
    );

    const chat = new ChatOpenRouter({
      model,
      apiKey: openRouterApiKey,
      siteUrl: process.env.OPENROUTER_APP_URL,
      siteName: process.env.OPENROUTER_APP_TITLE,
      maxRetries: 0,
    });

    const agent = createDeepAgent({
      model: chat,
      tools: [queryOntologyTool, proposeActionTool, executeTool, evalTool],
      systemPrompt: CLONE_SYSTEM_PROMPT,
      backend,
      store,
      interruptOn: CLONE_INTERRUPT_ON,
      checkpointer,
    });

    const fallbackModel = process.env.OPENROUTER_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
    const fallback = createDeepAgent({
      model: new ChatOpenRouter({
        model: fallbackModel,
        apiKey: openRouterApiKey,
        siteUrl: process.env.OPENROUTER_APP_URL,
        siteName: process.env.OPENROUTER_APP_TITLE,
        maxRetries: 0,
      }),
      tools: [queryOntologyTool, proposeActionTool, executeTool, evalTool],
      systemPrompt: CLONE_SYSTEM_PROMPT,
      backend,
      store,
      interruptOn: CLONE_INTERRUPT_ON,
      checkpointer,
    });

    const invokeWithRetry = withRetry(agent.invoke.bind(agent), {
      maxRetries: 2,
      initialDelayMs: 500,
      backoffFactor: 2,
      retryOn: isTransientError,
    });

    const invokeWithFallback = withFallback({
      primary: invokeWithRetry,
      fallback: fallback.invoke.bind(fallback),
      shouldFallback: isTransientError,
    });

    agent.invoke = invokeWithFallback as typeof agent.invoke;

    agents.set(key, agent);
    return agent;
  })();

  pending.set(key, promise);

  try {
    return await promise;
  } finally {
    pending.delete(key);
  }
}

/** Config identifying which paused thread an invocation belongs to. */
export function threadConfig(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

export interface PendingApproval {
  status: "interrupt";
  /** Echoed back on resume so the server holds no per-thread state. */
  thread_id: string;
  model: string;
  action_requests: HITLRequest["actionRequests"];
  review_configs: HITLRequest["reviewConfigs"];
}

/**
 * Pull the human-approval request out of an agent result, if the run paused.
 * Returns null for a normal completion.
 */
export function extractInterrupt(
  result: unknown,
  threadId: string,
  model: string,
): PendingApproval | null {
  const interrupts = (result as { __interrupt__?: Array<{ value: HITLRequest }> })
    ?.__interrupt__;
  const request = interrupts?.[0]?.value;
  if (!request) return null;

  return toPendingApproval(request, threadId, model);
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

/**
 * Ask the checkpointer whether a thread is parked on an approval.
 *
 * `invoke` surfaces the pause on its return value, but a streamed run does
 * not reliably carry `__interrupt__` on a chunk, so the stream path checks
 * the persisted graph state once the stream drains instead of guessing from
 * chunk shape.
 */
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

/**
 * Resume a paused thread with the human's decisions. One decision per action
 * request, in the same order the interrupt listed them.
 *
 * Returns another PendingApproval when the run pauses again (the agent may
 * request more gated tools after the approved ones run).
 */
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

export interface AgentEvaluationInput {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  rubric?: string[];
}

/**
 * Evaluate an agent output against a rubric.
 * Returns a score and per-criterion assessment.
 */
export async function evaluateAgent(input: AgentEvaluationInput) {
  const activeAgent = await getCloneAgent(input.model);
  const evalPrompt = `Evaluate the conversation below. Return JSON with "score" (1-5), "criteria" array, and "summary".\n\nRubric:\n${(input.rubric ?? ["Correctness", "Clarity"]).join("\n")}`;

  const result = await activeAgent.invoke({
    messages: [
      ...input.messages,
      { role: "system", content: evalPrompt },
    ],
  });

  const last = (result.messages as { content?: unknown }[]).at(-1);
  const raw =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? null);

  let parsed: { score?: number; criteria?: unknown[]; summary?: string } = {};
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = match ? (JSON.parse(match[0]) as typeof parsed) : { score: 0, summary: "No JSON found" };
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

/**
 * Orchestrate a multi-step agent run toward a high-level goal.
 * Produces a plan, executes it, and returns the final output.
 */
export async function orchestrateAgent(input: OrchestrationInput) {
  const activeAgent = await getCloneAgent(input.model);

  const planPrompt = `Goal: ${input.goal}\n\n${input.context ? `Context: ${input.context}\n\n` : ""}` +
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
