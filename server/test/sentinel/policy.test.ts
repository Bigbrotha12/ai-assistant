import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_SENTINEL_POLICY,
  SENTINEL_CANNED_RESPONSE_IDS,
  SENTINEL_DECISION_TABLE,
  decideSentinel,
  policyForMode,
} from "../../src/sentinel/policy.ts";
import type {
  L1Finding,
  SentinelCategory,
  SentinelDirection,
  SentinelSeverity,
} from "../../src/sentinel/types.ts";

const directions: SentinelDirection[] = ["input", "tool_result", "output", "speak_pass", "memory"];
const categories: SentinelCategory[] = [
  "self_harm",
  "violence",
  "illegal",
  "pii",
  "child_safety",
  "sexual_content",
  "medical_guardrail",
  "jailbreak_attempt",
  "harmless",
];
const severities: SentinelSeverity[] = ["low", "medium", "high"];

function finding(category: SentinelCategory, severity: SentinelSeverity = "high"): L1Finding {
  return { ruleId: `test.${category}.${severity}`, category, severity };
}

describe("Sentinel L3 policy", () => {
  test("defaults to advisory flagging for findings", () => {
    assert.equal(DEFAULT_SENTINEL_POLICY.mode, "advisory");
    assert.equal(DEFAULT_SENTINEL_POLICY.defaultVerdict, "flag");
    const decision = decideSentinel([finding("illegal")], { direction: "output" });
    assert.equal(decision.verdict, "flag");
    assert.deepEqual(decision.action, {
      cannedResponseId: SENTINEL_CANNED_RESPONSE_IDS.advisory,
    });
  });

  test("allows content with no L1 findings in both modes", () => {
    for (const mode of ["advisory", "blocking"] as const) {
      const decision = decideSentinel([], { direction: "output" }, policyForMode(mode));
      assert.equal(decision.verdict, "allow");
      assert.equal(decision.severity, null);
      assert.deepEqual(decision.categories, []);
      assert.deepEqual(decision.action, { cannedResponseId: null });
    }
  });

  test("flips every risky finding to block in blocking mode", () => {
    for (const category of categories.filter((value) => value !== "harmless")) {
      const advisory = decideSentinel([finding(category, "medium")], { direction: "tool_result" });
      const blocking = decideSentinel(
        [finding(category, "medium")],
        { direction: "tool_result" },
        policyForMode("blocking"),
      );
      assert.equal(advisory.verdict, "flag", category);
      assert.equal(blocking.verdict, "block", category);
      assert.equal(blocking.action.cannedResponseId, SENTINEL_CANNED_RESPONSE_IDS.blocked);
    }
  });

  test("keeps harmless findings allowed", () => {
    const decision = decideSentinel([finding("harmless", "low")], { direction: "memory" });
    assert.equal(decision.verdict, "allow");
  });

  test("aggregates severity, categories, and rule ids deterministically", () => {
    const decision = decideSentinel(
      [
        { ruleId: "z.rule", category: "jailbreak_attempt", severity: "high" },
        { ruleId: "a.rule", category: "illegal", severity: "medium" },
      ],
      { direction: "speak_pass" },
    );
    assert.equal(decision.verdict, "flag");
    assert.equal(decision.severity, "high");
    assert.deepEqual(decision.categories, ["illegal", "jailbreak_attempt"]);
    assert.deepEqual(decision.matchedRuleIds, ["a.rule", "z.rule"]);
  });

  test("uses the repeated-context decision row when recent context repeats a category", () => {
    const decision = decideSentinel([finding("self_harm", "high")], {
      direction: "output",
      recentCategories: ["self_harm"],
    });
    assert.equal(decision.verdict, "flag");
    const blocking = decideSentinel(
      [finding("self_harm", "high")],
      { direction: "output", recentCategories: ["self_harm"] },
      policyForMode("blocking"),
    );
    assert.equal(blocking.verdict, "block");
  });

  test("contains a deterministic row for every direction, category, severity, and context", () => {
    assert.equal(
      SENTINEL_DECISION_TABLE.length,
      directions.length * (1 + categories.length * severities.length * 2),
    );
    for (const row of SENTINEL_DECISION_TABLE) {
      assert.equal(typeof row.id, "string");
      assert.ok(directions.includes(row.direction));
      assert.ok(["none", "any"].includes(row.finding));
      assert.ok(row.category === "any" || categories.includes(row.category));
      assert.ok(row.severity === "any" || severities.includes(row.severity));
      assert.ok(["advisory", "blocking"].includes(row.advisory === "allow" ? "advisory" : "blocking"));
      assert.ok(["advisory", "blocking"].includes(row.blocking === "allow" ? "advisory" : "blocking"));
    }
  });

  test("every table row produces its declared advisory and blocking verdict", () => {
    for (const row of SENTINEL_DECISION_TABLE) {
      if (row.finding === "none") {
        assert.equal(decideSentinel([], { direction: row.direction }).verdict, "allow", row.id);
        continue;
      }
      assert.ok(row.category !== "any");
      assert.ok(row.severity !== "any");
      const context = row.context === "repeated" ? { recentCategories: [row.category] } : {};
      const input = [finding(row.category, row.severity)];
      const advisory = decideSentinel(input, { direction: row.direction, ...context });
      const blocking = decideSentinel(input, { direction: row.direction, ...context }, policyForMode("blocking"));
      assert.equal(advisory.verdict, row.advisory, row.id);
      assert.equal(blocking.verdict, row.blocking, row.id);
    }
  });

  test("rejects an unknown policy mode", () => {
    assert.throws(() => policyForMode("unsafe" as never), /unknown sentinel policy mode/);
  });
});
