import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { getSupabaseClient } from "./supabase.js";
import { createTestWorkspace, destroyTestWorkspace } from "./test-workspace.js";

// Must be set before server.js is imported so it skips listen/schedulers.
process.env.NODE_ENV = "test";

// Real integration test: live Supabase, no mocks. Skipped when the
// environment lacks credentials, mirroring supabase.test.ts.
const enabled = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  process.env.DEFAULT_USER_ID,
);

const runId = randomUUID().slice(0, 8);

describe.skipIf(!enabled)("Ontology relations API (integration)", () => {
  let app: Express;
  let workspaceId = "";
  let personId = "";
  let companyId = "";
  let relationId = "";
  let relationTypeId = "";

  beforeAll(async () => {
    const { app: expressApp } = await import("./server.js");
    app = expressApp;
    // server.js re-reads this per request; without it a missing workspace_id
    // must 400 instead of silently falling back to the product workspace.
    delete process.env.DEFAULT_WORKSPACE_ID;
    workspaceId = await createTestWorkspace();

    // Fixtures are data-layer inserts (real rows, same client the server
    // uses); the routes under test here are the relations endpoints.
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("ontology_objects")
      .insert([
        {
          workspace_id: workspaceId,
          object_type: "person",
          external_id: `itest-rel-person-${runId}`,
          display_name: "Relation Person",
          attributes: {},
        },
        {
          workspace_id: workspaceId,
          object_type: "company",
          external_id: `itest-rel-company-${runId}`,
          display_name: "Relation Company",
          attributes: {},
        },
      ])
      .select("id, object_type");
    if (error) throw new Error(`fixture insert failed: ${error.message}`);
    personId = data.find((o) => o.object_type === "person")!.id;
    companyId = data.find((o) => o.object_type === "company")!.id;
  }, 30_000);

  afterAll(async () => {
    await destroyTestWorkspace(workspaceId);
  }, 30_000);

  it("returns 400 without workspace_id", async () => {
    const res = await request(app).get("/api/relations");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("workspace_id");
  });

  it("returns 403 for a workspace the user is not a member of", async () => {
    const res = await request(app).get(
      `/api/relations?workspace_id=${randomUUID()}`,
    );
    expect(res.status).toBe(403);
  });

  it("requires subject_id, predicate, and object_id", async () => {
    const res = await request(app)
      .post(`/api/relations?workspace_id=${workspaceId}`)
      .send({ subject_id: personId });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("required");
  });

  it("rejects an endpoint that is not in the workspace", async () => {
    const res = await request(app)
      .post(`/api/relations?workspace_id=${workspaceId}`)
      .send({
        subject_id: personId,
        predicate: "works_for",
        object_id: randomUUID(),
      });
    expect(res.status).toBe(400);
  });

  it("creates a relation between two objects in the workspace", async () => {
    const res = await request(app)
      .post(`/api/relations?workspace_id=${workspaceId}`)
      .send({
        subject_id: personId,
        predicate: "works_for",
        object_id: companyId,
        attributes: { since: 2021 },
      });
    expect(res.status).toBe(200);
    relationId = res.body.relation.id;
    expect(relationId).toBeTruthy();
    expect(res.body.relation.predicate).toBe("works_for");
    expect(res.body.relation.attributes).toEqual({ since: 2021 });
  });

  it("lists relations with a total count", async () => {
    const res = await request(app).get(
      `/api/relations?workspace_id=${workspaceId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.relations[0].id).toBe(relationId);
  });

  it("filters by subject, object, and predicate", async () => {
    const hit = await request(app).get(
      `/api/relations?workspace_id=${workspaceId}&subject_id=${personId}&object_id=${companyId}&predicate=works_for`,
    );
    expect(hit.status).toBe(200);
    expect(hit.body.total).toBe(1);

    const miss = await request(app).get(
      `/api/relations?workspace_id=${workspaceId}&predicate=owns`,
    );
    expect(miss.status).toBe(200);
    expect(miss.body.total).toBe(0);
  });

  it("surfaces database errors as 400", async () => {
    // Not a UUID — the real database rejects it and the route reports it.
    const res = await request(app)
      .patch(`/api/relations/not-a-uuid?workspace_id=${workspaceId}`)
      .send({ predicate: "owns" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("requires at least one updatable field", async () => {
    const res = await request(app)
      .patch(`/api/relations/${relationId}?workspace_id=${workspaceId}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("updates the predicate", async () => {
    const res = await request(app)
      .patch(`/api/relations/${relationId}?workspace_id=${workspaceId}`)
      .send({ predicate: "employed_by" });
    expect(res.status).toBe(200);
    expect(res.body.relation.predicate).toBe("employed_by");

    const listed = await request(app).get(
      `/api/relations?workspace_id=${workspaceId}&predicate=employed_by`,
    );
    expect(listed.body.total).toBe(1);
  });

  it("requires a predicate on relation type create", async () => {
    const res = await request(app)
      .post(`/api/relation-types?workspace_id=${workspaceId}`)
      .send({ label: "Works For" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("predicate");
  });

  it("creates and relabels a relation type", async () => {
    const created = await request(app)
      .post(`/api/relation-types?workspace_id=${workspaceId}`)
      .send({ predicate: "employed_by", label: "Employed By" });
    expect(created.status).toBe(200);
    relationTypeId = created.body.relation_type.id;
    expect(created.body.relation_type.label).toBe("Employed By");

    // Upsert on (workspace_id, predicate): same predicate relabels in place.
    const relabeled = await request(app)
      .post(`/api/relation-types?workspace_id=${workspaceId}`)
      .send({ predicate: "employed_by", label: "Employer" });
    expect(relabeled.status).toBe(200);
    expect(relabeled.body.relation_type.id).toBe(relationTypeId);
    expect(relabeled.body.relation_type.label).toBe("Employer");
  });

  it("lists the workspace's predicates", async () => {
    const res = await request(app).get(
      `/api/relation-types?workspace_id=${workspaceId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.relation_types).toHaveLength(1);
    expect(res.body.relation_types[0].predicate).toBe("employed_by");
  });

  it("deletes a relation type", async () => {
    const res = await request(app).delete(
      `/api/relation-types/${relationTypeId}?workspace_id=${workspaceId}`,
    );
    expect(res.status).toBe(200);

    const listed = await request(app).get(
      `/api/relation-types?workspace_id=${workspaceId}`,
    );
    expect(listed.body.relation_types).toHaveLength(0);
  });

  it("deletes a relation", async () => {
    const res = await request(app).delete(
      `/api/relations/${relationId}?workspace_id=${workspaceId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const listed = await request(app).get(
      `/api/relations?workspace_id=${workspaceId}`,
    );
    expect(listed.body.total).toBe(0);
  });
});
