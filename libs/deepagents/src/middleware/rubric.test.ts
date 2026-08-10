import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import {
  createRubricMiddleware,
  computeRubricOutcome,
  formatRubricTranscript,
} from "./rubric.js";

describe("computeRubricOutcome", () => {
  it("terminates with the grader's verdict when satisfied", () => {
    const outcome = computeRubricOutcome({
      verdict: { result: "satisfied", explanation: "all good", criteria: [] },
      iteration: 0,
      maxIterations: 3,
    });
    expect(outcome).toEqual({ status: "satisfied" });
  });

  it("terminates with the grader's verdict when failed", () => {
    const outcome = computeRubricOutcome({
      verdict: {
        result: "failed",
        explanation: "malformed rubric",
        criteria: [],
      },
      iteration: 0,
      maxIterations: 3,
    });
    expect(outcome).toEqual({ status: "failed" });
  });

  it("loops back to the model with per-criterion feedback when revision is needed", () => {
    const outcome = computeRubricOutcome({
      verdict: {
        result: "needs_revision",
        explanation: "misses a criterion",
        criteria: [
          { name: "three lines", passed: true },
          {
            name: "mentions spring",
            passed: false,
            gap: "no mention of spring",
          },
        ],
      },
      iteration: 0,
      maxIterations: 3,
    });
    expect(outcome.status).toBe("needs_revision");
    expect(outcome.jumpTo).toBe("model");
    expect(outcome.feedbackMessage).toBeInstanceOf(HumanMessage);
    expect(outcome.feedbackMessage?.text).toContain("mentions spring");
    expect(outcome.feedbackMessage?.text).toContain("no mention of spring");
  });

  it("stops looping once the iteration cap is reached", () => {
    const outcome = computeRubricOutcome({
      verdict: {
        result: "needs_revision",
        explanation: "still missing something",
        criteria: [{ name: "x", passed: false, gap: "y" }],
      },
      iteration: 2,
      maxIterations: 3,
    });
    expect(outcome).toEqual({ status: "max_iterations_reached" });
  });
});

describe("formatRubricTranscript", () => {
  it("renders each message's type and text content", () => {
    const transcript = formatRubricTranscript([
      new HumanMessage("Write a haiku."),
      new AIMessage("Old pond / a frog jumps in / water's sound"),
    ]);
    expect(transcript).toBe(
      "[human] Write a haiku.\n\n[ai] Old pond / a frog jumps in / water's sound",
    );
  });
});

describe("createRubricMiddleware", () => {
  it("rejects a non-positive maxIterations", () => {
    expect(() =>
      createRubricMiddleware({
        model: "anthropic:claude-haiku-4-5",
        maxIterations: 0,
      }),
    ).toThrow(/maxIterations/);
  });

  it("rejects a non-integer maxIterations", () => {
    expect(() =>
      createRubricMiddleware({
        model: "anthropic:claude-haiku-4-5",
        maxIterations: 1.5,
      }),
    ).toThrow(/maxIterations/);
  });

  it("declares afterAgent with a canJumpTo of model", () => {
    const middleware = createRubricMiddleware({
      model: "anthropic:claude-haiku-4-5",
    });
    const afterAgent = middleware.afterAgent as { canJumpTo?: string[] };
    expect(afterAgent.canJumpTo).toEqual(["model"]);
  });

  it("is a no-op when no rubric is present on state", async () => {
    const middleware = createRubricMiddleware({
      model: "anthropic:claude-haiku-4-5",
    });
    const afterAgent = middleware.afterAgent as {
      hook: (state: unknown, runtime: unknown) => unknown;
    };
    const result = await afterAgent.hook({ messages: [] }, {});
    expect(result).toBeUndefined();
  });
});
