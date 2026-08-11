/**
 * Object chunks — the write side of semantic search.
 *
 * `semantic.ts` reads `ontology_chunks` via pgvector; this module writes
 * them. Every path that creates or mutates an `ontology_objects` row must
 * call `upsertObjectChunk` afterwards, otherwise the object exists in the
 * ontology but is invisible to `semantic_search`.
 *
 * One chunk per object (unique on `workspace_id, object_id`, see migration
 * 000012), holding the object's display name plus its non-internal
 * attributes. Re-upserting replaces the chunk so it stays in sync.
 */
import { embedText } from "./embeddings.js";
import { getSupabaseClient } from "./supabase.js";

/**
 * Build the embeddable text for an object: display name followed by the
 * JSON of its attributes. Internal keys (leading `_`) and null/undefined
 * values are dropped — they are bookkeeping, not meaning.
 */
export function buildChunkText(
  displayName: string,
  attributes: Record<string, unknown>,
): string {
  const embeddable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("_")) continue;
    if (value === null || value === undefined) continue;
    embeddable[key] = value;
  }
  return `${displayName}\n${JSON.stringify(embeddable)}`;
}

/**
 * Embed an object's current state and upsert its chunk.
 *
 * Throws if the embedding call or the upsert fails. Callers decide whether
 * that is fatal: it never is for a write that already succeeded, since the
 * object is in the ontology either way — it's just not yet searchable.
 */
export async function upsertObjectChunk(
  workspaceId: string,
  objectId: string,
  displayName: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  const content = buildChunkText(displayName, attributes);
  const embedding = await embedText(content);

  const supabase = getSupabaseClient();
  const { error } = await supabase.from("ontology_chunks").upsert(
    {
      workspace_id: workspaceId,
      object_id: objectId,
      content,
      embedding: JSON.stringify(embedding),
    },
    { onConflict: "workspace_id, object_id" },
  );
  if (error) throw new Error(error.message);
}
