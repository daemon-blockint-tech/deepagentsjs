import { embedText } from "./embeddings.js";
import { getSupabaseClient } from "./supabase.js";
import { getCurrentUserId } from "./auth.js";

async function verifyWorkspaceMembership(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string
) {
  const userId = getCurrentUserId();
  if (!userId) {
    throw new Error("Unauthorized: no current user");
  }
  const { data, error } = await supabase
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new Error("Workspace access denied");
  }
}

/**
 * Semantically search ontology chunks for a workspace using pgvector.
 * Embeds the query text via OpenRouter, then calls the match_ontology_chunks RPC.
 */
export async function semanticQueryOntology({
  workspace_id,
  query,
  limit = 10,
  threshold = 0.5,
}: {
  workspace_id: string;
  query: string;
  limit?: number;
  threshold?: number;
}): Promise<unknown[]> {
  const supabase = getSupabaseClient();
  await verifyWorkspaceMembership(supabase, workspace_id);

  const embedding = await embedText(query);
  const { data, error } = await supabase.rpc("match_ontology_chunks", {
    query_embedding: JSON.stringify(embedding),
    match_threshold: threshold,
    match_count: Math.min(Math.max(1, limit), 50),
    p_workspace_id: workspace_id,
  });

  if (error) {
    throw new Error(error.message);
  }

  return (data as unknown[]) ?? [];
}
