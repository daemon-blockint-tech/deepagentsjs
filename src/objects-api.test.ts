import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

process.env.NODE_ENV = "test";
process.env.OPENROUTER_API_KEY = "test-key";
process.env.DEFAULT_WORKSPACE_ID = "ws-test";

// Mock embeddings so tests don't call the real OpenRouter API.
vi.mock("./embeddings.js", () => ({
  embedText: vi.fn(async (text: string) => {
    const embedding = new Array(1536).fill(0);
    for (let i = 0; i < text.length; i++) {
      embedding[i % 1536] += text.charCodeAt(i) / 1000;
    }
    return embedding;
  }),
}));

// Mock supabase with a chainable query builder.
function makeChainable(
  finalData: unknown = null,
  finalError: unknown = null,
  count: number | null = null,
) {
  const terminal = {
    data: finalData,
    error: finalError,
    count,
  };

  // When .single() or .maybeSingle() is called, unwrap array to first element
  const singleTerminal = {
    data: Array.isArray(finalData) ? (finalData[0] ?? null) : finalData,
    error: finalError,
    count,
  };

  // A thenable that resolves to singleTerminal
  const singleThenable = {
    then: (resolve: (v: unknown) => void) =>
      Promise.resolve(singleTerminal).then(resolve),
    catch: () => Promise.resolve(singleTerminal),
  };

  const proxy = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === "data") return terminal.data;
      if (prop === "error") return terminal.error;
      if (prop === "count") return terminal.count;
      if (prop === "then") {
        return (resolve: (v: unknown) => void) =>
          Promise.resolve(terminal).then(resolve);
      }
      if (prop === "catch") {
        return () => Promise.resolve(terminal);
      }
      if (prop === "single" || prop === "maybeSingle") {
        // Return a function that returns the thenable
        return () => singleThenable;
      }
      // Return a function that returns the proxy for chaining
      return () => proxy;
    },
  });
  return proxy;
}

const supabaseMock = {
  auth: {
    getUser: vi.fn(async () => ({
      data: { user: { id: "user-test" } },
      error: null,
    })),
  },
  from: vi.fn((table: string) => {
    if (table === "ontology_objects") {
      return makeChainable(
        [
          {
            id: "obj-1",
            object_type: "person",
            external_id: "alice",
            display_name: "Alice",
            attributes: { age: 30, role: "engineer" },
            created_at: "2025-01-01T00:00:00Z",
            updated_at: "2025-01-02T00:00:00Z",
          },
        ],
        null,
        1,
      );
    }
    if (table === "ontology_properties") {
      return makeChainable(
        [
          { key: "age", value: 30, value_type: "number" },
          { key: "role", value: "engineer", value_type: "string" },
        ],
        null,
      );
    }
    if (table === "ontology_chunks") {
      return makeChainable(null, null);
    }
    return makeChainable(null, null);
  }),
  rpc: vi.fn(() =>
    makeChainable(
      [
        {
          chunk_id: "chunk-1",
          object_id: "obj-1",
          content: 'Alice\n{"age":30}',
          similarity: 0.92,
          display_name: "Alice",
          external_id: "alice",
          object_type: "person",
          attributes: { age: 30 },
        },
      ],
      null,
    ),
  ),
};

vi.mock("./supabase.js", () => ({
  getSupabaseClient: vi.fn(() => supabaseMock),
}));

// Mock automations to avoid starting real listeners/schedulers
vi.mock("./automations.js", () => ({
  evaluateAutomations: vi.fn(async () => []),
  startAutomationScheduler: vi.fn(),
  stopAutomationScheduler: vi.fn(),
  processScheduledAutomations: vi.fn(async () => []),
}));

vi.mock("./automation-listener.js", () => ({
  startAutomationListener: vi.fn(async () => {}),
  stopAutomationListener: vi.fn(async () => {}),
}));

describe("Ontology objects API", () => {
  let app: Express;

  beforeAll(async () => {
    const { app: expressApp } = await import("./server.js");
    app = expressApp;
  });

  describe("GET /api/objects", () => {
    it("returns 400 without workspace_id", async () => {
      // Temporarily unset DEFAULT_WORKSPACE_ID
      const oldWs = process.env.DEFAULT_WORKSPACE_ID;
      delete process.env.DEFAULT_WORKSPACE_ID;
      const res = await request(app).get("/api/objects");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("workspace_id");
      process.env.DEFAULT_WORKSPACE_ID = oldWs;
    });

    it("returns objects list with total count", async () => {
      const res = await request(app).get("/api/objects?workspace_id=ws-test");
      expect(res.status).toBe(200);
      expect(res.body.objects).toBeInstanceOf(Array);
      expect(res.body.total).toBe(1);
      expect(res.body.objects[0].id).toBe("obj-1");
    });

    it("accepts object_type and query filters", async () => {
      const res = await request(app).get(
        "/api/objects?workspace_id=ws-test&object_type=person&query=alice",
      );
      expect(res.status).toBe(200);
      expect(res.body.objects).toBeInstanceOf(Array);
    });
  });

  describe("GET /api/objects/:id", () => {
    it("returns a single object", async () => {
      const res = await request(app).get(
        "/api/objects/obj-1?workspace_id=ws-test",
      );
      expect(res.status).toBe(200);
      expect(res.body.object).toBeDefined();
      expect(res.body.object.id).toBe("obj-1");
    });
  });

  describe("GET /api/objects/search/semantic", () => {
    it("returns 400 without query", async () => {
      const res = await request(app).get(
        "/api/objects/search/semantic?workspace_id=ws-test",
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("query");
    });

    it("returns semantic search results with similarity scores", async () => {
      const res = await request(app).get(
        "/api/objects/search/semantic?workspace_id=ws-test&query=alice",
      );
      expect(res.status).toBe(200);
      expect(res.body.results).toBeInstanceOf(Array);
      expect(res.body.results[0].similarity).toBeGreaterThan(0);
      expect(res.body.results[0].display_name).toBe("Alice");
    });
  });

  describe("GET /api/objects/:id/properties", () => {
    it("returns normalized properties for an object", async () => {
      const res = await request(app).get(
        "/api/objects/obj-1/properties?workspace_id=ws-test",
      );
      expect(res.status).toBe(200);
      expect(res.body.properties).toBeInstanceOf(Array);
      expect(res.body.properties[0].key).toBe("age");
    });
  });

  describe("POST /api/objects", () => {
    it("returns 400 without object_type", async () => {
      const res = await request(app)
        .post("/api/objects?workspace_id=ws-test")
        .send({ external_id: "test-1" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("object_type");
    });

    it("returns 400 without external_id", async () => {
      const res = await request(app)
        .post("/api/objects?workspace_id=ws-test")
        .send({ object_type: "person" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("external_id");
    });

    it("creates an object successfully", async () => {
      const res = await request(app)
        .post("/api/objects?workspace_id=ws-test")
        .send({
          object_type: "person",
          external_id: "bob-2",
          display_name: "Bob",
          attributes: { age: 25 },
        });
      expect(res.status).toBe(200);
      expect(res.body.object).toBeDefined();
      expect(res.body.object.object_type).toBe("person");
    });
  });

  describe("PATCH /api/objects/:id", () => {
    it("updates an object successfully", async () => {
      const res = await request(app)
        .patch("/api/objects/obj-1?workspace_id=ws-test")
        .send({
          display_name: "Alice Updated",
          attributes: { age: 31 },
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("DELETE /api/objects/:id", () => {
    it("deletes an object successfully", async () => {
      const res = await request(app).delete(
        "/api/objects/obj-1?workspace_id=ws-test",
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
