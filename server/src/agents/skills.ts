import { logger } from "../observability/logger.ts";
import { estimateTokens } from "../token_estimate.ts";

/**
 * Default skill token budget when a caller does not supply one. Production
 * callers pass env.AGENT_SKILL_BUDGET_TOKENS; this constant is the module
 * fallback (matches the env default).
 */
export const DEFAULT_SKILL_TOKEN_BUDGET = 6000;

export function composeAgentPrompt(
  systemPrompt: string,
  skills?: { id: string; title: string; content: string }[],
  budget?: number,
): string {
  if (!skills || skills.length === 0) return systemPrompt;

  const effectiveBudget = budget ?? DEFAULT_SKILL_TOKEN_BUDGET;
  const separator = "\n\n## Skills\n";
  const separatorEstimate = estimateTokens(separator);
  const systemEstimate = estimateTokens(systemPrompt);

  const included: typeof skills = [];
  let running = systemEstimate + separatorEstimate;

  for (const skill of skills) {
    const skillText = `\n### ${skill.title}\n\n${skill.content}`;
    const skillEstimate = estimateTokens(skillText);

    if (running + skillEstimate > effectiveBudget) {
      // Always include at least one skill: if the first skill alone is over
      // budget, dropping everything would leave an empty Skills section. The
      // prompt may therefore exceed the budget by the first skill's size.
      if (included.length === 0) {
        included.push(skill);
      }
      break;
    }

    running += skillEstimate;
    included.push(skill);
  }

  const dropped = skills.slice(included.length);
  if (dropped.length > 0) {
    logger.warn(
      `composeAgentPrompt: skills dropped (budget exceeded): ${dropped.map((s) => s.id).join(", ")}`,
    );
  }

  let result = systemPrompt + separator;
  for (const skill of included) {
    result += `\n### ${skill.title}\n\n${skill.content}`;
  }
  return result;
}