/**
 * LangGraph Agent Server entry point.
 *
 * Exposed via `langgraph.json` so `langgraph dev` serves the standard
 * /threads, /runs/stream, /assistants API on port 2024.
 *
 * This is a graph *factory*: the server calls it per run with the
 * `LangGraphRunnableConfig`, so we can read `user_id` from the configurable
 * object and set the request-scoped identity that the tools rely on.
 *
 * v2.0: The graph is now a **supervisor** — the orchestrator agent
 * delegates to specialist agents (research, analysis, action) internally.
 * All agents share the same checkpointer and store, so thread state
 * (including paused HITL approvals) persists across the conversation.
 * The frontend sees a single unified agent via the standard API.
 */
export {
  graph,
  getCloneAgent,
  DEFAULT_MODEL,
  AGENT_VERSION,
} from "./supervisor.js";
