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
import { embedText } from "./embeddings.js";
import { upsertObjectChunk } from "./object-chunks.js";
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

// ---------------------------------------------------------------------------
// Ontology objects — browse, search, CRUD
// ---------------------------------------------------------------------------

// List objects with optional filters
app.get("/api/objects", async (req: Request, res: Response) => {
  try {
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const objectType = queryStr(req.query.object_type) || "";
    const query = queryStr(req.query.query) || "";
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    const supabase = getSupabaseClient();
    let builder = supabase
      .from("ontology_objects")
      .select(
        "id, object_type, external_id, display_name, attributes, created_at, updated_at",
        { count: "exact" },
      )
      .eq("workspace_id", workspace_id)
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (objectType) {
      builder = builder.eq("object_type", objectType);
    }
    if (query) {
      builder = builder.or(
        `display_name.ilike.%${query}%,external_id.ilike.%${query}%`,
      );
    }

    const { data, error, count } = await builder;
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ objects: data ?? [], total: count ?? 0 });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Get a single object by ID
app.get("/api/objects/:id", async (req: Request, res: Response) => {
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
    const { data, error } = await supabase
      .from("ontology_objects")
      .select(
        "id, object_type, external_id, display_name, attributes, created_at, updated_at",
      )
      .eq("id", id)
      .eq("workspace_id", workspace_id)
      .single();
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ object: data });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Semantic search via pgvector
app.get("/api/objects/search/semantic", async (req: Request, res: Response) => {
  try {
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const query = queryStr(req.query.query) || "";
    if (!query) {
      return res.status(400).json({ error: "query is required" });
    }
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const threshold = Number(req.query.threshold) || 0.5;

    const embedding = await embedText(query);
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("match_ontology_chunks", {
      query_embedding: JSON.stringify(embedding),
      match_threshold: threshold,
      match_count: limit,
      p_workspace_id: workspace_id,
    });
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ results: data ?? [] });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Get normalized properties for an object
app.get("/api/objects/:id/properties", async (req: Request, res: Response) => {
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
    const { data, error } = await supabase
      .from("ontology_properties")
      .select("key, value, value_type")
      .eq("object_id", id)
      .eq("workspace_id", workspace_id)
      .order("key", { ascending: true });
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ properties: data ?? [] });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Create a new object (admin operation — direct insert, not through action lifecycle)
app.post("/api/objects", async (req: Request, res: Response) => {
  try {
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const { object_type, external_id, display_name, attributes } = req.body as {
      object_type?: string;
      external_id?: string;
      display_name?: string;
      attributes?: Record<string, unknown>;
    };
    if (!object_type || !external_id) {
      return res
        .status(400)
        .json({ error: "object_type and external_id are required" });
    }
    const attrs = attributes ?? {};
    const supabase = getSupabaseClient();

    // Check for type conflict on re-create with same external_id
    const { data: existing } = await supabase
      .from("ontology_objects")
      .select("id, object_type")
      .eq("workspace_id", workspace_id)
      .eq("external_id", external_id)
      .maybeSingle();
    if (existing && existing.object_type !== object_type) {
      return res.status(400).json({
        error: `Object with external_id "${external_id}" already exists with object_type "${existing.object_type}", cannot create as "${object_type}".`,
      });
    }

    const { data, error } = await supabase
      .from("ontology_objects")
      .upsert(
        {
          workspace_id,
          object_type,
          external_id,
          display_name: display_name ?? external_id,
          attributes: attrs,
        },
        { onConflict: "workspace_id, external_id" },
      )
      .select("id")
      .single();
    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const objectId = data.id;

    // Sync normalized properties: delete stale, upsert current
    const currentKeys = Object.entries(attrs)
      .filter(([k, v]) => !k.startsWith("_") && v !== null && v !== undefined)
      .map(([k]) => k);

    let staleDelete = supabase
      .from("ontology_properties")
      .delete()
      .eq("object_id", objectId);
    if (currentKeys.length > 0) {
      staleDelete = staleDelete.notIn("key", currentKeys);
    }
    await staleDelete;

    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith("_")) continue;
      if (value === null || value === undefined) continue;
      await supabase.from("ontology_properties").upsert(
        {
          workspace_id,
          object_id: objectId,
          key,
          value: value as unknown,
          value_type:
            typeof value === "number"
              ? "number"
              : typeof value === "boolean"
                ? "boolean"
                : "string",
        },
        { onConflict: "workspace_id, object_id, key" },
      );
    }

    // Generate embedding and upsert chunk for semantic searchability
    try {
      await upsertObjectChunk(
        workspace_id,
        objectId,
        display_name ?? external_id,
        attrs,
      );
    } catch (err) {
      // Embedding failure is non-fatal — object is created, just not
      // semantically searchable. Re-save or run `pnpm backfill:chunks` to retry.
      process.stderr.write(
        `POST /api/objects: embedding failed for ${objectId}: ${getErrorMessage(err)}\n`,
      );
    }

    return res.json({
      object: {
        id: objectId,
        object_type,
        external_id,
        display_name,
        attributes: attrs,
      },
    });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Update an object (admin operation — direct update, not through action lifecycle)
app.patch("/api/objects/:id", async (req: Request, res: Response) => {
  try {
    const id = queryStr(req.params.id);
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const { display_name, attributes } = req.body as {
      display_name?: string;
      attributes?: Record<string, unknown>;
    };

    const supabase = getSupabaseClient();

    // Fetch current object to get existing attributes for merge
    const { data: existing, error: fetchError } = await supabase
      .from("ontology_objects")
      .select("id, display_name, attributes")
      .eq("id", id)
      .eq("workspace_id", workspace_id)
      .single();
    if (fetchError || !existing) {
      return res
        .status(400)
        .json({ error: fetchError?.message ?? "Object not found" });
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (display_name !== undefined) updates.display_name = display_name;

    // If attributes provided, merge with existing
    const mergedAttrs = attributes
      ? { ...(existing.attributes as Record<string, unknown>), ...attributes }
      : (existing.attributes as Record<string, unknown>);

    if (attributes) {
      updates.attributes = mergedAttrs;
    }

    const { error: updateError } = await supabase
      .from("ontology_objects")
      .update(updates)
      .eq("id", id)
      .eq("workspace_id", workspace_id);
    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    // Sync normalized properties if attributes changed
    if (attributes) {
      const currentKeys = Object.entries(mergedAttrs)
        .filter(([k, v]) => !k.startsWith("_") && v !== null && v !== undefined)
        .map(([k]) => k);

      let staleDelete = supabase
        .from("ontology_properties")
        .delete()
        .eq("object_id", id);
      if (currentKeys.length > 0) {
        staleDelete = staleDelete.notIn("key", currentKeys);
      }
      await staleDelete;

      for (const [key, value] of Object.entries(mergedAttrs)) {
        if (key.startsWith("_")) continue;
        if (value === null || value === undefined) continue;
        await supabase.from("ontology_properties").upsert(
          {
            workspace_id,
            object_id: id,
            key,
            value: value as unknown,
            value_type:
              typeof value === "number"
                ? "number"
                : typeof value === "boolean"
                  ? "boolean"
                  : "string",
          },
          { onConflict: "workspace_id, object_id, key" },
        );
      }
    }

    // Refresh the semantic chunk whenever the object's searchable surface
    // changed. A rename changes it just as much as an attribute edit, so
    // this sits outside the `attributes` branch.
    if (display_name !== undefined || attributes) {
      try {
        await upsertObjectChunk(
          workspace_id,
          id,
          display_name ?? (existing.display_name as string) ?? id,
          mergedAttrs,
        );
      } catch (err) {
        // Non-fatal — the update landed, the chunk is just stale.
        process.stderr.write(
          `PATCH /api/objects/${id}: embedding failed: ${getErrorMessage(err)}\n`,
        );
      }
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Delete an object (cascades to properties + chunks via FK)
app.delete("/api/objects/:id", async (req: Request, res: Response) => {
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
      .from("ontology_objects")
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

// ---------------------------------------------------------------------------
// Relations — edges between ontology objects
//
// `predicate` is free text; `ontology_relation_types` (below) lets a
// workspace declare and label the predicates it uses, but relations do not
// FK to it, so an unregistered predicate is still valid.
// ---------------------------------------------------------------------------

const RELATION_COLUMNS =
  "id, subject_id, predicate, object_id, attributes, created_at";

/**
 * Confirm both endpoints of a relation live in the given workspace.
 *
 * The service-role key bypasses RLS, so without this check a caller could
 * link objects across workspace boundaries and read one workspace's data
 * through another's relation graph.
 *
 * Returns an error message, or null when both objects check out.
 */
async function verifyRelationEndpoints(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
  subjectId: string,
  objectId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("ontology_objects")
    .select("id")
    .eq("workspace_id", workspaceId)
    .in("id", [subjectId, objectId]);
  if (error) return error.message;

  const found = new Set((data ?? []).map((row) => row.id as string));
  const missing = [subjectId, objectId].filter((id) => !found.has(id));
  if (missing.length > 0) {
    return `Object(s) not found in workspace: ${[...new Set(missing)].join(", ")}`;
  }
  return null;
}

// List relations, optionally filtered by either endpoint or by predicate
app.get("/api/relations", async (req: Request, res: Response) => {
  try {
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const subjectId = queryStr(req.query.subject_id) || "";
    const objectId = queryStr(req.query.object_id) || "";
    const predicate = queryStr(req.query.predicate) || "";
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    const supabase = getSupabaseClient();
    let builder = supabase
      .from("ontology_relations")
      .select(RELATION_COLUMNS, { count: "exact" })
      .eq("workspace_id", workspace_id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (subjectId) builder = builder.eq("subject_id", subjectId);
    if (objectId) builder = builder.eq("object_id", objectId);
    if (predicate) builder = builder.eq("predicate", predicate);

    const { data, error, count } = await builder;
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ relations: data ?? [], total: count ?? 0 });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Create a relation
app.post("/api/relations", async (req: Request, res: Response) => {
  try {
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const { subject_id, predicate, object_id, attributes } = req.body as {
      subject_id?: string;
      predicate?: string;
      object_id?: string;
      attributes?: Record<string, unknown>;
    };
    if (!subject_id || !predicate || !object_id) {
      return res.status(400).json({
        error: "subject_id, predicate, and object_id are required",
      });
    }

    const supabase = getSupabaseClient();
    const endpointError = await verifyRelationEndpoints(
      supabase,
      workspace_id,
      subject_id,
      object_id,
    );
    if (endpointError) {
      return res.status(400).json({ error: endpointError });
    }

    const { data, error } = await supabase
      .from("ontology_relations")
      .insert({
        workspace_id,
        subject_id,
        predicate,
        object_id,
        attributes: attributes ?? {},
      })
      .select(RELATION_COLUMNS)
      .single();
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ relation: data });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Update a relation's predicate or attributes. Endpoints are immutable —
// re-pointing an edge is a delete plus a create, so the intent stays explicit.
app.patch("/api/relations/:id", async (req: Request, res: Response) => {
  try {
    const id = queryStr(req.params.id);
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const { predicate, attributes } = req.body as {
      predicate?: string;
      attributes?: Record<string, unknown>;
    };
    if (predicate === undefined && attributes === undefined) {
      return res
        .status(400)
        .json({ error: "predicate or attributes is required" });
    }

    const updates: Record<string, unknown> = {};
    if (predicate !== undefined) updates.predicate = predicate;
    if (attributes !== undefined) updates.attributes = attributes;

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("ontology_relations")
      .update(updates)
      .eq("id", id)
      .eq("workspace_id", workspace_id)
      .select(RELATION_COLUMNS)
      .single();
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ relation: data });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Delete a relation
app.delete("/api/relations/:id", async (req: Request, res: Response) => {
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
      .from("ontology_relations")
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

// ---------------------------------------------------------------------------
// Relation types — the workspace's vocabulary of predicates
// ---------------------------------------------------------------------------

app.get("/api/relation-types", async (req: Request, res: Response) => {
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
      .from("ontology_relation_types")
      .select("id, predicate, label, created_at")
      .eq("workspace_id", workspace_id)
      .order("predicate", { ascending: true });
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ relation_types: data ?? [] });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Create or relabel a relation type. Upserts on (workspace_id, predicate)
// so registering an already-known predicate updates its label instead of
// failing on the unique constraint.
app.post("/api/relation-types", async (req: Request, res: Response) => {
  try {
    const workspace_id =
      queryStr(req.query.workspace_id) ||
      process.env.DEFAULT_WORKSPACE_ID ||
      "";
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const { predicate, label } = req.body as {
      predicate?: string;
      label?: string;
    };
    if (!predicate) {
      return res.status(400).json({ error: "predicate is required" });
    }

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("ontology_relation_types")
      .upsert(
        { workspace_id, predicate, label: label ?? null },
        { onConflict: "workspace_id, predicate" },
      )
      .select("id, predicate, label, created_at")
      .single();
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json({ relation_type: data });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Delete a relation type. Existing relations using the predicate are left
// alone — the predicate is free text, this only drops the label.
app.delete("/api/relation-types/:id", async (req: Request, res: Response) => {
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
      .from("ontology_relation_types")
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
