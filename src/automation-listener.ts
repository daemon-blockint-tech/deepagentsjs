import process from "node:process";
import pg from "pg";
import { evaluateAutomations, type AutomationContext } from "./automations.js";

const CHANNEL = "ontology_object_changed";

interface ObjectChangedPayload {
  workspace_id: string;
  object_id: string;
  object_type: string;
  change_type: "insert" | "update" | "delete";
}

let client: pg.Client | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function getConnectionString(): string {
  const url =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    "";
  if (!url) {
    throw new Error(
      "DATABASE_URL or SUPABASE_DB_URL is not set; automation listener cannot connect",
    );
  }
  return url;
}

/**
 * Handle a parsed notification payload by evaluating object_changed automations.
 */
async function handleNotification(payload: ObjectChangedPayload): Promise<void> {
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
      const payload = JSON.parse(msg.payload) as ObjectChangedPayload;
      void handleNotification(payload);
    } catch (err) {
      process.stderr.write(
        `Automation listener payload parse error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  });

  client.on("error", (err) => {
    process.stderr.write(`Automation listener pg client error: ${err.message}\n`);
    scheduleReconnect();
  });

  client.on("end", () => {
    if (!stopped) {
      process.stderr.write("Automation listener connection ended; reconnecting\n");
      scheduleReconnect();
    }
  });

  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    process.stdout.write(
      `Automation listener connected and LISTENing on channel "${CHANNEL}"\n`,
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
 */
export async function startAutomationListener(): Promise<void> {
  if (client || stopped === false) {
    // Allow restart after explicit stop.
  }
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
