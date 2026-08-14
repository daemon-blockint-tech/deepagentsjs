import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./supabase.js", () => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock("./fault-tolerance.js", () => ({
  withRetry: (fn: (...a: unknown[]) => Promise<unknown>) => fn,
  isTransientError: () => false,
}));

import { queryRelationsTool } from "./relations-tool.js";
import { getSupabaseClient } from "./supabase.js";
import * as auth from "./auth.js";

const WS = "550e8400-e29b-41d4-a716-446655440000";
const HELIOS = "11111111-1111-4111-8111-111111111111";
const AMARA = "22222222-2222-4222-8222-222222222222";
const LENA = "33333333-3333-4333-8333-333333333333";

/**
 * Supabase stub driven by a per-table queue: each `.from(table)` consumes
 * the next queued result, so the tool's two relation queries (outgoing then
 * incoming) can return different rows.
 */
function makeSupabaseMock(
  queues: Record<string, { data: unknown; error: unknown }[]>,
) {
  const calls: { table: string; methods: [string, unknown[]][] }[] = [];

  const from = vi.fn((table: string) => {
    const result = queues[table]?.shift() ?? { data: [], error: null };
    const record: { table: string; methods: [string, unknown[]][] } = {
      table,
      methods: [],
    };
    calls.push(record);

    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) =>
              Promise.resolve(result).then(resolve);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve(result);
          }
          return (...args: unknown[]) => {
            record.methods.push([prop as string, args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  });

  vi.mocked(getSupabaseClient).mockReturnValue({
    from,
  } as unknown as ReturnType<typeof getSupabaseClient>);
  return { calls };
}

/** Membership lookup succeeds; relation/object queues follow. */
function withMembership(
  queues: Record<string, { data: unknown; error: unknown }[]>,
) {
  return makeSupabaseMock({
    workspace_members: [{ data: { user_id: "user-1" }, error: null }],
    ...queues,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.setCurrentUserId("user-1");
});

describe("query_relations", () => {
  it("denies callers who are not workspace members", async () => {
    makeSupabaseMock({ workspace_members: [{ data: null, error: null }] });

    await expect(
      queryRelationsTool.invoke({ workspace_id: WS, object_id: HELIOS }),
    ).rejects.toThrow(/Workspace access denied/);
  });

  it("labels direction from the caller's object and resolves the far end", async () => {
    withMembership({
      ontology_relations: [
        // outgoing: none — an account is the object end of works_for
        { data: [], error: null },
        // incoming: two people work for it
        {
          data: [
            {
              id: "rel-1",
              subject_id: AMARA,
              predicate: "works_for",
              object_id: HELIOS,
              attributes: {},
            },
            {
              id: "rel-2",
              subject_id: LENA,
              predicate: "works_for",
              object_id: HELIOS,
              attributes: {},
            },
          ],
          error: null,
        },
      ],
      ontology_objects: [
        {
          data: [
            {
              id: AMARA,
              display_name: "Amara Osei",
              object_type: "person",
              external_id: "person-amara",
            },
            {
              id: LENA,
              display_name: "Lena Vogt",
              object_type: "person",
              external_id: "person-lena",
            },
          ],
          error: null,
        },
      ],
    });

    const edges = JSON.parse(
      (await queryRelationsTool.invoke({
        workspace_id: WS,
        object_id: HELIOS,
      })) as string,
    );

    expect(edges).toHaveLength(2);
    expect(edges[0].direction).toBe("incoming");
    expect(edges[0].predicate).toBe("works_for");
    expect(edges[0].neighbor.display_name).toBe("Amara Osei");
    expect(edges[0].neighbor.object_type).toBe("person");
    expect(edges[1].neighbor.display_name).toBe("Lena Vogt");
  });

  it("reports the same edge as outgoing when traversing from the subject", async () => {
    withMembership({
      ontology_relations: [
        {
          data: [
            {
              id: "rel-1",
              subject_id: AMARA,
              predicate: "works_for",
              object_id: HELIOS,
              attributes: { since: 2021 },
            },
          ],
          error: null,
        },
        { data: [], error: null },
      ],
      ontology_objects: [
        {
          data: [
            {
              id: HELIOS,
              display_name: "Helios Energy",
              object_type: "account",
              external_id: "acct-helios",
            },
          ],
          error: null,
        },
      ],
    });

    const edges = JSON.parse(
      (await queryRelationsTool.invoke({
        workspace_id: WS,
        object_id: AMARA,
      })) as string,
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].direction).toBe("outgoing");
    expect(edges[0].neighbor.display_name).toBe("Helios Energy");
    expect(edges[0].attributes).toEqual({ since: 2021 });
  });

  it("skips the neighbour lookup when there are no edges", async () => {
    const { calls } = withMembership({
      ontology_relations: [
        { data: [], error: null },
        { data: [], error: null },
      ],
    });

    const edges = JSON.parse(
      (await queryRelationsTool.invoke({
        workspace_id: WS,
        object_id: HELIOS,
      })) as string,
    );

    expect(edges).toEqual([]);
    expect(calls.some((c) => c.table === "ontology_objects")).toBe(false);
  });

  it("queries only one side when direction is constrained", async () => {
    const { calls } = withMembership({
      ontology_relations: [{ data: [], error: null }],
    });

    await queryRelationsTool.invoke({
      workspace_id: WS,
      object_id: HELIOS,
      direction: "outgoing",
    });

    const relationCalls = calls.filter((c) => c.table === "ontology_relations");
    expect(relationCalls).toHaveLength(1);
    expect(relationCalls[0].methods).toContainEqual([
      "eq",
      ["subject_id", HELIOS],
    ]);
  });

  it("passes the predicate filter through to the query", async () => {
    const { calls } = withMembership({
      ontology_relations: [
        { data: [], error: null },
        { data: [], error: null },
      ],
    });

    await queryRelationsTool.invoke({
      workspace_id: WS,
      object_id: HELIOS,
      predicate: "works_for",
    });

    const relationCalls = calls.filter((c) => c.table === "ontology_relations");
    for (const call of relationCalls) {
      expect(call.methods).toContainEqual(["eq", ["predicate", "works_for"]]);
    }
  });

  it("surfaces a database error rather than returning partial edges", async () => {
    withMembership({
      ontology_relations: [{ data: null, error: { message: "boom" } }],
    });

    await expect(
      queryRelationsTool.invoke({
        workspace_id: WS,
        object_id: HELIOS,
        direction: "outgoing",
      }),
    ).rejects.toThrow(/boom/);
  });
});
