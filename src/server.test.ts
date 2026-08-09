import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import * as agent from "./agent.js";

type CloneAgent = ReturnType<typeof agent.getCloneAgent>;

vi.mock("./agent.js", () => ({
  getCloneAgent: vi.fn(),
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
});
