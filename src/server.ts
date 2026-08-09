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
import { z } from "zod";
import { traceable } from "langsmith/traceable";
import { getCloneAgent } from "./agent.js";
import { getCurrentUserId, runWithUserId } from "./auth.js";
import { register } from "./metrics.js";
import { rateLimitMiddleware } from "./rate-limit.js";
import { getSupabaseClient } from "./supabase.js";
import { parseDocuments, type DocumentPayload } from "./udop.js";
import { semanticQueryOntology } from "./semantic.js";
import { approveAction, executeAction } from "./actions.js";
import { evaluateAutomations, startAutomationScheduler } from "./automations.js";
import { queryInterfaceObjects, executeInterfaceAction } from "./interfaces.js";
import { queryObjectSet } from "./services/object-set.js";
import { createObjectType, listObjectTypes, createInterface, listInterfaces } from "./services/metadata.js";
import { uploadFile, downloadFile, deleteFile } from "./storage.js";
import { createMediaSet, addMediaSetItem, getMediaSet, listMediaSets } from "./media-sets.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load root .env.local first, then backend/.env.local to allow overrides
dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const app: Express = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json({ limit: "50mb" }));
app.use("/api/chat", rateLimitMiddleware());

// Legacy engine routes use the configured service identity in an isolated async context.
// User-facing chat routes override this with the authenticated request identity below.
function withDefaultUser(
  _req: Request,
  _res: Response,
  next: NextFunction
): void {
  runWithUserId(process.env.DEFAULT_USER_ID ?? null, next);
}

app.use("/api", withDefaultUser);

app.get("/metrics", async (_req: Request, res: Response) => {
  res.setHeader("Content-Type", register.contentType);
  res.send(await register.metrics());
});

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  const err = error as { message?: unknown; toString?: () => string } | undefined;
  if (typeof err?.message === "string") return err.message;
  if (typeof err?.toString === "function") return err.toString();
  return "Unknown error";
}

const openRouterApiKey = process.env.OPENROUTER_API_KEY;
if (!openRouterApiKey) {
  process.stderr.write("OPENROUTER_API_KEY is not set. /api/chat will fail.\n");
}

const langSmithEnabled = process.env.LANGSMITH_TRACING === "true" && !!process.env.LANGSMITH_API_KEY;
if (langSmithEnabled) {
  process.stdout.write(`LangSmith tracing enabled for project: ${process.env.LANGSMITH_PROJECT || "default"}\n`);
}

interface ChatInput {
  messages: Array<{ role: string; content: string }>;
  model?: string;
}

interface ChatContext extends ChatInput {
  context: string;
}

interface AiMessageLike {
  getType?: () => string;
  _getType?: () => string;
  content: unknown;
}

interface AgentChunk {
  messages?: Array<unknown>;
}

const chatMessageSchema = z.object({
  role: z.string().min(1),
  content: z.string().min(1),
});

const documentSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  content: z.string().min(1), // base64 encoded
});

const chatBodySchema = z.object({
  messages: z.array(chatMessageSchema).min(1),
  model: z.string().optional(),
  documents: z.array(documentSchema).optional(),
});

function parseChatBody(body: unknown) {
  const result = chatBodySchema.safeParse(body);
  if (!result.success) {
    throw new Error(result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "));
  }
  return result.data;
}

const ingest = traceable(
  async (
    messages: Array<{ role: string; content: string }>,
    documents: DocumentPayload[] | undefined,
    model?: string
  ): Promise<ChatInput> => {
    const enriched = [...messages];
    if (documents && documents.length > 0) {
      const parsed = await parseDocuments(documents);
      for (const doc of parsed) {
        enriched.push({
          role: "user",
          content: `Document "${doc.name}" (${doc.type}):\n${doc.text}`,
        });
      }
    }
    return { messages: enriched, model };
  },
  {
    name: "ingest",
    run_type: "tool",
  }
);

const retrieve = traceable(
  async (input: ChatInput): Promise<ChatContext> => {
    const workspaceId = process.env.DEFAULT_WORKSPACE_ID;
    const userId = getCurrentUserId();
    if (!workspaceId || !userId) {
      return { ...input, context: "" };
    }

    const userMessage = input.messages
      .filter((m) => m.role === "user")
      .pop()?.content;
    if (!userMessage) {
      return { ...input, context: "" };
    }

    let results: unknown[] = [];
    try {
      results = await semanticQueryOntology({
        workspace_id: workspaceId,
        query: userMessage,
        limit: 10,
        threshold: 0.5,
      });
    } catch {
      // If semantic search fails (e.g. no API key), continue without context
    }

    const context = results.length
      ? JSON.stringify({ workspace_id: workspaceId, chunks: results }, null, 2)
      : "";

    const contextualMessages = [...input.messages];
    if (context) {
      contextualMessages.splice(contextualMessages.length - 1, 0, {
        role: "system",
        content: `Relevant ontology chunks from workspace:\n${context}`,
      });
    }

    return { messages: contextualMessages, model: input.model, context };
  },
  {
    name: "retrieve",
    run_type: "retriever",
  }
);

const generate = traceable(
  async (ctx: ChatContext) => {
    const activeAgent = await getCloneAgent(ctx.model);
    const result = await activeAgent.invoke({ messages: ctx.messages });
    return result;
  },
  {
    name: "generate",
    run_type: "llm",
  }
);

const runChat = traceable(
  async (
    messages: Array<{ role: string; content: string }>,
    documents: DocumentPayload[] | undefined,
    model?: string
  ) => {
    const input = await ingest(messages, documents, model);
    const ctx = await retrieve(input);
    return generate(ctx);
  },
  {
    name: "clone_chat",
    run_type: "chain",
  }
);

// Identity is derived from the caller's Supabase access token, never from a
// client-supplied user id header (which would be trivially spoofable).
async function getAuthenticatedUserId(req: Request): Promise<string | null> {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) return null;
  try {
    const { data, error } = await getSupabaseClient().auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

function getLatestAiContent(chunk: AgentChunk) {
  const messages = chunk.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const last = messages[messages.length - 1] as AiMessageLike | undefined;
  const type = last?.getType?.() ?? last?._getType?.();
  if (type !== "ai" || !last) return null;

  const content = last.content;
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return null;
  return JSON.stringify(content as Record<string, unknown> | Array<unknown>);
}

app.get("/health", (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    openrouter_configured: !!openRouterApiKey,
    langsmith_tracing: langSmithEnabled,
  });
});

app.post("/api/chat", async (req: Request, res: Response) => {
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { messages, model, documents } = parseChatBody(req.body);
    const result = await runWithUserId(userId, () =>
      runChat(messages, documents, model)
    );
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/chat/stream", async (req: Request, res: Response) => {
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  let body: z.infer<typeof chatBodySchema>;
  try {
    body = parseChatBody(req.body);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }

  const { messages, model, documents } = body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let disconnected = false;
  req.on("aborted", () => {
    disconnected = true;
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      disconnected = true;
    }
  });

  try {
    await runWithUserId(userId, async () => {
      const input = await ingest(messages, documents, model);
      const ctx = await retrieve(input);
      const activeAgent = await getCloneAgent(model);
      const stream = await activeAgent.stream({ messages: ctx.messages });

      for await (const chunk of stream) {
        if (disconnected) break;
        const content = getLatestAiContent(chunk as AgentChunk);
        if (content) {
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }
    });

    if (disconnected || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    return res.end();
  } catch (error) {
    if (disconnected || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ error: getErrorMessage(error) })}\n\n`);
    return res.end();
  }
});

// Action lifecycle routes
app.post("/api/actions/:id/approve", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { workspace_id, approved } = req.body as { workspace_id: string; approved: boolean };
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
      const supabase = getSupabaseClient();
      await approveAction(supabase, id, workspace_id, approved === true);
      const result = await evaluateAutomations({
        workspace_id: workspace_id,
        trigger: approved ? "action_approved" : "action_rejected",
        action_type: undefined,
      });
      return res.json({ ok: true, automation_ids: result });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/actions/:id/execute", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { workspace_id } = req.body as { workspace_id: string };
    if (!workspace_id) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
      const supabase = getSupabaseClient();
      await executeAction(supabase, id, workspace_id);
      const result = await evaluateAutomations({
        workspace_id: workspace_id,
        trigger: "action_executed",
      });
      return res.json({ ok: true, automation_ids: result });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Interface routes
app.get("/api/interfaces/:slug/objects", async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const workspace_id = (req.query.workspace_id as string) || process.env.DEFAULT_WORKSPACE_ID || "";
    const query = (req.query.query as string) || "";
    const limit = Number(req.query.limit) || 10;
      const objects = await queryInterfaceObjects(workspace_id, slug, query, limit);
      return res.json({ objects });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/interfaces/:slug/actions", async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const { workspace_id, type, payload } = req.body as {
      workspace_id: string;
      type: string;
      payload: Record<string, unknown>;
    };
    if (!workspace_id || !type || !payload) {
      return res.status(400).json({ error: "workspace_id, type, and payload are required" });
    }
      const result = await executeInterfaceAction(workspace_id, slug, type, payload);
      return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

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
      const workspace_id = (req.query.workspace_id as string) || process.env.DEFAULT_WORKSPACE_ID || "";
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
      const workspace_id = (req.query.workspace_id as string) || process.env.DEFAULT_WORKSPACE_ID || "";
      const result = await listInterfaces(workspace_id);
      return res.json({ interfaces: result });
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

// Storage upload/download
app.post("/api/upload", async (req: Request, res: Response) => {
  try {
      const { workspace_id, type, file_name, mime_type, data, object_id } = req.body as {
        workspace_id: string;
        type: "media" | "documents";
        file_name: string;
        mime_type: string;
        data: string;
        object_id?: string;
      };
      if (!workspace_id || !type || !file_name || !mime_type || !data) {
        return res.status(400).json({ error: "workspace_id, type, file_name, mime_type, and data are required" });
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
      const type = (req.query.type as "media" | "documents") || "documents";
      const result = await downloadFile({ type, id: req.params.id });
      return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.delete("/api/files/:id", async (req: Request, res: Response) => {
  try {
      const type = (req.query.type as "media" | "documents") || "documents";
      await deleteFile(type, req.params.id);
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
        return res.status(400).json({ error: "workspace_id and name are required" });
      }
      const set = await createMediaSet({ workspace_id, name, description, metadata });
      return res.json(set);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/media-sets", async (req: Request, res: Response) => {
  try {
      const workspaceId = req.query.workspace_id as string;
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
      const set = await getMediaSet(req.params.id);
      if (!set) return res.status(404).json({ error: "Media set not found" });
      return res.json(set);
  } catch (error) {
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/media-sets/:id/items", async (req: Request, res: Response) => {
  try {
      const { item_id, item_type } = req.body as { item_id: string; item_type: "media" | "document" };
      if (!item_id || !item_type) {
        return res.status(400).json({ error: "item_id and item_type are required" });
      }
      const item = await addMediaSetItem({ set_id: req.params.id, item_id, item_type });
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
  });
}

export { app };

