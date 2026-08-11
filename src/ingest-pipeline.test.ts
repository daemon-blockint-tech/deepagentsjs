import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

// Mock supabase client so we never hit a real backend.
vi.mock("./supabase.js", () => ({
  getSupabaseClient: vi.fn(),
}));

// Mock fault-tolerance so withRetry is pass-through (no real sleeps).
vi.mock("./fault-tolerance.js", () => ({
  withRetry: (fn: (...a: unknown[]) => Promise<unknown>) => fn,
  isTransientError: () => false,
}));

// Mock source-validation so URL fetches are controlled without network.
vi.mock("./source-validation.js", () => ({
  safeFetch: vi.fn(),
  assertSafeLocalPath: vi.fn(async (p: string) => p),
}));

// Mock embeddings so tests don't call the real OpenRouter API.
vi.mock("./embeddings.js", () => ({
  embedText: vi.fn(async (text: string) => {
    // Return a deterministic 1536-dim vector based on the text hash.
    const embedding = new Array(1536).fill(0);
    for (let i = 0; i < text.length; i++) {
      embedding[i % 1536] += text.charCodeAt(i) / 1000;
    }
    return embedding;
  }),
}));

import {
  CsvConnector,
  JsonApiConnector,
  runIngestJob,
  type IngestConnector,
} from "./ingest-pipeline.js";
import { getSupabaseClient } from "./supabase.js";
import { safeFetch } from "./source-validation.js";
import { embedText } from "./embeddings.js";

// ---------------------------------------------------------------------------
// Mock supabase client: a single chainable object per table, with shared
// spies. The terminal value is controlled by a per-call resolver so different
// rows can get different results (e.g. first row succeeds, second fails).
// ---------------------------------------------------------------------------

type ChainResult = { data: unknown; error: unknown };

/**
 * A spy wrapper that records calls and delegates to a per-chain implementation.
 * Each .from() call creates a fresh chain with its own spy wrappers, but all
 * spy wrappers for the same table+method push into a shared calls array.
 */
interface AggregatedSpy {
  calls: unknown[][];
  mock: { calls: unknown[][] };
}

/**
 * Build a supabase mock where `.from(table)` returns a chain whose terminal
 * resolves to a value determined by `resolveResult()`. Each .from() call
 * gets its own chain (so methods return the correct chain), but call
 * recordings are aggregated per table+method across all .from() calls.
 */
function makeSupabaseMock(
  tables: Record<
    string,
    {
      resolveResult: () => ChainResult;
      /** Optional resolver for .maybeSingle() calls; defaults to "no row". */
      resolveMaybeSingle?: () => ChainResult;
    }
  >,
) {
  // Aggregated call recordings: spies[table][method] = { calls: [], mock: { calls } }
  const spies: Record<string, Record<string, AggregatedSpy>> = {};
  for (const table of Object.keys(tables)) {
    spies[table] = {};
    for (const m of [
      "insert",
      "update",
      "upsert",
      "delete",
      "select",
      "eq",
      "notIn",
      "single",
      "maybeSingle",
    ]) {
      const calls: unknown[][] = [];
      spies[table][m] = { calls, mock: { calls } };
    }
  }

  const from = vi.fn((table: string) => {
    const config = tables[table];
    if (!config) throw new Error(`Unexpected supabase table: ${table}`);

    // Build a chainable where every method returns the chain itself,
    // except `single()` / `maybeSingle()` and the awaited chain which
    // resolve to the result.
    const chain: Record<string, (...a: unknown[]) => unknown> = {};

    const makeMethod = (methodName: string) => {
      const agg = spies[table][methodName];
      return (...args: unknown[]) => {
        agg.calls.push(args);
        if (methodName === "single") {
          return Promise.resolve(config.resolveResult());
        }
        if (methodName === "maybeSingle") {
          return Promise.resolve(
            config.resolveMaybeSingle
              ? config.resolveMaybeSingle()
              : { data: null, error: null },
          );
        }
        return chain;
      };
    };

    chain.insert = makeMethod("insert");
    chain.update = makeMethod("update");
    chain.upsert = makeMethod("upsert");
    chain.delete = makeMethod("delete");
    chain.select = makeMethod("select");
    chain.eq = makeMethod("eq");
    chain.notIn = makeMethod("notIn");
    chain.single = makeMethod("single");
    chain.maybeSingle = makeMethod("maybeSingle");

    // Make the chain itself thenable (for queries without .single())
    const thenable = new Proxy(chain, {
      get(target, prop, receiver) {
        if (prop === "then") {
          return (
            resolve: (v: ChainResult) => unknown,
            reject?: (e: unknown) => unknown,
          ) => Promise.resolve(config.resolveResult()).then(resolve, reject);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return thenable;
  });

  return { from, spies };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// runIngestJob — action lifecycle
// ---------------------------------------------------------------------------

describe("runIngestJob action lifecycle", () => {
  const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

  it("inserts action as 'running' and marks 'completed' on success", async () => {
    const mock = makeSupabaseMock({
      actions: {
        resolveResult: () => ({ data: { id: "action-1" }, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const successConnector: IngestConnector = {
      name: "test",
      ingest: async () => ({ ingested: 3, errors: [] }),
    };

    const result = await runIngestJob(WORKSPACE_ID, [successConnector]);

    expect(result.ingested).toBe(3);
    const actionsSpies = mock.spies.actions;
    expect(actionsSpies.insert.mock.calls).toHaveLength(1);
    const inserted = actionsSpies.insert.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(inserted.status).toBe("running");
    expect(inserted.type).toBe("ingest");
    expect(inserted.workspace_id).toBe(WORKSPACE_ID);
    expect(actionsSpies.update.mock.calls).toHaveLength(1);
    const updated = actionsSpies.update.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(updated.status).toBe("completed");
  });

  it("marks action 'failed' (via success path) when a connector throws and 0 rows ingested", async () => {
    // ingestPipeline catches connector errors internally and returns them
    // in result.errors. runIngestJob then sets status "failed" because
    // ingested === 0 && errors.length > 0. The error is NOT rethrown.
    const mock = makeSupabaseMock({
      actions: {
        resolveResult: () => ({ data: { id: "action-2" }, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const failingConnector: IngestConnector = {
      name: "boom",
      ingest: async () => {
        throw new Error("pipeline exploded");
      },
    };

    const result = await runIngestJob(WORKSPACE_ID, [failingConnector]);
    expect(result.ingested).toBe(0);
    expect(result.errors).toEqual(["[boom] pipeline exploded"]);

    const actionsSpies = mock.spies.actions;
    expect(actionsSpies.update.mock.calls).toHaveLength(1);
    const updated = actionsSpies.update.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(updated.status).toBe("failed");
    const payload = updated.payload as Record<string, unknown>;
    expect(payload.errors).toEqual(["[boom] pipeline exploded"]);
  });

  it("marks action 'failed' and rethrows when ingestPipeline itself throws", async () => {
    // If ingestPipeline throws (not a connector error, which it catches
    // internally), runIngestJob's catch block marks the action failed and
    // rethrows. We trigger this by making the connector's ingest() throw
    // an object whose message/toString access throws — that escapes
    // ingestPipeline's catch (which calls getErrorMessage on the error).
    const mock = makeSupabaseMock({
      actions: {
        resolveResult: () => ({ data: { id: "action-3" }, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const explodingError = {
      get message(): string {
        throw new Error("unexpected pipeline error");
      },
    };
    const explodingConnector: IngestConnector = {
      name: "boom",
      ingest: async () => {
        throw explodingError;
      },
    };

    await expect(
      runIngestJob(WORKSPACE_ID, [explodingConnector]),
    ).rejects.toThrow("unexpected pipeline error");

    const actionsSpies = mock.spies.actions;
    expect(actionsSpies.update.mock.calls).toHaveLength(1);
    const updated = actionsSpies.update.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(updated.status).toBe("failed");
    const payload = updated.payload as Record<string, unknown>;
    expect(payload.error).toBe("unexpected pipeline error");
  });

  it("marks action 'failed' when all rows error and ingested is 0", async () => {
    const mock = makeSupabaseMock({
      actions: {
        resolveResult: () => ({ data: { id: "action-4" }, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const allErrorsConnector: IngestConnector = {
      name: "errs",
      ingest: async () => ({ ingested: 0, errors: ["row 1: bad"] }),
    };

    const result = await runIngestJob(WORKSPACE_ID, [allErrorsConnector]);
    expect(result.ingested).toBe(0);
    const actionsSpies = mock.spies.actions;
    expect(actionsSpies.update.mock.calls).toHaveLength(1);
    const updated = actionsSpies.update.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(updated.status).toBe("failed");
  });

  it("marks action 'completed' when some rows succeed despite errors", async () => {
    const mock = makeSupabaseMock({
      actions: {
        resolveResult: () => ({ data: { id: "action-5" }, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const partialConnector: IngestConnector = {
      name: "partial",
      ingest: async () => ({ ingested: 2, errors: ["row 3: bad"] }),
    };

    const result = await runIngestJob(WORKSPACE_ID, [partialConnector]);
    expect(result.ingested).toBe(2);
    const actionsSpies = mock.spies.actions;
    const updated = actionsSpies.update.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(updated.status).toBe("completed");
  });

  it("throws when the initial action insert fails", async () => {
    const mock = makeSupabaseMock({
      actions: {
        resolveResult: () => ({
          data: null,
          error: { message: "insert rejected" },
        }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    await expect(
      runIngestJob(WORKSPACE_ID, [
        { name: "x", ingest: async () => ({ ingested: 0, errors: [] }) },
      ]),
    ).rejects.toThrow("insert rejected");
  });
});

// ---------------------------------------------------------------------------
// CsvConnector — local file + URL branches
// ---------------------------------------------------------------------------

describe("CsvConnector", () => {
  let tempDir: string;
  let ingestDir: string;
  let oldEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ingest-csv-"));
    ingestDir = join(tempDir, "ingest");
    await mkdir(ingestDir, { recursive: true });
    oldEnv = process.env.INGEST_DATA_DIR;
    process.env.INGEST_DATA_DIR = ingestDir;
  });

  afterEach(async () => {
    process.env.INGEST_DATA_DIR = oldEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads a local CSV file and ingests rows as ontology objects", async () => {
    const csvPath = join(ingestDir, "data.csv");
    await writeFile(csvPath, "name,age\nAlice,30\nBob,25\n");

    let objCallCount = 0;
    const mock = makeSupabaseMock({
      ontology_objects: {
        resolveResult: () => {
          objCallCount++;
          return { data: { id: `obj-${objCallCount}` }, error: null };
        },
      },
      ontology_properties: {
        resolveResult: () => ({ data: null, error: null }),
      },
      ontology_chunks: {
        resolveResult: () => ({ data: null, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const connector = new CsvConnector({
      source: csvPath,
      objectType: "person",
      externalIdColumn: "name",
      skipEmbeddings: true,
    });
    const result = await connector.ingest("ws-1");

    expect(result.ingested).toBe(2);
    expect(result.errors).toEqual([]);
    // upsert called once per row
    expect(mock.spies.ontology_objects.upsert.mock.calls).toHaveLength(2);
    const firstUpsert = mock.spies.ontology_objects.upsert.mock
      .calls[0][0] as Record<string, unknown>;
    expect(firstUpsert.external_id).toBe("Alice");
    expect(firstUpsert.object_type).toBe("person");
    const attrs = firstUpsert.attributes as Record<string, unknown>;
    expect(attrs.age).toBe(30); // number coercion
    expect(attrs.name).toBe("Alice");
  });

  it("fetches a remote CSV via safeFetch when source is an http URL", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      new Response("name,age\nCarol,40\n", { status: 200 }),
    );

    const mock = makeSupabaseMock({
      ontology_objects: {
        resolveResult: () => ({ data: { id: "obj-1" }, error: null }),
      },
      ontology_properties: {
        resolveResult: () => ({ data: null, error: null }),
      },
      ontology_chunks: {
        resolveResult: () => ({ data: null, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const connector = new CsvConnector({
      source: "https://example.com/data.csv",
      objectType: "person",
      skipEmbeddings: true,
    });
    const result = await connector.ingest("ws-1");

    expect(result.ingested).toBe(1);
    expect(safeFetch).toHaveBeenCalledWith("https://example.com/data.csv");
  });

  it("records per-row errors without aborting the whole ingest", async () => {
    const csvPath = join(ingestDir, "errs.csv");
    await writeFile(csvPath, "name,age\nAlice,30\nBob,25\n");

    let objCallCount = 0;
    const mock = makeSupabaseMock({
      ontology_objects: {
        resolveResult: () => {
          objCallCount++;
          if (objCallCount === 1) {
            return { data: { id: "obj-1" }, error: null };
          }
          return { data: null, error: { message: "constraint violation" } };
        },
      },
      ontology_properties: {
        resolveResult: () => ({ data: null, error: null }),
      },
      ontology_chunks: {
        resolveResult: () => ({ data: null, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const connector = new CsvConnector({
      source: csvPath,
      objectType: "person",
      externalIdColumn: "name",
      skipEmbeddings: true,
    });
    const result = await connector.ingest("ws-1");

    expect(result.ingested).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Row 2:.*constraint violation/);
  });
});

// ---------------------------------------------------------------------------
// JsonApiConnector — URL fetch + items/data/array shapes
// ---------------------------------------------------------------------------

describe("JsonApiConnector", () => {
  it("ingests items from a bare JSON array", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      new Response(JSON.stringify([{ id: "a", name: "Alpha" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const mock = makeSupabaseMock({
      ontology_objects: {
        resolveResult: () => ({ data: { id: "obj-1" }, error: null }),
      },
      ontology_properties: {
        resolveResult: () => ({ data: null, error: null }),
      },
      ontology_chunks: {
        resolveResult: () => ({ data: null, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const connector = new JsonApiConnector({
      url: "https://api.example.com/items",
      objectType: "thing",
      externalIdField: "id",
      skipEmbeddings: true,
    });
    const result = await connector.ingest("ws-1");

    expect(result.ingested).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("ingests items from { data: [...] } shape", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "x", title: "Test" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const mock = makeSupabaseMock({
      ontology_objects: {
        resolveResult: () => ({ data: { id: "obj-1" }, error: null }),
      },
      ontology_properties: {
        resolveResult: () => ({ data: null, error: null }),
      },
      ontology_chunks: {
        resolveResult: () => ({ data: null, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const connector = new JsonApiConnector({
      url: "https://api.example.com/data",
      objectType: "thing",
      externalIdField: "id",
      skipEmbeddings: true,
    });
    const result = await connector.ingest("ws-1");

    expect(result.ingested).toBe(1);
  });

  it("throws when JSON response has no array", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      new Response(JSON.stringify({ not_an_array: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const mock = makeSupabaseMock({
      ontology_objects: {
        resolveResult: () => ({ data: { id: "obj-1" }, error: null }),
      },
      ontology_properties: {
        resolveResult: () => ({ data: null, error: null }),
      },
      ontology_chunks: {
        resolveResult: () => ({ data: null, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const connector = new JsonApiConnector({
      url: "https://api.example.com/bad",
      objectType: "thing",
      skipEmbeddings: true,
    });
    await expect(connector.ingest("ws-1")).rejects.toThrow(/not an array/);
  });

  it("throws on non-2xx response", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      new Response("not found", { status: 404, statusText: "Not Found" }),
    );

    const mock = makeSupabaseMock({
      ontology_objects: {
        resolveResult: () => ({ data: { id: "obj-1" }, error: null }),
      },
      ontology_properties: {
        resolveResult: () => ({ data: null, error: null }),
      },
      ontology_chunks: {
        resolveResult: () => ({ data: null, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const connector = new JsonApiConnector({
      url: "https://api.example.com/missing",
      objectType: "thing",
      skipEmbeddings: true,
    });
    await expect(connector.ingest("ws-1")).rejects.toThrow(/404/);
  });
});

// ---------------------------------------------------------------------------
// insertOntologyObject stale-property cleanup (B2)
// ---------------------------------------------------------------------------

describe("insertOntologyObject stale-property cleanup", () => {
  const WORKSPACE_ID = "ws-stale";

  it("deletes ontology_properties not present in the current attributes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ingest-stale-"));
    const ingestDir = join(tempDir, "ingest");
    await mkdir(ingestDir, { recursive: true });
    const oldEnv = process.env.INGEST_DATA_DIR;
    process.env.INGEST_DATA_DIR = ingestDir;

    try {
      const csvPath = join(ingestDir, "data.csv");
      await writeFile(csvPath, "name,age\nAlice,30\n");

      const mock = makeSupabaseMock({
        ontology_objects: {
          resolveResult: () => ({ data: { id: "obj-1" }, error: null }),
        },
        ontology_properties: {
          resolveResult: () => ({ data: null, error: null }),
        },
        ontology_chunks: {
          resolveResult: () => ({ data: null, error: null }),
        },
      });
      vi.mocked(getSupabaseClient).mockReturnValue(
        mock as unknown as ReturnType<typeof getSupabaseClient>,
      );

      const connector = new CsvConnector({
        source: csvPath,
        objectType: "person",
        externalIdColumn: "name",
        skipEmbeddings: true,
      });
      await connector.ingest(WORKSPACE_ID);

      const propsSpies = mock.spies.ontology_properties;
      // delete called on ontology_properties
      expect(propsSpies.delete.mock.calls).toHaveLength(1);
      // eq("object_id", "obj-1") on the delete chain
      expect(
        propsSpies.eq.mock.calls.some(
          (c) => c[0] === "object_id" && c[1] === "obj-1",
        ),
      ).toBe(true);
      // notIn("key", ["name", "age"]) — the current keys
      expect(propsSpies.notIn.mock.calls).toHaveLength(1);
      const notInArgs = propsSpies.notIn.mock.calls[0];
      expect(notInArgs[0]).toBe("key");
      expect(notInArgs[1]).toEqual(expect.arrayContaining(["name", "age"]));
    } finally {
      process.env.INGEST_DATA_DIR = oldEnv;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("deletes all properties (no notIn filter) when current attributes has no valid keys", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ingest-empty-"));
    const ingestDir = join(tempDir, "ingest");
    await mkdir(ingestDir, { recursive: true });
    const oldEnv = process.env.INGEST_DATA_DIR;
    process.env.INGEST_DATA_DIR = ingestDir;

    try {
      const csvPath = join(ingestDir, "data.csv");
      // All columns either start with "_" or have empty values.
      // "_internal" starts with "_" → skipped.
      // "empty" has value "" → not null/undefined, so it IS included.
      // To get zero current keys, we need all values to be null/undefined
      // or all keys to start with "_". A CSV with only "_"-prefixed columns:
      await writeFile(csvPath, "_a,_b\nfoo,bar\n");

      const mock = makeSupabaseMock({
        ontology_objects: {
          resolveResult: () => ({ data: { id: "obj-1" }, error: null }),
        },
        ontology_properties: {
          resolveResult: () => ({ data: null, error: null }),
        },
        ontology_chunks: {
          resolveResult: () => ({ data: null, error: null }),
        },
      });
      vi.mocked(getSupabaseClient).mockReturnValue(
        mock as unknown as ReturnType<typeof getSupabaseClient>,
      );

      const connector = new CsvConnector({
        source: csvPath,
        objectType: "person",
        skipEmbeddings: true,
      });
      await connector.ingest(WORKSPACE_ID);

      const propsSpies = mock.spies.ontology_properties;
      expect(propsSpies.delete.mock.calls).toHaveLength(1);
      expect(
        propsSpies.eq.mock.calls.some(
          (c) => c[0] === "object_id" && c[1] === "obj-1",
        ),
      ).toBe(true);
      // No notIn filter since currentKeys is empty → delete all for this object
      expect(propsSpies.notIn.mock.calls).toHaveLength(0);
    } finally {
      process.env.INGEST_DATA_DIR = oldEnv;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// insertOntologyObject object_type mismatch guard (N2)
// ---------------------------------------------------------------------------

describe("insertOntologyObject object_type mismatch guard", () => {
  const WORKSPACE_ID = "ws-type-guard";

  it("throws when re-ingesting an external_id with a different object_type", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ingest-typeguard-"));
    const ingestDir = join(tempDir, "ingest");
    await mkdir(ingestDir, { recursive: true });
    const oldEnv = process.env.INGEST_DATA_DIR;
    process.env.INGEST_DATA_DIR = ingestDir;

    try {
      const csvPath = join(ingestDir, "data.csv");
      await writeFile(csvPath, "name,age\nAlice,30\n");

      const mock = makeSupabaseMock({
        ontology_objects: {
          // Pre-check finds an existing object with a different object_type.
          resolveMaybeSingle: () => ({
            data: { id: "obj-existing", object_type: "company" },
            error: null,
          }),
          resolveResult: () => ({ data: { id: "obj-1" }, error: null }),
        },
        ontology_properties: {
          resolveResult: () => ({ data: null, error: null }),
        },
        ontology_chunks: {
          resolveResult: () => ({ data: null, error: null }),
        },
      });
      vi.mocked(getSupabaseClient).mockReturnValue(
        mock as unknown as ReturnType<typeof getSupabaseClient>,
      );

      const connector = new CsvConnector({
        source: csvPath,
        objectType: "person", // different from existing "company"
        externalIdColumn: "name",
        skipEmbeddings: true,
      });
      const result = await connector.ingest(WORKSPACE_ID);

      // The per-row error is caught by CsvConnector and reported in
      // result.errors (not rethrown), with 0 rows ingested.
      expect(result.ingested).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(
        /already exists.*object_type "company".*cannot re-ingest as "person"/,
      );

      // Upsert must NOT have been called — the guard rejected before it.
      expect(mock.spies.ontology_objects.upsert.mock.calls).toHaveLength(0);
    } finally {
      process.env.INGEST_DATA_DIR = oldEnv;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("proceeds with upsert when existing object has the same object_type", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ingest-sametype-"));
    const ingestDir = join(tempDir, "ingest");
    await mkdir(ingestDir, { recursive: true });
    const oldEnv = process.env.INGEST_DATA_DIR;
    process.env.INGEST_DATA_DIR = ingestDir;

    try {
      const csvPath = join(ingestDir, "data.csv");
      await writeFile(csvPath, "name,age\nAlice,30\n");

      const mock = makeSupabaseMock({
        ontology_objects: {
          // Pre-check finds an existing object with the SAME object_type.
          resolveMaybeSingle: () => ({
            data: { id: "obj-existing", object_type: "person" },
            error: null,
          }),
          resolveResult: () => ({ data: { id: "obj-1" }, error: null }),
        },
        ontology_properties: {
          resolveResult: () => ({ data: null, error: null }),
        },
        ontology_chunks: {
          resolveResult: () => ({ data: null, error: null }),
        },
      });
      vi.mocked(getSupabaseClient).mockReturnValue(
        mock as unknown as ReturnType<typeof getSupabaseClient>,
      );

      const connector = new CsvConnector({
        source: csvPath,
        objectType: "person",
        externalIdColumn: "name",
        skipEmbeddings: true,
      });
      const result = await connector.ingest(WORKSPACE_ID);

      expect(result.ingested).toBe(1);
      // Upsert WAS called — same type is allowed (idempotent re-ingest).
      expect(mock.spies.ontology_objects.upsert.mock.calls).toHaveLength(1);
    } finally {
      process.env.INGEST_DATA_DIR = oldEnv;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Embedding generation on ingest
// ---------------------------------------------------------------------------

describe("Embedding generation on ingest", () => {
  let tempDir: string;
  let ingestDir: string;
  let oldEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ingest-embed-"));
    ingestDir = join(tempDir, "ingest");
    await mkdir(ingestDir, { recursive: true });
    oldEnv = process.env.INGEST_DATA_DIR;
    process.env.INGEST_DATA_DIR = ingestDir;
  });

  afterEach(async () => {
    process.env.INGEST_DATA_DIR = oldEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("generates an embedding and upserts into ontology_chunks on ingest", async () => {
    const csvPath = join(ingestDir, "data.csv");
    await writeFile(csvPath, "name,age\nAlice,30\n");

    const mock = makeSupabaseMock({
      ontology_objects: {
        resolveResult: () => ({ data: { id: "obj-1" }, error: null }),
      },
      ontology_properties: {
        resolveResult: () => ({ data: null, error: null }),
      },
      ontology_chunks: {
        resolveResult: () => ({ data: null, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const connector = new CsvConnector({
      source: csvPath,
      objectType: "person",
      externalIdColumn: "name",
      // skipEmbeddings defaults to false — embeddings should be generated
    });
    const result = await connector.ingest("ws-1");

    expect(result.ingested).toBe(1);
    expect(result.errors).toEqual([]);

    // embedText was called with display_name + JSON of attributes
    expect(embedText).toHaveBeenCalledTimes(1);
    const embeddedText = vi.mocked(embedText).mock.calls[0][0];
    expect(embeddedText).toContain("Alice");
    expect(embeddedText).toContain("age");

    // ontology_chunks upsert was called with the correct fields
    expect(mock.spies.ontology_chunks.upsert.mock.calls).toHaveLength(1);
    const chunkUpsert = mock.spies.ontology_chunks.upsert.mock
      .calls[0][0] as Record<string, unknown>;
    expect(chunkUpsert.object_id).toBe("obj-1");
    expect(chunkUpsert.workspace_id).toBe("ws-1");
    expect(chunkUpsert.content).toBe(embeddedText);
    expect(chunkUpsert.embedding).toBeTypeOf("string"); // JSON string of the vector
  });

  it("records a soft error when embedding fails but still counts the object as ingested", async () => {
    const csvPath = join(ingestDir, "data.csv");
    await writeFile(csvPath, "name,age\nAlice,30\n");

    // Make embedText throw
    vi.mocked(embedText).mockRejectedValueOnce(new Error("API rate limited"));

    const mock = makeSupabaseMock({
      ontology_objects: {
        resolveResult: () => ({ data: { id: "obj-1" }, error: null }),
      },
      ontology_properties: {
        resolveResult: () => ({ data: null, error: null }),
      },
      ontology_chunks: {
        resolveResult: () => ({ data: null, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const connector = new CsvConnector({
      source: csvPath,
      objectType: "person",
      externalIdColumn: "name",
    });
    const result = await connector.ingest("ws-1");

    // Object was ingested despite embedding failure
    expect(result.ingested).toBe(1);
    // Error is recorded so the operator knows
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Embedding failed.*API rate limited/);
  });

  it("skips embedding entirely when skipEmbeddings is true", async () => {
    const csvPath = join(ingestDir, "data.csv");
    await writeFile(csvPath, "name,age\nAlice,30\n");

    const mock = makeSupabaseMock({
      ontology_objects: {
        resolveResult: () => ({ data: { id: "obj-1" }, error: null }),
      },
      ontology_properties: {
        resolveResult: () => ({ data: null, error: null }),
      },
      ontology_chunks: {
        resolveResult: () => ({ data: null, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const connector = new CsvConnector({
      source: csvPath,
      objectType: "person",
      externalIdColumn: "name",
      skipEmbeddings: true,
    });
    const result = await connector.ingest("ws-1");

    expect(result.ingested).toBe(1);
    expect(result.errors).toEqual([]);

    // embedText was NOT called
    expect(embedText).not.toHaveBeenCalled();
    // ontology_chunks upsert was NOT called
    expect(mock.spies.ontology_chunks.upsert.mock.calls).toHaveLength(0);
  });

  it("uses correct object_id and workspace_id in the chunk upsert", async () => {
    const csvPath = join(ingestDir, "data.csv");
    await writeFile(csvPath, "name,age\nBob,25\n");

    const mock = makeSupabaseMock({
      ontology_objects: {
        resolveResult: () => ({ data: { id: "obj-bob" }, error: null }),
      },
      ontology_properties: {
        resolveResult: () => ({ data: null, error: null }),
      },
      ontology_chunks: {
        resolveResult: () => ({ data: null, error: null }),
      },
    });
    vi.mocked(getSupabaseClient).mockReturnValue(
      mock as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const connector = new CsvConnector({
      source: csvPath,
      objectType: "person",
      externalIdColumn: "name",
    });
    await connector.ingest("ws-bob-test");

    const chunkUpsert = mock.spies.ontology_chunks.upsert.mock
      .calls[0][0] as Record<string, unknown>;
    expect(chunkUpsert.object_id).toBe("obj-bob");
    expect(chunkUpsert.workspace_id).toBe("ws-bob-test");
  });
});
