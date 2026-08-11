import { getSupabaseClient } from "./supabase.js";
import { verifyWorkspaceMembership } from "./auth.js";
import { queryOntologyTool, proposeActionTool } from "./tools.js";

export interface OntologyInterface {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  object_type?: string | null;
  property_whitelist: string[];
  required_properties: string[];
  markings: string[];
}

async function loadInterface(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
  slug: string
): Promise<OntologyInterface> {
  const { data, error } = await supabase
    .from("ontology_interfaces")
    .select(
      "id, workspace_id, name, slug, object_type, property_whitelist, required_properties, markings"
    )
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .single();

  if (error || !data) {
    throw new Error(`Interface not found: ${slug}`);
  }

  return {
    ...data,
    property_whitelist: (data.property_whitelist ?? []) as string[],
    required_properties: (data.required_properties ?? []) as string[],
    markings: (data.markings ?? []) as string[],
  };
}

/**
 * Query objects through an interface filter.
 * Results are projected to the interface's whitelisted properties.
 */
export async function queryInterfaceObjects(
  workspaceId: string,
  interfaceSlug: string,
  query: string,
  limit = 10
): Promise<unknown[]> {
  const supabase = getSupabaseClient();
  await verifyWorkspaceMembership(supabase, workspaceId);

  const iface = await loadInterface(supabase, workspaceId, interfaceSlug);

  // Find object ids that are members of this interface
  const { data: memberships, error: memberError } = await supabase
    .from("ontology_interface_memberships")
    .select("object_id")
    .eq("interface_id", iface.id);

  if (memberError) throw new Error(memberError.message);

  const objectIds = (memberships ?? []).map((m) => m.object_id as string);
  if (objectIds.length === 0) {
    return [];
  }

  let builder = supabase
    .from("ontology_objects")
    .select("id, object_type, external_id, display_name, attributes")
    .in("id", objectIds)
    .eq("workspace_id", workspaceId)
    .limit(limit);

  if (iface.object_type) {
    builder = builder.eq("object_type", iface.object_type);
  }

  if (query) {
    builder = builder.or(`display_name.ilike.%${query}%,external_id.ilike.%${query}%`);
  }

  const { data, error } = await builder;
  if (error) throw new Error(error.message);

  // Project to whitelisted attributes
  const objects = (data ?? []) as Array<{
    id: string;
    object_type: string;
    external_id: string;
    display_name: string | null;
    attributes: Record<string, unknown>;
  }>;

  if (iface.property_whitelist.length === 0) return objects;

  return objects.map((obj) => ({
    ...obj,
    attributes: Object.fromEntries(
      Object.entries(obj.attributes).filter(([key]) =>
        iface.property_whitelist.includes(key)
      )
    ),
  }));
}

/**
 * Propose an action through an interface.
 * Validates required properties before proposing.
 */
export async function executeInterfaceAction(
  workspaceId: string,
  interfaceSlug: string,
  actionType: string,
  payload: Record<string, unknown>
): Promise<{ action_id: string; status: string }> {
  const supabase = getSupabaseClient();
  await verifyWorkspaceMembership(supabase, workspaceId);

  const iface = await loadInterface(supabase, workspaceId, interfaceSlug);

  // Validate payload contains required properties
  const missing = iface.required_properties.filter(
    (key) => payload[key] === undefined
  );
  if (missing.length > 0) {
    throw new Error(`Missing required properties: ${missing.join(", ")}`);
  }

  // If a payload contains non-whitelisted keys, filter them out
  const allowed = new Set([
    ...iface.property_whitelist,
    ...iface.required_properties,
    "object_id",
    "external_id",
  ]);

  const sanitized: Record<string, unknown> = Object.fromEntries(
    Object.entries(payload).filter(([key]) => allowed.has(key))
  );

  const result = await proposeActionTool.invoke({
    workspace_id: workspaceId,
    type: actionType,
    payload: sanitized,
    requires_approval: true,
  });

  return JSON.parse(result as string) as { action_id: string; status: string };
}
