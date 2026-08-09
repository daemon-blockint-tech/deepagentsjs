import { AsyncLocalStorage } from "node:async_hooks";

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
