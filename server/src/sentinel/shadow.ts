import { createHash, randomUUID } from "node:crypto";
import type { Ledger, TaskRow } from "../ledger/index.ts";
import { DEFAULT_RULE_SET, evaluateL1 } from "./l1.ts";
import { decideSentinel, policyForMode } from "./policy.ts";
import { isRecord } from "../shared/util.ts";
import {
  SENTINEL_CATEGORIES,
  SENTINEL_FINDING_SOURCES,
  SENTINEL_SEVERITIES,
  SENTINEL_SHADOW_DIRECTIONS,
  SENTINEL_SHADOW_SCHEMA_VERSION,
  SENTINEL_SHADOW_SCHEMA_VERSION_SEMANTIC,
  SENTINEL_RUNTIME_MODE,
  SENTINEL_VERDICTS,
} from "./types.ts";
import type {
  SentinelCategory,
  SentinelFinding,
  SentinelFindingSource,
  SentinelPolicy,
  SentinelRuleSet,
  SentinelRuntimeMode,
  SentinelSeverity,
  SentinelShadowDirection,
  SentinelVerdictValue,
} from "./types.ts";
import { emitSentinelShadowAudit } from "../audit/telemetry.ts";
import { logger } from "../observability/logger.ts";
import type { DecisionClient } from "../transport/decisions.ts";
import {
  SentinelSemanticCache,
  evaluateSentinelSemanticCached,
  sentinelFindingsForDecision,
} from "./semantic.ts";
import type { SemanticEvaluation } from "./semantic.ts";

export const SENTINEL_SHADOW_INTENT_PREFIX = "sentinel:shadow:";
export const SENTINEL_SHADOW_DEFAULT_LIMIT = 50;
export const SENTINEL_SHADOW_MAX_LIMIT = 100;
export const SENTINEL_SHADOW_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
export const SENTINEL_SHADOW_DEFAULT_QUEUE_SIZE = 256;
export const SENTINEL_SHADOW_MAX_REPORTS_PER_TURN = 32;
export const SENTINEL_SHADOW_DROP_POLICY = "drop-newest" as const;
export const SENTINEL_SHADOW_MAX_PERSISTENCE_ATTEMPTS = 8;
export const SENTINEL_SHADOW_MAX_TRACKED_TURNS_PER_OWNER = 1_024;
export const SENTINEL_SHADOW_MAX_OWNER_STATES = 4_096;

export type SentinelShadowInput = {
  owner: string;
  text: string;
  direction: SentinelShadowDirection;
  requestId: string;
  taskId?: string | null;
  reportKey?: string;
};

/**
 * Fields every persisted shadow report carries regardless of schema version.
 * Independently observable facts (L1 `findings`, and on v2 the semantic stage's
 * `semanticFindings` / `semanticAvailable` / `semanticThreshold` /
 * `semanticModelVersion`) stay as separate fields rather than being folded into
 * one another, so a reader never has to infer one outcome from another's branch.
 */
type SentinelShadowMetadataBase = {
  shadow: true;
  policyMode: "blocking" | "advisory";
  direction: SentinelShadowDirection;
  categories: readonly SentinelCategory[];
  severities: readonly SentinelSeverity[];
  ruleIds: readonly string[];
  matchedRuleIds: readonly string[];
  findings: readonly SentinelFinding[];
  severity: SentinelSeverity | null;
  verdictWouldBe: SentinelVerdictValue;
  policyVersion: string;
  ruleSetVersion: string;
  requestId: string;
  taskId: string | null;
  sourceTaskId: string | null;
  timestamp: string;
  ts: number;
};

/** Historical schema: L1-only, no semantic fields. */
export type SentinelShadowMetadataV1 = SentinelShadowMetadataBase & {
  schemaVersion: typeof SENTINEL_SHADOW_SCHEMA_VERSION;
  mode: typeof SENTINEL_RUNTIME_MODE;
};

/** Semantic-aware schema: records the semantic stage's independent outcome. */
export type SentinelShadowMetadataV2 = SentinelShadowMetadataBase & {
  schemaVersion: typeof SENTINEL_SHADOW_SCHEMA_VERSION_SEMANTIC;
  mode: SentinelRuntimeMode;
  semanticAvailable: boolean;
  semanticFindings: readonly SentinelFinding[];
  semanticThreshold: number;
  semanticModelVersion: string;
};

export type SentinelShadowMetadata = SentinelShadowMetadataV1 | SentinelShadowMetadataV2;

export type SentinelShadowReport = SentinelShadowMetadata & {
  reportId: string;
};

export type SentinelShadowWriteResult = {
  report: SentinelShadowReport;
  created: boolean;
};

export type SentinelShadowQueueStats = {
  queued: number;
  accepted: number;
  persisted: number;
  dropped: number;
  droppedByQueueCap: number;
  droppedByTurnCap: number;
  failed: number;
};

export interface SentinelShadowSink {
  report(input: SentinelShadowInput): unknown;
}

/**
 * Semantic (decision-model) stage configuration for the shadow reporter.
 *
 * Absent: the reporter keeps the historical v1, L1-only behavior. Present:
 * every report is written as v2. `enabled:false` records `mode:"l1_only"` with
 * `semanticAvailable:false` and makes zero model calls; `enabled:true`
 * evaluates the text in the queue drain (never in the chat path) and records
 * `mode:"l1_semantic"`, falling back to L1 when the stage is unavailable.
 */
export type SentinelShadowSemanticOptions = {
  enabled: boolean;
  /** Confidence at or above which a category fires (0..1). */
  threshold: number;
  contextAware: boolean;
  /** `plugin id @ version`, persisted as `semanticModelVersion`. */
  modelVersion: string;
  /**
   * Injectable evaluation seam for deterministic tests. When omitted the
   * reporter evaluates through `client` + `cache`.
   */
  evaluate?: (text: string) => Promise<SemanticEvaluation>;
  /** Decision client used when `evaluate` is not supplied. */
  client?: DecisionClient;
  /** Bounded semantic cache. Defaults to a fresh default-sized cache. */
  cache?: SentinelSemanticCache;
};

export type SentinelShadowReporterOptions = {
  ledger: Ledger;
  ruleSet?: SentinelRuleSet;
  policy?: SentinelPolicy;
  now?: () => number;
  maxQueueSize?: number;
  maxReportsPerTurn?: number;
  semantic?: SentinelShadowSemanticOptions;
};

type SentinelShadowTurnState = {
  accepted: number;
  queued: number;
};

type SentinelShadowOwnerState = {
  turns: Map<string, SentinelShadowTurnState>;
} & SentinelShadowQueueStats;

type QueuedSentinelShadowReport = {
  owner: string;
  intentBase: string;
  turnKey: string;
  requestedTaskId: string | null;
  metadata: SentinelShadowMetadataV1;
  /**
   * Text to evaluate in the semantic drain. Empty unless the semantic stage is
   * enabled, so a disabled/legacy queue retains no evaluated text.
   */
  text: string;
  resolve: (result: SentinelShadowWriteResult | null) => void;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SEVERITY_ORDER = new Map<SentinelSeverity, number>(
  SENTINEL_SEVERITIES.map((severity, index) => [severity, index]),
);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validTimestamp(value: number): boolean {
  if (!Number.isSafeInteger(value) || value < 0) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() === value;
}

function safeRequestId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    return `sentinel_${randomUUID()}`;
  }
  const trimmed = value.trim();
  if (SAFE_ID.test(trimmed)) return trimmed;
  return `sentinel_${sha256(trimmed).slice(0, 32)}`;
}

function safeTaskId(value: unknown): string | null {
  if (typeof value !== "string" || !SAFE_TASK_ID.test(value.trim())) return null;
  return value.trim();
}

function uniqueSeverities(findings: readonly SentinelFinding[]): SentinelSeverity[] {
  return [...new Set(findings.map((finding) => finding.severity))].sort(
    (left, right) => (SEVERITY_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (SEVERITY_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

function validCategory(value: unknown): value is SentinelCategory {
  return typeof value === "string" && SENTINEL_CATEGORIES.includes(value as SentinelCategory);
}

function validSeverity(value: unknown): value is SentinelSeverity {
  return typeof value === "string" && SENTINEL_SEVERITIES.includes(value as SentinelSeverity);
}

function validVerdict(value: unknown): value is SentinelVerdictValue {
  return typeof value === "string" && SENTINEL_VERDICTS.includes(value as SentinelVerdictValue);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

/**
 * Reconstruct findings from a persisted report. Reports written before the
 * semantic stage existed carry L1 findings with no `source`; default those to
 * `"l1"` so historical reports stay readable instead of being dropped. A
 * present-but-unknown source, or an out-of-range `confidence`, is rejected.
 */
function parseFindings(value: unknown): SentinelFinding[] | null {
  if (!Array.isArray(value)) return null;
  const findings: SentinelFinding[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !validCategory(entry.category) || !validSeverity(entry.severity)) {
      return null;
    }
    if (typeof entry.ruleId !== "string" || entry.ruleId.trim() === "") return null;
    const source = entry.source === undefined ? "l1" : entry.source;
    if (
      typeof source !== "string" ||
      !SENTINEL_FINDING_SOURCES.includes(source as SentinelFindingSource)
    ) {
      return null;
    }
    const confidence = entry.confidence;
    if (
      confidence !== undefined &&
      (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    ) {
      return null;
    }
    findings.push({
      ruleId: entry.ruleId,
      category: entry.category,
      severity: entry.severity,
      source: source as SentinelFindingSource,
      ...(confidence === undefined ? {} : { confidence }),
    });
  }
  return findings;
}

/**
 * Reconstruct a persisted shadow report from either schema. Historical v1
 * reports (L1-only) still parse, and their findings default to `source:"l1"`;
 * v2 reports additionally validate the semantic stage's fields. Both versions
 * stay readable side by side rather than one superseding the other.
 */
export function parseSentinelShadowMetadata(value: unknown): SentinelShadowMetadata | null {
  if (!isRecord(value)) return null;
  if (value.shadow !== true) return null;
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== SENTINEL_SHADOW_SCHEMA_VERSION &&
    schemaVersion !== SENTINEL_SHADOW_SCHEMA_VERSION_SEMANTIC) {
    return null;
  }
  const mode = value.mode;
  if (mode !== "l1_only" && mode !== "l1_semantic") return null;
  if (schemaVersion === SENTINEL_SHADOW_SCHEMA_VERSION && mode !== "l1_only") return null;
  if (value.policyMode !== "blocking" && value.policyMode !== "advisory") return null;
  if (
    typeof value.direction !== "string" ||
    !SENTINEL_SHADOW_DIRECTIONS.includes(value.direction as SentinelShadowDirection)
  ) {
    return null;
  }
  const categories = stringArray(value.categories);
  const severities = stringArray(value.severities);
  const ruleIds = stringArray(value.ruleIds);
  const matchedRuleIds = stringArray(value.matchedRuleIds);
  const findings = parseFindings(value.findings);
  if (
    categories === null ||
    severities === null ||
    ruleIds === null ||
    matchedRuleIds === null ||
    findings === null
  ) {
    return null;
  }
  if (!categories.every(validCategory) || !severities.every(validSeverity)) return null;
  if (ruleIds.some((id) => id.trim() === "") || matchedRuleIds.some((id) => id.trim() === "")) {
    return null;
  }
  if (value.severity !== null && !validSeverity(value.severity)) return null;
  if (!validVerdict(value.verdictWouldBe)) return null;
  if (
    typeof value.policyVersion !== "string" ||
    value.policyVersion.trim() === "" ||
    typeof value.ruleSetVersion !== "string" ||
    value.ruleSetVersion.trim() === "" ||
    typeof value.requestId !== "string" ||
    !SAFE_ID.test(value.requestId) ||
    typeof value.timestamp !== "string" ||
    !Number.isSafeInteger(value.ts) ||
    (value.ts as number) < 0
  ) {
    return null;
  }
  if (value.taskId !== null && !safeTaskId(value.taskId)) return null;
  if (value.sourceTaskId !== null && !safeTaskId(value.sourceTaskId)) return null;
  const base: SentinelShadowMetadataBase = {
    shadow: true,
    policyMode: value.policyMode,
    direction: value.direction as SentinelShadowDirection,
    categories: [...new Set(categories)] as SentinelCategory[],
    severities: [...new Set(severities)] as SentinelSeverity[],
    ruleIds: [...new Set(ruleIds)],
    matchedRuleIds: [...new Set(matchedRuleIds)],
    findings: findings.map((finding) => ({ ...finding })),
    severity: value.severity as SentinelSeverity | null,
    verdictWouldBe: value.verdictWouldBe,
    policyVersion: value.policyVersion,
    ruleSetVersion: value.ruleSetVersion,
    requestId: value.requestId,
    taskId: value.taskId as string | null,
    sourceTaskId: value.sourceTaskId as string | null,
    timestamp: value.timestamp,
    ts: value.ts as number,
  };
  if (schemaVersion === SENTINEL_SHADOW_SCHEMA_VERSION) {
    return { schemaVersion: SENTINEL_SHADOW_SCHEMA_VERSION, mode: "l1_only", ...base };
  }
  const semanticFindings = parseFindings(value.semanticFindings);
  if (semanticFindings === null) return null;
  const semanticThreshold = value.semanticThreshold;
  if (
    typeof semanticThreshold !== "number" ||
    !Number.isFinite(semanticThreshold) ||
    semanticThreshold < 0 ||
    semanticThreshold > 1
  ) {
    return null;
  }
  if (typeof value.semanticModelVersion !== "string" || value.semanticModelVersion.trim() === "") {
    return null;
  }
  if (typeof value.semanticAvailable !== "boolean") return null;
  return {
    schemaVersion: SENTINEL_SHADOW_SCHEMA_VERSION_SEMANTIC,
    mode,
    ...base,
    semanticAvailable: value.semanticAvailable,
    semanticFindings: semanticFindings.map((finding) => ({ ...finding })),
    semanticThreshold,
    semanticModelVersion: value.semanticModelVersion,
  };
}

function buildMetadata(
  input: SentinelShadowInput,
  ruleSet: SentinelRuleSet,
  policy: SentinelPolicy,
  requestId: string,
  taskId: string | null,
  now: () => number,
): SentinelShadowMetadataV1 {
  const findings = evaluateL1(input.text, ruleSet);
  const decision = decideSentinel(findings, { direction: input.direction }, policy);
  const rawNow = now();
  const ts = validTimestamp(rawNow) ? rawNow : Date.now();
  return {
    schemaVersion: SENTINEL_SHADOW_SCHEMA_VERSION,
    shadow: true,
    mode: SENTINEL_RUNTIME_MODE,
    policyMode: policy.mode,
    direction: input.direction,
    categories: decision.categories,
    severities: uniqueSeverities(findings),
    ruleIds: decision.matchedRuleIds,
    matchedRuleIds: decision.matchedRuleIds,
    findings: findings.map((finding) => ({ ...finding })),
    severity: decision.severity,
    verdictWouldBe: decision.verdict,
    policyVersion: policy.version,
    ruleSetVersion: ruleSet.version,
    requestId,
    taskId,
    sourceTaskId: taskId,
    timestamp: new Date(ts).toISOString(),
    ts,
  };
}

/**
 * Build the v2 report from the synchronous L1 seed plus the semantic stage's
 * outcome. Decision fields (`categories`, `severities`, `severity`, `ruleIds`,
 * `verdictWouldBe`) are recomputed from `decisionFindings` — semantic-only when
 * the stage answered, L1 otherwise — while the seed's L1 findings stay in
 * `findings` and the semantic findings in `semanticFindings` so both stages
 * remain independently auditable.
 */
function v2MetadataFromL1(
  seed: SentinelShadowMetadataV1,
  options: Pick<SentinelShadowSemanticOptions, "threshold" | "modelVersion">,
  outcome: {
    mode: SentinelRuntimeMode;
    available: boolean;
    semanticFindings: readonly SentinelFinding[];
    decisionFindings: readonly SentinelFinding[];
  },
  policy: SentinelPolicy,
): SentinelShadowMetadataV2 {
  const decision = decideSentinel(
    outcome.decisionFindings,
    { direction: seed.direction },
    policy,
  );
  return {
    ...seed,
    schemaVersion: SENTINEL_SHADOW_SCHEMA_VERSION_SEMANTIC,
    mode: outcome.mode,
    categories: decision.categories,
    severities: uniqueSeverities(outcome.decisionFindings),
    ruleIds: decision.matchedRuleIds,
    matchedRuleIds: decision.matchedRuleIds,
    severity: decision.severity,
    verdictWouldBe: decision.verdict,
    semanticAvailable: outcome.available,
    semanticFindings: outcome.semanticFindings.map((finding) => ({ ...finding })),
    semanticThreshold: options.threshold,
    semanticModelVersion: options.modelVersion,
  };
}

function validateSemanticOptions(options: SentinelShadowSemanticOptions): void {
  if (typeof options.enabled !== "boolean") {
    throw new Error("sentinel shadow semantic `enabled` must be a boolean");
  }
  if (
    typeof options.threshold !== "number" ||
    !Number.isFinite(options.threshold) ||
    options.threshold < 0 ||
    options.threshold > 1
  ) {
    throw new RangeError("sentinel shadow semantic threshold must be between 0 and 1");
  }
  if (typeof options.modelVersion !== "string" || options.modelVersion.trim() === "") {
    throw new Error("sentinel shadow semantic modelVersion must be a non-empty string");
  }
}

export function readSentinelShadowReport(
  ledger: Ledger,
  taskId: string,
  owner: string,
): SentinelShadowReport | null {
  const task = ledger.getTask(taskId, owner);
  if (!task || task.worker !== "sentinel" || !task.spec.startsWith(SENTINEL_SHADOW_INTENT_PREFIX)) {
    return null;
  }
  for (const step of ledger.listSteps(task.id, owner)) {
    if (step.stage !== "sentinel" || step.action !== "sentinel:shadow" || step.result === null) {
      continue;
    }
    try {
      const metadata = parseSentinelShadowMetadata(JSON.parse(step.result) as unknown);
      if (metadata !== null) return { ...metadata, reportId: task.id };
    } catch {
    }
  }
  return null;
}

export class SentinelShadowReporter implements SentinelShadowSink {
  private readonly ledger: Ledger;
  private readonly ruleSet: SentinelRuleSet;
  private readonly policy: SentinelPolicy;
  private readonly now: () => number;
  private readonly maxQueueSize: number;
  private readonly maxReportsPerTurn: number;
  private readonly semantic: SentinelShadowSemanticOptions | undefined;
  private readonly semanticClient?: DecisionClient;
  private readonly semanticCache?: SentinelSemanticCache;
  private readonly queue: QueuedSentinelShadowReport[] = [];
  private readonly ownerStates = new Map<string, SentinelShadowOwnerState>();
  private drainScheduled = false;
  private draining = false;
  private droppedTotal = 0;

  constructor(options: SentinelShadowReporterOptions) {
    this.ledger = options.ledger;
    this.ruleSet = options.ruleSet ?? DEFAULT_RULE_SET;
    this.policy = options.policy ?? policyForMode("blocking");
    this.now = options.now ?? Date.now;
    this.maxQueueSize = options.maxQueueSize ?? SENTINEL_SHADOW_DEFAULT_QUEUE_SIZE;
    this.maxReportsPerTurn =
      options.maxReportsPerTurn ?? SENTINEL_SHADOW_MAX_REPORTS_PER_TURN;
    if (
      !Number.isSafeInteger(this.maxQueueSize) ||
      this.maxQueueSize <= 0 ||
      this.maxQueueSize > SENTINEL_SHADOW_MAX_OWNER_STATES
    ) {
      throw new RangeError("maxQueueSize must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxReportsPerTurn) || this.maxReportsPerTurn <= 0) {
      throw new RangeError("maxReportsPerTurn must be a positive safe integer");
    }
    this.semantic = options.semantic;
    if (this.semantic !== undefined) {
      validateSemanticOptions(this.semantic);
      if (this.semantic.enabled) {
        if (this.semantic.evaluate === undefined && this.semantic.client === undefined) {
          throw new Error(
            "sentinel shadow semantic stage requires an evaluate seam or a decision client",
          );
        }
        if (this.semantic.evaluate === undefined) {
          this.semanticClient = this.semantic.client;
          this.semanticCache = this.semantic.cache ?? new SentinelSemanticCache();
        }
      }
    }
  }

  report(input: SentinelShadowInput): Promise<SentinelShadowWriteResult | null> {
    try {
      if (input.owner.trim() === "" || typeof input.text !== "string") {
        return Promise.resolve(null);
      }
      if (!SENTINEL_SHADOW_DIRECTIONS.includes(input.direction)) {
        return Promise.resolve(null);
      }
      const requestId = safeRequestId(input.requestId);
      const turnKey = requestId;
      const ownerState = this.stateForOwner(input.owner);
      if (ownerState === null || this.queue.length >= this.maxQueueSize) {
        this.recordDrop(input.owner, ownerState, "queue");
        return Promise.resolve(null);
      }
      const requestedTaskId = safeTaskId(input.taskId);
      const metadata = buildMetadata(
        input,
        this.ruleSet,
        this.policy,
        requestId,
        null,
        this.now,
      );
      if (!this.reserveTurn(ownerState, turnKey)) {
        this.recordDrop(input.owner, ownerState, "turn");
        return Promise.resolve(null);
      }
      const reportKey =
        typeof input.reportKey === "string" && input.reportKey.trim() !== ""
          ? input.reportKey.trim()
          : `${input.direction}:${requestId}`;
      const intentBase = `${SENTINEL_SHADOW_INTENT_PREFIX}${sha256(
        `${input.owner}\u0000${reportKey}`,
      )}`;
      return new Promise<SentinelShadowWriteResult | null>((resolve) => {
        this.queue.push({
          owner: input.owner,
          intentBase,
          turnKey,
          requestedTaskId,
          metadata,
          text: this.semantic?.enabled === true ? input.text : "",
          resolve,
        });
        const turn = ownerState.turns.get(turnKey);
        if (turn !== undefined) turn.queued += 1;
        ownerState.queued += 1;
        ownerState.accepted += 1;
        this.scheduleDrain();
      });
    } catch {
      return Promise.resolve(null);
    }
  }

  async flush(): Promise<void> {
    while (this.draining || this.drainScheduled || this.queue.length > 0) {
      this.scheduleDrain();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  getQueueStats(owner: string): SentinelShadowQueueStats {
    const state = this.ownerStates.get(owner);
    if (state === undefined) {
      return {
        queued: 0,
        accepted: 0,
        persisted: 0,
        dropped: 0,
        droppedByQueueCap: 0,
        droppedByTurnCap: 0,
        failed: 0,
      };
    }
    return {
      queued: state.queued,
      accepted: state.accepted,
      persisted: state.persisted,
      dropped: state.dropped,
      droppedByQueueCap: state.droppedByQueueCap,
      droppedByTurnCap: state.droppedByTurnCap,
      failed: state.failed,
    };
  }

  getDroppedCount(): number {
    return this.droppedTotal;
  }

  private stateForOwner(owner: string): SentinelShadowOwnerState | null {
    const existing = this.ownerStates.get(owner);
    if (existing !== undefined) return existing;
    for (const [ownerId, state] of this.ownerStates) {
      if (state.queued === 0) {
        this.ownerStates.delete(ownerId);
        break;
      }
    }
    if (this.ownerStates.size >= SENTINEL_SHADOW_MAX_OWNER_STATES) return null;
    const state: SentinelShadowOwnerState = {
      turns: new Map(),
      queued: 0,
      accepted: 0,
      persisted: 0,
      dropped: 0,
      droppedByQueueCap: 0,
      droppedByTurnCap: 0,
      failed: 0,
    };
    this.ownerStates.set(owner, state);
    return state;
  }

  private reserveTurn(state: SentinelShadowOwnerState, turnKey: string): boolean {
    let turn = state.turns.get(turnKey);
    if (turn !== undefined && turn.accepted >= this.maxReportsPerTurn) return false;
    if (turn === undefined) {
      if (state.turns.size >= SENTINEL_SHADOW_MAX_TRACKED_TURNS_PER_OWNER) {
        for (const [trackedKey, tracked] of state.turns) {
          if (tracked.queued === 0) {
            state.turns.delete(trackedKey);
            break;
          }
        }
      }
      if (state.turns.size >= SENTINEL_SHADOW_MAX_TRACKED_TURNS_PER_OWNER) {
        return false;
      }
      turn = { accepted: 0, queued: 0 };
      state.turns.set(turnKey, turn);
    }
    turn.accepted += 1;
    return true;
  }

  private recordDrop(
    owner: string,
    state: SentinelShadowOwnerState | null,
    reason: "queue" | "turn",
  ): void {
    this.droppedTotal += 1;
    const target = state ?? this.stateForOwner(owner);
    if (target === null) return;
    target.dropped += 1;
    if (reason === "queue") target.droppedByQueueCap += 1;
    else target.droppedByTurnCap += 1;
  }

  private scheduleDrain(): void {
    if (this.draining || this.drainScheduled || this.queue.length === 0) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.draining) return;
    const pending = this.queue.shift();
    if (pending === undefined) return;
    this.draining = true;
    const state = this.ownerStates.get(pending.owner);
    const turn = state?.turns.get(pending.turnKey);
    if (state !== undefined) {
      state.queued = Math.max(0, state.queued - 1);
      if (turn !== undefined) turn.queued = Math.max(0, turn.queued - 1);
    }
    void this.processPending(pending, state);
  }

  /**
   * Resolve one queued report (awaiting the semantic stage when enabled),
   * persist it, settle its promise exactly once, and drain the next item after
   * success or failure. Semantic evaluation failures are contained here so a
   * model call can never reject a chat turn: the report falls back to L1.
   */
  private async processPending(
    pending: QueuedSentinelShadowReport,
    state: SentinelShadowOwnerState | undefined,
  ): Promise<void> {
    let result: SentinelShadowWriteResult | null = null;
    try {
      const metadata = await this.resolveMetadata(pending);
      result = this.persist(pending, metadata);
      if (state !== undefined) {
        if (result === null) state.failed += 1;
        else state.persisted += 1;
      }
    } catch {
      if (state !== undefined) state.failed += 1;
    } finally {
      pending.resolve(result);
      this.draining = false;
      this.scheduleDrain();
    }
  }

  /**
   * Produce the metadata to persist. With no semantic option the synchronous L1
   * seed is written as-is (historical v1). With the semantic stage configured,
   * the seed is widened to v2: disabled makes no model call, enabled awaits the
   * evaluator and falls back to L1 when it is unavailable.
   */
  private async resolveMetadata(
    pending: QueuedSentinelShadowReport,
  ): Promise<SentinelShadowMetadata> {
    const semantic = this.semantic;
    if (semantic === undefined) return pending.metadata;
    const seed = pending.metadata;
    if (!semantic.enabled) {
      return v2MetadataFromL1(
        seed,
        semantic,
        {
          mode: "l1_only",
          available: false,
          semanticFindings: [],
          decisionFindings: seed.findings,
        },
        this.policy,
      );
    }
    const evaluation = await this.evaluateSemantic(semantic, pending.text);
    const decisionFindings = sentinelFindingsForDecision(seed.findings, evaluation);
    if (!evaluation.available) {
      this.logSemanticUnavailable(seed, semantic, evaluation);
    }
    return v2MetadataFromL1(
      seed,
      semantic,
      {
        mode: "l1_semantic",
        available: evaluation.available,
        semanticFindings: evaluation.available ? evaluation.findings : [],
        decisionFindings,
      },
      this.policy,
    );
  }

  /**
   * Evaluate the semantic stage through the injected seam or the decision
   * client. A thrown evaluator is contained as an L1-fallback unavailable
   * result rather than rejecting the drain.
   */
  private async evaluateSemantic(
    semantic: SentinelShadowSemanticOptions,
    text: string,
  ): Promise<SemanticEvaluation> {
    try {
      if (semantic.evaluate !== undefined) return await semantic.evaluate(text);
      return await evaluateSentinelSemanticCached(this.semanticClient!, text, {
        threshold: semantic.threshold,
        contextAware: semantic.contextAware,
        modelVersion: semantic.modelVersion,
        cache: this.semanticCache!,
      });
    } catch {
      return { available: false, fallback: "l1", reason: "client_error" };
    }
  }

  /** Log the semantic stage's failure class — never the evaluated text. */
  private logSemanticUnavailable(
    seed: SentinelShadowMetadataV1,
    semantic: SentinelShadowSemanticOptions,
    evaluation: SemanticEvaluation,
  ): void {
    if (evaluation.available) return;
    logger.warn("sentinel: semantic stage unavailable; using L1 fallback", {
      requestId: seed.requestId,
      direction: seed.direction,
      reason: evaluation.reason,
      failedCategory: evaluation.failedCategory,
      modelVersion: semantic.modelVersion,
    });
  }

  private persist(
    pending: QueuedSentinelShadowReport,
    resolved: SentinelShadowMetadata,
  ): SentinelShadowWriteResult | null {
    const candidateKeys = [
      pending.intentBase,
      ...Array.from(
        { length: SENTINEL_SHADOW_MAX_PERSISTENCE_ATTEMPTS },
        (_, index) => `${pending.intentBase}:attempt:${index}`,
      ),
    ];
    let activeIntentKey = pending.intentBase;
    try {
      for (const intentKey of candidateKeys) {
        activeIntentKey = intentKey;
        const existing = this.ledger.getTaskByIntentKey(pending.owner, intentKey);
        if (existing !== null) {
          if (
            existing.worker === "sentinel" &&
            existing.spec.startsWith(SENTINEL_SHADOW_INTENT_PREFIX) &&
            existing.status === "awaiting_review"
          ) {
            const report = readSentinelShadowReport(
              this.ledger,
              existing.id,
              pending.owner,
            );
            if (report !== null) return { report, created: false };
          }
          this.repairTask(existing);
          continue;
        }

        const task = this.ledger.createTask({
          owner: pending.owner,
          intentKey,
          spec: `${SENTINEL_SHADOW_INTENT_PREFIX}${pending.metadata.direction}`,
          worker: "sentinel",
        });
        const claimed = this.ledger.claimTask(task.id, pending.owner);
        if (!validTimestamp(task.created_ts)) {
          throw new RangeError("ledger returned an invalid Sentinel report timestamp");
        }
        const sourceTaskId =
          pending.requestedTaskId !== null &&
          this.ledger.getTask(pending.requestedTaskId, pending.owner) !== null
            ? pending.requestedTaskId
            : null;
        const metadata: SentinelShadowMetadata = {
          ...resolved,
          taskId: sourceTaskId,
          sourceTaskId,
          timestamp: new Date(task.created_ts).toISOString(),
          ts: task.created_ts,
        };
        this.ledger.appendStep(
          task.id,
          pending.owner,
          {
            stage: "sentinel",
            action: "sentinel:shadow",
            result: JSON.stringify(metadata),
          },
          claimed.fence_token,
        );
        this.ledger.completeTaskWithFence(
          task.id,
          pending.owner,
          "awaiting_review",
          claimed.fence_token,
        );
        this.emitAudit(pending.owner, metadata);
        return { report: { ...metadata, reportId: task.id }, created: true };
      }
      this.repairIntent(pending.owner, activeIntentKey);
      return null;
    } catch {
      this.repairIntent(pending.owner, activeIntentKey);
      return null;
    }
  }

  private repairIntent(owner: string, intentKey: string): void {
    const task = this.ledger.getTaskByIntentKey(owner, intentKey);
    if (
      task === null ||
      task.worker !== "sentinel" ||
      !task.spec.startsWith(SENTINEL_SHADOW_INTENT_PREFIX)
    ) {
      return;
    }
    this.repairTask(task);
  }

  private repairTask(task: TaskRow): void {
    try {
      if (task.status === "queued") {
        this.ledger.completeTask(task.id, task.owner, "cancelled");
        return;
      }
      if (task.status === "stuck") {
        const resumed = this.ledger.resumeTask(task.id, task.owner);
        this.ledger.completeTaskWithFence(
          task.id,
          task.owner,
          "failed",
          resumed.fence_token,
        );
        return;
      }
      if (task.status === "running") {
        this.ledger.completeTaskWithFence(
          task.id,
          task.owner,
          "failed",
          task.fence_token,
        );
      }
    } catch {
    }
  }

  private emitAudit(owner: string, metadata: SentinelShadowMetadata): void {
    emitSentinelShadowAudit({
      owner,
      requestId: metadata.requestId,
      taskId: metadata.taskId ?? undefined,
      direction: metadata.direction,
      verdict: metadata.verdictWouldBe,
      category: metadata.categories[0],
      categories: metadata.categories,
      severity: metadata.severity ?? undefined,
      severities: metadata.severities,
      ruleIds: metadata.ruleIds,
    });
  }
}

export function tryReportSentinelShadow(
  sink: SentinelShadowSink | undefined,
  input: SentinelShadowInput,
): void {
  if (sink === undefined) return;
  try {
    const result = sink.report(input);
    if (
      result !== null &&
      result !== undefined &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
  }
}

export function sentinelTextFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const text: string[] = [];
  for (const block of value) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    text.push(block.text);
  }
  return text.join("\n");
}

export function sentinelTextFromMessage(message: unknown): string {
  if (!isRecord(message)) return "";
  return sentinelTextFromContent(message.content);
}

export function lastUserTextFromMessages(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    const role = message.role;
    const type = typeof message.getType === "function" ? message.getType() : undefined;
    if (role === "user" || type === "human") return sentinelTextFromMessage(message);
  }
  return null;
}
