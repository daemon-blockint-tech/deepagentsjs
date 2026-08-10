import { z } from "zod"
import { tool } from "@langchain/core/tools"
import { queryInterfaceObjects, executeInterfaceAction } from "./interfaces.js"
import { withRetry, isTransientError } from "./fault-tolerance.js"

const DEFAULT_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffFactor: 2,
  retryOn: isTransientError,
}

/**
 * Query ontology objects through an Interface filter.
 *
 * Interfaces are access-controlled views over the Ontology. They define:
 * - property_whitelist: which attributes are visible
 * - required_properties: which attributes must be present
 * - object_type: which object types are included
 * - markings: semantic tags for grouping
 *
 * Specialists use this to read only the data they're authorized to see.
 * For example, a "Pricing Specialist" might have an interface that only
 * exposes `price`, `currency`, and `competitor` fields — not internal notes.
 */
export const queryInterfaceTool = tool(
  withRetry(async ({ workspace_id, interface_slug, query, limit }) => {
    const results = await queryInterfaceObjects(
      workspace_id,
      interface_slug,
      query,
      limit
    )
    return JSON.stringify(results)
  }, DEFAULT_RETRY),
  {
    name: "query_interface",
    description:
      "Query ontology objects through an Interface (access-controlled view). " +
      "Interfaces filter which properties are visible and which object types are included. " +
      "Use this when you need scoped access to the Ontology — e.g. only pricing data, " +
      "only customer data, only public fields. " +
      "The interface_slug identifies which interface to use (e.g. 'pricing-view', 'customer-summary').",
    schema: z.object({
      workspace_id: z.string().uuid(),
      interface_slug: z
        .string()
        .describe("Interface slug (e.g. 'pricing-view', 'customer-summary', 'competitor-data')"),
      query: z
        .string()
        .optional()
        .describe("Search text for display_name or external_id"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 10)"),
    }),
  }
)

/**
 * Propose an action through an Interface.
 *
 * Validates required properties and filters the payload to only
 * whitelisted properties before proposing. This ensures specialists
 * can only propose changes to fields they're authorized to modify.
 */
export const proposeInterfaceActionTool = tool(
  withRetry(async ({ workspace_id, interface_slug, action_type, payload }) => {
    const result = await executeInterfaceAction(
      workspace_id,
      interface_slug,
      action_type,
      payload
    )
    return JSON.stringify(result)
  }, DEFAULT_RETRY),
  {
    name: "propose_interface_action",
    description:
      "Propose an action through an Interface (access-controlled write). " +
      "Validates required properties and filters payload to whitelisted fields only. " +
      "Use this when a specialist needs to propose changes within its authorized scope. " +
      "The interface determines which fields can be modified.",
    schema: z.object({
      workspace_id: z.string().uuid(),
      interface_slug: z
        .string()
        .describe("Interface slug that defines the allowed scope"),
      action_type: z
        .string()
        .describe("Action type (e.g. 'update_object', 'create_object')"),
      payload: z
        .record(z.unknown())
        .describe("Action payload (will be filtered to whitelisted properties)"),
    }),
  }
)
