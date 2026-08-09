import { describe, it, expect, vi, beforeEach } from "vitest";
import { queryOntologyTool, proposeActionTool } from "./tools.js";
import * as auth from "./auth.js";
import * as supabase from "./supabase.js";

vi.mock("./supabase.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supabase.js")>()),
  getSupabaseClient: vi.fn(),
}));

describe("tools.ts workspace authorization", () => {
  let fromMock: any;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  function membershipQuery(singleResult: { data: unknown; error: unknown }) {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue(singleResult),
    };
    const chain = {
      from: vi.fn((table: string) => {
        if (table === "workspace_members") return query;
        return fromMock;
      }),
    };
    vi.mocked(supabase.getSupabaseClient).mockReturnValue(chain as any);
    return { chain, query };
  }

  it("propose_action throws when no current user", async () => {
    auth.setCurrentUserId(null);
    membershipQuery({ data: null, error: null });

    await expect(
      proposeActionTool.invoke({
        workspace_id: "550e8400-e29b-41d4-a716-446655440000",
        type: "test",
        payload: {},
      })
    ).rejects.toThrow(/Unauthorized/);
  });

  it("propose_action throws when user is not workspace member", async () => {
    auth.setCurrentUserId("user-123");
    const { query } = membershipQuery({ data: null, error: { message: "not found" } });
    query.eq.mockReturnThis();

    await expect(
      proposeActionTool.invoke({
        workspace_id: "550e8400-e29b-41d4-a716-446655440000",
        type: "test",
        payload: {},
      })
    ).rejects.toThrow(/Workspace access denied/);
  });

  it("propose_action succeeds when user is workspace member", async () => {
    auth.setCurrentUserId("user-123");
    membershipQuery({ data: { id: "member-1" }, error: null });

    const insertQuery = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: "action-1" }, error: null }),
    };
    fromMock = insertQuery;

    const result = await proposeActionTool.invoke({
      workspace_id: "550e8400-e29b-41d4-a716-446655440000",
      type: "test",
      payload: {},
    });

    expect(result).toContain("action-1");
  });

  it("query_ontology throws when user is not workspace member", async () => {
    auth.setCurrentUserId("user-123");
    membershipQuery({ data: null, error: { message: "not found" } });

    await expect(
      queryOntologyTool.invoke({
        workspace_id: "550e8400-e29b-41d4-a716-446655440000",
        query: "test",
      })
    ).rejects.toThrow(/Workspace access denied/);
  });

  it("query_ontology sanitizes wildcards and limits results", async () => {
    auth.setCurrentUserId("user-123");
    membershipQuery({ data: { id: "member-1" }, error: null });

    const ilikeMock = vi.fn().mockReturnThis();
    const limitMock = vi.fn().mockResolvedValue({ data: [{ id: "obj-1" }], error: null });
    fromMock = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: ilikeMock,
      limit: limitMock,
    };

    await queryOntologyTool.invoke({
      workspace_id: "550e8400-e29b-41d4-a716-446655440000",
      query: "te%st_",
      limit: 20,
    });

    expect(ilikeMock).toHaveBeenCalledWith("display_name", "%test%");
    expect(limitMock).toHaveBeenCalledWith(20);
  });
});
