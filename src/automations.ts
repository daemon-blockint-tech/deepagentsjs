import { getSupabaseClient } from "./supabase.js";
import { getCurrentUserId } from "./auth.js";
import { proposeActionTool } from "./tools.js";
import { getErrorMessage } from "./utils.js";

export interface AutomationContext {
  workspace_id: string;
  trigger:
    | "action_proposed"
    | "action_approved"
    | "action_rejected"
    | "action_executed"
    | "object_changed"
    | "schedule";
  action_type?: string;
  action_payload?: Record<string, unknown>;
  object_id?: string;
  object_type?: string;
}

async function proposeTemplatedAction(
  ctx: AutomationContext,
  automation: {
    id: string;
    workspace_id: string;
    action_type: string;
    action_payload_template: Record<string, unknown>;
    trigger_config: Record<string, unknown>;
  },
): Promise<string> {
  const config = automation.trigger_config ?? {};
  const template = automation.action_payload_template ?? {};
  const payload = { ...template };
  if (ctx.object_id) {
    payload.object_id = ctx.object_id;
  }
  if (ctx.action_payload) {
    Object.assign(payload, ctx.action_payload);
  }

  const result = await proposeActionTool.invoke({
    workspace_id: ctx.workspace_id,
    type: automation.action_type,
    payload,
    requires_approval: (config.requires_approval as boolean) ?? true,
  });

  const parsed = JSON.parse(result as string) as { action_id: string };
  return parsed.action_id;
}

/**
 * Evaluate matching automations for a trigger event.
 * For each active automation whose trigger matches, propose a templated action.
 */
export async function evaluateAutomations(
  ctx: AutomationContext,
): Promise<string[]> {
  const supabase = getSupabaseClient();
  const userId = getCurrentUserId();
  if (!userId) {
    throw new Error("Unauthorized: no current user");
  }

  const { data, error } = await supabase
    .from("ontology_automations")
    .select(
      "id, workspace_id, action_type, action_payload_template, trigger_config",
    )
    .eq("workspace_id", ctx.workspace_id)
    .eq("trigger_type", ctx.trigger)
    .eq("is_active", true);

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to load automations");
  }

  const created: string[] = [];

  for (const automation of data) {
    const config = (automation.trigger_config ?? {}) as Record<string, unknown>;
    const matchesActionType =
      !config.action_type || (config.action_type as string) === ctx.action_type;
    const matchesObjectType =
      !config.object_type || (config.object_type as string) === ctx.object_type;

    if (!matchesActionType || !matchesObjectType) continue;

    created.push(await proposeTemplatedAction(ctx, automation));
  }

  return created;
}

/**
 * Poll scheduled automations and trigger those whose interval has passed.
 * This is an in-memory, single-node scheduler. For multi-instance deployments,
 * replace with a distributed scheduler (e.g. Bull, pg-boss, or k8s CronJob).
 */
export async function processScheduledAutomations(): Promise<string[]> {
  const supabase = getSupabaseClient();
  const userId = getCurrentUserId();
  if (!userId) {
    throw new Error("Unauthorized: no current user");
  }

  const { data, error } = await supabase
    .from("ontology_automations")
    .select(
      "id, workspace_id, action_type, action_payload_template, trigger_config, last_run_at",
    )
    .eq("trigger_type", "schedule")
    .eq("is_active", true);

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to load scheduled automations");
  }

  const created: string[] = [];
  const now = new Date().toISOString();

  for (const automation of data) {
    const config = (automation.trigger_config ?? {}) as Record<string, unknown>;
    const everySeconds = Number(config.every_seconds ?? 300);
    const lastRun = automation.last_run_at
      ? new Date(automation.last_run_at).getTime()
      : 0;
    const due = Date.now() - lastRun >= everySeconds * 1000;

    if (!due) continue;

    const actionId = await proposeTemplatedAction(
      { workspace_id: automation.workspace_id, trigger: "schedule" },
      automation,
    );
    created.push(actionId);

    await supabase
      .from("ontology_automations")
      .update({ last_run_at: now })
      .eq("id", automation.id);
  }

  return created;
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startAutomationScheduler(intervalMs = 60000) {
  if (schedulerInterval) return;
  schedulerInterval = setInterval(async () => {
    try {
      await processScheduledAutomations();
    } catch (err) {
      // Log and continue; do not crash the scheduler.
      process.stderr.write(`Scheduler error: ${getErrorMessage(err)}\n`);
    }
  }, intervalMs);
}

export function stopAutomationScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}
