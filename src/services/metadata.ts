import { getSupabaseClient } from "../supabase.js";
import { getCurrentUserId } from "../auth.js";

async function verifyWorkspace(workspaceId: string) {
  const supabase = getSupabaseClient();
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

export async function createObjectType(input: {
  workspace_id: string;
  name: string;
  schema?: Record<string, unknown>;
}) {
  await verifyWorkspace(input.workspace_id);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ontology_object_types")
    .insert({
      workspace_id: input.workspace_id,
      name: input.name,
      schema: input.schema ?? {},
    })
    .select("id, name, schema, version, created_at")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listObjectTypes(workspaceId: string) {
  await verifyWorkspace(workspaceId);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ontology_object_types")
    .select("id, name, schema, version, created_at")
    .eq("workspace_id", workspaceId)
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createInterface(input: {
  workspace_id: string;
  name: string;
  slug: string;
  object_type?: string;
  property_whitelist?: string[];
  required_properties?: string[];
  markings?: string[];
}) {
  await verifyWorkspace(input.workspace_id);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ontology_interfaces")
    .insert({
      workspace_id: input.workspace_id,
      name: input.name,
      slug: input.slug,
      object_type: input.object_type,
      property_whitelist: input.property_whitelist ?? [],
      required_properties: input.required_properties ?? [],
      markings: input.markings ?? [],
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listInterfaces(workspaceId: string) {
  await verifyWorkspace(workspaceId);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ontology_interfaces")
    .select()
    .eq("workspace_id", workspaceId)
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}
