import { getSupabaseClient } from "../../supabase.js";
import { proposeActionTool } from "../../tools.js";
import { approveAction, executeAction } from "../../actions.js";

export interface ProposeInput {
  workspace_id: string;
  type: string;
  payload: Record<string, unknown>;
  requires_approval?: boolean;
}

/**
 * Action tool service: propose, approve, and execute ontology mutations.
 */
export async function propose(input: ProposeInput) {
  const result = await proposeActionTool.invoke({
    workspace_id: input.workspace_id,
    type: input.type,
    payload: input.payload,
    requires_approval: input.requires_approval,
  });
  return JSON.parse(result as string) as { action_id: string; status: string };
}

export async function approve(
  actionId: string,
  workspaceId: string,
  approved: boolean,
) {
  const supabase = getSupabaseClient();
  await approveAction(supabase, actionId, workspaceId, approved);
}

export async function execute(actionId: string, workspaceId: string) {
  const supabase = getSupabaseClient();
  await executeAction(supabase, actionId, workspaceId);
}
