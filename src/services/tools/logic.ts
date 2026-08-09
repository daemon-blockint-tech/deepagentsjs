import { getCloneAgent } from "../../agent.js";

export interface LogicRunInput {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  enable_tools?: boolean;
}

/**
 * Logic tool service: run model-based reasoning.
 * Wraps getCloneAgent for rule execution, classification, or generation tasks.
 */
export async function runLogic(input: LogicRunInput) {
  const activeAgent = await getCloneAgent(input.model);
  const result = await activeAgent.invoke({ messages: input.messages });
  return result;
}
