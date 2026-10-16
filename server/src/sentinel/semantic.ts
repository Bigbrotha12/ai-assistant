import { createHash } from "node:crypto";
import type {
  DecisionAnswers,
  DecisionClient,
  DecisionErrorCode,
  DecisionQuestion,
} from "../transport/decisions.ts";
import { SENTINEL_CATEGORIES } from "./types.ts";
import type {
  SentinelCategory,
  SentinelFinding,
  SentinelSeverity,
} from "./types.ts";

/**
 * Sentinel semantic layer: the pure half of the Kev-4B decision-model stage.
 *
 * `transport/decisions.ts` owns the wire contract and failure classification;
 * this module owns WHAT is asked (one `noul` question per Sentinel category,
 * phrased with the POC wording), HOW an answer becomes a finding
 * (category-derived severity, synthetic `semantic.<category>` rule id), and
 * WHEN the stage is unavailable. `evaluateSentinelSemanticCached` adds the
 * reusable entry point: it memoizes successful evaluations in an injected
 * bounded cache and bounds the state to the decision client's token budget
 * before asking. The async caller (`shadow.ts` drain, `service.ts` check) is
 * wired in a later step, so the prompt, severity mapping, thresholding, cache
 * key, truncation, and fallback decision stay deterministic and unit-testable.
 */

/** The internal decision model Sentinel asks. */
export const SENTINEL_SEMANTIC_MODEL_ID = "kev-4b";

/**
 * Category descriptions, verbatim from the POC harness (`semantic_eval.py`
 * `CATEGORIES`). `harmless` is not a POC category but Sentinel asks about it so
 * every category gets a probability; a high score there means benign content.
 */
export const SENTINEL_SEMANTIC_DESCRIPTIONS: Readonly<Record<SentinelCategory, string>> = {
  self_harm: "self-harm or suicide",
  violence: "harming other people",
  illegal: "weapons, fraud, or drugs",
  pii: "personal identifying information such as SSNs or home addresses",
  child_safety: "sexual content involving a child",
  sexual_content: "explicit sexual content",
  medical_guardrail: "unsafe medical advice such as diagnosis or prescription",
  jailbreak_attempt: "bypassing or overriding system instructions",
  harmless: "benign or harmless content",
};

/**
 * Category-derived severity (plan §5). Keeping severity a function of the
 * category — not of confidence — means L1 and semantic land on the same
 * decision-table row for a category. Confidence rides on the finding as a
 * routing signal and never changes the verdict.
 */
export const SENTINEL_SEMANTIC_SEVERITY: Readonly<Record<SentinelCategory, SentinelSeverity>> = {
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

/** Synthetic, non-empty rule id for a semantic finding. */
export function semanticRuleId(category: SentinelCategory): string {
  return `semantic.${category}`;
}

/** `plugin id @ version`, the model-version token a report/cache keys on. */
export function semanticModelVersion(plugin: { id: string; version: string }): string {
  return `${plugin.id}@${plugin.version}`;
}

/**
 * One `noul` instruction for a category. The context-aware wording (POC
 * `--context-aware`) asks about intent — does the text itself express/request
 * it — rather than mere topical mention, which cut false positives on quoted
 * or warned-about content.
 */
export function semanticInstruction(
  category: SentinelCategory,
  contextAware: boolean,
): string {
  const description = SENTINEL_SEMANTIC_DESCRIPTIONS[category];
  return contextAware
    ? `Does the text itself express or request ${description}, as opposed to merely mentioning, quoting, or warning about it?`
    : `Does the text concern ${description}?`;
}

/**
 * One question per category — all nine, including `harmless` — keyed by the
 * category name so the answer map is exhaustive. The transport still sends one
 * POST per question; this only shapes the question set.
 */
export function buildSemanticQuestions(
  contextAware: boolean,
): Record<SentinelCategory, DecisionQuestion> {
  const questions = {} as Record<SentinelCategory, DecisionQuestion>;
  for (const category of SENTINEL_CATEGORIES) {
    questions[category] = {
      type: "noul",
      instructions: semanticInstruction(category, contextAware),
    };
  }
  return questions;
}

export type SemanticCacheKeyInput = {
  text: string;
  threshold: number;
  contextAware: boolean;
  modelVersion: string;
};

/**
 * Cache key for a semantic verdict. Same text under a different threshold,
 * prompt style, or model version is a different question set with different
 * probabilities, so all four inputs are folded in.
 */
export function semanticCacheKey(input: SemanticCacheKeyInput): string {
  const digest = createHash("sha256").update(input.text, "utf8").digest("hex");
  return [
    digest,
    String(input.threshold),
    input.contextAware ? "context-aware" : "plain",
    input.modelVersion,
  ].join("\u0000");
}

export const SENTINEL_SEMANTIC_CACHE_MAX_ENTRIES = 512;

/**
 * Bounded LRU cache of semantic evaluations. The shadow path sees the same text
 * across turns, but the decision model is a hard dependency, so the cache is
 * capped and evicts the least-recently-used entry rather than growing without
 * bound.
 */
export class SentinelSemanticCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, SemanticEvaluation>();

  constructor(maxEntries: number = SENTINEL_SEMANTIC_CACHE_MAX_ENTRIES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("semantic cache maxEntries must be a positive safe integer");
    }
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): SemanticEvaluation | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: SemanticEvaluation): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Why the semantic stage could not produce a verdict. A single failed question
 * makes the whole stage unavailable: a partial answer set would silently
 * downgrade a harmful category to "not seen", so the caller falls back to the
 * L1 verdict instead of trusting a partial one.
 */
export type SemanticUnavailableReason = "missing_answer" | "client_error" | DecisionErrorCode;

export type SemanticUnavailable = {
  readonly available: false;
  /** Signal to the caller: use the L1-only verdict for this text. */
  readonly fallback: "l1";
  readonly reason: SemanticUnavailableReason;
  /** The category whose question failed, when it was a per-question failure. */
  readonly failedCategory?: SentinelCategory;
};

export type SemanticAvailable = {
  readonly available: true;
  readonly modelVersion: string;
  readonly threshold: number;
  readonly contextAware: boolean;
  readonly probabilities: Readonly<Record<SentinelCategory, number>>;
  readonly findings: readonly SentinelFinding[];
};

export type SemanticEvaluation = SemanticAvailable | SemanticUnavailable;

export type SemanticEvaluateOptions = {
  /** Confidence at or above which a category fires (0..1). */
  threshold: number;
  contextAware: boolean;
  modelVersion: string;
};

function normalizeThreshold(threshold: number): number {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError("semantic threshold must be between 0 and 1");
  }
  return threshold;
}

function unavailable(
  reason: SemanticUnavailableReason,
  failedCategory?: SentinelCategory,
): SemanticUnavailable {
  return {
    available: false,
    fallback: "l1",
    reason,
    ...(failedCategory === undefined ? {} : { failedCategory }),
  };
}

/**
 * Turn a full answer set into findings, or signal L1 fallback if ANY question
 * failed. A semantic finding uses the category-derived severity, the synthetic
 * `semantic.<category>` rule id, and carries the raw probability as
 * `confidence`.
 */
export function evaluateSemanticAnswers(
  answers: DecisionAnswers,
  options: SemanticEvaluateOptions,
): SemanticEvaluation {
  const threshold = normalizeThreshold(options.threshold);
  const probabilities = {} as Record<SentinelCategory, number>;
  for (const category of SENTINEL_CATEGORIES) {
    const answer = answers[category];
    if (answer === undefined) return unavailable("missing_answer", category);
    if (!answer.ok) return unavailable(answer.error, category);
    probabilities[category] = answer.probability;
  }
  const findings: SentinelFinding[] = SENTINEL_CATEGORIES
    .filter((category) => probabilities[category] >= threshold)
    .map((category) => ({
      ruleId: semanticRuleId(category),
      category,
      severity: SENTINEL_SEMANTIC_SEVERITY[category],
      source: "semantic" as const,
      confidence: probabilities[category],
    }));
  return {
    available: true,
    modelVersion: options.modelVersion,
    threshold,
    contextAware: options.contextAware,
    probabilities,
    findings,
  };
}

/**
 * Choose which findings feed `decideSentinel`. When the semantic stage answered,
 * its findings alone decide: L1 is NOT unioned in (the POC's naive union scored
 * worse than semantic alone and only added false positives). On a semantic
 * failure the deterministic L1 findings are the fallback. The caller keeps BOTH
 * sets for audit either way.
 */
export function sentinelFindingsForDecision(
  l1Findings: readonly SentinelFinding[],
  semantic: SemanticEvaluation,
): readonly SentinelFinding[] {
  return semantic.available ? semantic.findings : l1Findings;
}

/**
 * Conservative bytes-per-token ceiling used to size the state cap without a
 * bundled tokenizer. Any tokenizer fragments its input into tokens that each
 * span at least one UTF-8 byte, so a text's token count can never exceed its
 * byte count. Capping the state at `tokenLimit` bytes therefore cannot overflow
 * the model's sequence window; it deliberately under-uses the window rather
 * than risk an upstream silent truncation. An exact count would need the
 * server's vocabulary, which the gateway does not carry.
 */
export const SENTINEL_SEMANTIC_BYTES_PER_TOKEN = 1;

/**
 * Tokens any encoder wraps a sequence in before scoring (BOS/EOS and padding).
 * Subtracted alongside the question envelope so the state cap lands below the
 * raw window rather than exactly at it.
 */
export const SENTINEL_SEMANTIC_SPECIAL_TOKEN_RESERVE = 2;

/**
 * Bytes the non-state part of one decision request occupies: the longest
 * `noul` instruction across every category and phrasing mode, its category id,
 * and the surrounding JSON envelope the client serializes
 * (`{"state":"","questions":{"<id>":{"type":"noul","instructions":"..."}}}`).
 *
 * Derived from the actual question set at module load rather than a hand-copied
 * number, so a wording change cannot silently push a request past the model
 * window. The previous fixed 64-byte reserve was smaller than the longest
 * instruction alone, which let the state cap overshoot the window.
 */
export const SENTINEL_SEMANTIC_QUESTION_BYTE_RESERVE = longestQuestionEnvelopeBytes();

function longestQuestionEnvelopeBytes(): number {
  let longest = 0;
  for (const contextAware of [false, true]) {
    const questions = buildSemanticQuestions(contextAware);
    for (const category of SENTINEL_CATEGORIES) {
      const body = JSON.stringify({ state: "", questions: { [category]: questions[category] } });
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > longest) longest = bytes;
    }
  }
  return longest;
}

/**
 * UTF-8 byte budget for `state` given the decision model's token budget, after
 * reserving room for the question envelope and the encoder's special tokens.
 * Under the conservative `bytes <= tokens` assumption this keeps the whole
 * request within the window. Returns `0` when the reserve consumes the window.
 */
export function semanticStateByteBudget(tokenLimit: number): number {
  if (!Number.isSafeInteger(tokenLimit) || tokenLimit <= 0) {
    throw new RangeError("semantic token budget must be a positive safe integer");
  }
  const reserve =
    SENTINEL_SEMANTIC_QUESTION_BYTE_RESERVE + SENTINEL_SEMANTIC_SPECIAL_TOKEN_RESERVE;
  const usable = tokenLimit - reserve;
  return usable <= 0 ? 0 : usable * SENTINEL_SEMANTIC_BYTES_PER_TOKEN;
}

/**
 * Marker inserted between the retained head and tail when `state` exceeds the
 * budget, so the model can tell content was removed and does not read the two
 * fragments as one contiguous passage.
 */
export const SENTINEL_SEMANTIC_TRUNCATION_MARKER = "\n…\n";

/** Longest prefix of `state` whose UTF-8 length fits `maxBytes`, split only at code-point boundaries. */
function utf8Head(state: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const codePoint of state) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return state.slice(0, end);
}

/** Longest suffix of `state` whose UTF-8 length fits `maxBytes`, split only at code-point boundaries. */
function utf8Tail(state: string, maxBytes: number): string {
  let bytes = 0;
  let start = state.length;
  while (start > 0) {
    let unitStart = start - 1;
    const unit = state.charCodeAt(unitStart);
    if (unit >= 0xdc00 && unit <= 0xdfff && unitStart > 0) {
      const previous = state.charCodeAt(unitStart - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) unitStart -= 1;
    }
    const codePointBytes = Buffer.byteLength(state.slice(unitStart, start), "utf8");
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    start = unitStart;
  }
  return state.slice(start);
}

/**
 * Deterministic, Unicode-safe truncation of `state` to a UTF-8 byte budget that
 * keeps BOTH ends: head and tail each take a share of the budget, joined by a
 * marker when content was removed. Head-only truncation let harmful text past
 * the cap — a request appended after a long benign preamble — stay invisible to
 * the semantic-only decision, so the tail is preserved too.
 *
 * Both cuts iterate by code point so a surrogate pair is never split into a
 * lone surrogate (which would serialize to U+FFFD and change the evaluated
 * text); combining sequences may be split, which cannot produce invalid
 * Unicode. A state already within budget is returned unchanged; a budget too
 * small to hold the marker degrades to a head-only prefix.
 */
export function boundSemanticState(state: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("semantic state maxBytes must be a non-negative safe integer");
  }
  if (Buffer.byteLength(state, "utf8") <= maxBytes) return state;
  const markerBytes = Buffer.byteLength(SENTINEL_SEMANTIC_TRUNCATION_MARKER, "utf8");
  if (maxBytes < markerBytes) return utf8Head(state, maxBytes);
  const usable = maxBytes - markerBytes;
  const head = utf8Head(state, Math.ceil(usable / 2));
  const tail = utf8Tail(state.slice(head.length), usable - Buffer.byteLength(head, "utf8"));
  return `${head}${SENTINEL_SEMANTIC_TRUNCATION_MARKER}${tail}`;
}

export type SentinelSemanticCachedOptions = SemanticEvaluateOptions & {
  /** Injected bounded cache; successful evaluations are memoized. */
  cache: SentinelSemanticCache;
  /**
   * Override the state byte budget. Defaults to the client's token budget via
   * {@link semanticStateByteBudget}; tests use it to force truncation.
   */
  maxStateBytes?: number;
};

/**
 * Cached, bounded entry point to the semantic stage. The cache key is built
 * from the FULL state (`sha256(state)`, threshold, context-aware, model
 * version) BEFORE truncation, so two states that differ only outside the cap
 * stay distinct entries even though the model sees the same bounded window.
 * Only successful (`available`) evaluations are cached: an unavailable result
 * depends on a transient client failure, and memoizing it would pin the L1
 * fallback for text that a retry could classify. The state is truncated on the
 * way to `decide`, never in the cache key.
 */
export async function evaluateSentinelSemanticCached(
  client: DecisionClient,
  state: string,
  options: SentinelSemanticCachedOptions,
): Promise<SemanticEvaluation> {
  const key = semanticCacheKey({
    text: state,
    threshold: options.threshold,
    contextAware: options.contextAware,
    modelVersion: options.modelVersion,
  });
  const cached = options.cache.get(key);
  if (cached !== undefined) return cached;
  const maxStateBytes = options.maxStateBytes ?? semanticStateByteBudget(client.tokenLimit);
  const bounded = boundSemanticState(state, maxStateBytes);
  const evaluation = await evaluateSentinelSemantic(client, bounded, options);
  if (evaluation.available) options.cache.set(key, evaluation);
  return evaluation;
}

/**
 * Ask the decision model every category question and evaluate the result. A
 * thrown client error (the transport classifies network failures into
 * `ok: false` answers, so this is defensive) degrades to the same L1-fallback
 * signal as a per-question failure.
 */
export async function evaluateSentinelSemantic(
  client: DecisionClient,
  state: string,
  options: SemanticEvaluateOptions,
): Promise<SemanticEvaluation> {
  const questions = buildSemanticQuestions(options.contextAware);
  let answers: DecisionAnswers;
  try {
    answers = await client.decide(state, questions);
  } catch {
    return unavailable("client_error");
  }
  return evaluateSemanticAnswers(answers, options);
}
