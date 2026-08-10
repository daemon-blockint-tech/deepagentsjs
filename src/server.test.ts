import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import * as agent from "./agent.js";

type CloneAgent = ReturnType<typeof agent.getCloneAgent>;

vi.mock("./agent.js", () => ({
  getCloneAgent: vi.fn(),
  threadConfig: vi.fn((threadId: string) => ({
    configurable: { thread_id: threadId },
  })),
  // Default to "nothing pending" so existing tests exercise the normal path;
  // the HITL cases below override these per test.
  extractInterrupt: vi.fn(() => null),
  getPendingApproval: vi.fn(async () => null),
  resumeAgent: vi.fn(),
  DEFAULT_MODEL: "openai/gpt-4o",
}));

vi.mock("./supabase.js", () => ({
  getSupabaseClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async (token: string) =>
        token.startsWith("valid-")
          ? { data: { user: { id: token.slice(6) } }, error: null }
          : { data: { user: null }, error: new Error("invalid token") },
      ),
    },
  })),
}));

process.env.NODE_ENV = "test";
process.env.OPENROUTER_API_KEY = "test-key";

describe("POST /api/chat", () => {
  let app: Express;

  beforeAll(async () => {
    const { app: expressApp } = await import("./server.js");
    app = expressApp;
  });

  it("rejects requests without an access token", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(401);
  });

  it("rejects requests with an invalid access token", async () => {
    const res = await request(app)
      .post("/api/chat")
      .set("Authorization", "Bearer wrong-token")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(401);
  });

  it("does not trust a client-supplied user id header", async () => {
    const res = await request(app)
      .post("/api/chat")
      .set("X-User-Id", "someone-else")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid messages", async () => {
    const res = await request(app)
      .post("/api/chat")
      .set("Authorization", "Bearer valid-chat-400")
      .send({ messages: "not-an-array", model: "openai/gpt-4o" });

    expect(res.status).toBe(400);
  });

  it("returns 200 with mocked OpenRouter response", async () => {
    vi.mocked(agent.getCloneAgent).mockReturnValue({
      invoke: vi.fn().mockResolvedValue({
        messages: [{ _getType: () => "ai", content: "Hello from test" }],
      }),
    } as unknown as CloneAgent);

    const res = await request(app)
      .post("/api/chat")
      .set("Authorization", "Bearer valid-chat-200")
      .send({
        messages: [{ role: "user", content: "hi" }],
        model: "openai/gpt-4o",
      });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain("Hello from test");
  });
});

describe("POST /api/chat/stream", () => {
  let app: Express;

  beforeAll(async () => {
    const { app: expressApp } = await import("./server.js");
    app = expressApp;
  });

  it("rejects streaming requests without an access token", async () => {
    const res = await request(app)
      .post("/api/chat/stream")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(401);
  });

  it("returns 200 and closes stream", async () => {
    async function* mockStream() {
      yield { messages: [{ _getType: () => "ai", content: "Hello " }] };
      yield { messages: [{ _getType: () => "ai", content: "stream" }] };
    }

    vi.mocked(agent.getCloneAgent).mockReturnValue({
      stream: vi.fn().mockReturnValue(mockStream()),
    } as unknown as CloneAgent);

    const res = await request(app)
      .post("/api/chat/stream")
      .set("Authorization", "Bearer valid-stream-200")
      .send({
        messages: [{ role: "user", content: "hi" }],
        model: "openai/gpt-4o",
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"content":"Hello "');
    expect(res.text).toContain('"content":"stream"');
    expect(res.text).toContain('"done":true');
  });

  describe("human-in-the-loop", () => {
    // Without this, call assertions below would pass simply because an earlier
    // test had not reached resumeAgent yet.
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(agent.extractInterrupt).mockReturnValue(null);
      vi.mocked(agent.getPendingApproval).mockResolvedValue(null);
    });

    const pending = {
      status: "interrupt" as const,
      thread_id: "thread-hitl",
      model: "openai/gpt-4o",
      action_requests: [{ name: "run_shell", args: { command: "node -e 1" } }],
      review_configs: [
        {
          actionName: "run_shell",
          allowedDecisions: ["approve", "reject"] as Array<
            "approve" | "edit" | "reject"
          >,
        },
      ],
    };

    it("returns the approval request instead of an answer when a run parks", async () => {
      vi.mocked(agent.getCloneAgent).mockReturnValue({
        invoke: vi.fn().mockResolvedValue({ messages: [] }),
      } as unknown as CloneAgent);
      vi.mocked(agent.extractInterrupt).mockReturnValue(pending);

      const res = await request(app)
        .post("/api/chat")
        .set("Authorization", "Bearer valid-hitl-1")
        .send({ messages: [{ role: "user", content: "run something" }] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("interrupt");
      expect(res.body.thread_id).toBe("thread-hitl");
      expect(res.body.action_requests[0].name).toBe("run_shell");
    });

    it("requires auth to resume", async () => {
      const res = await request(app)
        .post("/api/chat/resume")
        .send({ thread_id: "thread-hitl", decisions: [{ type: "approve" }] });

      expect(res.status).toBe(401);
    });

    it("rejects a decision type the JS middleware cannot handle", async () => {
      const res = await request(app)
        .post("/api/chat/resume")
        .set("Authorization", "Bearer valid-hitl-2")
        // "respond" exists in the Python API only.
        .send({ thread_id: "thread-hitl", decisions: [{ type: "respond" }] });

      expect(res.status).toBe(400);
    });

    it("refuses to resume a thread that is not parked", async () => {
      vi.mocked(agent.getPendingApproval).mockResolvedValue(null);

      const res = await request(app)
        .post("/api/chat/resume")
        .set("Authorization", "Bearer valid-hitl-3")
        .send({ thread_id: "unknown-thread", decisions: [{ type: "approve" }] });

      // Resuming an unknown id would otherwise run the tool with no approval.
      expect(res.status).toBe(409);
      expect(agent.resumeAgent).not.toHaveBeenCalled();
    });

    it("refuses when the decision count does not match the pending actions", async () => {
      vi.mocked(agent.getPendingApproval).mockResolvedValue(pending);

      const res = await request(app)
        .post("/api/chat/resume")
        .set("Authorization", "Bearer valid-hitl-4")
        .send({
          thread_id: "thread-hitl",
          decisions: [{ type: "approve" }, { type: "approve" }],
        });

      expect(res.status).toBe(400);
      expect(agent.resumeAgent).not.toHaveBeenCalled();
    });

    it("resumes a parked thread and returns the finished result", async () => {
      vi.mocked(agent.getPendingApproval).mockResolvedValue(pending);
      vi.mocked(agent.resumeAgent).mockResolvedValue({
        result: { messages: [{ content: "done" }] },
        interrupt: null,
      });

      const res = await request(app)
        .post("/api/chat/resume")
        .set("Authorization", "Bearer valid-hitl-5")
        .send({ thread_id: "thread-hitl", decisions: [{ type: "approve" }] });

      expect(res.status).toBe(200);
      expect(res.body.messages[0].content).toBe("done");
      expect(agent.resumeAgent).toHaveBeenCalledWith(
        "thread-hitl",
        [{ type: "approve" }],
        undefined,
      );
    });

    it("returns the next approval when the agent parks again", async () => {
      vi.mocked(agent.getPendingApproval).mockResolvedValue(pending);
      vi.mocked(agent.resumeAgent).mockResolvedValue({
        result: { messages: [] },
        interrupt: { ...pending, thread_id: "thread-hitl" },
      });

      const res = await request(app)
        .post("/api/chat/resume")
        .set("Authorization", "Bearer valid-hitl-6")
        .send({ thread_id: "thread-hitl", decisions: [{ type: "reject" }] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("interrupt");
    });
  });
});
