import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { createTestWorkspace, destroyTestWorkspace } from "./test-workspace.js";

// Must be set before server.js is imported so it skips listen/schedulers.
process.env.NODE_ENV = "test";

// Real integration test: live Supabase, real embeddings, no mocks.
// Skipped (loudly, as "skipped") when the environment lacks credentials,
// mirroring supabase.test.ts.
const enabled = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  process.env.DEFAULT_USER_ID,
);

const runId = randomUUID().slice(0, 8);
const ALICE_EXT = `itest-alice-${runId}`;
const BOB_EXT = `itest-bob-${runId}`;
const ALICE_NAME = `Alice Integration ${runId}`;

describe.skipIf(!enabled)("Ontology objects API (integration)", () => {
  let app: Express;
  let workspaceId = "";
  let aliceId = "";
  let bobId = "";

  beforeAll(async () => {
    const { app: expressApp } = await import("./server.js");
    app = expressApp;
    // server.js re-reads this per request; without it a missing workspace_id
    // must 400 instead of silently falling back to the product workspace.
    delete process.env.DEFAULT_WORKSPACE_ID;
    workspaceId = await createTestWorkspace();
  }, 30_000);

  afterAll(async () => {
    await destroyTestWorkspace(workspaceId);
  }, 30_000);

  it("returns 400 without workspace_id", async () => {
    const res = await request(app).get("/api/objects");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("workspace_id");
  });

  it("returns 403 for a workspace the user is not a member of", async () => {
    const res = await request(app).get(
      `/api/objects?workspace_id=${randomUUID()}`,
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 without object_type", async () => {
    const res = await request(app)
      .post(`/api/objects?workspace_id=${workspaceId}`)
      .send({ external_id: ALICE_EXT });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("object_type");
  });

  it("returns 400 without external_id", async () => {
    const res = await request(app)
      .post(`/api/objects?workspace_id=${workspaceId}`)
      .send({ object_type: "person" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("external_id");
  });

  it("creates an object and persists it", { timeout: 30_000 }, async () => {
    const res = await request(app)
      .post(`/api/objects?workspace_id=${workspaceId}`)
      .send({
        object_type: "person",
        external_id: ALICE_EXT,
        display_name: ALICE_NAME,
        attributes: { age: 30, role: "engineer" },
      });
    expect(res.status).toBe(200);
    aliceId = res.body.object.id;
    expect(aliceId).toBeTruthy();

    const fetched = await request(app).get(
      `/api/objects/${aliceId}?workspace_id=${workspaceId}`,
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body.object.external_id).toBe(ALICE_EXT);
    expect(fetched.body.object.display_name).toBe(ALICE_NAME);
    expect(fetched.body.object.attributes).toEqual({
      age: 30,
      role: "engineer",
    });
  });

  it("rejects re-creating an external_id as another type", async () => {
    const res = await request(app)
      .post(`/api/objects?workspace_id=${workspaceId}`)
      .send({ object_type: "company", external_id: ALICE_EXT });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("already exists");
  });

  it("lists objects with total count", { timeout: 30_000 }, async () => {
    const created = await request(app)
      .post(`/api/objects?workspace_id=${workspaceId}`)
      .send({ object_type: "company", external_id: BOB_EXT });
    expect(created.status).toBe(200);
    bobId = created.body.object.id;

    const res = await request(app).get(
      `/api/objects?workspace_id=${workspaceId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const ids = res.body.objects.map((o: { id: string }) => o.id);
    expect(ids).toContain(aliceId);
    expect(ids).toContain(bobId);
  });

  it("filters by object_type and query", async () => {
    const res = await request(app).get(
      `/api/objects?workspace_id=${workspaceId}&object_type=person&query=${ALICE_EXT}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.objects).toHaveLength(1);
    expect(res.body.objects[0].id).toBe(aliceId);
  });

  it("returns normalized properties for an object", async () => {
    const res = await request(app).get(
      `/api/objects/${aliceId}/properties?workspace_id=${workspaceId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.properties).toEqual([
      { key: "age", value: 30, value_type: "number" },
      { key: "role", value: "engineer", value_type: "string" },
    ]);
  });

  it("returns 400 without a semantic search query", async () => {
    const res = await request(app).get(
      `/api/objects/search/semantic?workspace_id=${workspaceId}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("query");
  });

  it(
    "finds the created object via semantic search",
    { timeout: 30_000 },
    async () => {
      const res = await request(app).get(
        `/api/objects/search/semantic?workspace_id=${workspaceId}&query=${encodeURIComponent(ALICE_NAME)}&threshold=0.1`,
      );
      expect(res.status).toBe(200);
      const match = res.body.results.find(
        (r: { object_id: string }) => r.object_id === aliceId,
      );
      // Fails when the create-time embedding didn't land — that's the point.
      expect(match).toBeDefined();
      expect(match.similarity).toBeGreaterThan(0.1);
    },
  );

  it(
    "updates an object and syncs properties",
    { timeout: 30_000 },
    async () => {
      const res = await request(app)
        .patch(`/api/objects/${aliceId}?workspace_id=${workspaceId}`)
        .send({
          display_name: `${ALICE_NAME} Updated`,
          attributes: { age: 31 },
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const fetched = await request(app).get(
        `/api/objects/${aliceId}?workspace_id=${workspaceId}`,
      );
      expect(fetched.body.object.display_name).toBe(`${ALICE_NAME} Updated`);
      // Attributes merge: age overwritten, role retained.
      expect(fetched.body.object.attributes).toEqual({
        age: 31,
        role: "engineer",
      });

      const props = await request(app).get(
        `/api/objects/${aliceId}/properties?workspace_id=${workspaceId}`,
      );
      expect(props.body.properties).toContainEqual({
        key: "age",
        value: 31,
        value_type: "number",
      });
    },
  );

  it("deletes an object", async () => {
    const res = await request(app).delete(
      `/api/objects/${bobId}?workspace_id=${workspaceId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const fetched = await request(app).get(
      `/api/objects/${bobId}?workspace_id=${workspaceId}`,
    );
    expect(fetched.status).toBe(400);
  });
});
