import { getSupabaseClient } from "../supabase.js";
import { getCurrentUserId } from "../auth.js";

export interface ObjectSetFilter {
  column: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "ilike" | "in" | "is";
  value: unknown;
}

export interface ObjectSetQuery {
  workspace_id: string;
  object_type?: string;
  interface_slug?: string;
  filters?: ObjectSetFilter[];
  search?: string;
  order_by?: { column: string; direction?: "asc" | "desc" }[];
  limit?: number;
  offset?: number;
}

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

/**
 * ObjectSetService: query objects with filters, ordering, pagination,
 * and optional interface projection.
 */
export async function queryObjectSet(input: ObjectSetQuery): Promise<{
  objects: unknown[];
  count: number;
}> {
  await verifyWorkspace(input.workspace_id);

  const supabase = getSupabaseClient();

  let interfaceWhitelist: string[] | null = null;
  let membershipIds: string[] | null = null;

  if (input.interface_slug) {
    const { data: iface, error: ifaceError } = await supabase
      .from("ontology_interfaces")
      .select("id, property_whitelist")
      .eq("workspace_id", input.workspace_id)
      .eq("slug", input.interface_slug)
      .single();

    if (ifaceError || !iface) {
      throw new Error(`Interface not found: ${input.interface_slug}`);
    }
    interfaceWhitelist = (iface.property_whitelist ?? []) as string[];

    const { data: members, error: memberError } = await supabase
      .from("ontology_interface_memberships")
      .select("object_id")
      .eq("interface_id", iface.id);

    if (memberError) throw new Error(memberError.message);
    membershipIds = (members ?? []).map((m) => m.object_id as string);
  }

  // Count query
  let countBuilder = supabase
    .from("ontology_objects")
    .select("id", { count: "exact" })
    .eq("workspace_id", input.workspace_id);

  if (input.object_type) {
    countBuilder = countBuilder.eq("object_type", input.object_type);
  }
  if (membershipIds) {
    countBuilder = countBuilder.in("id", membershipIds);
  }

  for (const f of input.filters ?? []) {
    countBuilder = countBuilder.filter("attributes->>" + f.column, f.op, f.value);
  }

  if (input.search) {
    countBuilder = countBuilder.or(
      `display_name.ilike.%${input.search}%,external_id.ilike.%${input.search}%`
    );
  }

  const { count, error: countError } = await countBuilder;
  if (countError) throw new Error(countError.message);

  // Data query
  let builder = supabase
    .from("ontology_objects")
    .select("id, object_type, external_id, display_name, attributes, created_at, updated_at")
    .eq("workspace_id", input.workspace_id);

  if (input.object_type) {
    builder = builder.eq("object_type", input.object_type);
  }
  if (membershipIds) {
    builder = builder.in("id", membershipIds);
  }

  for (const f of input.filters ?? []) {
    builder = builder.filter("attributes->>" + f.column, f.op, f.value);
  }

  if (input.search) {
    builder = builder.or(
      `display_name.ilike.%${input.search}%,external_id.ilike.%${input.search}%`
    );
  }

  for (const order of input.order_by ?? [{ column: "created_at", direction: "desc" }]) {
    builder = builder.order(order.column, { ascending: order.direction !== "desc" });
  }

  builder = builder.limit(input.limit ?? 50).offset(input.offset ?? 0);

  const { data, error } = await builder;
  if (error) throw new Error(error.message);

  const objects = (data ?? []) as Array<{
    id: string;
    object_type: string;
    external_id: string;
    display_name: string | null;
    attributes: Record<string, unknown>;
  }>;

  if (interfaceWhitelist && interfaceWhitelist.length > 0) {
    return {
      objects: objects.map((obj) => ({
        ...obj,
        attributes: Object.fromEntries(
          Object.entries(obj.attributes).filter(([key]) =>
            interfaceWhitelist?.includes(key)
          )
        ),
      })),
      count: count ?? 0,
    };
  }

  return { objects, count: count ?? 0 };
}
