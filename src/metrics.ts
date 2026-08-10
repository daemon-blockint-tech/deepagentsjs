import process from "node:process";
import client from "prom-client";

export const register = new client.Registry();

client.collectDefaultMetrics({
  register,
  prefix: "clone_",
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

export const httpRequestsTotal = new client.Counter({
  name: "clone_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "endpoint", "status_code"],
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: "clone_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "endpoint"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

export const chatStreamTotal = new client.Counter({
  name: "clone_chat_stream_total",
  help: "Total chat stream outcomes",
  labelNames: ["model", "outcome"],
  registers: [register],
});

export const chatFirstChunkDuration = new client.Histogram({
  name: "clone_chat_first_chunk_seconds",
  help: "Time to first chunk in chat stream",
  labelNames: ["model"],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const llmRequestDuration = new client.Histogram({
  name: "clone_llm_request_duration_seconds",
  help: "LLM request duration",
  labelNames: ["model"],
  buckets: [0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

export const llmRequestErrorsTotal = new client.Counter({
  name: "clone_llm_request_errors_total",
  help: "Total LLM request errors",
  labelNames: ["model", "error_type"],
  registers: [register],
});

export const toolCallsTotal = new client.Counter({
  name: "clone_tool_calls_total",
  help: "Total tool calls",
  labelNames: ["tool_name", "outcome"],
  registers: [register],
});

export const rateLimitViolationsTotal = new client.Counter({
  name: "clone_rate_limit_violations_total",
  help: "Total rate limit violations",
  labelNames: ["endpoint", "key_type", "model"],
  registers: [register],
});

export const langsmithWebhookResultsTotal = new client.Counter({
  name: "clone_langsmith_webhook_results_total",
  help: "LangSmith automation webhook processing results",
  labelNames: ["rule_id", "action", "outcome"],
  registers: [register],
});

export function metricsMiddleware() {
  return (
    req: { method: string; path: string; route?: { path?: string } },
    res: any,
    next: () => void,
  ) => {
    const start = process.hrtime.bigint();
    const endpoint = req.route?.path || req.path;

    res.on("finish", () => {
      const duration = Number(process.hrtime.bigint() - start) / 1e9;
      const status = String(res.statusCode || 0);
      const labels = { method: req.method, endpoint, status_code: status };

      httpRequestsTotal.inc(labels);
      httpRequestDuration.observe({ method: req.method, endpoint }, duration);
    });

    next();
  };
}
