/**
 * Workflow Router — code-defined task routing.
 *
 * Replaces LLM-based routing with a rule-based classifier.
 * The router examines the user's message and conversation history
 * and selects a predefined workflow path — a fixed sequence of
 * specialist steps with control gates between them.
 *
 * Principles:
 * - Predefined Paths: workflows are code-defined, not LLM-generated
 * - Control Gates: each step validates its input before running
 * - Separation of Concerns: LLM handles interpretation within a step,
 *   code manages which steps run and in what order
 *
 * The router is intentionally simple — keyword + pattern matching.
 * It's fast, deterministic, and auditable. If routing accuracy
 * becomes a problem, the classifier can be upgraded to a small
 * ML model without changing the workflow interface.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Specialist names that can be steps in a workflow. */
export type SpecialistName =
  | "research"
  | "analysis"
  | "writing"
  | "pricing"
  | "action";

/** A single step in a workflow. */
export interface WorkflowStep {
  /** Which specialist runs this step. */
  specialist: SpecialistName;
  /** Human-readable description of what this step does. */
  description: string;
  /** Gate that validates the step's input before running. */
  gate?: ControlGateName;
  /** Whether this step can be skipped if the gate fails (optional vs required). */
  optional?: boolean;
}

/** Named control gates — reusable validation functions. */
export type ControlGateName =
  | "has_workspace_context"
  | "has_research_findings"
  | "has_analysis_results"
  | "has_writing_draft"
  | "is_write_request"
  | "is_read_only"
  | "is_pricing_task"
  | "is_analysis_task";

/** A predefined workflow — a named sequence of steps. */
export interface Workflow {
  /** Unique identifier for this workflow. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** When to use this workflow (matched against user message). */
  description: string;
  /** The fixed sequence of steps. */
  steps: WorkflowStep[];
}

/** Result of routing a user message to a workflow. */
export interface RoutingResult {
  /** The selected workflow, or null for direct response. */
  workflow: Workflow | null;
  /** Why this workflow was chosen (for audit/logging). */
  reasoning: string;
  /** Confidence score 0-1. */
  confidence: number;
  /** Whether the router fell back to direct response. */
  direct: boolean;
}

// ---------------------------------------------------------------------------
// Workflow definitions — the predefined paths
// ---------------------------------------------------------------------------

const RESEARCH_WORKFLOW: Workflow = {
  id: "research",
  name: "Research Lookup",
  description: "Read-only query: find and summarize ontology data",
  steps: [
    {
      specialist: "research",
      description:
        "Search the ontology for relevant objects and return findings",
      gate: "has_workspace_context",
    },
  ],
};

const ANALYSIS_WORKFLOW: Workflow = {
  id: "analysis",
  name: "Data Analysis",
  description: "Compute, calculate, or analyze data",
  steps: [
    {
      specialist: "research",
      description: "Gather the data needed for analysis",
      gate: "has_workspace_context",
    },
    {
      specialist: "analysis",
      description: "Run computations on the gathered data",
      gate: "has_research_findings",
    },
  ],
};

const REPORT_WORKFLOW: Workflow = {
  id: "report",
  name: "Report Generation",
  description: "Research → Analyze → Write a report",
  steps: [
    {
      specialist: "research",
      description: "Gather data for the report",
      gate: "has_workspace_context",
    },
    {
      specialist: "analysis",
      description: "Analyze the gathered data",
      gate: "has_research_findings",
    },
    {
      specialist: "writing",
      description: "Draft the report from research + analysis findings",
      gate: "has_analysis_results",
    },
  ],
};

const PRICING_WORKFLOW: Workflow = {
  id: "pricing",
  name: "Pricing Strategy",
  description: "Analyze pricing and recommend changes",
  steps: [
    {
      specialist: "research",
      description: "Gather competitor and product pricing data",
      gate: "has_workspace_context",
    },
    {
      specialist: "pricing",
      description: "Analyze pricing and compute recommendations",
      gate: "has_research_findings",
    },
    {
      specialist: "action",
      description: "Propose price changes for human approval",
      gate: "is_write_request",
    },
  ],
};

const ACTION_WORKFLOW: Workflow = {
  id: "action",
  name: "Propose Change",
  description: "Propose a change to the ontology",
  steps: [
    {
      specialist: "research",
      description: "Find the object(s) to modify",
      gate: "has_workspace_context",
    },
    {
      specialist: "action",
      description: "Propose the change for human approval",
      gate: "is_write_request",
    },
  ],
};

const REPORT_AND_ACT_WORKFLOW: Workflow = {
  id: "report_and_act",
  name: "Report + Propose Actions",
  description: "Research → Analyze → Write → Propose actions",
  steps: [
    {
      specialist: "research",
      description: "Gather data",
      gate: "has_workspace_context",
    },
    {
      specialist: "analysis",
      description: "Analyze findings",
      gate: "has_research_findings",
    },
    {
      specialist: "writing",
      description: "Draft the report",
      gate: "has_analysis_results",
    },
    {
      specialist: "action",
      description: "Propose actions based on the report",
      gate: "is_write_request",
    },
  ],
};

const PRICING_REPORT_WORKFLOW: Workflow = {
  id: "pricing_report",
  name: "Pricing Report + Recommendations",
  description: "Research → Pricing analysis → Write report → Propose changes",
  steps: [
    {
      specialist: "research",
      description: "Gather pricing data",
      gate: "has_workspace_context",
    },
    {
      specialist: "pricing",
      description: "Analyze pricing and compute recommendations",
      gate: "has_research_findings",
    },
    {
      specialist: "writing",
      description: "Draft the pricing report",
      gate: "has_analysis_results",
    },
    {
      specialist: "action",
      description: "Propose price changes for approval",
      gate: "is_write_request",
    },
  ],
};

/** All predefined workflows, ordered by specificity (most specific first). */
const WORKFLOWS: Workflow[] = [
  PRICING_REPORT_WORKFLOW,
  REPORT_AND_ACT_WORKFLOW,
  PRICING_WORKFLOW,
  REPORT_WORKFLOW,
  ANALYSIS_WORKFLOW,
  ACTION_WORKFLOW,
  RESEARCH_WORKFLOW,
];

// ---------------------------------------------------------------------------
// Routing classifier — keyword + pattern matching
// ---------------------------------------------------------------------------

interface RoutingPattern {
  keywords: RegExp;
  workflow: Workflow;
  /** Additional check — returns false if the pattern shouldn't match. */
  condition?: (message: string, history: Array<{ role: string }>) => boolean;
}

const PATTERNS: RoutingPattern[] = [
  // Pricing report + recommendations
  {
    keywords:
      /(harga|price|pricing).*((laporan|report)|(rekomendasi|recommend|suggest|change|update))|(report|laporan).*(price|pricing)/i,
    workflow: PRICING_REPORT_WORKFLOW,
  },
  // Report + propose actions
  {
    keywords:
      /(laporan|report).*(rekomendasi|recommend|suggest|action|propose|update|change)|(rekomendasi|recommend).*(laporan|report)/i,
    workflow: REPORT_AND_ACT_WORKFLOW,
  },
  // Pricing only
  {
    keywords: /(harga|price|pricing|margin|competit)/i,
    workflow: PRICING_WORKFLOW,
    condition: (msg) =>
      /rekomendasi|recommend|suggest|change|update|strategy/i.test(msg),
  },
  // Report only (no action requested)
  {
    keywords: /(laporan|report|summary|ringkasan|draft|tulis|write)/i,
    workflow: REPORT_WORKFLOW,
    condition: (msg) =>
      !/(update|change|propose|execute|create|delete)/i.test(msg),
  },
  // Analysis
  {
    keywords:
      /(analisis|analyze|calculate|hitung|compute|simulat|evaluasi|evaluate|compare|banding)/i,
    workflow: ANALYSIS_WORKFLOW,
  },
  // Action (write request)
  {
    keywords:
      /(update|change|ubah|create|buat|delete|hapus|set|propose|execute)/i,
    workflow: ACTION_WORKFLOW,
  },
  // Research (default for questions)
  {
    keywords:
      /(apa|siapa|dimana|kapan|bagaimana|what|who|where|when|how|find|cari|lookup|search|show|tampilkan)/i,
    workflow: RESEARCH_WORKFLOW,
  },
];

/**
 * Route a user message to the appropriate workflow.
 *
 * The classifier checks patterns in order — first match wins.
 * If no pattern matches, returns a direct response (no workflow).
 */
export function routeMessage(
  message: string,
  history: Array<{ role: string }> = [],
): RoutingResult {
  const trimmed = message.trim();

  // Greetings and short messages → direct response
  if (
    trimmed.length < 15 &&
    !/(find|cari|show|update|create|analyze|report)/i.test(trimmed)
  ) {
    return {
      workflow: null,
      reasoning: "Short message or greeting — direct response",
      confidence: 0.9,
      direct: true,
    };
  }

  // Follow-up in an existing conversation → direct response
  // (the orchestrator LLM handles follow-ups from context)
  if (history.length > 4) {
    return {
      workflow: null,
      reasoning: "Follow-up in existing conversation — direct response",
      confidence: 0.7,
      direct: true,
    };
  }

  // Try each pattern
  for (const pattern of PATTERNS) {
    if (pattern.keywords.test(trimmed)) {
      if (pattern.condition && !pattern.condition(trimmed, history)) {
        continue;
      }
      return {
        workflow: pattern.workflow,
        reasoning: `Matched pattern: ${pattern.workflow.id} — ${pattern.workflow.description}`,
        confidence: 0.8,
        direct: false,
      };
    }
  }

  // Default: research workflow (safe read-only)
  return {
    workflow: RESEARCH_WORKFLOW,
    reasoning:
      "No specific pattern matched — defaulting to research (read-only)",
    confidence: 0.5,
    direct: false,
  };
}

/**
 * List all available workflows (for debugging/UI).
 */
export function listWorkflows(): Workflow[] {
  return WORKFLOWS;
}

/**
 * Get a workflow by ID.
 */
export function getWorkflow(id: string): Workflow | null {
  return WORKFLOWS.find((w) => w.id === id) ?? null;
}
