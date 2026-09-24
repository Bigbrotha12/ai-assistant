export const SENTINEL_SCHEMA_VERSION = 1 as const;
export const SENTINEL_SHADOW_SCHEMA_VERSION = 1 as const;

export const SENTINEL_DIRECTIONS = [
  "input",
  "tool_result",
  "output",
  "speak_pass",
  "memory",
] as const;
export type SentinelDirection = (typeof SENTINEL_DIRECTIONS)[number];
export type SentinelPublicDirection = Exclude<SentinelDirection, "input">;

export const SENTINEL_SHADOW_DIRECTIONS = [
  "input",
  "tool_result",
  "output",
] as const;
export type SentinelShadowDirection = (typeof SENTINEL_SHADOW_DIRECTIONS)[number];

export const SENTINEL_CATEGORIES = [
  "self_harm",
  "violence",
  "illegal",
  "pii",
  "child_safety",
  "sexual_content",
  "medical_guardrail",
  "jailbreak_attempt",
  "harmless",
] as const;
export type SentinelCategory = (typeof SENTINEL_CATEGORIES)[number];

export const SENTINEL_SEVERITIES = ["low", "medium", "high"] as const;
export type SentinelSeverity = (typeof SENTINEL_SEVERITIES)[number];

export const SENTINEL_VERDICTS = ["allow", "flag", "block"] as const;
export type SentinelVerdictValue = (typeof SENTINEL_VERDICTS)[number];

export const SENTINEL_RUNTIME_MODE = "l1_only" as const;

export const SENTINEL_POLICY_MODES = ["advisory", "blocking"] as const;
export type SentinelPolicyMode = (typeof SENTINEL_POLICY_MODES)[number];

export type SentinelRuleContext = {
  requires?: readonly string[];
  excludes?: readonly string[];
};

export type SentinelRule = {
  id: string;
  category: SentinelCategory;
  severity: SentinelSeverity;
  match: "phrase";
  patterns: readonly string[];
  context?: SentinelRuleContext;
};

export type SentinelRuleSet = {
  schemaVersion: typeof SENTINEL_SCHEMA_VERSION;
  version: string;
  rules: readonly SentinelRule[];
};

export type L1Finding = {
  ruleId: string;
  category: SentinelCategory;
  severity: SentinelSeverity;
};

export type SentinelContext = {
  taskId?: string;
  plugin?: string;
  subtask?: string;
  recentCategories?: readonly SentinelCategory[];
};

export type SentinelCheckRequest = {
  text: string;
  direction: SentinelDirection;
  context?: SentinelContext;
};

export type SentinelAction = {
  cannedResponseId: string | null;
};

export type SentinelVerdict = {
  mode: typeof SENTINEL_RUNTIME_MODE;
  verdict: SentinelVerdictValue;
  categories: readonly SentinelCategory[];
  severity: SentinelSeverity | null;
  matchedRuleIds: readonly string[];
  action: SentinelAction;
  requestId: string;
  ruleSetVersion: string;
  policyVersion: string;
};

export type SentinelPolicy = {
  version: string;
  mode: SentinelPolicyMode;
  defaultVerdict: SentinelVerdictValue;
  defaultRuleCategory: SentinelCategory;
};

export type SentinelPolicyContext = {
  direction: SentinelDirection;
  plugin?: string;
  subtask?: string;
  recentCategories?: readonly SentinelCategory[];
};

export type SentinelDecisionRow = {
  id: string;
  direction: SentinelDirection;
  finding: "none" | "any";
  category: "any" | SentinelCategory;
  severity: "any" | SentinelSeverity;
  context: "any" | "repeated";
  advisory: SentinelVerdictValue;
  blocking: SentinelVerdictValue;
};

export type SentinelDecision = {
  verdict: SentinelVerdictValue;
  categories: readonly SentinelCategory[];
  severity: SentinelSeverity | null;
  matchedRuleIds: readonly string[];
  action: SentinelAction;
};

export type SentinelCheckResult = {
  verdict: SentinelVerdict;
  findings: readonly L1Finding[];
  ledgerTaskId: string | null;
};
