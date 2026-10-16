import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  SENTINEL_SEMANTIC_BYTES_PER_TOKEN,
  SENTINEL_SEMANTIC_CACHE_MAX_ENTRIES,
  SENTINEL_SEMANTIC_DESCRIPTIONS,
  SENTINEL_SEMANTIC_MODEL_ID,
  SENTINEL_SEMANTIC_QUESTION_BYTE_RESERVE,
  SENTINEL_SEMANTIC_SEVERITY,
  SENTINEL_SEMANTIC_SPECIAL_TOKEN_RESERVE,
  SENTINEL_SEMANTIC_TRUNCATION_MARKER,
  SentinelSemanticCache,
  boundSemanticState,
  buildSemanticQuestions,
  evaluateSemanticAnswers,
  evaluateSentinelSemantic,
  evaluateSentinelSemanticCached,
  semanticCacheKey,
  semanticInstruction,
  semanticModelVersion,
  semanticRuleId,
  semanticStateByteBudget,
  sentinelFindingsForDecision,
} from "../../src/sentinel/semantic.ts";
import type { SemanticEvaluation } from "../../src/sentinel/semantic.ts";
import { SENTINEL_CATEGORIES } from "../../src/sentinel/types.ts";
import type { SentinelCategory, SentinelFinding, SentinelSeverity } from "../../src/sentinel/types.ts";
import type {
  DecisionAnswer,
  DecisionAnswers,
  DecisionClient,
  DecisionQuestion,
} from "../../src/transport/decisions.ts";

const OPTIONS = { threshold: 0.5, contextAware: true, modelVersion: "kev-4b@1.0.0" } as const;

function answersWith(
  overrides: Partial<Record<SentinelCategory, DecisionAnswer>> = {},
): DecisionAnswers {
  const answers: Record<string, DecisionAnswer> = {};
  for (const category of SENTINEL_CATEGORIES) {
    answers[category] = overrides[category] ?? { ok: true, probability: 0.1 };
  }
  return answers;
}

function fakeClient(answers: DecisionAnswers): DecisionClient {
  return {
    endpoint: "http://decision.example/v1/systemone",
    tokenLimit: 512,
    decide: async () => answers,
  };
}

describe("Sentinel semantic questions", () => {
  test("uses the Kev-4B decision model id", () => {
    assert.equal(SENTINEL_SEMANTIC_MODEL_ID, "kev-4b");
    assert.equal(semanticModelVersion({ id: "kev-4b", version: "1.0.0" }), "kev-4b@1.0.0");
  });

  test("asks exactly one noul question per category, including harmless", () => {
    const questions = buildSemanticQuestions(false);
    assert.deepEqual(Object.keys(questions), [...SENTINEL_CATEGORIES]);
    assert.equal(Object.keys(questions).length, 9);
    for (const category of SENTINEL_CATEGORIES) {
      assert.equal(questions[category].type, "noul", category);
      assert.ok(questions[category].instructions.trim().length > 0, category);
    }
    assert.equal(questions.self_harm.instructions, "Does the text concern self-harm or suicide?");
    assert.equal(questions.harmless.instructions, "Does the text concern benign or harmless content?");
  });

  test("context-aware instructions ask about intent, not mere mention", () => {
    const plain = buildSemanticQuestions(false);
    const aware = buildSemanticQuestions(true);
    assert.equal(
      aware.self_harm.instructions,
      "Does the text itself express or request self-harm or suicide, as opposed to merely mentioning, quoting, or warning about it?",
    );
    assert.notEqual(aware.self_harm.instructions, plain.self_harm.instructions);
    assert.equal(
      semanticInstruction("jailbreak_attempt", true),
      aware.jailbreak_attempt.instructions,
    );
    for (const category of SENTINEL_CATEGORIES) {
      assert.notEqual(aware[category].instructions, plain[category].instructions, category);
    }
  });

  test("covers every category with a description and the settled severity mapping", () => {
    for (const category of SENTINEL_CATEGORIES) {
      assert.ok(SENTINEL_SEMANTIC_DESCRIPTIONS[category].trim().length > 0, category);
      assert.ok(SENTINEL_SEMANTIC_SEVERITY[category], category);
    }
    const expected: Record<SentinelCategory, SentinelSeverity> = {
      self_harm: "high",
      violence: "high",
      illegal: "high",
      pii: "high",
      child_safety: "high",
      jailbreak_attempt: "high",
      sexual_content: "medium",
      medical_guardrail: "medium",
      harmless: "low",
    };
    assert.deepEqual(SENTINEL_SEMANTIC_SEVERITY, expected);
  });

  test("uses a non-empty synthetic semantic.<category> rule id", () => {
    for (const category of SENTINEL_CATEGORIES) {
      const id = semanticRuleId(category);
      assert.equal(id, `semantic.${category}`);
      assert.ok(id.trim().length > 0, category);
    }
  });
});

describe("Sentinel semantic evaluation", () => {
  test("thresholds each category into a semantic finding carrying its probability", () => {
    const evaluation = evaluateSemanticAnswers(
      answersWith({
        self_harm: { ok: true, probability: 0.9 },
        sexual_content: { ok: true, probability: 0.6 },
        harmless: { ok: true, probability: 0.8 },
      }),
      OPTIONS,
    );
    assert.equal(evaluation.available, true);
    if (!evaluation.available) return;
    assert.deepEqual(
      evaluation.findings.map((finding) => finding.category),
      ["self_harm", "sexual_content", "harmless"],
    );
    const selfHarm = evaluation.findings.find((finding) => finding.category === "self_harm");
    assert.equal(selfHarm?.ruleId, "semantic.self_harm");
    assert.equal(selfHarm?.source, "semantic");
    assert.equal(selfHarm?.severity, "high");
    assert.equal(selfHarm?.confidence, 0.9);
    const harmless = evaluation.findings.find((finding) => finding.category === "harmless");
    assert.equal(harmless?.severity, "low");
    assert.equal(evaluation.probabilities.harmless, 0.8);
    assert.equal(evaluation.modelVersion, "kev-4b@1.0.0");
    assert.equal(evaluation.threshold, 0.5);
    assert.equal(evaluation.contextAware, true);
  });

  test("fires at the threshold boundary and drops below it", () => {
    const evaluation = evaluateSemanticAnswers(
      answersWith({ violence: { ok: true, probability: 0.5 } }),
      OPTIONS,
    );
    assert.equal(evaluation.available, true);
    if (!evaluation.available) return;
    assert.ok(evaluation.findings.some((finding) => finding.category === "violence"));
    assert.equal(
      evaluation.findings.some((finding) => finding.category === "illegal"),
      false,
    );
  });

  test("treats ANY failed question as semantic unavailable, not a partial verdict", () => {
    const evaluation = evaluateSemanticAnswers(
      answersWith({
        self_harm: { ok: true, probability: 0.99 },
        violence: { ok: false, error: "timeout" },
      }),
      OPTIONS,
    );
    assert.equal(evaluation.available, false);
    if (evaluation.available) return;
    assert.equal(evaluation.fallback, "l1");
    assert.equal(evaluation.reason, "timeout");
    assert.equal(evaluation.failedCategory, "violence");
  });

  test("treats a missing category answer as unavailable", () => {
    const answers = answersWith();
    delete (answers as Record<string, DecisionAnswer>).pii;
    const evaluation = evaluateSemanticAnswers(answers, OPTIONS);
    assert.equal(evaluation.available, false);
    if (evaluation.available) return;
    assert.equal(evaluation.reason, "missing_answer");
    assert.equal(evaluation.failedCategory, "pii");
  });

  test("rejects an out-of-range threshold", () => {
    for (const threshold of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => evaluateSemanticAnswers(answersWith(), { ...OPTIONS, threshold }),
        RangeError,
        String(threshold),
      );
    }
  });

  test("async wrapper asks the context-aware questions and degrades on a thrown client", async () => {
    let captured: Record<string, DecisionQuestion> | undefined;
    const client: DecisionClient = {
      endpoint: "http://decision.example/v1/systemone",
      tokenLimit: 512,
      decide: async (_state, questions) => {
        captured = questions;
        return answersWith({ self_harm: { ok: true, probability: 0.9 } });
      },
    };
    const evaluation = await evaluateSentinelSemantic(client, "text", OPTIONS);
    assert.deepEqual(captured, buildSemanticQuestions(true));
    assert.equal(evaluation.available, true);

    const failed = await evaluateSentinelSemantic(
      fakeClient(answersWith({ illegal: { ok: false, error: "network" } })),
      "text",
      OPTIONS,
    );
    assert.equal(failed.available, false);
    if (!failed.available) assert.equal(failed.fallback, "l1");

    const throwing: DecisionClient = {
      endpoint: "http://decision.example/v1/systemone",
      tokenLimit: 512,
      decide: async () => {
        throw new Error("boom");
      },
    };
    const thrown = await evaluateSentinelSemantic(throwing, "text", OPTIONS);
    assert.equal(thrown.available, false);
    if (!thrown.available) assert.equal(thrown.reason, "client_error");
  });

  test("selects semantic findings when available and falls back to L1 without unioning", () => {
    const l1: SentinelFinding[] = [
      { ruleId: "illegal.weapon_or_fraud", category: "illegal", severity: "high", source: "l1" },
    ];
    const available = evaluateSemanticAnswers(
      answersWith({ self_harm: { ok: true, probability: 0.9 } }),
      OPTIONS,
    );
    const chosen = sentinelFindingsForDecision(l1, available);
    assert.deepEqual(chosen.map((finding) => finding.source), ["semantic"]);
    assert.equal(chosen.some((finding) => finding.category === "illegal"), false);

    const unavailable = evaluateSemanticAnswers(
      answersWith({ violence: { ok: false, error: "timeout" } }),
      OPTIONS,
    );
    assert.equal(sentinelFindingsForDecision(l1, unavailable), l1);
  });
});

describe("Sentinel semantic cache", () => {
  test("cache key folds in text, threshold, context-aware, and model version", () => {
    const base = { text: "hello", threshold: 0.5, contextAware: false, modelVersion: "kev-4b@1.0.0" };
    assert.equal(semanticCacheKey(base), semanticCacheKey({ ...base }));
    assert.notEqual(semanticCacheKey(base), semanticCacheKey({ ...base, text: "world" }));
    assert.notEqual(semanticCacheKey(base), semanticCacheKey({ ...base, threshold: 0.6 }));
    assert.notEqual(semanticCacheKey(base), semanticCacheKey({ ...base, contextAware: true }));
    assert.notEqual(semanticCacheKey(base), semanticCacheKey({ ...base, modelVersion: "kev-4b@1.0.1" }));
  });

  test("bounds entries and evicts the least-recently-used key", () => {
    const cache = new SentinelSemanticCache(2);
    const value = evaluateSemanticAnswers(answersWith(), OPTIONS) as SemanticEvaluation;
    cache.set("a", value);
    cache.set("b", value);
    assert.equal(cache.get("a"), value);
    cache.set("c", value);
    assert.equal(cache.size, 2);
    assert.equal(cache.get("a"), value);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("c"), value);
    assert.equal(SENTINEL_SEMANTIC_CACHE_MAX_ENTRIES, 512);
    assert.throws(() => new SentinelSemanticCache(0), RangeError);
  });
});

describe("Sentinel semantic state bounding", () => {
  test("reserves room for the longest serialized question plus the special tokens", () => {
    assert.equal(SENTINEL_SEMANTIC_BYTES_PER_TOKEN, 1);
    const instructions = SENTINEL_CATEGORIES.flatMap((category) => [
      buildSemanticQuestions(false)[category].instructions,
      buildSemanticQuestions(true)[category].instructions,
    ]);
    const longestInstruction = Math.max(
      ...instructions.map((instruction) => Buffer.byteLength(instruction, "utf8")),
    );
    assert.ok(
      SENTINEL_SEMANTIC_QUESTION_BYTE_RESERVE > 64,
      "the reserve must exceed the old fixed 64-byte value",
    );
    assert.ok(
      SENTINEL_SEMANTIC_QUESTION_BYTE_RESERVE > longestInstruction,
      "the reserve covers the longest instruction and its JSON envelope",
    );
    assert.equal(SENTINEL_SEMANTIC_SPECIAL_TOKEN_RESERVE, 2);
  });

  test("sizes the state byte budget from the token window minus the full reserve", () => {
    const reserve =
      SENTINEL_SEMANTIC_QUESTION_BYTE_RESERVE + SENTINEL_SEMANTIC_SPECIAL_TOKEN_RESERVE;
    assert.equal(semanticStateByteBudget(reserve + 512), 512);
    assert.equal(semanticStateByteBudget(reserve), 0, "the reserve can consume the whole window");
    assert.equal(semanticStateByteBudget(reserve + 1), 1);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => semanticStateByteBudget(bad), RangeError, String(bad));
    }
  });

  test("returns the state unchanged when it already fits the byte budget", () => {
    assert.equal(boundSemanticState("héllo", 32), "héllo");
    assert.equal(boundSemanticState("", 0), "");
  });

  test("preserves both the head and the tail when truncating", () => {
    const tail = "HARMFUL_TAIL_TEXT";
    const state = "A".repeat(100) + tail;
    const bounded = boundSemanticState(state, 60);
    assert.ok(Buffer.byteLength(bounded, "utf8") <= 60);
    assert.ok(bounded.includes(SENTINEL_SEMANTIC_TRUNCATION_MARKER), "the elision marker is present");
    assert.ok(bounded.startsWith("A"), "the head is retained");
    assert.ok(bounded.endsWith(tail), "tail content survives truncation");
    assert.equal("A".repeat(60).includes(tail), false, "a head-only cut would have dropped the tail");
  });

  test("never splits a surrogate pair or multibyte character at either cut", () => {
    const emoji = "😀"; // 4 UTF-8 bytes, 2 UTF-16 code units
    const bounded = boundSemanticState(emoji.repeat(20), 30);
    assert.ok(Buffer.byteLength(bounded, "utf8") <= 30);
    assert.equal(bounded.includes("\uFFFD"), false, "no replacement character is introduced");
    assert.equal(Buffer.from(bounded, "utf8").toString("utf8"), bounded, "valid UTF-8 round-trip");
    assert.equal(
      bounded,
      emoji.repeat(3) + SENTINEL_SEMANTIC_TRUNCATION_MARKER + emoji.repeat(3),
    );
  });

  test("degrades to a head-only prefix when the budget cannot hold the marker", () => {
    const emoji = "😀";
    const markerBytes = Buffer.byteLength(SENTINEL_SEMANTIC_TRUNCATION_MARKER, "utf8");
    assert.ok(markerBytes > 1);
    assert.equal(boundSemanticState("abcdef", markerBytes - 1), "abcd");
    assert.equal(boundSemanticState(emoji, 2), "");
    assert.equal(boundSemanticState(emoji, 3), "", "a partial surrogate pair is never emitted");
    assert.equal(boundSemanticState(emoji, 4), emoji);
    // BMP multibyte characters count their full UTF-8 length too.
    assert.equal(boundSemanticState("héllo", 3), "hé");
  });

  test("rejects a non-integer or negative byte budget", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      assert.throws(() => boundSemanticState("x", bad), RangeError, String(bad));
    }
  });
});

describe("Sentinel semantic cached wrapper", () => {
  type CapturedCall = { state: string; questions: Record<string, DecisionQuestion> };

  function recordingClient(
    reply: () => DecisionAnswers,
    tokenLimit = 512,
  ): { client: DecisionClient; calls: CapturedCall[] } {
    const calls: CapturedCall[] = [];
    const client: DecisionClient = {
      endpoint: "http://decision.example/v1/systemone",
      tokenLimit,
      decide: async (state, questions) => {
        calls.push({ state, questions });
        return reply();
      },
    };
    return { client, calls };
  }

  function optionsFor(cache: SentinelSemanticCache) {
    return { ...OPTIONS, cache };
  }

  test("serves a repeated evaluation from the cache without re-asking", async () => {
    const { client, calls } = recordingClient(() =>
      answersWith({ self_harm: { ok: true, probability: 0.9 } })
    );
    const cache = new SentinelSemanticCache();
    const first = await evaluateSentinelSemanticCached(client, "same text", optionsFor(cache));
    const second = await evaluateSentinelSemanticCached(client, "same text", optionsFor(cache));
    assert.equal(calls.length, 1, "the second call is a cache hit");
    assert.equal(cache.size, 1);
    assert.equal(first, second, "the cached evaluation object is returned verbatim");
    assert.equal(second.available, true);
  });

  test("keeps distinct cache entries for threshold, context-aware, model version, and full text", async () => {
    const { client, calls } = recordingClient(() => answersWith());
    const cache = new SentinelSemanticCache();
    await evaluateSentinelSemanticCached(client, "text", { ...OPTIONS, cache });
    await evaluateSentinelSemanticCached(client, "text", { ...OPTIONS, cache, threshold: 0.6 });
    await evaluateSentinelSemanticCached(client, "text", { ...OPTIONS, cache, contextAware: false });
    await evaluateSentinelSemanticCached(client, "text", { ...OPTIONS, cache, modelVersion: "kev-4b@1.0.1" });
    await evaluateSentinelSemanticCached(client, "other text", { ...OPTIONS, cache });
    assert.equal(calls.length, 5, "each key input is a distinct question set");
    assert.equal(cache.size, 5);
  });

  test("caches only available evaluations; a transient failure stays retryable", async () => {
    const cache = new SentinelSemanticCache();
    let fail = true;
    const { client, calls } = recordingClient(() =>
      fail
        ? answersWith({ violence: { ok: false, error: "timeout" } })
        : answersWith({ violence: { ok: true, probability: 0.9 } })
    );
    const first = await evaluateSentinelSemanticCached(client, "retry me", optionsFor(cache));
    assert.equal(first.available, false);
    if (!first.available) assert.equal(first.fallback, "l1");
    assert.equal(cache.size, 0, "an unavailable result is not memoized");

    fail = false;
    const retried = await evaluateSentinelSemanticCached(client, "retry me", optionsFor(cache));
    assert.equal(calls.length, 2, "the failure did not pin the L1 fallback");
    assert.equal(retried.available, true);
    assert.equal(cache.size, 1);

    const hit = await evaluateSentinelSemanticCached(client, "retry me", optionsFor(cache));
    assert.equal(calls.length, 2, "the successful retry is now cached");
    assert.equal(hit, retried);
  });

  test("leaves a thrown client as an unavailable, uncached evaluation", async () => {
    const cache = new SentinelSemanticCache();
    const client: DecisionClient = {
      endpoint: "http://decision.example/v1/systemone",
      tokenLimit: 512,
      decide: async () => {
        throw new Error("boom");
      },
    };
    const evaluation = await evaluateSentinelSemanticCached(client, "text", optionsFor(cache));
    assert.equal(evaluation.available, false);
    if (!evaluation.available) assert.equal(evaluation.reason, "client_error");
    assert.equal(cache.size, 0);
  });

  test("bounds the state to the client token budget before decide", async () => {
    const reserve =
      SENTINEL_SEMANTIC_QUESTION_BYTE_RESERVE + SENTINEL_SEMANTIC_SPECIAL_TOKEN_RESERVE;
    const tokenLimit = reserve + 40;
    const { client, calls } = recordingClient(() => answersWith(), tokenLimit);
    const cache = new SentinelSemanticCache();
    const state = "x".repeat(500);
    await evaluateSentinelSemanticCached(client, state, optionsFor(cache));
    assert.equal(calls.length, 1);
    assert.equal(semanticStateByteBudget(tokenLimit), 40);
    assert.ok(Buffer.byteLength(calls[0]!.state, "utf8") <= 40);
    assert.ok(calls[0]!.state.includes(SENTINEL_SEMANTIC_TRUNCATION_MARKER));
    assert.ok(calls[0]!.state.startsWith("x"));
    assert.ok(calls[0]!.state.endsWith("x"));
  });

  test("keys on the full state even when two states truncate to the same bounded window", async () => {
    const { client, calls } = recordingClient(() => answersWith(), 512);
    const cache = new SentinelSemanticCache();
    const maxStateBytes = 13; // head "ABCD" (4) + marker (5) + tail "WXYZ" (4)
    await evaluateSentinelSemanticCached(client, "ABCD" + "x".repeat(100) + "WXYZ", {
      ...OPTIONS,
      cache,
      maxStateBytes,
    });
    await evaluateSentinelSemanticCached(client, "ABCD" + "y".repeat(100) + "WXYZ", {
      ...OPTIONS,
      cache,
      maxStateBytes,
    });
    const expected = `ABCD${SENTINEL_SEMANTIC_TRUNCATION_MARKER}WXYZ`;
    assert.deepEqual(calls.map((call) => call.state), [expected, expected]);
    assert.equal(calls.length, 2, "distinct full texts are distinct cache keys");
    assert.equal(cache.size, 2);
  });

  test("honors the injected cache bound and evicts through the wrapper", async () => {
    const { client, calls } = recordingClient(() => answersWith());
    const cache = new SentinelSemanticCache(1);
    await evaluateSentinelSemanticCached(client, "first", optionsFor(cache));
    await evaluateSentinelSemanticCached(client, "second", optionsFor(cache));
    assert.equal(cache.size, 1, "the cache stays bounded to its configured maximum");
    await evaluateSentinelSemanticCached(client, "first", optionsFor(cache));
    assert.equal(calls.length, 3, "the evicted first entry is recomputed");
  });
});
