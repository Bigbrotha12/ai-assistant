import { createHash } from "node:crypto";
import { logger } from "../logger.ts";
import { redactForOutbound } from "../redact.ts";

export const AUDIT_TELEMETRY_ENABLED_ENV = "AUDIT_TELEMETRY_ENABLED";
export const AUDIT_TELEMETRY_LEVEL_ENV = "AUDIT_TELEMETRY_LEVEL";
export const DEFAULT_AUDIT_TELEMETRY_QUEUE_SIZE = 1_024;
export const AUDIT_TELEMETRY_DROP_POLICY = "drop-newest" as const;

export type AuditLogLevel = "error" | "warn" | "info" | "debug";
export type AuditOutcome = "ok" | "error" | "timeout" | "circuit-open" | "policy-denied" | "cancelled";
export type AuditEventName =
  | "plugin.tool"
  | "plugin.management"
  | "mcp.connect"
  | "mcp.list"
  | "mcp.tool"
  | "mcp.policy"
  | "sentinel.shadow";
export type AuditKind = "plugin" | "mcp" | "sentinel";
export type AuditCircuitState = "closed" | "open" | "half-open";

export type AuditEventInput = {
  event: AuditEventName;
  kind: AuditKind;
  outcome: AuditOutcome;
  owner?: string;
  server?: string;
  pluginId?: string;
  tool?: string;
  durationMs?: number;
  inputBytes?: number;
  outputBytes?: number;
  errorCode?: string;
  policyCode?: string;
  requestId?: string;
  status?: string | number;
  cacheHit?: boolean;
  ownerBound?: boolean;
  circuitState?: AuditCircuitState;
  direction?: "input" | "tool_result" | "output";
  verdict?: "allow" | "flag" | "block";
  category?: string;
  categories?: readonly string[];
  severity?: string;
  severities?: readonly string[];
  ruleIds?: readonly string[];
  shadow?: boolean;
  taskId?: string;
  operation?: string;
};

type AuditTelemetryConfig = {
  enabled: boolean;
  level: AuditLogLevel;
  maxQueueSize: number;
};

const VALID_EVENTS = new Set<AuditEventName>([
  "plugin.tool",
  "plugin.management",
  "mcp.connect",
  "mcp.list",
  "mcp.tool",
  "mcp.policy",
  "sentinel.shadow",
]);
const VALID_KINDS = new Set<AuditKind>(["plugin", "mcp", "sentinel"]);
const VALID_OUTCOMES = new Set<AuditOutcome>([
  "ok",
  "error",
  "timeout",
  "circuit-open",
  "policy-denied",
  "cancelled",
]);
const VALID_CIRCUIT_STATES = new Set<AuditCircuitState>(["closed", "open", "half-open"]);
const MAX_STRING_LENGTH = 512;
type QueuedAuditRecord = { level: AuditLogLevel; line: string };
const auditQueue: QueuedAuditRecord[] = [];
let configOverride: Partial<AuditTelemetryConfig> | undefined;
let telemetryFailureLogged = false;
let auditDraining = false;
let auditDrainScheduled = false;
let auditTelemetryDropped = 0;

function isLogLevel(value: string | undefined): value is AuditLogLevel {
  return value === "error" || value === "warn" || value === "info" || value === "debug";
}

function isFalseFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

function currentConfig(): AuditTelemetryConfig {
  const levelValue = configOverride?.level ?? process.env[AUDIT_TELEMETRY_LEVEL_ENV];
  const aliasLevel = process.env.AUDIT_LOG_LEVEL;
  const level = isLogLevel(levelValue) ? levelValue : isLogLevel(aliasLevel) ? aliasLevel : "info";
  const maxQueueSize = configOverride?.maxQueueSize ?? DEFAULT_AUDIT_TELEMETRY_QUEUE_SIZE;
  if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize <= 0) {
    throw new RangeError("maxQueueSize must be a positive safe integer");
  }
  return {
    enabled: configOverride?.enabled ?? !isFalseFlag(process.env[AUDIT_TELEMETRY_ENABLED_ENV]),
    level,
    maxQueueSize,
  };
}

function redactString(value: string): string {
  return redactForOutbound(value).slice(0, MAX_STRING_LENGTH);
}

export function redactAuditValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "object" || value === null) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactAuditValue(item, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const safe = redactAuditValue(nested, seen);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

function ownerHash(owner: string | undefined): string | undefined {
  if (!owner) return undefined;
  return createHash("sha256").update(owner, "utf8").digest("hex");
}

function auditCode(value: string | undefined): string | undefined {
  if (value === undefined || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) return undefined;
  return redactString(value);
}

function makeRecord(input: AuditEventInput): Record<string, unknown> | undefined {
  if (!VALID_EVENTS.has(input.event) || !VALID_KINDS.has(input.kind) || !VALID_OUTCOMES.has(input.outcome)) {
    return undefined;
  }
  if (input.circuitState !== undefined && !VALID_CIRCUIT_STATES.has(input.circuitState)) {
    return undefined;
  }

  const record: Record<string, unknown> = {
    event: redactString(input.event),
    kind: redactString(input.kind),
    outcome: redactString(input.outcome),
  };
  const fields: Array<[string, unknown]> = [
    ["ownerHash", ownerHash(input.owner)],
    ["server", input.server],
    ["pluginId", input.pluginId],
    ["tool", input.tool],
    ["requestId", auditCode(input.requestId)],
    ["taskId", auditCode(input.taskId)],
    ["operation", auditCode(input.operation)],
    ["errorCode", auditCode(input.errorCode)],
    ["policyCode", auditCode(input.policyCode)],
    ["status", typeof input.status === "string" ? auditCode(input.status) : input.status],
    ["direction", auditCode(input.direction)],
    ["verdict", auditCode(input.verdict)],
    ["category", auditCode(input.category)],
    ["severity", auditCode(input.severity)],
  ];
  for (const [key, value] of fields) {
    if (value === undefined || value === null) continue;
    const safe = redactAuditValue(value);
    if (safe !== undefined) record[key] = safe;
  }
  for (const [key, value] of [
    ["durationMs", input.durationMs],
    ["inputBytes", input.inputBytes],
    ["outputBytes", input.outputBytes],
    ["cacheHit", input.cacheHit],
    ["ownerBound", input.ownerBound],
    ["shadow", input.shadow],
  ] as const) {
    if (value === undefined) continue;
    const safe = redactAuditValue(value);
    if (safe !== undefined) record[key] = safe;
  }
  for (const [key, value] of [
    ["categories", input.categories],
    ["severities", input.severities],
    ["ruleIds", input.ruleIds],
  ] as const) {
    if (value === undefined) continue;
    const safe = redactAuditValue(value);
    if (safe !== undefined) record[key] = safe;
  }
  if (input.circuitState !== undefined) record.circuitState = redactString(input.circuitState);
  return record;
}

function reportFailure(): void {
  if (telemetryFailureLogged) return;
  telemetryFailureLogged = true;
  const maxQueueSize = configOverride?.maxQueueSize ?? DEFAULT_AUDIT_TELEMETRY_QUEUE_SIZE;
  if (auditQueue.length < maxQueueSize) {
    auditQueue.push({ level: "warn", line: "[audit] telemetry emission failed" });
    scheduleAuditDrain();
  }
}

function scheduleAuditDrain(): void {
  if (auditDraining || auditDrainScheduled || auditQueue.length === 0) return;
  auditDrainScheduled = true;
  setImmediate(() => {
    auditDrainScheduled = false;
    void drainAuditQueue();
  });
}

async function drainAuditQueue(): Promise<void> {
  if (auditDraining) return;
  auditDraining = true;
  try {
    while (auditQueue.length > 0) {
      const record = auditQueue.shift()!;
      try {
        await logger[record.level](record.line);
      } catch {
        reportFailure();
      }
    }
  } finally {
    auditDraining = false;
    scheduleAuditDrain();
  }
}

export function getAuditTelemetryDroppedCount(): number {
  return auditTelemetryDropped;
}

export async function flushAuditTelemetry(): Promise<void> {
  while (auditDraining || auditDrainScheduled || auditQueue.length > 0) {
    scheduleAuditDrain();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function configureAuditTelemetry(config: Partial<AuditTelemetryConfig>): void {
  configOverride = { ...config };
}

export function resetAuditTelemetryConfig(): void {
  configOverride = undefined;
  telemetryFailureLogged = false;
  auditTelemetryDropped = 0;
}

export function getAuditTelemetryConfig(): AuditTelemetryConfig {
  return currentConfig();
}

export function emitAuditEvent(input: AuditEventInput): void {
  try {
    const config = currentConfig();
    if (!config.enabled) return;
    const record = makeRecord(input);
    if (!record) return;
    if (auditQueue.length >= config.maxQueueSize) {
      auditTelemetryDropped += 1;
      return;
    }
    auditQueue.push({ level: config.level, line: JSON.stringify(record) });
    scheduleAuditDrain();
  } catch {
    reportFailure();
  }
}

export function emitPluginToolAudit(
  input: Omit<AuditEventInput, "event" | "kind">,
): void {
  emitAuditEvent({ ...input, event: "plugin.tool", kind: "plugin" });
}

export function emitPluginManagementAudit(
  input: Omit<AuditEventInput, "event" | "kind">,
): void {
  emitAuditEvent({ ...input, event: "plugin.management", kind: "plugin" });
}

export function emitMcpToolAudit(
  input: Omit<AuditEventInput, "event" | "kind">,
): void {
  emitAuditEvent({ ...input, event: "mcp.tool", kind: "mcp" });
}

export function emitSentinelShadowAudit(
  input: Omit<AuditEventInput, "event" | "kind" | "outcome"> & {
    direction: "input" | "tool_result" | "output";
    verdict: "allow" | "flag" | "block";
  },
): void {
  emitAuditEvent({
    ...input,
    event: "sentinel.shadow",
    kind: "sentinel",
    outcome: "ok",
    shadow: true,
  });
}
