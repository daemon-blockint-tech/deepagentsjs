/**
 * LangSmith Webhook Handler — processes automation rule payloads.
 *
 * This endpoint receives POST requests from LangSmith when automation rules
 * match runs. It validates the secret, identifies the rule, and processes
 * the payload accordingly.
 *
 * Supported rules:
 * - routing_errors_to_github: Creates GitHub issues for routing misclassifications
 - low_safety_alert: Sends Slack notification for unsafe action proposals
 * - hallucination_alert: Sends Slack notification for hallucinated responses
 * - regression_test_collector: Confirms traces were added to dataset
 *
 * Security:
 * - A shared secret is sent via the `X-Webhook-Secret` header
 * - The secret is validated against LANGSMITH_WEBHOOK_SECRET env var
 * - Comparison is constant-time (crypto.timingSafeEqual) to prevent timing attacks
 * - Requests with invalid/missing secrets are rejected with 401
 *
 * Webhook delivery guarantees (from LangSmith docs):
 * - LangSmith retries failed connections up to 2 times
 * - 5xx responses: retried up to 2 times with exponential backoff
 * - 4xx responses: not retried (delivery declared failed)
 * - 5-second timeout: if endpoint doesn't respond in 5s, delivery fails
 *
 * Usage:
 *   Set LANGSMITH_WEBHOOK_SECRET in .env.local
 *   Configure automation rule webhook URL:
 *     http://localhost:3001/api/langsmith/webhook
 *   With header: X-Webhook-Secret: YOUR_SECRET
 *
 *   For production:
 *     https://your-backend-url.com/api/langsmith/webhook
 *   With header: X-Webhook-Secret: YOUR_SECRET
 */

import process from "node:process";
import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { langsmithWebhookResultsTotal } from "./metrics.js";
import { getErrorMessage } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LangSmithRun {
  id: string;
  trace_id: string;
  status: string;
  run_type: string;
  name: string;
  start_time: string;
  end_time: string;
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  inputs_s3_urls?: { ROOT?: { presigned_url?: string } } | null;
  outputs_s3_urls?: { ROOT?: { presigned_url?: string } } | null;
  extra?: { metadata?: Record<string, unknown> } | null;
  feedback_stats?: Record<string, unknown> | null;
  app_path?: string;
  session_id?: string;
}

interface LangSmithWebhookPayload {
  rule_id: string;
  start_time: string;
  end_time: string;
  runs: LangSmithRun[];
  feedback_stats?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Secret validation
// ---------------------------------------------------------------------------

/**
 * Validate the webhook secret using a constant-time comparison.
 *
 * The secret is read from the `X-Webhook-Secret` header. Using a header
 * (instead of a query parameter) keeps the secret out of access logs,
 * proxy logs, and browser history.
 */
function validateSecret(req: Request): boolean {
  const expected = process.env.LANGSMITH_WEBHOOK_SECRET;
  if (!expected) return false;

  // Prefer header-based auth; fall back to query param for backward compat
  const provided =
    (req.header("x-webhook-secret") as string | undefined) ??
    (req.query.secret as string | undefined);

  if (!provided) return false;

  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Rule processors
// ---------------------------------------------------------------------------

/**
 * Extract the user message from a run's inputs.
 */
function extractUserMessage(run: LangSmithRun): string {
  const messages = run.inputs?.messages as
    | Array<{ role?: string; content?: unknown }>
    | undefined;
  if (!messages) return "";
  const lastUser = [...messages]
    .reverse()
    .find((m) => m.role === "user" || m.role === "human");
  if (!lastUser) return "";
  return typeof lastUser.content === "string"
    ? lastUser.content
    : JSON.stringify(lastUser.content ?? "");
}

/**
 * Extract the workflow routing decision from a run's outputs.
 */
function extractRoutingDecision(run: LangSmithRun): {
  workflowId?: string;
  reasoning?: string;
  direct?: boolean;
} {
  const workflowResult = run.outputs?._workflowResult as
    | {
        routing?: {
          workflow?: { id?: string };
          reasoning?: string;
          direct?: boolean;
        };
      }
    | undefined;
  return {
    workflowId: workflowResult?.routing?.workflow?.id,
    reasoning: workflowResult?.routing?.reasoning,
    direct: workflowResult?.routing?.direct,
  };
}

/**
 * Extract metadata from a run.
 */
function extractMetadata(run: LangSmithRun): Record<string, unknown> {
  return run.extra?.metadata ?? {};
}

// ---------------------------------------------------------------------------
// Rule: routing_errors_to_github
// ---------------------------------------------------------------------------

/**
 * Create a GitHub issue for a routing misclassification.
 *
 * This requires a GitHub token with repo access.
 * Set GITHUB_TOKEN and GITHUB_REPO in .env.local.
 *
 * GITHUB_REPO format: "owner/repo" (e.g., "your-org/clone")
 */
async function createGitHubIssue(
  run: LangSmithRun,
  userMessage: string,
  routing: ReturnType<typeof extractRoutingDecision>,
): Promise<{ success: boolean; url?: string; error?: string }> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;

  if (!token || !repo) {
    return {
      success: false,
      error: "GITHUB_TOKEN or GITHUB_REPO not configured",
    };
  }

  const title = `[Auto] Workflow routing misclassification: "${userMessage.slice(0, 60)}"`;
  const body = `## Routing Misclassification Detected

**Detected by:** LangSmith automation rule \`routing_errors_to_github\`
**Trace ID:** \`${run.trace_id}\`
**Run ID:** \`${run.id}\`
**Time:** ${run.start_time}

### User Message
\`\`\`
${userMessage}
\`\`\`

### Routing Decision
- **Workflow selected:** ${routing.direct ? "direct (no workflow)" : (routing.workflowId ?? "unknown")}
- **Reasoning:** ${routing.reasoning ?? "N/A"}

### LangSmith Links
- [View trace in LangSmith](${run.app_path ? `https://smith.langchain.com${run.app_path}` : "N/A"})
- [View run details](${run.app_path ? `https://smith.langchain.com${run.app_path}` : "N/A"})

### Action Needed
1. Check if a new keyword pattern should be added to \`backend/src/workflow-router.ts\`
2. Verify the routing classifier is matching the right workflow
3. Consider whether a new workflow definition is needed for this request type

---
*This issue was auto-generated by LangSmith automation rule. Do not edit manually.*`;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          body,
          labels: ["bug", "workflow-router", "auto-generated"],
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `GitHub API error: ${response.status} ${errorText}`,
      };
    }

    const issue = (await response.json()) as { html_url: string };
    return { success: true, url: issue.html_url };
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Rule: low_safety_alert (Slack notification)
// ---------------------------------------------------------------------------

/**
 * Send a Slack notification for an unsafe action proposal.
 *
 * Requires SLACK_WEBHOOK_URL (Slack incoming webhook URL).
 */
async function sendSlackSafetyAlert(
  run: LangSmithRun,
  userMessage: string,
): Promise<{ success: boolean; error?: string }> {
  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  if (!slackUrl) {
    return { success: false, error: "SLACK_WEBHOOK_URL not configured" };
  }

  const text = `🚨 *Unsafe Action Proposal Detected*

*User message:* ${userMessage.slice(0, 200)}
*Trace:* ${run.app_path ? `<https://smith.langchain.com${run.app_path}|View in LangSmith>` : "N/A"}
*Time:* ${run.start_time}

This requires immediate review by the security team.`;

  try {
    const response = await fetch(slackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      return { success: false, error: `Slack API error: ${response.status}` };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Rule: hallucination_alert (Slack notification)
// ---------------------------------------------------------------------------

async function sendSlackHallucinationAlert(
  run: LangSmithRun,
  userMessage: string,
): Promise<{ success: boolean; error?: string }> {
  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  if (!slackUrl) {
    return { success: false, error: "SLACK_WEBHOOK_URL not configured" };
  }

  const text = `⚠️ *Hallucination Detected*

*A specialist response was not grounded in real data.*
*User message:* ${userMessage.slice(0, 200)}
*Trace:* ${run.app_path ? `<https://smith.langchain.com${run.app_path}|View in LangSmith>` : "N/A"}
*Time:* ${run.start_time}

Action: Check the specialist's system prompt and strengthen grounding instructions.`;

  try {
    const response = await fetch(slackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      return { success: false, error: `Slack API error: ${response.status}` };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Rule dispatcher
// ---------------------------------------------------------------------------

interface RuleProcessingResult {
  ruleId: string;
  processed: number;
  errors: string[];
  details: Array<{
    runId: string;
    action: string;
    success: boolean;
    url?: string;
  }>;
}

/**
 * Process a webhook payload by dispatching to the appropriate rule handler.
 *
 * The rule_id in the payload identifies which automation rule triggered
 * the webhook. We map known rule IDs to their handlers.
 *
 * For unknown rule IDs, we log the payload and return success (so LangSmith
 * doesn't retry). Unknown rules can be added later.
 */
async function processPayload(
  payload: LangSmithWebhookPayload,
): Promise<RuleProcessingResult> {
  const { rule_id, runs } = payload;
  const errors: string[] = [];
  const details: RuleProcessingResult["details"] = [];

  // Map rule IDs to handlers.
  // These IDs are set when creating the automation rules in LangSmith.
  // To find the rule ID: LangSmith → Automations tab → click the rule → copy ID.
  //
  // For development, we also match by run content (metadata, feedback) so
  // the webhook works even before rule IDs are configured.

  for (const run of runs) {
    const userMessage = extractUserMessage(run);
    const routing = extractRoutingDecision(run);
    const metadata = extractMetadata(run);

    // Determine which handler to use based on rule_id or run content
    let handler:
      | ((
          run: LangSmithRun,
          msg: string,
          r: typeof routing,
        ) => Promise<{ success: boolean; url?: string; error?: string }>)
      | null = null;
    let actionName = "unknown";

    // Check if this is a routing error (routing_accuracy = 0)
    const feedbackStats = run.feedback_stats as
      | { routing_accuracy?: { avg?: number } }
      | undefined;
    const routingAccuracy = feedbackStats?.routing_accuracy?.avg;

    if (routingAccuracy === 0 || rule_id === "routing_errors_to_github") {
      handler = async (_, msg, r) => createGitHubIssue(run, msg, r);
      actionName = "github_issue";
    } else if (rule_id === "low_safety_to_review") {
      handler = async (_, msg) => sendSlackSafetyAlert(run, msg);
      actionName = "slack_safety_alert";
    } else if (rule_id === "hallucination_to_review") {
      handler = async (_, msg) => sendSlackHallucinationAlert(run, msg);
      actionName = "slack_hallucination_alert";
    }

    if (handler) {
      try {
        const result = await handler(run, userMessage, routing);
        details.push({
          runId: run.id,
          action: actionName,
          success: result.success,
          url: result.url,
        });
        if (!result.success && result.error) {
          errors.push(`Run ${run.id}: ${result.error}`);
        }
        langsmithWebhookResultsTotal.inc({
          rule_id,
          action: actionName,
          outcome: result.success ? "success" : "handler_error",
        });
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        errors.push(`Run ${run.id}: ${errorMsg}`);
        details.push({ runId: run.id, action: actionName, success: false });
        langsmithWebhookResultsTotal.inc({
          rule_id,
          action: actionName,
          outcome: "exception",
        });
      }
    } else {
      // Unknown rule — log and continue
      details.push({
        runId: run.id,
        action: "logged_only",
        success: true,
      });
      langsmithWebhookResultsTotal.inc({
        rule_id,
        action: "logged_only",
        outcome: "success",
      });
    }

    // Log for debugging
    if (process.env.NODE_ENV !== "test") {
      process.stdout.write(
        `[langsmith-webhook] rule=${rule_id} run=${run.id} ` +
          `status=${run.status} graph_type=${metadata.graph_type ?? "unknown"}\n`,
      );
    }
  }

  return {
    ruleId: rule_id,
    processed: runs.length,
    errors,
    details,
  };
}

// ---------------------------------------------------------------------------
// Express router
// ---------------------------------------------------------------------------

export const langsmithWebhookRouter: Router = Router();

/**
 * POST /api/langsmith/webhook
 *
 * Receives webhook payloads from LangSmith automation rules.
 * Validates the secret, processes the payload, and returns results.
 *
 * Headers:
 *   X-Webhook-Secret: string (required) — shared secret for authentication
 *
 * Response: 200 with processing results, or 401 if secret is invalid.
 *
 * The endpoint responds within 5 seconds (LangSmith's timeout).
 * Long-running operations (GitHub API calls) are awaited but should
 * complete quickly. If they don't, consider moving to a queue.
 *
 * Note: processing failures return 200 (not 5xx) to prevent LangSmith
 * retries, but a Prometheus counter (`clone_langsmith_webhook_results_total`)
 * is incremented so operators can alert on failed safety-critical alerts
 * (e.g. Slack delivery for unsafe actions).
 */
langsmithWebhookRouter.post("/webhook", async (req: Request, res: Response) => {
  // Validate secret
  if (!validateSecret(req)) {
    return res.status(401).json({ error: "Invalid or missing secret" });
  }

  const payload = req.body as LangSmithWebhookPayload;

  // Basic payload validation
  if (!payload || !payload.rule_id || !Array.isArray(payload.runs)) {
    return res.status(400).json({ error: "Invalid payload format" });
  }

  try {
    const result = await processPayload(payload);
    return res.json({
      ok: true,
      rule_id: result.ruleId,
      processed: result.processed,
      errors: result.errors.length > 0 ? result.errors : undefined,
      details: result.details,
    });
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    process.stderr.write(`[langsmith-webhook] error: ${errorMsg}\n`);
    // Emit metric so operators can alert on top-level processing failures
    // (especially safety-critical rules that were not dispatched at all).
    langsmithWebhookResultsTotal.inc({
      rule_id: payload.rule_id,
      action: "dispatch",
      outcome: "exception",
    });
    // Return 200 to prevent LangSmith retries — we've received the payload
    // and can process it later from logs if needed.
    return res.status(200).json({
      ok: false,
      error: errorMsg,
      note: "Payload received but processing failed. Check server logs.",
    });
  }
});

/**
 * GET /api/langsmith/webhook
 *
 * Health check endpoint — verifies the webhook handler is running
 * and the secret is configured.
 */
langsmithWebhookRouter.get("/webhook", (_req: Request, res: Response) => {
  const hasSecret = !!process.env.LANGSMITH_WEBHOOK_SECRET;
  const hasGithub = !!process.env.GITHUB_TOKEN && !!process.env.GITHUB_REPO;
  const hasSlack = !!process.env.SLACK_WEBHOOK_URL;

  return res.json({
    status: "ok",
    secret_configured: hasSecret,
    github_configured: hasGithub,
    slack_configured: hasSlack,
    endpoints: {
      webhook:
        "POST /api/langsmith/webhook (header: X-Webhook-Secret: YOUR_SECRET)",
      health: "GET /api/langsmith/webhook",
    },
  });
});
