import process from "node:process";

import { getSupabaseClient } from "./supabase.js";
import { getCurrentUserId } from "./auth.js";
import { proposeActionTool } from "./tools.js";
import { scheduleOutcomeCheck } from "./outcome-tracker.js";
import { upsertObjectChunk } from "./object-chunks.js";
import { getErrorMessage } from "./utils.js";

export interface ActionPayload {
  workspace_id: string;
  type: string;
  payload: Record<string, unknown>;
  requires_approval?: boolean;
}

export interface ApprovalInput {
  action_id: string;
  workspace_id: string;
  approved: boolean;
}

function actionLog(
  supabase: ReturnType<typeof getSupabaseClient>,
  actionId: string,
  workspaceId: string,
  event: "proposed" | "approved" | "rejected" | "executed",
) {
  return supabase.from("action_logs").insert({
    action_id: actionId,
    workspace_id: workspaceId,
    event,
    performed_by: getCurrentUserId(),
  });
}

/**
 * Re-embed an object the executor just wrote so `semantic_search` can see it.
 *
 * Never fatal: the ontology write already committed and the action must still
 * be marked executed. A missed chunk is recoverable with `pnpm backfill:chunks`.
 */
async function refreshChunk(
  workspaceId: string,
  objectId: string,
  displayName: string,
  attributes: Record<string, unknown>,
) {
  try {
    await upsertObjectChunk(workspaceId, objectId, displayName, attributes);
  } catch (err) {
    process.stderr.write(
      `executeAction: embedding failed for object ${objectId}: ${getErrorMessage(err)}\n`,
    );
  }
}

async function verifyActionAccess(
  supabase: ReturnType<typeof getSupabaseClient>,
  actionId: string,
  workspaceId: string,
) {
  const userId = getCurrentUserId();
  if (!userId) {
    throw new Error("Unauthorized: no current user");
  }
  const { data: action, error: actionError } = await supabase
    .from("actions")
    .select("id, workspace_id, status")
    .eq("id", actionId)
    .eq("workspace_id", workspaceId)
    .single();

  if (actionError || !action) {
    throw new Error("Action not found");
  }

  const { data: membership, error: memberError } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .single();

  if (memberError || !membership) {
    throw new Error("Workspace access denied");
  }

  return { action, role: membership.role };
}

export async function executeAction(
  supabase: ReturnType<typeof getSupabaseClient>,
  actionId: string,
  workspaceId: string,
) {
  const { action } = await verifyActionAccess(supabase, actionId, workspaceId);
  if (action.status !== "approved" && action.status !== "proposed") {
    throw new Error("Action is not in an executable state");
  }

  const { data: full, error } = await supabase
    .from("actions")
    .select("type, payload")
    .eq("id", actionId)
    .single();
  if (error || !full) {
    throw new Error(error?.message ?? "Action not found");
  }

  const { type, payload } = full;

  // Core write operations. Each type maps to an ontology mutation.
  if (type === "update_object") {
    const objectId = payload.object_id as string;
    const updates = payload.updates as Record<string, unknown>;

    const { data: updated, error: updateError } = await supabase
      .from("ontology_objects")
      .update({
        attributes: updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", objectId)
      .eq("workspace_id", workspaceId)
      .select("display_name")
      .single();

    if (updateError) throw new Error(updateError.message);

    // Sync normalized properties
    for (const [key, value] of Object.entries(updates)) {
      const { error: upsertError } = await supabase
        .from("ontology_properties")
        .upsert(
          {
            workspace_id: workspaceId,
            object_id: objectId,
            key,
            value: value as unknown,
            value_type: "json",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "workspace_id, object_id, key" },
        );
      if (upsertError) throw new Error(upsertError.message);
    }

    await refreshChunk(
      workspaceId,
      objectId,
      (updated?.display_name as string) ?? objectId,
      updates,
    );
  } else if (type === "create_object") {
    const objectType = payload.object_type as string;
    const externalId = payload.external_id as string;
    const displayName = payload.display_name as string;
    const attributes = payload.attributes as Record<string, unknown>;

    const { data: created, error: createError } = await supabase
      .from("ontology_objects")
      .insert({
        workspace_id: workspaceId,
        object_type: objectType,
        external_id: externalId,
        display_name: displayName,
        attributes,
      })
      .select("id")
      .single();

    if (createError) throw new Error(createError.message);
    if (!created) throw new Error("Object creation returned no id");

    for (const [key, value] of Object.entries(attributes)) {
      const { error: propError } = await supabase
        .from("ontology_properties")
        .insert({
          workspace_id: workspaceId,
          object_id: created.id,
          key,
          value: value as unknown,
          value_type: "json",
        });
      if (propError) throw new Error(propError.message);
    }

    await refreshChunk(workspaceId, created.id, displayName, attributes);
  } else if (type === "webhook") {
    const url = payload.url as string;
    const body = JSON.stringify(payload.body ?? {});
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Webhook failed: ${res.status} ${await res.text()}`);
    }
  } else {
    throw new Error(`Unknown action type: ${type}`);
  }

  const userId = getCurrentUserId();
  const now = new Date().toISOString();
  const { error: statusError } = await supabase
    .from("actions")
    .update({
      status: "executed",
      executed_by: userId,
      executed_at: now,
    })
    .eq("id", actionId)
    .eq("workspace_id", workspaceId);

  if (statusError) throw new Error(statusError.message);

  await actionLog(supabase, actionId, workspaceId, "executed");

  // Record the decision with an initial outcome snapshot.
  // The outcome is updated later by the outcome-tracker (delayed metric check)
  // or by user feedback flowing back through /api/feedback.
  await supabase.from("decisions").insert({
    workspace_id: workspaceId,
    action_id: actionId,
    outcome: {
      type,
      status: "executed",
      executed_at: now,
      payload_summary: summarizePayload(type, payload),
    },
    created_by: userId,
    executed_at: now,
  });

  // Schedule a delayed outcome check so the agent can learn whether
  // the action's effect persisted (the "Clone jadi semakin ahli" loop).
  scheduleOutcomeCheck(actionId, workspaceId, type, payload);
}

/**
 * Produce a compact summary of the action payload for the decision record.
 * Keeps the outcome JSON small while preserving enough context for learning.
 */
function summarizePayload(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (type === "update_object") {
    return {
      object_id: payload.object_id,
      fields_updated: Object.keys(payload.updates ?? payload),
    };
  }
  if (type === "create_object") {
    return {
      object_type: payload.object_type,
      display_name: payload.display_name,
    };
  }
  if (type === "webhook") {
    return { url: payload.url };
  }
  return { keys: Object.keys(payload) };
}

export async function approveAction(
  supabase: ReturnType<typeof getSupabaseClient>,
  actionId: string,
  workspaceId: string,
  approved: boolean,
) {
  const { action } = await verifyActionAccess(supabase, actionId, workspaceId);
  if (action.status !== "proposed") {
    throw new Error("Action is not in proposed state");
  }

  const newStatus = approved ? "approved" : "rejected";
  const userId = getCurrentUserId();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("actions")
    .update({
      status: newStatus,
      approved_by: approved ? userId : null,
      approved_at: approved ? now : null,
    })
    .eq("id", actionId)
    .eq("workspace_id", workspaceId);

  if (error) throw new Error(error.message);
  await actionLog(
    supabase,
    actionId,
    workspaceId,
    approved ? "approved" : "rejected",
  );

  if (approved) {
    await executeAction(supabase, actionId, workspaceId);
  }
}

export async function createAction(input: ActionPayload) {
  return proposeActionTool.invoke({
    workspace_id: input.workspace_id,
    type: input.type,
    payload: input.payload,
    requires_approval: input.requires_approval,
  });
}
