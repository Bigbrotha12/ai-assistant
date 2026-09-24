import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { DEFAULT_RULE_SET, evaluateL1 } from "../../src/sentinel/l1.ts";
import {
  evaluateSentinelCases,
  loadSentinelEvalCases,
  parseSentinelEvalManifest,
  validateSentinelEvalManifest,
} from "../../src/sentinel/eval.ts";
import {
  SENTINEL_RULE_SET_SOURCE_JSON,
  SENTINEL_RULE_SET_SOURCE_SHA256,
  SENTINEL_RULE_SET_VERSION,
} from "../../src/sentinel/rules.generated.ts";
import { createHash } from "node:crypto";

const casesUrl = new URL("../../../test/fixtures/sentinel/cases.v1.jsonl", import.meta.url);
const manifestUrl = new URL("../../../test/fixtures/sentinel/manifest.v1.json", import.meta.url);
const mutatedCasesUrl = new URL(
  "../../../test/fixtures/sentinel/cases.mutated.v1.jsonl",
  import.meta.url,
);
const mutatedManifestUrl = new URL(
  "../../../test/fixtures/sentinel/manifest.mutated.v1.json",
  import.meta.url,
);
const rulesUrl = new URL("../../src/sentinel/rules.v1.json", import.meta.url);

function loadJsonl(url: URL): string {
  return readFileSync(url, "utf8");
}

describe("Sentinel S3 evaluation harness", () => {
  test("generated server artifact is pinned to the canonical rule source", () => {
    const source = readFileSync(rulesUrl, "utf8");
    assert.equal(SENTINEL_RULE_SET_SOURCE_JSON, source);
    assert.equal(
      SENTINEL_RULE_SET_SOURCE_SHA256,
      createHash("sha256").update(source, "utf8").digest("hex"),
    );
    assert.equal(DEFAULT_RULE_SET.version, SENTINEL_RULE_SET_VERSION);
  });

  test("seed corpus passes the L1 and L3 policy threshold", () => {
    const source = loadJsonl(casesUrl);
    const cases = loadSentinelEvalCases(source);
    const manifest = parseSentinelEvalManifest(JSON.parse(loadJsonl(manifestUrl)));
    validateSentinelEvalManifest(manifest, cases, {
      casesSource: source,
      rulesSource: readFileSync(rulesUrl, "utf8"),
    });
    const report = evaluateSentinelCases(cases, {
      ruleSet: DEFAULT_RULE_SET,
      threshold: manifest.thresholds.l1.testDecisionAccuracy,
      suiteVersion: manifest.suiteVersion,
    });
    assert.equal(report.passed, true);
    assert.equal(report.caseCount, 19);
    assert.equal(report.overall.decisionAccuracy, 1);
    assert.equal(report.overall.benignFalsePositiveRate, 0);
    assert.equal(report.failures.length, 0);
    assert.equal(report.perCategory.self_harm.precision, 1);
    assert.equal(report.perCategory.jailbreak_attempt.recall, 1);
  });

  test("mutated fixture fails the threshold and reports no corpus text", () => {
    const source = loadJsonl(mutatedCasesUrl);
    const cases = loadSentinelEvalCases(source);
    const manifest = parseSentinelEvalManifest(JSON.parse(loadJsonl(mutatedManifestUrl)));
    validateSentinelEvalManifest(manifest, cases, {
      casesSource: source,
      rulesSource: readFileSync(rulesUrl, "utf8"),
    });
    const report = evaluateSentinelCases(cases, {
      ruleSet: DEFAULT_RULE_SET,
      threshold: manifest.thresholds.l1.testDecisionAccuracy,
      suiteVersion: manifest.suiteVersion,
    });
    assert.equal(report.passed, false);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0]?.id, "input.mutated.en.test.failure");
    assert.equal(report.failures[0]?.expectedDecision, "allow");
    assert.equal(report.failures[0]?.actualDecision, "flag");
    assert.equal(JSON.stringify(report).includes("kill myself"), false);
  });

  test("threshold reporting is deterministic and configurable", () => {
    const cases = loadSentinelEvalCases(loadJsonl(mutatedCasesUrl));
    const first = evaluateSentinelCases(cases, { threshold: 0 });
    const second = evaluateSentinelCases(cases, { threshold: 0 });
    const strict = evaluateSentinelCases(cases, { threshold: 1 });
    assert.deepEqual(first, second);
    assert.equal(first.passed, true);
    assert.equal(strict.passed, false);
    assert.equal(typeof first.overall.decisionAccuracy, "number");
    assert.equal(typeof first.overall.macroF1, "number");
    assert.equal(typeof first.perCategory.self_harm.precision, "number");
  });

  test("schema validation rejects duplicate ids and malformed records", () => {
    const valid = JSON.parse(loadJsonl(casesUrl).split("\n")[0]!) as Record<string, unknown>;
    assert.throws(
      () => loadSentinelEvalCases(`${JSON.stringify(valid)}\n${JSON.stringify(valid)}`),
      /duplicate case id/,
    );
    assert.throws(
      () => loadSentinelEvalCases(
        JSON.stringify({
          ...valid,
          id: "bad.empty",
          text: " ",
        }),
      ),
      /text must be a non-empty string|must not be empty/,
    );
    assert.throws(
      () => loadSentinelEvalCases(
        JSON.stringify({
          ...valid,
          id: "bad.category",
          labels: [{ category: "not-a-category", severity: "high" }],
        }),
      ),
      /unknown category/,
    );
    const compatibility = loadSentinelEvalCases(
      JSON.stringify({
        ...valid,
        id: "compatibility.quarantine",
        expected: { decision: "quarantine", categories: [] },
      }),
    );
    assert.equal(compatibility[0]?.expected.decision, "quarantine");
  });

  test("the shared corpus exercises the same L1 evaluator", () => {
    const cases = loadSentinelEvalCases(loadJsonl(casesUrl));
    for (const item of cases) {
      const findings = evaluateL1(item.text);
      const categories = [...new Set(findings.map((finding) => finding.category))].sort();
      assert.deepEqual(categories, item.expected.categories, item.id);
    }
  });
});
