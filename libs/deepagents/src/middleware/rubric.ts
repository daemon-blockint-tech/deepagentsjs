/**
 * Rubric middleware: LLM-as-a-judge grading loop.
 *
 * Wraps a deep agent with a grader sub-agent that checks the transcript
 * against a rubric supplied on invocation state (`rubric`). When the grader
 * returns `needs_revision`, per-criterion feedback is injected as a new
 * message and the agent runs again — up to `maxIterations` times — by
 * jumping the graph back to the model node from `afterAgent`.
 *
 * ## Usage
 *
 * ```typescript
 * import { createRubricMiddleware } from "deepagents";
 * import { MemorySaver } from "@langchain/langgraph";
 *
 * const middleware = createRubricMiddleware({
 *   model: "anthropic:claude-haiku-4-5",
 *   maxIterations: 3,
 * });
 *
 * const agent = createDeepAgent({
 *   middleware: [middleware],
 *   checkpointer: new MemorySaver(),
 * });
 *
 * const result = await agent.invoke(
 *   {
 *     messages: [{ role: "user", content: "Write a haiku about spring." }],
 *     rubric: "- Three lines\n- 5-7-5 syllables\n- Theme is spring",
 *   },
 *   { configurable: { thread_id: "haiku-1" } },
 * );
 * ```
 *
 * Omitting `rubric` on invocation leaves the middleware inert. A
 * checkpointer isn't required for the grading loop itself (it runs to
 * completion inside a single `invoke()` call), but is required if you want
 * the same rubric to keep applying across separate `invoke()` calls on one
 * thread.
 */

import { z } from "zod";
import {
  createMiddleware,
  createAgent,
  type StructuredTool,
  /**
   * required for type inference
   */
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

/** Terminal or in-progress status of a rubric grading run. */
export type RubricStatus =
  | "satisfied"
  | "needs_revision"
  | "max_iterations_reached"
  | "failed"
  | "grader_error";

/** Per-criterion grading result. */
export interface RubricCriterionResult {
  name: string;
  passed: boolean;
  /** Actionable feedback for a failing criterion. Absent when `passed` is true. */
  gap?: string;
}

/** One grader pass, reported to {@link RubricMiddlewareOptions.onEvaluation}. */
export interface RubricEvaluation {
  /** Shared by every evaluation within one rubric attempt. */
  gradingRunId: string;
  /** Zero-based index of this grader pass within the run. */
  iteration: number;
  /** The grader's own verdict for this pass — not the run's terminal status. */
  result: "satisfied" | "needs_revision" | "failed" | "grader_error";
  explanation: string;
  criteria: RubricCriterionResult[];
}

export interface RubricMiddlewareOptions {
  /** Chat model used by the grader. Often smaller/cheaper than the working model. */
  model: LanguageModelLike | string;
  /** Grading instructions. Falls back to a built-in grader prompt. */
  systemPrompt?: string;
  /** Tools the grader may call to gather evidence before producing a verdict. */
  tools?: StructuredTool[];
  /** Maximum grader iterations per rubric attempt. Must be a positive integer. Default 3. */
  maxIterations?: number;
  /** Invoked after every grading iteration. Errors are logged and swallowed. */
  onEvaluation?: (evaluation: RubricEvaluation) => void | Promise<void>;
}

const DEFAULT_GRADER_SYSTEM_PROMPT = `You are an LLM-as-a-judge grader reviewing an agent's conversation transcript against a rubric.

Evaluate every criterion in the rubric against the transcript. If tools are available, use them to verify claims (e.g. running tests) rather than trusting the transcript at face value.

Report a verdict:
- "satisfied" if every criterion passes.
- "needs_revision" if at least one criterion fails — list every criterion with pass/fail and, for failures, a concrete "gap" describing what to fix.
- "failed" if the rubric itself is malformed or impossible to evaluate against this transcript.`;

const RubricCriterionSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  gap: z.string().optional(),
});

const RubricVerdictSchema = z.object({
  result: z.enum(["satisfied", "needs_revision", "failed"]),
  explanation: z.string(),
  criteria: z.array(RubricCriterionSchema).default([]),
});
type RubricVerdict = z.infer<typeof RubricVerdictSchema>;

const RubricStateSchema = z.object({
  /** Grading criteria for the current turn. Grading is skipped when unset. */
  rubric: z.string().optional(),
  /** Rubric text the last grading run was started for — detects a new run. */
  _rubricGradedRubric: z.string().optional(),
  _rubricStatus: z
    .enum([
      "satisfied",
      "needs_revision",
      "max_iterations_reached",
      "failed",
      "grader_error",
    ])
    .optional(),
  _rubricIterations: z.number().default(0),
  _rubricRunId: z.string().optional(),
});

/** Render a message transcript as plain text for the grader prompt. */
export function formatRubricTranscript(
  messages: readonly BaseMessage[],
): string {
  return messages
    .map((message) => {
      const text =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
      return `[${message.getType()}] ${text}`;
    })
    .join("\n\n");
}

/**
 * Decide the run's next status and, when another pass is warranted, the
 * feedback message to inject before jumping back to the model.
 *
 * Split out of the `afterAgent` hook so the loop/termination branching can
 * be unit tested without a live grader model.
 */
export function computeRubricOutcome(params: {
  verdict: RubricVerdict;
  iteration: number;
  maxIterations: number;
}): {
  status: RubricStatus;
  jumpTo?: "model";
  feedbackMessage?: HumanMessage;
} {
  const { verdict, iteration, maxIterations } = params;

  if (verdict.result !== "needs_revision") {
    return { status: verdict.result };
  }
  if (iteration + 1 >= maxIterations) {
    return { status: "max_iterations_reached" };
  }

  const gaps = verdict.criteria
    .filter((criterion) => !criterion.passed)
    .map(
      (criterion) => `- ${criterion.name}: ${criterion.gap ?? "does not pass"}`,
    )
    .join("\n");

  return {
    status: "needs_revision",
    jumpTo: "model",
    feedbackMessage: new HumanMessage(
      `Your previous response did not satisfy the rubric. Address the following before answering again:\n\n${gaps || verdict.explanation}`,
    ),
  };
}

/**
 * Create rubric-based LLM-as-a-judge middleware.
 *
 * Pass a `rubric` string on invocation state to enable grading for that
 * call — see the module docs for a full example.
 *
 * @param options - Grader model, tools, iteration cap, and evaluation callback.
 * @returns An `AgentMiddleware` to include in `createDeepAgent({ middleware })`.
 */
export function createRubricMiddleware(options: RubricMiddlewareOptions) {
  const {
    model,
    systemPrompt = DEFAULT_GRADER_SYSTEM_PROMPT,
    tools = [],
    maxIterations = 3,
    onEvaluation,
  } = options;

  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(
      `maxIterations must be a positive integer, got ${maxIterations}`,
    );
  }

  // Built once and reused across grading iterations and invocations.
  const graderAgent = createAgent({
    model,
    systemPrompt,
    tools,
    responseFormat: RubricVerdictSchema,
  });

  return createMiddleware({
    name: "RubricMiddleware",
    stateSchema: RubricStateSchema,
    afterAgent: {
      canJumpTo: ["model"],
      hook: async (state) => {
        const rubric = state.rubric;
        if (!rubric) return undefined;

        const isNewRun =
          state._rubricGradedRubric !== rubric ||
          state._rubricStatus !== "needs_revision";
        const iteration = isNewRun ? 0 : state._rubricIterations;
        const gradingRunId =
          isNewRun || !state._rubricRunId
            ? crypto.randomUUID()
            : state._rubricRunId;

        let verdict: RubricVerdict;
        let graderThrew = false;
        try {
          const graderResult = await graderAgent.invoke({
            messages: [
              new HumanMessage(
                `## Rubric\n${rubric}\n\n## Transcript to grade\n${formatRubricTranscript(state.messages ?? [])}`,
              ),
            ],
          });
          verdict = graderResult.structuredResponse as RubricVerdict;
        } catch (e) {
          graderThrew = true;
          verdict = { result: "failed", explanation: `${e}`, criteria: [] };
        }

        const outcome = computeRubricOutcome({
          verdict,
          iteration,
          maxIterations,
        });
        const status: RubricStatus = graderThrew
          ? "grader_error"
          : outcome.status;

        if (onEvaluation) {
          try {
            await onEvaluation({
              gradingRunId,
              iteration,
              result: graderThrew ? "grader_error" : verdict.result,
              explanation: verdict.explanation,
              criteria: verdict.criteria,
            });
          } catch (callbackError) {
            // Errors in the callback are logged and swallowed — the grading
            // loop must not be derailed by a broken observer.
            // oxlint-disable-next-line no-console
            console.warn(
              "[RubricMiddleware] onEvaluation callback threw:",
              callbackError,
            );
          }
        }

        return {
          rubric,
          _rubricGradedRubric: rubric,
          _rubricStatus: status,
          _rubricIterations: iteration + 1,
          _rubricRunId: gradingRunId,
          ...(outcome.feedbackMessage && {
            messages: [outcome.feedbackMessage],
          }),
          ...(outcome.jumpTo && { jumpTo: outcome.jumpTo }),
        };
      },
    },
  });
}
