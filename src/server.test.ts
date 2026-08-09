import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import * as agent from "./agent.js";

vi.mock("./agent.js", () => ({
  getCloneAgent: vi.fn(),
}));

process.env.NODE_ENV = "test";
process.env.OPENROUTER_API_KEY = "test-key";

describe("POST /api/chat", () => {
  let app: Express;

  beforeAll(async () => {
    const { app: expressApp } = await import("./server.js");
    app = expressApp;
  });

  it("returns 400 for invalid messages", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ messages: "not-an-array", model: "openai/gpt-4o" });

    expect(res.status).toBe(400);
  });

  it("returns 200 with mocked OpenRouter response", async () => {
    vi.mocked(agent.getCloneAgent).mockReturnValue({
      invoke: vi.fn().mockResolvedValue({
        messages: [{ _getType: () => "ai", content: "Hello from test" }],
      }),
    } as any);

    const res = await request(app)
      .post("/api/chat")
      .send({ messages: [{ role: "user", content: "hi" }], model: "openai/gpt-4o" });

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

  it("returns 200 and closes stream", async () => {
    async function* mockStream() {
      yield { messages: [{ _getType: () => "ai", content: "Hello " }] };
      yield { messages: [{ _getType: () => "ai", content: "stream" }] };
    }

    vi.mocked(agent.getCloneAgent).mockReturnValue({
      stream: vi.fn().mockReturnValue(mockStream()),
    } as any);

    const res = await request(app)
      .post("/api/chat/stream")
      .send({ messages: [{ role: "user", content: "hi" }], model: "openai/gpt-4o" });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"done":true');
  });
});
