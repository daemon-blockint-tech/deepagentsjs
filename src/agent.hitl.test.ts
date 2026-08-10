import { describe, it, expect } from "vitest";
import { CLONE_INTERRUPT_ON, extractInterrupt } from "./agent.js";

/**
 * These cover the pure decision logic around human-in-the-loop: which tools
 * are gated, and whether a run is recognised as parked. Actually driving a
 * model through an interrupt needs live credentials and lives in the
 * deepagents integration suite, not here.
 */
describe("HITL interrupt configuration", () => {
  it("gates the tools that execute code", () => {
    expect(CLONE_INTERRUPT_ON.run_shell).toBeDefined();
    expect(CLONE_INTERRUPT_ON.eval).toBeDefined();
  });

  it("leaves read-only and already-approved tools ungated", () => {
    // query_ontology only reads; propose_action writes a proposal that carries
    // its own approval via /api/actions/:id/approve.
    expect(CLONE_INTERRUPT_ON.query_ontology).toBeUndefined();
    expect(CLONE_INTERRUPT_ON.propose_action).toBeUndefined();
  });

  it("allows editing shell arguments but not sandboxed eval", () => {
    const shell = CLONE_INTERRUPT_ON.run_shell as { allowedDecisions: string[] };
    const evaluate = CLONE_INTERRUPT_ON.eval as { allowedDecisions: string[] };

    expect(shell.allowedDecisions).toContain("edit");
    expect(evaluate.allowedDecisions).not.toContain("edit");
    // "respond" is Python-only; sending it would be rejected by the JS middleware.
    for (const config of [shell, evaluate]) {
      expect(config.allowedDecisions).not.toContain("respond");
      expect(config.allowedDecisions).toContain("approve");
      expect(config.allowedDecisions).toContain("reject");
    }
  });
});

describe("extractInterrupt", () => {
  const request = {
    actionRequests: [{ name: "run_shell", args: { command: "node -e 1" } }],
    reviewConfigs: [
      { actionName: "run_shell", allowedDecisions: ["approve", "reject"] },
    ],
  };

  it("returns an approval request when the run parked", () => {
    const pending = extractInterrupt(
      { __interrupt__: [{ value: request }] },
      "thread-1",
      "openai/gpt-4o",
    );

    expect(pending).not.toBeNull();
    expect(pending?.status).toBe("interrupt");
    expect(pending?.thread_id).toBe("thread-1");
    // Echoed back so resume needs no server-side per-thread state.
    expect(pending?.model).toBe("openai/gpt-4o");
    expect(pending?.action_requests).toHaveLength(1);
    expect(pending?.action_requests[0].name).toBe("run_shell");
  });

  it("returns null for a completed run", () => {
    expect(
      extractInterrupt({ messages: [] }, "thread-1", "openai/gpt-4o"),
    ).toBeNull();
  });

  it("returns null rather than throwing on empty or missing results", () => {
    expect(extractInterrupt({}, "t", "m")).toBeNull();
    expect(extractInterrupt({ __interrupt__: [] }, "t", "m")).toBeNull();
    expect(extractInterrupt(null, "t", "m")).toBeNull();
    expect(extractInterrupt(undefined, "t", "m")).toBeNull();
  });
});
