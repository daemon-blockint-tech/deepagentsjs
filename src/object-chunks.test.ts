import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./supabase.js", () => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock("./embeddings.js", () => ({
  embedText: vi.fn(async () => new Array(1536).fill(0.1)),
}));

import { buildChunkText, upsertObjectChunk } from "./object-chunks.js";
import { getSupabaseClient } from "./supabase.js";
import { embedText } from "./embeddings.js";

/** Minimal supabase stub: records the upsert call, returns a fixed result. */
function makeSupabaseMock(result: { error: unknown } = { error: null }) {
  const upsert = vi.fn(async () => result);
  const from = vi.fn(() => ({ upsert }));
  vi.mocked(getSupabaseClient).mockReturnValue({
    from,
  } as unknown as ReturnType<typeof getSupabaseClient>);
  return { from, upsert };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildChunkText", () => {
  it("puts the display name first, then the attributes as JSON", () => {
    const text = buildChunkText("Acme Corp", { status: "active", seats: 42 });
    expect(text).toBe('Acme Corp\n{"status":"active","seats":42}');
  });

  it("drops internal keys and null/undefined values", () => {
    const text = buildChunkText("Draft", {
      _temp: true,
      _created_by_agent: true,
      title: "Q3 report",
      notes: null,
      owner: undefined,
    });
    expect(text).toBe('Draft\n{"title":"Q3 report"}');
    expect(text).not.toContain("_temp");
    expect(text).not.toContain("notes");
  });

  it("handles an object with no embeddable attributes", () => {
    expect(buildChunkText("Bare", { _temp: true })).toBe("Bare\n{}");
  });
});

describe("upsertObjectChunk", () => {
  it("embeds the chunk text and upserts on (workspace_id, object_id)", async () => {
    const { from, upsert } = makeSupabaseMock();

    await upsertObjectChunk("ws-1", "obj-1", "Acme Corp", { status: "active" });

    expect(embedText).toHaveBeenCalledWith('Acme Corp\n{"status":"active"}');
    expect(from).toHaveBeenCalledWith("ontology_chunks");

    const [row, options] = upsert.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(row.workspace_id).toBe("ws-1");
    expect(row.object_id).toBe("obj-1");
    expect(row.content).toBe('Acme Corp\n{"status":"active"}');
    expect(JSON.parse(row.embedding as string)).toHaveLength(1536);
    expect(options).toEqual({ onConflict: "workspace_id, object_id" });
  });

  it("throws when the upsert fails so callers can decide what to do", async () => {
    makeSupabaseMock({ error: { message: "unique violation" } });

    await expect(
      upsertObjectChunk("ws-1", "obj-1", "Acme Corp", {}),
    ).rejects.toThrow("unique violation");
  });

  it("propagates embedding failures without touching the database", async () => {
    const { upsert } = makeSupabaseMock();
    vi.mocked(embedText).mockRejectedValueOnce(new Error("API key missing"));

    await expect(
      upsertObjectChunk("ws-1", "obj-1", "Acme Corp", {}),
    ).rejects.toThrow("API key missing");
    expect(upsert).not.toHaveBeenCalled();
  });
});
