import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_RULE_SET, evaluateL1 } from "./l1.ts";
import { decideSentinel, DEFAULT_SENTINEL_POLICY } from "./policy.ts";
import {
  SENTINEL_CATEGORIES,
  SENTINEL_DIRECTIONS,
  SENTINEL_SEVERITIES,
  SENTINEL_VERDICTS,
} from "./types.ts";
import type {
  SentinelCategory,
  SentinelDirection,
  SentinelPolicy,
  SentinelRuleSet,
  SentinelSeverity,
  SentinelVerdictValue,
} from "./types.ts";

export const SENTINEL_EVAL_SCHEMA_VERSION = 1 as const;
export const SENTINEL_EVAL_SPLITS = ["train", "dev", "test"] as const;
export const SENTINEL_EVAL_DECISIONS = [
  ...SENTINEL_VERDICTS,
  "quarantine",
  "refuse",
] as const;
export type SentinelEvalSplit = (typeof SENTINEL_EVAL_SPLITS)[number];
export type SentinelEvalDecision = (typeof SENTINEL_EVAL_DECISIONS)[number];

export type SentinelEvalLabel = {
  category: SentinelCategory;
  severity: SentinelSeverity;
};

export type SentinelEvalCase = {
  schemaVersion: typeof SENTINEL_EVAL_SCHEMA_VERSION;
  id: string;
  split: SentinelEvalSplit;
  direction: SentinelDirection;
  language: string;
  text: string;
  labels: readonly SentinelEvalLabel[];
  expected: {
    decision: SentinelEvalDecision;
    categories: readonly SentinelCategory[];
  };
  provenance: {
    kind: "synthetic" | "licensed";
    license: string;
  };
  notes: string;
};

export type SentinelEvalManifest = {
  schemaVersion: typeof SENTINEL_EVAL_SCHEMA_VERSION;
  suiteVersion: string;
  datasetStatus?: "seed" | "release";
  minimumCases: {
    benignPerLaunchLanguage: number;
    positivePerCategory: number;
    adversarialParaphrasePerCategory: number;
  };
  thresholds: {
    l1: {
      testDecisionAccuracy: number;
    };
  };
  expectedHashes?: {
    rulesSha256?: string;
    casesSha256?: string;
  };
};

export type SentinelEvalCaseResult = {
  id: string;
  expectedDecision: SentinelVerdictValue;
  actualDecision: SentinelVerdictValue;
  expectedCategories: readonly SentinelCategory[];
  actualCategories: readonly SentinelCategory[];
  correct: boolean;
};

export type SentinelEvalCategoryMetrics = {
  support: number;
  predicted: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: number;
  recall: number;
  f1: number;
};

export type SentinelEvalReport = {
  suiteVersion: string;
  ruleSetVersion: string;
  policyVersion: string;
  caseCount: number;
  threshold: number;
  passed: boolean;
  overall: {
    decisionAccuracy: number;
    categoryPrecision: number;
    categoryRecall: number;
    macroF1: number;
    benignFalsePositiveRate: number;
  };
  perCategory: Record<SentinelCategory, SentinelEvalCategoryMetrics>;
  failures: readonly SentinelEvalCaseResult[];
};

export type SentinelEvalOptions = {
  ruleSet?: SentinelRuleSet;
  policy?: SentinelPolicy;
  threshold?: number;
  suiteVersion?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value as number;
}

function requiredProbability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${path} must be a probability between 0 and 1`);
  }
  return value;
}

function parseCategories(value: unknown, path: string): SentinelCategory[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  const categories: SentinelCategory[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !SENTINEL_CATEGORIES.includes(entry as SentinelCategory)) {
      throw new Error(`${path} contains an unknown category`);
    }
    const category = entry as SentinelCategory;
    if (!categories.includes(category)) categories.push(category);
  }
  return sortCategories(categories);
}

function parseLabels(value: unknown): SentinelEvalLabel[] {
  if (!Array.isArray(value)) throw new Error("labels must be an array");
  const labels: SentinelEvalLabel[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error("labels entries must be objects");
    const category = entry.category;
    const severity = entry.severity;
    if (
      typeof category !== "string" ||
      !SENTINEL_CATEGORIES.includes(category as SentinelCategory)
    ) {
      throw new Error("labels contains an unknown category");
    }
    if (
      typeof severity !== "string" ||
      !SENTINEL_SEVERITIES.includes(severity as SentinelSeverity)
    ) {
      throw new Error("labels contains an unknown severity");
    }
    const label = {
      category: category as SentinelCategory,
      severity: severity as SentinelSeverity,
    };
    if (
      !labels.some(
        (existing) =>
          existing.category === label.category && existing.severity === label.severity,
      )
    ) {
      labels.push(label);
    }
  }
  return labels;
}

export function parseSentinelEvalCase(value: unknown, path = "case"): SentinelEvalCase {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (value.schemaVersion !== SENTINEL_EVAL_SCHEMA_VERSION) {
    throw new Error(`${path}.schemaVersion is unsupported`);
  }
  const id = requiredString(value.id, `${path}.id`);
  const split = value.split;
  if (typeof split !== "string" || !SENTINEL_EVAL_SPLITS.includes(split as SentinelEvalSplit)) {
    throw new Error(`${path}.split is invalid`);
  }
  const direction = value.direction;
  if (
    typeof direction !== "string" ||
    !SENTINEL_DIRECTIONS.includes(direction as SentinelDirection)
  ) {
    throw new Error(`${path}.direction is invalid`);
  }
  const language = requiredString(value.language, `${path}.language`);
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw new Error(`${path}.language must be a BCP-47 code`);
  }
  const text = requiredString(value.text, `${path}.text`);
  if (text.trim() === "") throw new Error(`${path}.text must not be empty`);
  const expected = value.expected;
  if (!isRecord(expected)) throw new Error(`${path}.expected must be an object`);
  if (
    typeof expected.decision !== "string" ||
    !SENTINEL_EVAL_DECISIONS.includes(expected.decision as SentinelEvalDecision)
  ) {
    throw new Error(`${path}.expected.decision is invalid`);
  }
  const provenance = value.provenance;
  if (!isRecord(provenance)) throw new Error(`${path}.provenance must be an object`);
  if (provenance.kind !== "synthetic" && provenance.kind !== "licensed") {
    throw new Error(`${path}.provenance.kind is invalid`);
  }
  const license = requiredString(provenance.license, `${path}.provenance.license`);
  return {
    schemaVersion: SENTINEL_EVAL_SCHEMA_VERSION,
    id,
    split: split as SentinelEvalSplit,
    direction: direction as SentinelDirection,
    language,
    text,
    labels: parseLabels(value.labels),
    expected: {
      decision: expected.decision as SentinelEvalDecision,
      categories: parseCategories(expected.categories, `${path}.expected.categories`),
    },
    provenance: {
      kind: provenance.kind,
      license,
    },
    notes: requiredString(value.notes, `${path}.notes`),
  };
}

export function loadSentinelEvalCases(source: string): SentinelEvalCase[] {
  const cases: SentinelEvalCase[] = [];
  const ids = new Set<string>();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim();
    if (line === undefined || line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`case line ${index + 1} is not valid JSON`);
    }
    const parsed = parseSentinelEvalCase(value, `case line ${index + 1}`);
    if (ids.has(parsed.id)) throw new Error(`duplicate case id ${parsed.id}`);
    ids.add(parsed.id);
    cases.push(parsed);
  }
  if (cases.length === 0) throw new Error("the eval corpus is empty");
  return cases;
}

export function loadSentinelEvalCasesFile(path: string): SentinelEvalCase[] {
  return loadSentinelEvalCases(readFileSync(path, "utf8"));
}

export function parseSentinelEvalManifest(value: unknown): SentinelEvalManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schemaVersion !== SENTINEL_EVAL_SCHEMA_VERSION) {
    throw new Error("manifest.schemaVersion is unsupported");
  }
  const suiteVersion = requiredString(value.suiteVersion, "manifest.suiteVersion");
  if (value.datasetStatus !== undefined && value.datasetStatus !== "seed" && value.datasetStatus !== "release") {
    throw new Error("manifest.datasetStatus is invalid");
  }
  const minimum = value.minimumCases;
  if (!isRecord(minimum)) throw new Error("manifest.minimumCases must be an object");
  const thresholds = value.thresholds;
  if (!isRecord(thresholds) || !isRecord(thresholds.l1)) {
    throw new Error("manifest.thresholds.l1 must be an object");
  }
  const expectedHashes = value.expectedHashes;
  let hashes: SentinelEvalManifest["expectedHashes"];
  if (expectedHashes !== undefined) {
    if (!isRecord(expectedHashes)) throw new Error("manifest.expectedHashes must be an object");
    hashes = {};
    if (expectedHashes.rulesSha256 !== undefined) {
      hashes.rulesSha256 = parseSha256(
        expectedHashes.rulesSha256,
        "manifest.expectedHashes.rulesSha256",
      );
    }
    if (expectedHashes.casesSha256 !== undefined) {
      hashes.casesSha256 = parseSha256(
        expectedHashes.casesSha256,
        "manifest.expectedHashes.casesSha256",
      );
    }
  }
  return {
    schemaVersion: SENTINEL_EVAL_SCHEMA_VERSION,
    suiteVersion,
    ...(value.datasetStatus === undefined ? {} : { datasetStatus: value.datasetStatus }),
    minimumCases: {
      benignPerLaunchLanguage: requiredNonNegativeInteger(
        minimum.benignPerLaunchLanguage,
        "manifest.minimumCases.benignPerLaunchLanguage",
      ),
      positivePerCategory: requiredNonNegativeInteger(
        minimum.positivePerCategory,
        "manifest.minimumCases.positivePerCategory",
      ),
      adversarialParaphrasePerCategory: requiredNonNegativeInteger(
        minimum.adversarialParaphrasePerCategory,
        "manifest.minimumCases.adversarialParaphrasePerCategory",
      ),
    },
    thresholds: {
      l1: {
        testDecisionAccuracy: requiredProbability(
          thresholds.l1.testDecisionAccuracy,
          "manifest.thresholds.l1.testDecisionAccuracy",
        ),
      },
    },
    ...(hashes === undefined ? {} : { expectedHashes: hashes }),
  };
}

function parseSha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 hash`);
  }
  return value;
}

export function validateSentinelEvalManifest(
  manifest: SentinelEvalManifest,
  cases: readonly SentinelEvalCase[],
  options: { casesSource?: string; rulesSource?: string } = {},
): void {
  if (options.casesSource !== undefined && manifest.expectedHashes?.casesSha256 !== undefined) {
    const actual = sha256(options.casesSource);
    if (actual !== manifest.expectedHashes.casesSha256) {
      throw new Error("the eval corpus hash does not match the manifest");
    }
  }
  if (options.rulesSource !== undefined && manifest.expectedHashes?.rulesSha256 !== undefined) {
    const actual = sha256(options.rulesSource);
    if (actual !== manifest.expectedHashes.rulesSha256) {
      throw new Error("the Sentinel rule source hash does not match the manifest");
    }
  }
  const benignLanguages = new Set(
    cases.filter((item) => item.labels.length === 0).map((item) => item.language),
  );
  if (benignLanguages.size < manifest.minimumCases.benignPerLaunchLanguage) {
    throw new Error("the eval corpus has too few benign launch-language cases");
  }
  const positives = new Map<SentinelCategory, number>();
  const adversarial = new Map<SentinelCategory, number>();
  for (const item of cases) {
    const categories = new Set(item.labels.map((label) => label.category));
    for (const category of categories) {
      positives.set(category, (positives.get(category) ?? 0) + 1);
      if (item.notes.toLowerCase().includes("adversarial")) {
        adversarial.set(category, (adversarial.get(category) ?? 0) + 1);
      }
    }
  }
  for (const category of SENTINEL_CATEGORIES.filter((value) => value !== "harmless")) {
    if ((positives.get(category) ?? 0) < manifest.minimumCases.positivePerCategory) {
      throw new Error(`the eval corpus has too few positive cases for ${category}`);
    }
    if (
      (adversarial.get(category) ?? 0) <
      manifest.minimumCases.adversarialParaphrasePerCategory
    ) {
      throw new Error(`the eval corpus has too few adversarial cases for ${category}`);
    }
  }
}

export function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function sortCategories(categories: readonly SentinelCategory[]): SentinelCategory[] {
  return [...new Set(categories)].sort(
    (left, right) => SENTINEL_CATEGORIES.indexOf(left) - SENTINEL_CATEGORIES.indexOf(right),
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? (numerator === 0 ? 1 : 0) : numerator / denominator;
}

function emptyCategoryMetrics(): SentinelEvalCategoryMetrics {
  return {
    support: 0,
    predicted: 0,
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    trueNegative: 0,
    precision: 1,
    recall: 1,
    f1: 1,
  };
}

function normalizeSentinelEvalDecision(decision: SentinelEvalDecision): SentinelVerdictValue {
  if (decision === "quarantine" || decision === "refuse") return "block";
  return decision;
}

export function evaluateSentinelCase(
  item: SentinelEvalCase,
  ruleSet: SentinelRuleSet,
  policy: SentinelPolicy = DEFAULT_SENTINEL_POLICY,
): SentinelEvalCaseResult {
  const findings = evaluateL1(item.text, ruleSet);
  const decision = decideSentinel(
    findings,
    { direction: item.direction },
    policy,
  );
  const expectedDecision = normalizeSentinelEvalDecision(item.expected.decision);
  return {
    id: item.id,
    expectedDecision,
    actualDecision: decision.verdict,
    expectedCategories: item.expected.categories,
    actualCategories: decision.categories,
    correct: decision.verdict === expectedDecision,
  };
}

export function evaluateSentinelCases(
  cases: readonly SentinelEvalCase[],
  options: SentinelEvalOptions = {},
): SentinelEvalReport {
  const ruleSet = options.ruleSet ?? DEFAULT_RULE_SET;
  const policy = options.policy ?? DEFAULT_SENTINEL_POLICY;
  const threshold = options.threshold ?? 1;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("eval threshold must be between 0 and 1");
  }
  if (cases.length === 0) throw new Error("the eval corpus is empty");
  const perCategory = Object.fromEntries(
    SENTINEL_CATEGORIES.map((category) => [category, emptyCategoryMetrics()]),
  ) as Record<SentinelCategory, SentinelEvalCategoryMetrics>;
  let correctDecisions = 0;
  let benignCases = 0;
  let benignFalsePositives = 0;
  const failures: SentinelEvalCaseResult[] = [];
  for (const item of cases) {
    const result = evaluateSentinelCase(item, ruleSet, policy);
    if (result.correct) correctDecisions++;
    else failures.push(result);
    const actualLabels = new Set(item.labels.map((label) => label.category));
    const predicted = new Set(result.actualCategories);
    if (actualLabels.size === 0) {
      benignCases++;
      if (predicted.size > 0) benignFalsePositives++;
    }
    for (const category of SENTINEL_CATEGORIES) {
      const metrics = perCategory[category];
      const support = actualLabels.has(category);
      const isPredicted = predicted.has(category);
      if (support) metrics.support++;
      if (isPredicted) metrics.predicted++;
      if (support && isPredicted) metrics.truePositive++;
      else if (!support && isPredicted) metrics.falsePositive++;
      else if (support && !isPredicted) metrics.falseNegative++;
      else metrics.trueNegative++;
    }
  }
  for (const category of SENTINEL_CATEGORIES) {
    const metrics = perCategory[category];
    metrics.precision = ratio(metrics.truePositive, metrics.truePositive + metrics.falsePositive);
    metrics.recall = ratio(metrics.truePositive, metrics.truePositive + metrics.falseNegative);
    metrics.f1 = ratio(2 * metrics.precision * metrics.recall, metrics.precision + metrics.recall);
  }
  const totalTruePositive = SENTINEL_CATEGORIES.reduce(
    (sum, category) => sum + perCategory[category].truePositive,
    0,
  );
  const totalPredicted = SENTINEL_CATEGORIES.reduce(
    (sum, category) => sum + perCategory[category].predicted,
    0,
  );
  const totalSupport = SENTINEL_CATEGORIES.reduce(
    (sum, category) => sum + perCategory[category].support,
    0,
  );
  const supportedCategories = SENTINEL_CATEGORIES.filter(
    (category) => perCategory[category].support > 0,
  );
  const decisionAccuracy = ratio(correctDecisions, cases.length);
  return {
    suiteVersion: options.suiteVersion ?? "unversioned",
    ruleSetVersion: ruleSet.version,
    policyVersion: policy.version,
    caseCount: cases.length,
    threshold,
    passed: decisionAccuracy >= threshold,
    overall: {
      decisionAccuracy,
      categoryPrecision: ratio(totalTruePositive, totalPredicted),
      categoryRecall: ratio(totalTruePositive, totalSupport),
      macroF1:
        supportedCategories.length === 0
          ? 1
          : supportedCategories.reduce((sum, category) => sum + perCategory[category].f1, 0) /
            supportedCategories.length,
      benignFalsePositiveRate: ratio(benignFalsePositives, benignCases),
    },
    perCategory,
    failures,
  };
}

export const runSentinelEval = evaluateSentinelCases;
