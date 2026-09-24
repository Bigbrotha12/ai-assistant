import {
  SENTINEL_CATEGORIES,
  SENTINEL_DIRECTIONS,
  SENTINEL_POLICY_MODES,
  SENTINEL_SEVERITIES,
} from "./types.ts";
import type {
  L1Finding,
  SentinelAction,
  SentinelCategory,
  SentinelDecision,
  SentinelDecisionRow,
  SentinelPolicy,
  SentinelPolicyContext,
  SentinelPolicyMode,
  SentinelSeverity,
  SentinelVerdictValue,
} from "./types.ts";

export const SENTINEL_POLICY_VERSION = "sentinel-policy.v1.0.0";
export const SENTINEL_CANNED_RESPONSE_IDS = {
  advisory: "sentinel_advisory_v1",
  blocked: "sentinel_blocked_v1",
} as const;

export const DEFAULT_SENTINEL_POLICY: SentinelPolicy = {
  version: SENTINEL_POLICY_VERSION,
  mode: "advisory",
  defaultVerdict: "flag",
  defaultRuleCategory: "harmless",
};

const VERDICT_PRECEDENCE: Record<SentinelVerdictValue, number> = {
  allow: 0,
  flag: 1,
  block: 2,
};

const CATEGORY_ORDER = new Map(
  SENTINEL_CATEGORIES.map((category, index) => [category, index]),
);
const SEVERITY_ORDER: Record<SentinelSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function rowsForDirection(direction: SentinelDecisionRow["direction"]): SentinelDecisionRow[] {
  const rows: SentinelDecisionRow[] = [
    {
      id: `${direction}.no_finding`,
      direction,
      finding: "none",
      category: "any",
      severity: "any",
      context: "any",
      advisory: "allow",
      blocking: "allow",
    },
  ];
  for (const category of SENTINEL_CATEGORIES) {
    for (const severity of SENTINEL_SEVERITIES) {
      const verdict = category === "harmless" ? "allow" : "flag";
      const blocking = category === "harmless" ? "allow" : "block";
      for (const context of ["any", "repeated"] as const) {
        rows.push({
          id: `${direction}.${category}.${severity}.${context}`,
          direction,
          finding: "any",
          category,
          severity,
          context,
          advisory: verdict,
          blocking,
        });
      }
    }
  }
  return rows;
}

export const SENTINEL_DECISION_TABLE: readonly SentinelDecisionRow[] = Object.freeze(
  SENTINEL_DIRECTIONS.flatMap(rowsForDirection),
);

const DEFAULT_DECISION_ROW: SentinelDecisionRow = {
  id: "default.flagged",
  direction: "output",
  finding: "any",
  category: "any",
  severity: "any",
  context: "any",
  advisory: "flag",
  blocking: "block",
};

export function policyForMode(mode: SentinelPolicyMode): SentinelPolicy {
  if (!SENTINEL_POLICY_MODES.includes(mode)) {
    throw new Error(`unknown sentinel policy mode: ${mode}`);
  }
  return { ...DEFAULT_SENTINEL_POLICY, mode };
}

function sortCategories(categories: readonly SentinelCategory[]): SentinelCategory[] {
  return [...new Set(categories)].sort(
    (left, right) => (CATEGORY_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (CATEGORY_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

function highestSeverity(findings: readonly L1Finding[]): SentinelSeverity | null {
  let highest: SentinelSeverity | null = null;
  for (const finding of findings) {
    if (highest === null || SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[highest]) {
      highest = finding.severity;
    }
  }
  return highest;
}

function actionFor(verdict: SentinelVerdictValue): SentinelAction {
  if (verdict === "allow") return { cannedResponseId: null };
  return {
    cannedResponseId:
      verdict === "block"
        ? SENTINEL_CANNED_RESPONSE_IDS.blocked
        : SENTINEL_CANNED_RESPONSE_IDS.advisory,
  };
}

function rowFor(
  direction: SentinelPolicyContext["direction"],
  finding: L1Finding,
  recentCategories: ReadonlySet<SentinelCategory>,
  policy: SentinelPolicy,
): SentinelDecisionRow {
  const candidates = SENTINEL_DECISION_TABLE.filter(
    (row) =>
      row.direction === direction &&
      row.finding === "any" &&
      row.category === finding.category &&
      row.severity === finding.severity,
  );
  const repeated = candidates.find(
    (row) => row.context === "repeated" && recentCategories.has(finding.category),
  );
  const fallback: SentinelDecisionRow = {
    ...DEFAULT_DECISION_ROW,
    advisory: policy.defaultVerdict,
    blocking: policy.defaultVerdict === "block" ? "block" : "flag",
  };
  const selected = repeated ?? candidates.find((row) => row.context === "any") ?? fallback;
  return {
    ...selected,
    advisory: policy.mode === "advisory" ? selected.advisory : selected.blocking,
  };
}

export function decideSentinel(
  findings: readonly L1Finding[],
  context: SentinelPolicyContext,
  policy: SentinelPolicy = DEFAULT_SENTINEL_POLICY,
): SentinelDecision {
  const sortedFindings = [...findings].sort(
    (left, right) => left.ruleId.localeCompare(right.ruleId),
  );
  const recentCategories = new Set(context.recentCategories ?? []);
  const selected = sortedFindings
    .map((finding) => rowFor(context.direction, finding, recentCategories, policy))
    .map((row) => row[policy.mode]);
  const verdict = selected.length === 0
    ? "allow"
    : selected.reduce<SentinelVerdictValue>(
        (current, candidate) =>
          VERDICT_PRECEDENCE[candidate] > VERDICT_PRECEDENCE[current] ? candidate : current,
        selected[0]!,
      );
  return {
    verdict,
    categories: sortCategories(sortedFindings.map((finding) => finding.category)),
    severity: highestSeverity(sortedFindings),
    matchedRuleIds: sortedFindings.map((finding) => finding.ruleId),
    action: actionFor(verdict),
  };
}

export const applySentinelPolicy = decideSentinel;
export const applyPolicy = decideSentinel;
