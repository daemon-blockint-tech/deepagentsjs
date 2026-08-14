/**
 * Backward compatibility shim — all agent logic now lives in supervisor.ts.
 *
 * The supervisor module exports the multi-agent registry (orchestrator +
 * research, analysis, action specialists) plus all HITL/eval/orchestration
 * helpers that server.ts and other files depend on.
 *
 * This file re-exports everything so existing imports (`from "./agent.js"`)
 * continue to work without changes.
 */
export {
  getCloneAgent,
  threadConfig,
  extractInterrupt,
  getPendingApproval,
  resumeAgent,
  evaluateAgent,
  orchestrateAgent,
  DEFAULT_MODEL,
  AGENT_VERSION,
  CLONE_INTERRUPT_ON,
  checkpointer,
  store,
  backend,
} from "./supervisor.js";

export type {
  PendingApproval,
  AgentEvaluationInput,
  OrchestrationInput,
} from "./supervisor.js";
