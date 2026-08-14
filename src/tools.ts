import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { getSupabaseClient } from "./supabase.js";
import { verifyWorkspaceMembership } from "./auth.js";
import { withRetry, isTransientError } from "./fault-tolerance.js";

const MAX_ONTOLOGY_LIMIT = 50;

const DEFAULT_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffFactor: 2,
  retryOn: isTransientError,
};

function sanitizeSearch(value: string): string {
  // Strip Postgres ILIKE wildcard characters so the search is always a literal substring.
  return value.replace(/[%_]/g, "");
}

export const queryOntologyTool = tool(
  withRetry(async ({ workspace_id, query, limit }) => {
    const supabase = getSupabaseClient();
    await verifyWorkspaceMembership(supabase, workspace_id);
    const safeLimit = Math.min(Math.max(1, limit ?? 10), MAX_ONTOLOGY_LIMIT);
    const pattern = `%${sanitizeSearch(query)}%`;
    const { data: displayData, error: displayError } = await supabase
      .from("ontology_objects")
      .select("id, object_type, external_id, display_name, attributes")
      .eq("workspace_id", workspace_id)
      .ilike("display_name", pattern)
      .limit(safeLimit);

    const { data: externalData, error: externalError } = await supabase
      .from("ontology_objects")
      .select("id, object_type, external_id, display_name, attributes")
      .eq("workspace_id", workspace_id)
      .ilike("external_id", pattern)
      .limit(safeLimit);

    const error = displayError ?? externalError;
    if (error) {
      throw new Error(error.message);
    }

    const seen = new Set<string>();
    const combined = [];
    for (const row of [...(displayData ?? []), ...(externalData ?? [])]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      combined.push(row);
      if (combined.length >= safeLimit) break;
    }

    return JSON.stringify(combined);
  }, DEFAULT_RETRY),
  {
    name: "query_ontology",
    description:
      "Search ontology objects in a workspace by display name or external id. " +
      "Returns a JSON array of matching objects.",
    schema: z.object({
      workspace_id: z.string().uuid(),
      query: z.string().describe("Search text for display_name or external_id"),
      limit: z
        .number()
        .min(1)
        .max(MAX_ONTOLOGY_LIMIT)
        .optional()
        .describe("Max results to return"),
    }),
  },
);

export const proposeActionTool = tool(
  withRetry(async ({ workspace_id, type, payload, requires_approval }) => {
    const supabase = getSupabaseClient();
    await verifyWorkspaceMembership(supabase, workspace_id);
    const { data, error } = await supabase
      .from("actions")
      .insert({
        workspace_id,
        type,
        payload,
        requires_approval: requires_approval ?? true,
        status: "proposed",
      })
      .select("id")
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return JSON.stringify({ action_id: data.id, status: "proposed" });
  }, DEFAULT_RETRY),
  {
    name: "propose_action",
    description:
      "Propose an action that requires user approval before execution. " +
      "Inserts a record into the actions table and returns the action id.",
    schema: z.object({
      workspace_id: z.string().uuid(),
      type: z
        .string()
        .describe("Action type, e.g. 'send_email' or 'update_crm'"),
      payload: z.record(z.unknown()).describe("Action payload"),
      requires_approval: z
        .boolean()
        .optional()
        .describe("Whether approval is required"),
    }),
  },
);
