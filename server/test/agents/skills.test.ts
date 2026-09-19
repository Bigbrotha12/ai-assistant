import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  composeAgentPrompt,
  DEFAULT_SKILL_TOKEN_BUDGET,
} from "../../src/agents/skills.ts";

describe("composeAgentPrompt", () => {
  test("no skills returns systemPrompt verbatim", () => {
    const prompt = "You are a helpful assistant.";
    assert.equal(composeAgentPrompt(prompt), prompt);
    assert.equal(composeAgentPrompt(prompt, []), prompt);
    assert.equal(composeAgentPrompt(prompt, undefined), prompt);
  });

  test("single skill includes title and content", () => {
    const result = composeAgentPrompt("Base prompt.", [
      { id: "recipes", title: "Recipes", content: "## Recipe tips\nUse fresh ingredients." },
    ]);
    assert.ok(result.startsWith("Base prompt."));
    assert.ok(result.includes("## Skills"));
    assert.ok(result.includes("### Recipes"));
    assert.ok(result.includes("## Recipe tips\nUse fresh ingredients."));
  });

  test("multiple skills all included within budget", () => {
    const result = composeAgentPrompt("Base.", [
      { id: "a", title: "Alpha", content: "Short A." },
      { id: "b", title: "Beta", content: "Short B." },
      { id: "c", title: "Gamma", content: "Short C." },
    ], 100_000);
    assert.ok(result.includes("### Alpha"));
    assert.ok(result.includes("### Beta"));
    assert.ok(result.includes("### Gamma"));
  });

  test("over budget drops trailing skills and warns", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };
    try {
      const result = composeAgentPrompt("X.", [
        { id: "keep", title: "Keep", content: "short" },
        { id: "drop1", title: "Drop1", content: "x".repeat(200) },
        { id: "drop2", title: "Drop2", content: "x".repeat(200) },
      ], 10);
      assert.ok(result.includes("### Keep"));
      assert.ok(!result.includes("### Drop1"));
      assert.ok(!result.includes("### Drop2"));
      assert.ok(warnings.some((w) => w.includes("drop1") && w.includes("drop2")));
    } finally {
      console.warn = origWarn;
    }
  });

  test("first skill alone exceeds budget is included anyway (graceful)", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };
    try {
      const result = composeAgentPrompt("X.", [
        { id: "huge", title: "Huge", content: "x".repeat(500) },
        { id: "tiny", title: "Tiny", content: "a" },
      ], 5);
      assert.ok(result.includes("### Huge"));
      assert.ok(!result.includes("### Tiny"));
      assert.ok(warnings.some((w) => w.includes("tiny")));
    } finally {
      console.warn = origWarn;
    }
  });

  test("edge: empty title and content still included", () => {
    const result = composeAgentPrompt("P.", [
      { id: "empty", title: "", content: "" },
    ]);
    assert.ok(result.includes("### "));
  });

  test("edge: large skill truncated at budget level", () => {
    const long = "x".repeat(10_000);
    const result = composeAgentPrompt(long, [
      { id: "s", title: "S", content: "short" },
    ], 10);
    assert.ok(result.includes("### S"));
    assert.ok(result.includes("short"));
  });

  test("default budget constant is 6000", () => {
    assert.equal(DEFAULT_SKILL_TOKEN_BUDGET, 6000);
  });

  test("custom budget parameter is honored", () => {
    const result = composeAgentPrompt("P.", [
      { id: "s1", title: "S1", content: "a".repeat(400) },
      { id: "s2", title: "S2", content: "b".repeat(400) },
    ], 100);
    assert.ok(result.includes("### S1"));
    assert.ok(!result.includes("### S2"));
  });
});