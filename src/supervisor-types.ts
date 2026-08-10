/**
 * Shared type for DeepAgent instances.
 *
 * Kept in a separate file to avoid circular imports between
 * supervisor.ts and delegation-tools.ts.
 */
export type Agent = ReturnType<
  typeof import("deepagents").createDeepAgent
>
