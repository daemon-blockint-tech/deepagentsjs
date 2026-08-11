/**
 * Backfill `ontology_chunks` for objects that have none.
 *
 * Embedding-on-write only covers objects created from the point it shipped.
 * Anything written before that — or written while the embedding API was
 * down, since every write path treats embedding failure as non-fatal — is
 * invisible to `semantic_search` until it gets a chunk. This script finds
 * those objects and embeds them.
 *
 * Safe to re-run: it only touches objects with no chunk, and the upsert is
 * idempotent.
 *
 *   pnpm backfill:chunks --dry-run
 *   pnpm backfill:chunks --workspace <uuid> --limit 500
 */
import process from "node:process";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getSupabaseClient } from "./supabase.js";
import { upsertObjectChunk } from "./object-chunks.js";
import { getErrorMessage } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Both clients read their credentials lazily on first call, so loading the
// env here — after the imports are evaluated — is still in time.
dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

/** Rows scanned per page. Bounded so memory stays flat on large workspaces. */
const PAGE_SIZE = 500;

/**
 * Objects embedded at once. The embedding API is the bottleneck and the
 * slow path; a handful in flight keeps it busy without risking rate limits.
 */
const DEFAULT_CONCURRENCY = 5;

interface Options {
  workspaceId?: string;
  dryRun: boolean;
  limit: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dryRun: false,
    limit: Infinity,
    concurrency: DEFAULT_CONCURRENCY,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--workspace") {
      opts.workspaceId = argv[++i];
    } else if (arg === "--limit") {
      opts.limit = Number(argv[++i]);
    } else if (arg === "--concurrency") {
      opts.concurrency = Number(argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) {
    throw new Error("--concurrency must be a positive number");
  }
  if (Number.isNaN(opts.limit) || opts.limit < 1) {
    throw new Error("--limit must be a positive number");
  }
  return opts;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

interface ObjectRow {
  id: string;
  workspace_id: string;
  display_name: string | null;
  attributes: Record<string, unknown> | null;
}

/**
 * Scan objects a page at a time, yielding only those with no chunk.
 *
 * The "which of these have chunks" lookup is scoped to each page rather
 * than loading every chunk id up front, so memory stays flat regardless of
 * how many objects the workspace has.
 */
async function* findObjectsWithoutChunks(
  workspaceId: string | undefined,
): AsyncGenerator<ObjectRow> {
  const supabase = getSupabaseClient();

  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = supabase
      .from("ontology_objects")
      .select("id, workspace_id, display_name, attributes")
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (workspaceId) query = query.eq("workspace_id", workspaceId);

    const { data: objects, error } = await query;
    if (error) throw new Error(error.message);
    if (!objects || objects.length === 0) return;

    const ids = objects.map((o) => o.id as string);
    const { data: chunks, error: chunkError } = await supabase
      .from("ontology_chunks")
      .select("object_id")
      .in("object_id", ids);
    if (chunkError) throw new Error(chunkError.message);

    const embedded = new Set((chunks ?? []).map((c) => c.object_id as string));
    for (const object of objects as ObjectRow[]) {
      if (!embedded.has(object.id)) yield object;
    }

    if (objects.length < PAGE_SIZE) return;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  log(
    `Backfilling ontology_chunks${opts.workspaceId ? ` for workspace ${opts.workspaceId}` : " across all workspaces"}` +
      `${opts.dryRun ? " (dry run)" : ""}`,
  );

  let found = 0;
  let embedded = 0;
  const errors: string[] = [];
  let batch: ObjectRow[] = [];

  const flush = async () => {
    await Promise.all(
      batch.map(async (object) => {
        try {
          await upsertObjectChunk(
            object.workspace_id,
            object.id,
            object.display_name ?? object.id,
            object.attributes ?? {},
          );
          embedded++;
        } catch (err) {
          errors.push(`${object.id}: ${getErrorMessage(err)}`);
        }
      }),
    );
    batch = [];
    log(`  ${embedded} embedded, ${errors.length} failed…`);
  };

  for await (const object of findObjectsWithoutChunks(opts.workspaceId)) {
    found++;
    if (opts.dryRun) {
      log(`  would embed ${object.id} (${object.display_name ?? "unnamed"})`);
    } else {
      batch.push(object);
      if (batch.length >= opts.concurrency) await flush();
    }
    if (found >= opts.limit) break;
  }
  if (batch.length > 0) await flush();

  log(
    opts.dryRun
      ? `\n${found} object(s) missing chunks. Re-run without --dry-run to embed them.`
      : `\nDone: ${embedded}/${found} object(s) embedded, ${errors.length} failed.`,
  );

  if (errors.length > 0) {
    for (const err of errors.slice(0, 20)) process.stderr.write(`  ${err}\n`);
    if (errors.length > 20) {
      process.stderr.write(`  …and ${errors.length - 20} more\n`);
    }
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  process.stderr.write(`${getErrorMessage(err)}\n`);
  process.exitCode = 1;
}
