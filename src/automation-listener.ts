import process from "node:process";
import pg from "pg";
import { evaluateAutomations, type AutomationContext } from "./automations.js";

const OBJECT_CHANNEL = "ontology_object_changed";
const ACTION_CHANNEL = "action_status_changed";

interface ObjectChangedPayload {
  workspace_id: string;
  object_id: string;
  object_type: string;
  change_type: "insert" | "update" | "delete";
}

interface ActionStatusPayload {
  workspace_id: string;
  action_id: string;
  action_type: string;
  status: string;
  old_status: string | null;
}

let client: pg.Client | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function getConnectionString(): string {
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || "";
  if (!url) {
    throw new Error(
      "DATABASE_URL or SUPABASE_DB_URL is not set; automation listener cannot connect",
    );
  }
  return url;
}

/**
 * Handle a parsed object_changed notification by evaluating object_changed automations.
 */
async function handleObjectNotification(
  payload: ObjectChangedPayload,
): Promise<void> {
  const ctx: AutomationContext = {
    workspace_id: payload.workspace_id,
    trigger: "object_changed",
    object_id: payload.object_id,
    object_type: payload.object_type,
  };
  try {
    await evaluateAutomations(ctx);
  } catch (err) {
    process.stderr.write(
      `Automation listener evaluate error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Map an action status to the corresponding automation trigger type.
 * Only the four lifecycle triggers are mapped; other statuses (running,
 * completed, failed) don't have dedicated automation triggers.
 */
function statusToTrigger(status: string): AutomationContext["trigger"] | null {
  switch (status) {
    case "proposed":
      return "action_proposed";
    case "approved":
      return "action_approved";
    case "rejected":
      return "action_rejected";
    case "executed":
      return "action_executed";
    default:
      return null;
  }
}

/**
 * Handle a parsed action_status_changed notification by evaluating
 * the matching action lifecycle automations.
 */
async function handleActionNotification(
  payload: ActionStatusPayload,
): Promise<void> {
  const trigger = statusToTrigger(payload.status);
  if (!trigger) return;
  const ctx: AutomationContext = {
    workspace_id: payload.workspace_id,
    trigger,
    action_type: payload.action_type,
  };
  try {
    await evaluateAutomations(ctx);
  } catch (err) {
    process.stderr.write(
      `Automation listener evaluate error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Connect (or reconnect) to Postgres and LISTEN for ontology object changes.
 * On error, schedules a reconnect after a short backoff.
 */
async function connect(): Promise<void> {
  if (stopped) return;
  const connectionString = getConnectionString();
  client = new pg.Client({ connectionString });

  client.on("notification", (msg) => {
    if (!msg.payload) return;
    try {
      const payload = JSON.parse(msg.payload) as Record<string, unknown>;
      // Dispatch to the correct handler based on which channel fired.
      if (msg.channel === ACTION_CHANNEL) {
        void handleActionNotification(
          payload as unknown as ActionStatusPayload,
        );
      } else {
        void handleObjectNotification(
          payload as unknown as ObjectChangedPayload,
        );
      }
    } catch (err) {
      process.stderr.write(
        `Automation listener payload parse error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  });

  client.on("error", (err) => {
    process.stderr.write(
      `Automation listener pg client error: ${err.message}\n`,
    );
    scheduleReconnect();
  });

  client.on("end", () => {
    if (!stopped) {
      process.stderr.write(
        "Automation listener connection ended; reconnecting\n",
      );
      scheduleReconnect();
    }
  });

  try {
    await client.connect();
    await client.query(`LISTEN ${OBJECT_CHANNEL}`);
    await client.query(`LISTEN ${ACTION_CHANNEL}`);
    process.stdout.write(
      `Automation listener connected and LISTENing on channels "${OBJECT_CHANNEL}" and "${ACTION_CHANNEL}"\n`,
    );
  } catch (err) {
    process.stderr.write(
      `Automation listener connect error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (stopped) return;
  if (reconnectTimer) return;
  // Clear the stale client reference so a fresh one is created on reconnect.
  client = null;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, 5000);
}

/**
 * Start the Postgres LISTEN/NOTIFY automation listener.
 * If already connected and not stopped, returns early to avoid duplicate connections.
 */
export async function startAutomationListener(): Promise<void> {
  if (client && !stopped) return;
  stopped = false;
  await connect();
}

/**
 * Stop the listener and clean up resources.
 */
export async function stopAutomationListener(): Promise<void> {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (client) {
    try {
      await client.end();
    } catch {
      // Ignore errors during teardown.
    }
    client = null;
  }
}
