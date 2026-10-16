export const SENTINEL_SCHEMA_VERSION = 1 as const;
export const SENTINEL_SHADOW_SCHEMA_VERSION = 1 as const;
export const SENTINEL_SHADOW_SCHEMA_VERSION_SEMANTIC = 2 as const;
export const SENTINEL_SHADOW_SCHEMA_VERSIONS = [
  SENTINEL_SHADOW_SCHEMA_VERSION,
  SENTINEL_SHADOW_SCHEMA_VERSION_SEMANTIC,
] as const;
export type SentinelShadowSchemaVersion = (typeof SENTINEL_SHADOW_SCHEMA_VERSIONS)[number];

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

export const SENTINEL_FINDING_SOURCES = ["l1", "semantic"] as const;
export type SentinelFindingSource = (typeof SENTINEL_FINDING_SOURCES)[number];

export const SENTINEL_RUNTIME_MODE = "l1_only" as const;
export const SENTINEL_RUNTIME_MODES = ["l1_only", "l1_semantic"] as const;
export type SentinelRuntimeMode = (typeof SENTINEL_RUNTIME_MODES)[number];

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

/**
 * A detector hit. `source` records which stage produced it so the two layers
 * stay auditable side by side: L1 findings carry a real rule id, semantic
 * findings carry a synthetic `semantic.<category>` id and the model
 * probability in `confidence`.
 */
export type SentinelFinding = {
  ruleId: string;
  category: SentinelCategory;
  severity: SentinelSeverity;
  source: SentinelFindingSource;
  confidence?: number;
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
  mode: SentinelRuntimeMode;
  /**
   * Independent from `mode`: the stage can be configured (`mode:"l1_semantic"`)
   * yet unavailable for one text, in which case the verdict falls back to L1.
   */
  semanticAvailable: boolean;
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
  findings: readonly SentinelFinding[];
  ledgerTaskId: string | null;
};
