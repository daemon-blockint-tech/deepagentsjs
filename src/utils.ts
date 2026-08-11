export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Coerce a caught error to a string without using `instanceof`
 * (the project's `no-instanceof` lint rule forbids it).
 *
 * Handles Error, string, plain objects with a `message` or `toString`,
 * and falls back to a generic "Unknown error" sentinel.
 */
export function getErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  const err = error as
    | { message?: unknown; toString?: () => string }
    | undefined;
  if (typeof err?.message === "string") return err.message;
  if (typeof err?.toString === "function") return err.toString();
  return "Unknown error";
}
