/// <reference types="node" />
import process from "node:process";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import { runWithUserId } from "./auth.js";
import { register } from "./metrics.js";
import { getSupabaseClient } from "./supabase.js";
import { approveAction, executeAction } from "./actions.js";
import {
  startAutomationScheduler,
  stopAutomationScheduler,
} from "./automations.js";
import {
  startAutomationListener,
  stopAutomationListener,
} from "./automation-listener.js";
import { queryInterfaceObjects, executeInterfaceAction } from "./interfaces.js";
import { queryObjectSet } from "./services/object-set.js";
import {
  createObjectType,
  listObjectTypes,
  createInterface,
  listInterfaces,
} from "./services/metadata.js";
import { uploadFile, downloadFile, deleteFile } from "./storage.js";
import {
  createMediaSet,
  addMediaSetItem,
  getMediaSet,
  listMediaSets,
} from "./media-sets.js";
import { langsmithWebhookRouter } from "./langsmith-webhook.js";
import { getErrorMessage } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load root .env.local first, then backend/.env.local to allow overrides
dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const app: Express = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json({ limit: "50mb" }));

// Legacy engine routes use the configured service identity in an isolated async context.
// User-facing chat routes override this with the authenticated request identity below.
function withDefaultUser(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  runWithUserId(process.env.DEFAULT_USER_ID ?? null, next);
}

app.use("/api", withDefaultUser);

// LangSmith webhook handler — bypasses user auth (uses its own secret-based auth)
app.use("/api/langsmith", langsmithWebhookRouter);

app.get("/metrics", async (_req: Request, res: Response) => {
  res.setHeader("Content-Type", register.contentType);
  res.send(await register.metrics());
});

/**
 * Coerce an Express query/param value (string | string[] | undefined) to a string.
 * Takes the first element if it's an array.
 */
function queryStr(val: unknown): string {
  if (typeof val === "string") return val;
  if (Array.isArray(val) && val.length > 0) return String(val[0]);
  return "";
}

const openRouterApiKey = process.env.OPENROUTER_API_KEY;
if (!openRouterApiKey) {
  process.stderr.write(
    "OPENROUTER_API_KEY is not set. The LangGraph Agent Server (port 2024) will fail to call LLMs.\n",
  );
}

const langSmithEnabled =
  process.env.LANGSMITH_TRACING === "true" && !!process.env.LANGSMITH_API_KEY;
if (langSmithEnabled) {
  process.stdout.write(
    `LangSmith tracing enabled for project: ${process.env.LANGSMITH_PROJECT || "default"}\n`,
  );
}

app.get("/health", (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    openrouter_configured: !!openRouterApiKey,
    langsmith_tracing: langSmithEnabled,
  });
});

// ---------------------------------------------------------------------------
// Chat routes are served by the LangGraph Agent Server (port 2024), not here.
// The legacy /api/chat, /api/chat/stream, /api/chat/resume routes were removed
// when the frontend migrated to @langchain/langgraph-sdk. This Express server
// now handles only: actions, metadata, storage, media-sets, and health.
// ---------------------------------------------------------------------------

// Action lifecycle routes
app.post("/api/actions/:id/approve", async (req: Request, res: Response) => {
  try {
    const id = queryStr(req.params.id);
    const { workspace_id, approved } = req.body as {
      workspace_id: string;
      approved: boolean;
    };
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const supabase = getSupabaseClient();
    await approveAction(supabase, id, workspace_id, approved === true);
    // Automations are now triggered by the Postgres NOTIFY listener
    // (action_status_changed channel), not manually here.
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/actions/:id/execute", async (req: Request, res: Response) => {
  try {
    const id = queryStr(req.params.id);
    const { workspace_id } = req.body as { workspace_id: string };
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const supabase = getSupabaseClient();
    await executeAction(supabase, id, workspace_id);
    // Automations are now triggered by the Postgres NOTIFY listener
    // (action_status_changed channel), not manually here.
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Ingest job history — list actions with type='ingest'
app.get("/api/ingest", async (req: Request, res: Response) => {
  try {
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("actions")
      .select("id, status, payload, created_at")
      .eq("workspace_id", workspace_id)
      .eq("type", "ingest")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ jobs: data ?? [] });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ---------------------------------------------------------------------------
// Automations CRUD — manage automation rules
// ---------------------------------------------------------------------------

app.get("/api/automations", async (req: Request, res: Response) => {
  try {
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("ontology_automations")
      .select(
        "id, workspace_id, name, trigger_type, trigger_config, action_type, action_payload_template, is_active, created_at, updated_at, last_run_at",
      )
      .eq("workspace_id", workspace_id)
      .order("created_at", { ascending: false });
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ automations: data ?? [] });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/automations", async (req: Request, res: Response) => {
  try {
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const {
      name,
      trigger_type,
      trigger_config,
      action_type,
      action_payload_template,
      is_active,
    } = req.body as {
      name?: string;
      trigger_type?: string;
      trigger_config?: Record<string, unknown>;
      action_type?: string;
      action_payload_template?: Record<string, unknown>;
      is_active?: boolean;
    };
    if (!name || !trigger_type || !action_type) {
      return res
        .status(400)
        .json({ error: "name, trigger_type, and action_type are required" });
    }
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("ontology_automations")
      .insert({
        workspace_id,
        name,
        trigger_type,
        trigger_config: trigger_config ?? {},
        action_type,
        action_payload_template: action_payload_template ?? {},
        is_active: is_active ?? true,
      })
      .select(
        "id, workspace_id, name, trigger_type, trigger_config, action_type, action_payload_template, is_active, created_at",
      )
      .single();
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ automation: data });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.patch("/api/automations/:id", async (req: Request, res: Response) => {
  try {
    const id = queryStr(req.params.id);
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const updates = req.body as {
      name?: string;
      trigger_type?: string;
      trigger_config?: Record<string, unknown>;
      action_type?: string;
      action_payload_template?: Record<string, unknown>;
      is_active?: boolean;
    };
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("ontology_automations")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("workspace_id", workspace_id)
      .select(
        "id, workspace_id, name, trigger_type, trigger_config, action_type, action_payload_template, is_active, updated_at",
      )
      .single();
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ automation: data });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.delete("/api/automations/:id", async (req: Request, res: Response) => {
  try {
    const id = queryStr(req.params.id);
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("ontology_automations")
      .delete()
      .eq("id", id)
      .eq("workspace_id", workspace_id);
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Interface routes
app.get(
  "/api/interfaces/:slug/objects",
  async (req: Request, res: Response) => {
    try {
      const slug = queryStr(req.params.slug);
      const workspace_id =
        queryStr(req.query.workspace_id) ||
        process.env.DEFAULT_WORKSPACE_ID ||
        "";
      const query = queryStr(req.query.query) || "";
      const limit = Number(req.query.limit) || 10;
      const objects = await queryInterfaceObjects(
        workspace_id,
        slug,
        query,
        limit,
      );
      return res.json({ objects });
    } catch (error) {
      return res.status(400).json({ error: getErrorMessage(error) });
    }
  },
);

app.post(
  "/api/interfaces/:slug/actions",
  async (req: Request, res: Response) => {
    try {
      const slug = queryStr(req.params.slug);
      const { workspace_id, type, payload } = req.body as {
        workspace_id: string;
        type: string;
        payload: Record<string, unknown>;
      };
      if (!workspace_id || !type || !payload) {
        return res
          .status(400)
          .json({ error: "workspace_id, type, and payload are required" });
      }
      const result = await executeInterfaceAction(
        workspace_id,
        slug,
        type,
        payload,
      );
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: getErrorMessage(error) });
    }
  },
);

// Engine: ObjectSetService
app.post("/api/object-sets/query", async (req: Request, res: Response) => {
  try {
    const result = await queryObjectSet(req.body);
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Engine: MetadataService
app.post("/api/metadata/object-types", async (req: Request, res: Response) => {
  try {
    const { workspace_id, name, schema } = req.body as {
      workspace_id: string;
      name: string;
      schema?: Record<string, unknown>;
    };
    const result = await createObjectType({ workspace_id, name, schema });
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/metadata/object-types", async (req: Request, res: Response) => {
  try {
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    const result = await listObjectTypes(workspace_id);
    return res.json({ types: result });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/metadata/interfaces", async (req: Request, res: Response) => {
  try {
    const result = await createInterface(req.body);
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/metadata/interfaces", async (req: Request, res: Response) => {
  try {
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    const result = await listInterfaces(workspace_id);
    return res.json({ interfaces: result });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Storage upload/download
app.post("/api/upload", async (req: Request, res: Response) => {
  try {
    const { workspace_id, type, file_name, mime_type, data, object_id } =
      req.body as {
        workspace_id: string;
        type: "media" | "documents";
        file_name: string;
        mime_type: string;
        data: string;
        object_id?: string;
      };
    if (!workspace_id || !type || !file_name || !mime_type || !data) {
      return res.status(400).json({
        error:
          "workspace_id, type, file_name, mime_type, and data are required",
      });
    }
    const result = await uploadFile({
      workspace_id,
      type,
      file_name,
      mime_type,
      data,
      object_id,
    });
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/download/:id", async (req: Request, res: Response) => {
  try {
    const type =
      (queryStr(req.query.type) as "media" | "documents") || "documents";
    const result = await downloadFile({ type, id: queryStr(req.params.id) });
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.delete("/api/files/:id", async (req: Request, res: Response) => {
  try {
    const type =
      (queryStr(req.query.type) as "media" | "documents") || "documents";
    await deleteFile(type, queryStr(req.params.id));
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Media sets
app.post("/api/media-sets", async (req: Request, res: Response) => {
  try {
    const { workspace_id, name, description, metadata } = req.body as {
      workspace_id: string;
      name: string;
      description?: string;
      metadata?: Record<string, unknown>;
    };
    if (!workspace_id || !name) {
      return res
        .status(400)
        .json({ error: "workspace_id and name are required" });
    }
    const set = await createMediaSet({
      workspace_id,
      name,
      description,
      metadata,
    });
    return res.json(set);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/media-sets", async (req: Request, res: Response) => {
  try {
    const workspaceId = queryStr(req.query.workspace_id);
    if (!workspaceId) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const sets = await listMediaSets(workspaceId);
    return res.json(sets);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/media-sets/:id", async (req: Request, res: Response) => {
  try {
    const set = await getMediaSet(queryStr(req.params.id));
    if (!set) return res.status(404).json({ error: "Media set not found" });
    return res.json(set);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/media-sets/:id/items", async (req: Request, res: Response) => {
  try {
    const { item_id, item_type } = req.body as {
      item_id: string;
      item_type: "media" | "document";
    };
    if (!item_id || !item_type) {
      return res
        .status(400)
        .json({ error: "item_id and item_type are required" });
    }
    const item = await addMediaSetItem({
      set_id: queryStr(req.params.id),
      item_id,
      item_type,
    });
    return res.json(item);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

const PORT = Number(process.env.PORT || 3001);

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    process.stdout.write(`Backend server listening on port ${PORT}\n`);
    startAutomationScheduler();
    // Start the Postgres LISTEN/NOTIFY listener for object_changed automations.
    // Errors are handled internally with reconnection; don't crash on failure.
    startAutomationListener().catch((err) => {
      process.stderr.write(
        `Failed to start automation listener: ${getErrorMessage(err)}\n`,
      );
    });
  });
}

// Graceful shutdown: stop the scheduler and listener before exiting.
function gracefulShutdown(signal: string): void {
  process.stdout.write(`Received ${signal}; shutting down automations\n`);
  stopAutomationScheduler();
  void stopAutomationListener().finally(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export { app };
