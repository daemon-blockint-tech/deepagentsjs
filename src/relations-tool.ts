import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { getSupabaseClient } from "./supabase.js";
import { verifyWorkspaceMembership } from "./auth.js";
import { withRetry, isTransientError } from "./fault-tolerance.js";

const MAX_RELATION_LIMIT = 50;

const DEFAULT_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffFactor: 2,
  retryOn: isTransientError,
};

interface RelationRow {
  id: string;
  subject_id: string;
  predicate: string;
  object_id: string;
  attributes: Record<string, unknown> | null;
}

interface NeighborRow {
  id: string;
  display_name: string | null;
  object_type: string | null;
  external_id: string | null;
}

/**
 * Walk the ontology graph from one object.
 *
 * `query_ontology` and `semantic_search` both find objects in isolation;
 * neither can answer "who works for Helios" or "which accounts does Bao
 * touch". This is the traversal step — given an object, return its edges
 * with the object on the other end resolved to a name and type, so the
 * agent gets an answer rather than a list of UUIDs.
 *
 * Edges are followed in both directions by default: a person's `works_for`
 * edge is outgoing from the person and incoming to the account, and which
 * one the caller wants depends on where they started.
 */
export const queryRelationsTool = tool(
  withRetry(
    async ({ workspace_id, object_id, predicate, direction, limit }) => {
      const supabase = getSupabaseClient();
      await verifyWorkspaceMembership(supabase, workspace_id);

      const safeLimit = Math.min(Math.max(1, limit ?? 25), MAX_RELATION_LIMIT);
      const dir = direction ?? "both";

      const select = "id, subject_id, predicate, object_id, attributes";
      const relations: RelationRow[] = [];

      // Two queries rather than an `.or()` so each side uses its own index
      // (idx_ontology_relations_subject / _object) instead of a sequential scan.
      if (dir === "outgoing" || dir === "both") {
        let builder = supabase
          .from("ontology_relations")
          .select(select)
          .eq("workspace_id", workspace_id)
          .eq("subject_id", object_id)
          .limit(safeLimit);
        if (predicate) builder = builder.eq("predicate", predicate);
        const { data, error } = await builder;
        if (error) throw new Error(error.message);
        relations.push(...((data ?? []) as RelationRow[]));
      }

      if (dir === "incoming" || dir === "both") {
        let builder = supabase
          .from("ontology_relations")
          .select(select)
          .eq("workspace_id", workspace_id)
          .eq("object_id", object_id)
          .limit(safeLimit);
        if (predicate) builder = builder.eq("predicate", predicate);
        const { data, error } = await builder;
        if (error) throw new Error(error.message);
        relations.push(...((data ?? []) as RelationRow[]));
      }

      if (relations.length === 0) return JSON.stringify([]);

      // Resolve the far end of each edge in one lookup. Joining here rather
      // than with a PostgREST embed keeps the query readable — ontology_relations
      // has two foreign keys to the same table, which embeds handle awkwardly.
      const neighborIds = [
        ...new Set(
          relations.flatMap((r) =>
            [r.subject_id, r.object_id].filter((id) => id !== object_id),
          ),
        ),
      ];
      const { data: neighbors, error: neighborError } = await supabase
        .from("ontology_objects")
        .select("id, display_name, object_type, external_id")
        .eq("workspace_id", workspace_id)
        .in("id", neighborIds);
      if (neighborError) throw new Error(neighborError.message);

      const byId = new Map(
        ((neighbors ?? []) as NeighborRow[]).map((n) => [n.id, n]),
      );

      const edges = relations.slice(0, safeLimit).map((r) => {
        const outgoing = r.subject_id === object_id;
        const neighborId = outgoing ? r.object_id : r.subject_id;
        const neighbor = byId.get(neighborId);
        return {
          relation_id: r.id,
          predicate: r.predicate,
          direction: outgoing ? "outgoing" : "incoming",
          // Reads naturally either way: "<this object> works_for <neighbor>"
          // or "<neighbor> works_for <this object>".
          neighbor: {
            id: neighborId,
            display_name: neighbor?.display_name ?? null,
            object_type: neighbor?.object_type ?? null,
            external_id: neighbor?.external_id ?? null,
          },
          attributes: r.attributes ?? {},
        };
      });

      return JSON.stringify(edges);
    },
    DEFAULT_RETRY,
  ),
  {
    name: "query_relations",
    description:
      "Walk the ontology graph from one object to its connected objects. " +
      "Use after query_ontology or semantic_search has given you an object id, " +
      "to answer questions about how things relate — who works for an account, " +
      "which people are attached to a company, what an object is linked to. " +
      "Returns a JSON array of edges, each with the predicate, the direction, " +
      "and the object on the other end resolved to its name and type.",
    schema: z.object({
      workspace_id: z.string().uuid(),
      object_id: z
        .string()
        .uuid()
        .describe("The object to traverse from (get this from query_ontology)"),
      predicate: z
        .string()
        .optional()
        .describe("Only follow edges with this predicate, e.g. 'works_for'"),
      direction: z
        .enum(["outgoing", "incoming", "both"])
        .optional()
        .describe(
          "outgoing = this object is the subject; incoming = it is the object; default both",
        ),
      limit: z
        .number()
        .min(1)
        .max(MAX_RELATION_LIMIT)
        .optional()
        .describe("Max edges to return (default 25)"),
    }),
  },
);
