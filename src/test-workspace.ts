import { randomUUID } from "node:crypto";
import { getSupabaseClient } from "./supabase.js";

/**
 * Integration-test harness: a throwaway workspace on the real database.
 *
 * Tests run against the live Supabase project, so isolation comes from the
 * workspace boundary — every row a test creates lives in a workspace made
 * here, and teardown deletes only rows scoped to that workspace id. Nothing
 * outside the test workspace is ever read from or written to.
 */
export async function createTestWorkspace(): Promise<string> {
  const userId = process.env.DEFAULT_USER_ID;
  if (!userId) {
    throw new Error("DEFAULT_USER_ID must be set for integration tests");
  }
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("workspaces")
    .insert({
      slug: `itest-${randomUUID()}`,
      name: "Integration test (auto-deleted)",
      owner_user_id: userId,
    })
    .select("id")
    .single();
  if (error) {
    throw new Error(`create test workspace failed: ${error.message}`);
  }

  const { error: memberError } = await supabase
    .from("workspace_members")
    .insert({ workspace_id: data.id, user_id: userId, role: "owner" });
  if (memberError) {
    await supabase.from("workspaces").delete().eq("id", data.id);
    throw new Error(`add test membership failed: ${memberError.message}`);
  }

  return data.id;
}

/** Delete everything the test workspace owns, then the workspace itself. */
export async function destroyTestWorkspace(workspaceId: string): Promise<void> {
  if (!workspaceId) return;
  const supabase = getSupabaseClient();
  const failures: string[] = [];

  // Children before parents; every delete is scoped to the test workspace.
  const tables = [
    "ontology_relations",
    "ontology_relation_types",
    "ontology_chunks",
    "ontology_properties",
    "ontology_objects",
    "workspace_members",
  ];
  for (const table of tables) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq("workspace_id", workspaceId);
    if (error) failures.push(`${table}: ${error.message}`);
  }
  const { error } = await supabase
    .from("workspaces")
    .delete()
    .eq("id", workspaceId);
  if (error) failures.push(`workspaces: ${error.message}`);

  if (failures.length > 0) {
    throw new Error(
      `test workspace ${workspaceId} not fully cleaned up — ${failures.join("; ")}`,
    );
  }
}
