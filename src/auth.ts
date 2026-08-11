import { AsyncLocalStorage } from "node:async_hooks";

import { getSupabaseClient } from "./supabase.js";

const userContext = new AsyncLocalStorage<string | null>();
let legacyUserId: string | null = null;

export function getCurrentUserId(): string | null {
  return userContext.getStore() ?? legacyUserId;
}

/** Run request-scoped work without leaking identity across concurrent requests. */
export function runWithUserId<T>(userId: string | null, callback: () => T): T {
  return userContext.run(userId, callback);
}

/**
 * Legacy setter retained for non-request-scoped engine routes.
 * Prefer runWithUserId for async request handlers.
 */
export function setCurrentUserId(userId: string | null): void {
  legacyUserId = userId;
}

/**
 * Throw unless the current user is a member of the workspace.
 *
 * The service-role key bypasses RLS, so this is the check that actually
 * keeps one workspace's data out of another's reach. Every tool and query
 * that takes a `workspace_id` from its caller must call it first.
 *
 * `workspace_members` is keyed by (workspace_id, user_id) and has no `id`
 * column — selecting one makes PostgREST reject the query, which reads as
 * "access denied" for every caller. Select a column that exists.
 */
export async function verifyWorkspaceMembership(
  supabase: ReturnType<typeof getSupabaseClient>,
  workspaceId: string,
): Promise<void> {
  const userId = getCurrentUserId();
  if (!userId) {
    throw new Error("Unauthorized: no current user");
  }

  const { data, error } = await supabase
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Workspace membership check failed: ${error.message}`);
  }
  if (!data) {
    throw new Error("Workspace access denied");
  }
}
