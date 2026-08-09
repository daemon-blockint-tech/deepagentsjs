import { queryOntologyTool } from "../../tools.js";
import { semanticQueryOntology } from "../../semantic.js";
import { queryInterfaceObjects } from "../../interfaces.js";
import { queryObjectSet } from "../object-set.js";

export interface DataQueryInput {
  workspace_id: string;
  query: string;
  limit?: number;
  semantic?: boolean;
  interface_slug?: string;
}

/**
 * Data tool service: read objects from ontology.
 * Combines text search, semantic search, interface projection, and object-set queries.
 */
export async function queryData(input: DataQueryInput): Promise<unknown[]> {
  if (input.semantic) {
    return semanticQueryOntology({
      workspace_id: input.workspace_id,
      query: input.query,
      limit: input.limit ?? 10,
    });
  }

  if (input.interface_slug) {
    return queryInterfaceObjects(
      input.workspace_id,
      input.interface_slug,
      input.query,
      input.limit ?? 10
    );
  }

  const raw = await queryOntologyTool.invoke({
    workspace_id: input.workspace_id,
    query: input.query,
    limit: input.limit ?? 10,
  });
  return JSON.parse(raw as string) as unknown[];
}

export { queryObjectSet };
