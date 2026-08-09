import { queryOntologyTool, proposeActionTool } from "../../tools.js";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * SDK tool service: list and describe tools for external clients.
 */
export function listTools(): ToolDefinition[] {
  // The underlying tools are already LangChain Tool instances.
  return [
    {
      name: queryOntologyTool.name,
      description: queryOntologyTool.description,
      parameters: {},
    },
    {
      name: proposeActionTool.name,
      description: proposeActionTool.description,
      parameters: {},
    },
  ];
}
