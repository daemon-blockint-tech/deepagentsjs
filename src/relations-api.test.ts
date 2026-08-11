import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

process.env.NODE_ENV = "test";
process.env.OPENROUTER_API_KEY = "test-key";
process.env.DEFAULT_WORKSPACE_ID = "ws-test";

vi.mock("./embeddings.js", () => ({
  embedText: vi.fn(async () => new Array(1536).fill(0)),
}));

/**
 * Chainable supabase stub: every builder method returns the proxy, and
 * awaiting it (or calling .single()) resolves to the configured rows.
 */
function makeChainable(
  finalData: unknown = null,
  finalError: unknown = null,
  count: number | null = null,
) {
  const terminal = { data: finalData, error: finalError, count };
  const singleTerminal = {
    data: Array.isArray(finalData) ? (finalData[0] ?? null) : finalData,
    error: finalError,
    count,
  };
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
      if (prop === "catch") return () => Promise.resolve(terminal);
      if (prop === "single" || prop === "maybeSingle") {
        return () => singleThenable;
      }
      return () => proxy;
    },
  });
  return proxy;
}

const RELATION = {
  id: "rel-1",
  subject_id: "obj-1",
  predicate: "works_for",
  object_id: "obj-2",
  attributes: { since: 2021 },
  created_at: "2025-01-01T00:00:00Z",
};

const RELATION_TYPE = {
  id: "rt-1",
  predicate: "works_for",
  label: "Works For",
  created_at: "2025-01-01T00:00:00Z",
};

/** Objects the workspace lookup will report. Tests mutate this. */
let workspaceObjects: { id: string }[] = [{ id: "obj-1" }, { id: "obj-2" }];
/** Error the relations table returns, if any. Tests mutate this. */
let relationsError: unknown = null;

const supabaseMock = {
  auth: {
    getUser: vi.fn(async () => ({
      data: { user: { id: "user-test" } },
      error: null,
    })),
  },
  from: vi.fn((table: string) => {
    if (table === "ontology_objects") {
      return makeChainable(workspaceObjects, null, workspaceObjects.length);
    }
    if (table === "ontology_relations") {
      return makeChainable([RELATION], relationsError, 1);
    }
    if (table === "ontology_relation_types") {
      return makeChainable([RELATION_TYPE], null, 1);
    }
    return makeChainable(null, null);
  }),
  rpc: vi.fn(() => makeChainable([], null)),
};

vi.mock("./supabase.js", () => ({
  getSupabaseClient: vi.fn(() => supabaseMock),
}));

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

describe("Ontology relations API", () => {
  let app: Express;

  beforeAll(async () => {
    const { app: expressApp } = await import("./server.js");
    app = expressApp;
  });

  beforeEach(() => {
    workspaceObjects = [{ id: "obj-1" }, { id: "obj-2" }];
    relationsError = null;
  });

  describe("GET /api/relations", () => {
    it("returns 400 without workspace_id", async () => {
      const oldWs = process.env.DEFAULT_WORKSPACE_ID;
      delete process.env.DEFAULT_WORKSPACE_ID;
      const res = await request(app).get("/api/relations");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("workspace_id");
      process.env.DEFAULT_WORKSPACE_ID = oldWs;
    });

    it("returns relations with a total count", async () => {
      const res = await request(app).get("/api/relations?workspace_id=ws-test");
      expect(res.status).toBe(200);
      expect(res.body.relations).toBeInstanceOf(Array);
      expect(res.body.relations[0].id).toBe("rel-1");
      expect(res.body.total).toBe(1);
    });

    it("accepts subject, object, and predicate filters", async () => {
      const res = await request(app).get(
        "/api/relations?workspace_id=ws-test&subject_id=obj-1&object_id=obj-2&predicate=works_for",
      );
      expect(res.status).toBe(200);
      expect(res.body.relations).toBeInstanceOf(Array);
    });

    it("surfaces database errors as 400", async () => {
      relationsError = { message: "relation query blew up" };
      const res = await request(app).get("/api/relations?workspace_id=ws-test");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("relation query blew up");
    });
  });

  describe("POST /api/relations", () => {
    it("requires subject_id, predicate, and object_id", async () => {
      const res = await request(app)
        .post("/api/relations?workspace_id=ws-test")
        .send({ subject_id: "obj-1" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("predicate");
    });

    it("creates a relation between two objects in the workspace", async () => {
      const res = await request(app)
        .post("/api/relations?workspace_id=ws-test")
        .send({
          subject_id: "obj-1",
          predicate: "works_for",
          object_id: "obj-2",
        });
      expect(res.status).toBe(200);
      expect(res.body.relation.id).toBe("rel-1");
    });

    it("rejects an endpoint that is not in the workspace", async () => {
      // Only the subject resolves — the object belongs to another workspace
      // (or does not exist), so the edge must not be created.
      workspaceObjects = [{ id: "obj-1" }];
      const res = await request(app)
        .post("/api/relations?workspace_id=ws-test")
        .send({
          subject_id: "obj-1",
          predicate: "works_for",
          object_id: "obj-from-other-workspace",
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("obj-from-other-workspace");
      expect(res.body.error).not.toContain("obj-1,");
    });

    it("rejects when neither endpoint is in the workspace", async () => {
      workspaceObjects = [];
      const res = await request(app)
        .post("/api/relations?workspace_id=ws-test")
        .send({ subject_id: "a", predicate: "works_for", object_id: "b" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("a");
      expect(res.body.error).toContain("b");
    });
  });

  describe("PATCH /api/relations/:id", () => {
    it("requires at least one updatable field", async () => {
      const res = await request(app)
        .patch("/api/relations/rel-1?workspace_id=ws-test")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("predicate or attributes");
    });

    it("updates the predicate", async () => {
      const res = await request(app)
        .patch("/api/relations/rel-1?workspace_id=ws-test")
        .send({ predicate: "reports_to" });
      expect(res.status).toBe(200);
      expect(res.body.relation.id).toBe("rel-1");
    });
  });

  describe("DELETE /api/relations/:id", () => {
    it("deletes a relation", async () => {
      const res = await request(app).delete(
        "/api/relations/rel-1?workspace_id=ws-test",
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("relation types", () => {
    it("lists the workspace's predicates", async () => {
      const res = await request(app).get(
        "/api/relation-types?workspace_id=ws-test",
      );
      expect(res.status).toBe(200);
      expect(res.body.relation_types[0].predicate).toBe("works_for");
    });

    it("requires a predicate on create", async () => {
      const res = await request(app)
        .post("/api/relation-types?workspace_id=ws-test")
        .send({ label: "Works For" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("predicate");
    });

    it("creates a relation type", async () => {
      const res = await request(app)
        .post("/api/relation-types?workspace_id=ws-test")
        .send({ predicate: "works_for", label: "Works For" });
      expect(res.status).toBe(200);
      expect(res.body.relation_type.label).toBe("Works For");
    });

    it("deletes a relation type", async () => {
      const res = await request(app).delete(
        "/api/relation-types/rt-1?workspace_id=ws-test",
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
