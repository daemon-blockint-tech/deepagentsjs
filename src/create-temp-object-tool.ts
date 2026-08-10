import { z } from "zod"
import { tool } from "@langchain/core/tools"
import { getSupabaseClient } from "./supabase.js"
import { getCurrentUserId } from "./auth.js"
import { withRetry, isTransientError } from "./fault-tolerance.js"

const DEFAULT_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffFactor: 2,
  retryOn: isTransientError,
}

async function verifyWorkspaceMembership(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string
) {
  const userId = getCurrentUserId()
  if (!userId) throw new Error("Unauthorized: no current user")
  const { data, error } = await supabase
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .single()
  if (error || !data) throw new Error("Workspace access denied")
}

/**
 * Create a temporary/draft ontology object.
 *
 * Specialists use this to write working artifacts — draft reports,
 * intermediate analysis results, pricing models — directly to the
 * Ontology so other specialists can read them.
 *
 * Temp objects are marked with `attributes._temp = true` and
 * `attributes._created_by_agent = true`. After human approval,
 * they can be promoted to permanent via the execute_action flow
 * (which strips the _temp flag).
 */
export const createTempObjectTool = tool(
  withRetry(async ({ workspace_id, object_type, display_name, attributes }) => {
    const supabase = getSupabaseClient()
    await verifyWorkspaceMembership(supabase, workspace_id)

    // Mark as temporary + agent-created
    const markedAttributes = {
      ...attributes,
      _temp: true,
      _created_by_agent: true,
      _created_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from("ontology_objects")
      .insert({
        workspace_id,
        object_type,
        external_id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        display_name,
        attributes: markedAttributes,
      })
      .select("id, display_name, attributes")
      .single()

    if (error) throw new Error(error.message)

    // Also insert normalized properties for searchability
    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        if (key.startsWith("_")) continue
        await supabase.from("ontology_properties").upsert(
          {
            workspace_id,
            object_id: data.id,
            key,
            value: value as unknown,
            value_type: typeof value === "number" ? "number" : "string",
          },
          { onConflict: "workspace_id, object_id, key" }
        )
      }
    }

    return JSON.stringify({
      object_id: data.id,
      display_name: data.display_name,
      status: "temp_created",
      message: `Temporary object '${display_name}' created in Ontology. Other specialists can read it via query_ontology.`,
    })
  }, DEFAULT_RETRY),
  {
    name: "create_temp_object",
    description:
      "Create a temporary/draft object in the Ontology. " +
      "Other specialists can read it immediately via query_ontology. " +
      "Use this for draft reports, intermediate analysis, pricing models — " +
      "any working artifact that downstream specialists need. " +
      "Temp objects are marked with _temp=true and can be promoted to permanent later.",
    schema: z.object({
      workspace_id: z.string().uuid(),
      object_type: z
        .string()
        .describe("Object type, e.g. 'report', 'analysis', 'pricing_model', 'draft'"),
      display_name: z.string().describe("Human-readable name for the object"),
      attributes: z
        .record(z.unknown())
        .describe("Object attributes/fields as key-value pairs"),
    }),
  }
)
