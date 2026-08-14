/**
 * Task-based model routing.
 *
 * Different specialist tasks have different model requirements:
 * - Research (read-only search) → can use a cheaper/faster model
 * - Analysis (code execution, calculations) → needs a strong reasoning model
 * - Writing (drafting reports) → needs a model good at long-form text
 * - Pricing (math + recommendations) → needs strong reasoning
 * - Action (proposing changes) → needs to be careful, medium model
 * - Orchestrator (routing) → cheap model is fine
 *
 * If the user provides an explicit model override (via config), ALL
 * specialists use that model. Otherwise each specialist falls back to
 * its tier-based default.
 */

export type ModelTier = "fast" | "balanced" | "powerful";

/**
 * OpenRouter model names for each tier.
 */
export const MODEL_TIERS: Record<ModelTier, string> = {
  fast: "openai/gpt-4o-mini",
  balanced: "openai/gpt-4o",
  powerful: "anthropic/claude-3.5-sonnet",
};

/**
 * Default tier for each specialist (and the orchestrator).
 */
export const SPECIALIST_MODEL_TIER: Record<string, ModelTier> = {
  orchestrator: "fast",
  research: "fast",
  analysis: "powerful",
  writing: "balanced",
  pricing: "powerful",
  action: "balanced",
};

/**
 * Select a model for a given specialist.
 *
 * If `userModel` is provided and non-empty, it overrides the tier-based
 * default for ALL specialists (the user explicitly chose a model).
 * Otherwise the specialist's tier-based default is used.
 *
 * @param specialist  Specialist name (e.g. "orchestrator", "research")
 * @param userModel   Optional user-provided model override
 * @returns           The OpenRouter model name to use
 */
export function selectModel(specialist: string, userModel?: string): string {
  if (userModel && userModel.trim() !== "") {
    return userModel;
  }
  const tier = SPECIALIST_MODEL_TIER[specialist] ?? "balanced";
  return MODEL_TIERS[tier];
}

/**
 * Select a model for a task type + complexity combination.
 *
 * Maps the task type and its complexity to a model tier and returns
 * the corresponding OpenRouter model name.
 *
 * @param taskType    The kind of task (e.g. "research", "analysis")
 * @param complexity  "low" | "medium" | "high"
 * @returns           The OpenRouter model name to use
 */
export function selectModelForTask(
  taskType: string,
  complexity: "low" | "medium" | "high",
): string {
  const baseTier = SPECIALIST_MODEL_TIER[taskType] ?? "balanced";

  // Adjust tier based on complexity.
  // - low complexity never needs more than "fast"
  // - high complexity bumps up a level (fast→balanced, balanced→powerful)
  let tier: ModelTier = baseTier;
  if (complexity === "low") {
    tier = "fast";
  } else if (complexity === "high") {
    if (baseTier === "fast") tier = "balanced";
    else if (baseTier === "balanced") tier = "powerful";
    else tier = "powerful";
  }

  return MODEL_TIERS[tier];
}
