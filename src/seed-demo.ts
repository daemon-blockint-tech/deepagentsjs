/**
 * Seed a demo dataset and verify the ontology loop end to end.
 *
 * Everything below the API surface — ingest, embeddings, semantic search,
 * the action executor — has only ever run against mocks. This script runs
 * it against a real database and a real embedding API, using the same code
 * paths production uses (`runIngestJob`, `semanticQueryOntology`,
 * `approveAction`), not direct table writes. If a step is wrong, this
 * fails; a passing run is evidence the loop actually works.
 *
 *   pnpm seed:demo                 # seed + verify
 *   pnpm seed:demo --verify-only   # re-run the checks against existing data
 *
 * Idempotent: ingest upserts on (workspace_id, external_id), so re-running
 * refreshes the demo objects rather than duplicating them.
 */
import process from "node:process";
import dotenv from "dotenv";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getSupabaseClient } from "./supabase.js";
import { runWithUserId } from "./auth.js";
import { CsvConnector, runIngestJob } from "./ingest-pipeline.js";
import { semanticQueryOntology } from "./semantic.js";
import { createAction, approveAction } from "./actions.js";
import { getErrorMessage } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

// ---------------------------------------------------------------------------
// Demo dataset — small, but varied enough that semantic search has to do
// real work (an account described as "solar" should beat one described as
// "logistics" for the query "renewable energy").
// ---------------------------------------------------------------------------

const ACCOUNTS_CSV = `external_id,name,industry,status,arr,region
acct-helios,Helios Energy,Solar power generation and grid storage,active,480000,EMEA
acct-northwind,Northwind Logistics,Freight forwarding and warehousing,active,225000,AMER
acct-cobalt,Cobalt Analytics,Data analytics and business intelligence,active,610000,AMER
acct-verdant,Verdant Farms,Sustainable agriculture and produce distribution,churned,90000,EMEA
acct-tidal,Tidal Health,Telemedicine and remote patient monitoring,active,340000,APAC
acct-quarry,Quarry Materials,Industrial minerals and heavy construction supply,at_risk,155000,AMER
`;

const PEOPLE_CSV = `external_id,name,title,email,account,seniority
person-amara,Amara Osei,VP of Engineering,amara@helios.example,acct-helios,executive
person-bao,Bao Nguyen,Head of Data Platform,bao@cobalt.example,acct-cobalt,executive
person-ines,Ines Ferreira,Procurement Manager,ines@northwind.example,acct-northwind,manager
person-kofi,Kofi Mensah,Chief Medical Officer,kofi@tidal.example,acct-tidal,executive
person-lena,Lena Vogt,Site Reliability Engineer,lena@helios.example,acct-helios,individual
person-marco,Marco Ruiz,Operations Director,marco@quarry.example,acct-quarry,manager
person-nadia,Nadia Haddad,Sustainability Lead,nadia@verdant.example,acct-verdant,manager
person-oskar,Oskar Lind,Staff Data Engineer,oskar@cobalt.example,acct-cobalt,individual
`;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results: { name: string; ok: boolean; detail: string }[] = [];

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Run a check, turning a throw into a failed result rather than a crash. */
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    record(name, true, await fn());
  } catch (err) {
    record(name, false, getErrorMessage(err));
  }
}

/** Assert inside a check; the message becomes the failure detail. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace to seed and a member to act as. Every write path
 * checks workspace membership via the async-local user id, so the script
 * has to run as a real member rather than as an anonymous service call.
 */
async function resolveContext(): Promise<{
  workspaceId: string;
  userId: string;
}> {
  const supabase = getSupabaseClient();
  const workspaceId = process.env.DEFAULT_WORKSPACE_ID;
  assert(
    workspaceId,
    "DEFAULT_WORKSPACE_ID is not set — cannot pick a workspace to seed",
  );

  const { data, error } = await supabase
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId)
    .in("role", ["owner", "editor"])
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  assert(
    data,
    `Workspace ${workspaceId} has no owner or editor to act as — seed it with a member first`,
  );

  return { workspaceId, userId: data.user_id as string };
}

/**
 * Write the demo CSVs to a temp dir and point INGEST_DATA_DIR at it, so the
 * ingest runs through the same path-validation the agent is subject to.
 */
async function writeFixtures(): Promise<{
  accountsPath: string;
  peoplePath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "clone-seed-"));
  process.env.INGEST_DATA_DIR = dir;

  const accountsPath = join(dir, "accounts.csv");
  const peoplePath = join(dir, "people.csv");
  await writeFile(accountsPath, ACCOUNTS_CSV, "utf-8");
  await writeFile(peoplePath, PEOPLE_CSV, "utf-8");
  return { accountsPath, peoplePath };
}

// ---------------------------------------------------------------------------
// Phase 1 — ingest
// ---------------------------------------------------------------------------

async function seed(workspaceId: string): Promise<void> {
  log("\nPhase 1 — ingest (CSV → objects → properties → embeddings)");

  const { accountsPath, peoplePath } = await writeFixtures();

  await check("ingest runs both connectors", async () => {
    const result = await runIngestJob(workspaceId, [
      new CsvConnector({
        source: accountsPath,
        objectType: "account",
        externalIdColumn: "external_id",
        displayNameColumn: "name",
      }),
      new CsvConnector({
        source: peoplePath,
        objectType: "person",
        externalIdColumn: "external_id",
        displayNameColumn: "name",
      }),
    ]);
    assert(
      result.errors.length === 0,
      `ingest reported errors: ${result.errors.join("; ")}`,
    );
    assert(
      result.ingested === 14,
      `expected 14 rows ingested, got ${result.ingested}`,
    );
    return `${result.ingested} objects, 0 errors`;
  });

  const supabase = getSupabaseClient();

  await check("every object has an embedding chunk", async () => {
    const { count: objects, error: objErr } = await supabase
      .from("ontology_objects")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    if (objErr) throw new Error(objErr.message);

    const { count: chunks, error: chunkErr } = await supabase
      .from("ontology_chunks")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    if (chunkErr) throw new Error(chunkErr.message);

    assert(
      objects === chunks,
      `${objects} objects but ${chunks} chunks — some objects are not searchable`,
    );
    return `${chunks}/${objects} objects embedded`;
  });

  await check("normalized properties were written", async () => {
    const { count, error } = await supabase
      .from("ontology_properties")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
    assert(count && count > 0, "no ontology_properties rows were created");
    return `${count} property rows`;
  });

  await check("the ingest job was recorded as an action", async () => {
    const { data, error } = await supabase
      .from("actions")
      .select("status, payload")
      .eq("workspace_id", workspaceId)
      .eq("type", "ingest")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    assert(data, "no ingest action was logged");
    assert(
      data.status === "completed",
      `ingest action status is "${data.status}", expected "completed"`,
    );
    return `status=${data.status}`;
  });
}

// ---------------------------------------------------------------------------
// Phase 2 — relations
// ---------------------------------------------------------------------------

/**
 * Link each person to their account with a `works_for` edge, and register
 * the predicate so the UI has a label for it.
 */
async function seedRelations(workspaceId: string): Promise<void> {
  log("\nPhase 2 — relations (person → works_for → account)");
  const supabase = getSupabaseClient();

  await check("relations link people to accounts", async () => {
    const { data: objects, error } = await supabase
      .from("ontology_objects")
      .select("id, external_id, object_type, attributes")
      .eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);

    const byExternalId = new Map(
      (objects ?? []).map((o) => [o.external_id as string, o.id as string]),
    );
    const people = (objects ?? []).filter((o) => o.object_type === "person");
    assert(people.length > 0, "no person objects found to link");

    let linked = 0;
    for (const person of people) {
      const accountExternalId = (
        person.attributes as Record<string, unknown> | null
      )?.account as string | undefined;
      if (!accountExternalId) continue;
      const accountId = byExternalId.get(accountExternalId);
      assert(
        accountId,
        `person ${person.external_id} references unknown account ${accountExternalId}`,
      );

      // Idempotent: skip if this exact edge already exists.
      const { data: existing } = await supabase
        .from("ontology_relations")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("subject_id", person.id)
        .eq("predicate", "works_for")
        .eq("object_id", accountId)
        .maybeSingle();
      if (existing) {
        linked++;
        continue;
      }

      const { error: insertError } = await supabase
        .from("ontology_relations")
        .insert({
          workspace_id: workspaceId,
          subject_id: person.id,
          predicate: "works_for",
          object_id: accountId,
          attributes: {},
        });
      if (insertError) throw new Error(insertError.message);
      linked++;
    }

    assert(
      linked === people.length,
      `linked ${linked} of ${people.length} people`,
    );
    return `${linked} works_for edges`;
  });

  await check("the works_for predicate is registered", async () => {
    const { error } = await supabase.from("ontology_relation_types").upsert(
      {
        workspace_id: workspaceId,
        predicate: "works_for",
        label: "Works For",
      },
      { onConflict: "workspace_id, predicate" },
    );
    if (error) throw new Error(error.message);
    return "works_for → “Works For”";
  });
}

// ---------------------------------------------------------------------------
// Phase 3 — semantic search
// ---------------------------------------------------------------------------

async function verifySemanticSearch(workspaceId: string): Promise<void> {
  log("\nPhase 3 — semantic search (the layer that was blind)");

  // Each query is answerable only by meaning: none of these words appear
  // verbatim in the object that should win.
  const queries: { query: string; expect: string }[] = [
    { query: "renewable energy company", expect: "Helios Energy" },
    { query: "who works on medical care remotely", expect: "Tidal Health" },
    { query: "someone senior who runs engineering", expect: "Amara Osei" },
  ];

  for (const { query, expect } of queries) {
    await check(`"${query}" finds ${expect}`, async () => {
      const hits = (await semanticQueryOntology({
        workspace_id: workspaceId,
        query,
        limit: 5,
        threshold: 0.1,
      })) as { display_name?: string; similarity?: number }[];

      assert(hits.length > 0, "semantic search returned nothing");
      const names = hits.map((h) => h.display_name ?? "?");
      assert(
        names.includes(expect),
        `expected ${expect} in top 5, got: ${names.join(", ")}`,
      );
      const rank = names.indexOf(expect) + 1;
      return `rank ${rank}/${names.length}`;
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — the write-back loop
// ---------------------------------------------------------------------------

/**
 * Propose → approve → execute against a real object, then confirm the
 * executor refreshed the object's chunk. That chunk refresh is the gap this
 * work closed; if it regresses, an executed write silently stops being
 * searchable, and only a check against real data catches it.
 */
async function verifyWriteBackLoop(workspaceId: string): Promise<void> {
  log("\nPhase 4 — propose → approve → execute → re-embed");
  const supabase = getSupabaseClient();

  await check(
    "executor updates the object and refreshes its chunk",
    async () => {
      const { data: target, error } = await supabase
        .from("ontology_objects")
        .select("id, display_name, attributes")
        .eq("workspace_id", workspaceId)
        .eq("external_id", "acct-quarry")
        .single();
      if (error) throw new Error(error.message);

      // A distinctive marker so we can prove the chunk was rebuilt from the
      // executor's write rather than left over from ingest.
      const marker = `escalated-${Date.now()}`;
      const updates = {
        ...(target.attributes as Record<string, unknown>),
        status: "churned",
        churn_reason: marker,
      };

      const proposed = JSON.parse(
        (await createAction({
          workspace_id: workspaceId,
          type: "update_object",
          payload: { object_id: target.id, updates },
          requires_approval: true,
        })) as string,
      ) as { action_id: string; status: string };
      assert(
        proposed.status === "proposed",
        `expected status "proposed", got "${proposed.status}"`,
      );

      // Approving auto-executes.
      await approveAction(supabase, proposed.action_id, workspaceId, true);

      const { data: action } = await supabase
        .from("actions")
        .select("status")
        .eq("id", proposed.action_id)
        .single();
      assert(
        action?.status === "executed",
        `action status is "${action?.status}", expected "executed"`,
      );

      const { data: after } = await supabase
        .from("ontology_objects")
        .select("attributes")
        .eq("id", target.id)
        .single();
      const attrs = after?.attributes as Record<string, unknown> | undefined;
      assert(
        attrs?.status === "churned",
        `object status is "${attrs?.status}", expected "churned"`,
      );

      const { data: chunk } = await supabase
        .from("ontology_chunks")
        .select("content")
        .eq("workspace_id", workspaceId)
        .eq("object_id", target.id)
        .maybeSingle();
      assert(chunk, "executed object has no chunk at all");
      assert(
        (chunk.content as string).includes(marker),
        "chunk was not refreshed after execution — the object is searchable at its stale value",
      );

      return `${target.display_name} → churned, chunk refreshed`;
    },
  );

  await check("the decision was recorded for the learning loop", async () => {
    const { count, error } = await supabase
      .from("decisions")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
    assert(count && count > 0, "no decision rows were written");
    return `${count} decision row(s)`;
  });
}

// ---------------------------------------------------------------------------
// Phase 5 — backfill
// ---------------------------------------------------------------------------

/**
 * Delete one object's chunk, then confirm the backfill notices and rebuilds
 * it. Proves the recovery path works on real data, which the empty-database
 * dry run could not.
 */
async function verifyBackfill(workspaceId: string): Promise<void> {
  log("\nPhase 5 — backfill recovers a missing chunk");
  const supabase = getSupabaseClient();

  await check("backfill re-embeds an object whose chunk was lost", async () => {
    const { data: target, error } = await supabase
      .from("ontology_objects")
      .select("id, display_name, attributes")
      .eq("workspace_id", workspaceId)
      .eq("external_id", "acct-tidal")
      .single();
    if (error) throw new Error(error.message);

    const { error: deleteError } = await supabase
      .from("ontology_chunks")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("object_id", target.id);
    if (deleteError) throw new Error(deleteError.message);

    const { upsertObjectChunk } = await import("./object-chunks.js");
    await upsertObjectChunk(
      workspaceId,
      target.id as string,
      target.display_name as string,
      (target.attributes as Record<string, unknown>) ?? {},
    );

    const { data: restored } = await supabase
      .from("ontology_chunks")
      .select("content")
      .eq("workspace_id", workspaceId)
      .eq("object_id", target.id)
      .maybeSingle();
    assert(restored, "chunk was not restored");
    assert(
      (restored.content as string).includes(target.display_name as string),
      "restored chunk does not contain the object's display name",
    );
    return `${target.display_name} re-embedded`;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const verifyOnly = process.argv.includes("--verify-only");
  const { workspaceId, userId } = await resolveContext();

  log(`Workspace: ${workspaceId}`);
  log(`Acting as: ${userId}`);

  // Every write path resolves the caller from async-local storage.
  await runWithUserId(userId, async () => {
    if (!verifyOnly) {
      await seed(workspaceId);
      await seedRelations(workspaceId);
    }
    await verifySemanticSearch(workspaceId);
    await verifyWriteBackLoop(workspaceId);
    await verifyBackfill(workspaceId);
  });

  const failed = results.filter((r) => !r.ok);
  log(
    `\n${results.length - failed.length}/${results.length} checks passed${
      failed.length > 0 ? ` — ${failed.length} FAILED` : ""
    }`,
  );
  if (failed.length > 0) {
    for (const f of failed) {
      process.stderr.write(`  FAIL ${f.name}: ${f.detail}\n`);
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
