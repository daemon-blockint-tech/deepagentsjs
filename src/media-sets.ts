import { getSupabaseClient } from "./supabase.js";
import { getCurrentUserId } from "./auth.js";

export interface CreateMediaSetInput {
  workspace_id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export async function createMediaSet(input: CreateMediaSetInput) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("media_sets")
    .insert({
      workspace_id: input.workspace_id,
      name: input.name,
      description: input.description,
      metadata: input.metadata ?? {},
    })
    .select("id, workspace_id, name, description, metadata, created_at")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to create media set");
  return data;
}

export interface AddMediaSetItemInput {
  set_id: string;
  item_id: string;
  item_type: "media" | "document";
}

export async function addMediaSetItem(input: AddMediaSetItemInput) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("media_set_items")
    .insert({
      set_id: input.set_id,
      item_id: input.item_id,
      item_type: input.item_type,
    })
    .select("id, set_id, item_id, item_type, created_at")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to add item to media set");
  return data;
}

export interface MediaSetWithItems {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  items: unknown[];
}

export async function getMediaSet(setId: string): Promise<MediaSetWithItems | null> {
  const supabase = getSupabaseClient();
  const { data: set, error } = await supabase
    .from("media_sets")
    .select("id, workspace_id, name, description, metadata, created_at, updated_at")
    .eq("id", setId)
    .single();

  if (error || !set) return null;

  const { data: items, error: itemsError } = await supabase
    .from("media_set_items")
    .select("item_id, item_type, created_at")
    .eq("set_id", setId);

  if (itemsError) throw new Error(itemsError.message);

  return { ...set, items: items ?? [] };
}

export async function listMediaSets(workspaceId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("media_sets")
    .select("id, workspace_id, name, description, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}
