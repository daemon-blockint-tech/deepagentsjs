import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

process.env.NODE_ENV = "test";
process.env.OPENROUTER_API_KEY = "test-key";

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

describe("GET /health", () => {
  let app: Express;

  beforeAll(async () => {
    const { app: expressApp } = await import("./server.js");
    app = expressApp;
  });

  it("returns 200 with config status", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.openrouter_configured).toBe(true);
  });
});

describe("LangSmith webhook handler", () => {
  let app: Express;

  beforeAll(async () => {
    process.env.LANGSMITH_WEBHOOK_SECRET = "test-secret";
    const { app: expressApp } = await import("./server.js");
    app = expressApp;
  });

  describe("GET /api/langsmith/webhook (health check)", () => {
    it("returns 200 with config status", async () => {
      const res = await request(app).get("/api/langsmith/webhook");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.secret_configured).toBe(true);
    });
  });

  describe("POST /api/langsmith/webhook", () => {
    it("rejects requests without a secret", async () => {
      const res = await request(app)
        .post("/api/langsmith/webhook")
        .send({ rule_id: "test", runs: [] });

      expect(res.status).toBe(401);
    });

    it("rejects requests with an invalid secret", async () => {
      const res = await request(app)
        .post("/api/langsmith/webhook")
        .set("X-Webhook-Secret", "wrong-secret")
        .send({ rule_id: "test", runs: [] });

      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong-length secret (timing-safe)", async () => {
      const res = await request(app)
        .post("/api/langsmith/webhook")
        .set("X-Webhook-Secret", "short")
        .send({ rule_id: "test", runs: [] });

      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid payload format", async () => {
      const res = await request(app)
        .post("/api/langsmith/webhook")
        .set("X-Webhook-Secret", "test-secret")
        .send({ not_a_valid: "payload" });

      expect(res.status).toBe(400);
    });

    it("accepts a valid payload with unknown rule_id and logs it", async () => {
      const res = await request(app)
        .post("/api/langsmith/webhook")
        .set("X-Webhook-Secret", "test-secret")
        .send({
          rule_id: "unknown_rule",
          start_time: "2024-01-01T00:00:00Z",
          end_time: "2024-01-01T00:01:00Z",
          runs: [
            {
              id: "run-1",
              trace_id: "trace-1",
              status: "success",
              run_type: "llm",
              name: "test",
              start_time: "2024-01-01T00:00:00Z",
              end_time: "2024-01-01T00:00:30Z",
              inputs: { messages: [{ role: "user", content: "hi" }] },
              outputs: {},
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.processed).toBe(1);
      expect(res.body.details[0].action).toBe("logged_only");
    });
  });
});
