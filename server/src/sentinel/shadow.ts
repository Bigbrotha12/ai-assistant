import { createHash, randomUUID } from "node:crypto";
import type { Ledger, TaskRow } from "../ledger.ts";
import { DEFAULT_RULE_SET, evaluateL1 } from "./l1.ts";
import { decideSentinel, policyForMode } from "./policy.ts";
import {
  SENTINEL_CATEGORIES,
  SENTINEL_SEVERITIES,
  SENTINEL_SHADOW_DIRECTIONS,
  SENTINEL_SHADOW_SCHEMA_VERSION,
  SENTINEL_RUNTIME_MODE,
  SENTINEL_VERDICTS,
} from "./types.ts";
import type {
  L1Finding,
  SentinelCategory,
  SentinelPolicy,
  SentinelRuleSet,
  SentinelSeverity,
  SentinelShadowDirection,
  SentinelVerdictValue,
} from "./types.ts";
import { emitSentinelShadowAudit } from "../audit/telemetry.ts";

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

export type SentinelShadowMetadata = {
  schemaVersion: typeof SENTINEL_SHADOW_SCHEMA_VERSION;
  shadow: true;
  mode: typeof SENTINEL_RUNTIME_MODE;
  policyMode: "blocking" | "advisory";
  direction: SentinelShadowDirection;
  categories: readonly SentinelCategory[];
  severities: readonly SentinelSeverity[];
  ruleIds: readonly string[];
  matchedRuleIds: readonly string[];
  findings: readonly L1Finding[];
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

export type SentinelShadowReporterOptions = {
  ledger: Ledger;
  ruleSet?: SentinelRuleSet;
  policy?: SentinelPolicy;
  now?: () => number;
  maxQueueSize?: number;
  maxReportsPerTurn?: number;
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
  metadata: SentinelShadowMetadata;
  resolve: (result: SentinelShadowWriteResult | null) => void;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SEVERITY_ORDER = new Map<SentinelSeverity, number>(
  SENTINEL_SEVERITIES.map((severity, index) => [severity, index]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function uniqueSeverities(findings: readonly L1Finding[]): SentinelSeverity[] {
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

function parseFindings(value: unknown): L1Finding[] | null {
  if (!Array.isArray(value)) return null;
  const findings: L1Finding[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !validCategory(entry.category) || !validSeverity(entry.severity)) {
      return null;
    }
    if (typeof entry.ruleId !== "string" || entry.ruleId.trim() === "") return null;
    findings.push({
      ruleId: entry.ruleId,
      category: entry.category,
      severity: entry.severity,
    });
  }
  return findings;
}

export function parseSentinelShadowMetadata(value: unknown): SentinelShadowMetadata | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SENTINEL_SHADOW_SCHEMA_VERSION || value.shadow !== true) return null;
  if (value.mode !== SENTINEL_RUNTIME_MODE) return null;
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
  return {
    schemaVersion: SENTINEL_SHADOW_SCHEMA_VERSION,
    shadow: true,
    mode: SENTINEL_RUNTIME_MODE,
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
}

function buildMetadata(
  input: SentinelShadowInput,
  ruleSet: SentinelRuleSet,
  policy: SentinelPolicy,
  requestId: string,
  taskId: string | null,
  now: () => number,
): SentinelShadowMetadata {
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
    let result: SentinelShadowWriteResult | null = null;
    try {
      result = this.persist(pending);
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

  private persist(
    pending: QueuedSentinelShadowReport,
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
          ...pending.metadata,
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
