import { createHash } from "node:crypto";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { Client } from "@modelcontextprotocol/sdk/client";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";
import { env } from "../env.ts";
import { logger } from "../logger.ts";
import {
  createMcpToolListCache,
  type McpToolListCache,
} from "../middleware/cache.ts";
import type { ToolResultCache } from "../middleware/cache.ts";
import type { BudgetManager } from "../middleware/budget.ts";
import type { Ledger } from "../ledger.ts";
import { SsrfValidationError, validateMcpHeaderName } from "../plugins/ssrf.ts";
import type { LookupFn, Mode } from "../plugins/ssrf.ts";
import {
  authorizeEgressRequest,
  buildPinnedAgent,
  createEgressPolicy,
  normalizeHostname,
  resolveAndValidateHost,
  validateStaticUrl,
} from "../plugins/ssrf.ts";
import { credentialFingerprint } from "../plugins/credential.ts";
import {
  boundToolResult,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  TOOL_RESULT_TRUNCATION_MARKER,
} from "../tool_bounds.ts";
import { createBoundTool, makeToolBodies } from "../tools/bind.ts";
import { createToolPipeline } from "../tools/pipeline.ts";
import type { ToolCall, ToolCallScope } from "../tools/pipeline.ts";
import {
  createJobToolInterceptors,
  createSyncToolInterceptors,
} from "../tools/interceptors/order.ts";
import { redactForOutbound } from "../redact.ts";
import {
  emitAuditEvent,
  type AuditEventInput,
  type AuditOutcome,
} from "../audit/telemetry.ts";
import { isMcpHeaderReference } from "../plugins/types.ts";
import type { JsonSchema } from "../plugins/types.ts";
import { jsonSchemaToZod } from "../tools/schema.ts";

/**
 * MCP tools on the shared tool pipeline (step 1.11).
 *
 * MCP connection/circuit/list-cache lifecycle stays here; only per-call policy
 * moves onto `tools/pipeline.ts`. `bindMcpServers` dispatches every MCP tool
 * call through the SAME engine the plugin channels use, with
 * `pluginId: "mcp:<serverName>"` and `source: "mcp"`. Consequences recorded in
 * the plan (`docs/plugin-seam-architecture-plan.md` §5 D1/D2, §13):
 *
 *   - **D1 — MCP is budgeted.** Because MCP calls now carry `requestId` and
 *     `tool`, `withToolCallBudget` applies its FULL policy in addition to MCP's
 *     own per-server/per-owner caps. Concretely, an MCP server's tools are
 *     capped per owner at `DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_TURN`
 *     (8 calls to the SAME tool in one turn) and
 *     `DEFAULT_MAX_TOOL_CALLS_PER_OWNER_PLUGIN_PER_WINDOW` (20 calls to ANY tool
 *     of that one server per owner per `DEFAULT_TOOL_CALL_RATE_WINDOW_MS`
 *     (60 s)), in addition to the per-owner/per-plugin concurrency caps. The
 *     effective concurrency is `min(mcp cap, budget cap)`. This is a deliberate
 *     side effect of a uniform budget policy, accepted as ample for a chat agent
 *     and pinned by `test/agents/mcp_pipeline.test.ts`.
 *   - **D2 — MCP results are cacheable.** Read-only calls are keyed including a
 *     fingerprint of the RESOLVED request headers, so rotating `${MCP_TOKEN}`
 *     cannot serve a stale entry.
 *   - **D5 — MCP audit stays inside `runMcpOperation`.** The pipeline's
 *     `onResult` sink is plugin-source only; MCP audit carries fields
 *     (`circuitState`, `policyCode`, `ownerBound`, `cacheHit`) the sink cannot.
 *
 * Accepted minor divergence (no D-number, 1.11): a read-only RESULT-CACHE HIT
 * short-circuits in the pipeline's `cache` interceptor before the body, so
 * `runMcpOperation` never runs and the hit emits NO `mcp.tool` audit record.
 * D5 keeps audit inside the body, so closing this would require a second audit
 * path; the hit is not silent end to end (`cache.size`/diagnostics), but it is
 * not audited. See the plan's 1.11 "Accepted minor divergences".
 */

export type McpServerConfig = {
  name: string;
  url: string;
  headers?: Record<string, string>;
  headerRefs?: Record<string, string>;
  id?: string;
  pinnedIps?: readonly string[];
};

export type McpPinResolver = (
  server: McpServerConfig,
) => readonly string[] | undefined | Promise<readonly string[] | undefined>;
export type McpPinOption = readonly string[] | McpPinResolver;

export class McpError extends Error {
  readonly code: string;
  readonly policyCode?: string;
  constructor(message: string, code = "MCP_ERROR", policyCode?: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.policyCode = policyCode;
  }
}

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  readOnly?: boolean;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
};

export type McpCallResult = {
  content?: { type?: string; text?: string }[];
};

export const DEFAULT_MCP_MAX_CONNECTIONS_PER_SERVER = 4;
export const DEFAULT_MCP_MAX_IN_FLIGHT_CALLS_PER_SERVER = 8;
export const DEFAULT_MCP_MAX_CONNECTIONS_PER_OWNER = 2;
export const DEFAULT_MCP_MAX_IN_FLIGHT_CALLS_PER_OWNER = 4;
export const DEFAULT_MCP_CIRCUIT_FAILURE_THRESHOLD = 3;
export const DEFAULT_MCP_CIRCUIT_FAILURE_WINDOW_MS = 60_000;
export const DEFAULT_MCP_CIRCUIT_COOLDOWN_MS = 30_000;
export const DEFAULT_MCP_IDLE_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_MCP_MAX_SESSION_LIFETIME_MS = 24 * 60 * 60_000;
export const DEFAULT_MCP_SESSION_IDLE_TIMEOUT_MS = DEFAULT_MCP_IDLE_TIMEOUT_MS;
export const DEFAULT_MCP_SESSION_MAX_LIFETIME_MS = DEFAULT_MCP_MAX_SESSION_LIFETIME_MS;
export const MCP_EVICTION_ERROR_CODES = {
  idle: "MCP_SESSION_IDLE_TIMEOUT",
  max_lifetime: "MCP_SESSION_MAX_LIFETIME",
} as const;
export const MCP_RESOURCE_LIMIT_CODES = {
  runtime: "MCP_RUNTIME_LIMIT",
  close: "MCP_CLOSE_TIMEOUT",
} as const;
export type McpEvictionReason = keyof typeof MCP_EVICTION_ERROR_CODES;
export function isMcpToolSafeToRepeat(tool: Pick<McpTool, "readOnly" | "annotations">): boolean {
  const explicitlyReadOnly = tool.readOnly === true || tool.annotations?.readOnlyHint === true;
  return explicitlyReadOnly && tool.annotations?.destructiveHint !== true;
}

export const DEFAULT_MCP_BOUNDARY_LIMITS = {
  maxToolCount: 100,
  maxToolListBytes: 1_048_576,
  maxToolStringChars: 16_384,
  maxSchemaDepth: 32,
  maxCallResultBytes: 1_048_576,
  maxCallResultChars: 65_536,
} as const;

export type McpBoundaryLimits = {
  maxToolCount: number;
  maxToolListBytes: number;
  maxToolStringChars: number;
  maxSchemaDepth: number;
  maxCallResultBytes: number;
  maxCallResultChars: number;
};

export type McpResourceErrorCode =
  | "mcp_tool_list_item_limit"
  | "mcp_tool_list_byte_limit"
  | "mcp_tool_string_limit"
  | "mcp_tool_schema_depth_limit";

export type McpResourceUnit = "items" | "bytes" | "characters" | "depth";

export class McpResourceError extends Error {
  readonly code: McpResourceErrorCode;
  readonly limit: number;
  readonly unit: McpResourceUnit;

  constructor(
    code: McpResourceErrorCode,
    message: string,
    limit: number,
    unit: McpResourceUnit,
  ) {
    super(message);
    this.name = "McpResourceError";
    this.code = code;
    this.limit = limit;
    this.unit = unit;
  }
}

/** MCP limits and circuit state are process-local and assume the supported single-replica deployment. */
export const MCP_SINGLE_REPLICA_NOTICE =
  "MCP connection, concurrency, session lifetime, and circuit state are process-local; the supported gateway deployment has exactly one replica.";

export type McpLimits = {
  maxConnectionsPerServer: number;
  maxInFlightCallsPerServer: number;
  maxConnectionsPerOwner: number;
  maxInFlightCallsPerOwner: number;
  circuitFailureThreshold: number;
  circuitFailureWindowMs: number;
  circuitCooldownMs: number;
  now: () => number;
  idleTimeoutMs?: number;
  maxSessionLifetimeMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export type McpCircuitState = "closed" | "open" | "half-open";

export type McpCircuitSnapshot = {
  state: McpCircuitState;
  consecutiveFailures: number;
  openedAt?: number;
  probeInFlight: boolean;
};

type McpSessionConfig = {
  idleTimeoutMs: number;
  maxSessionLifetimeMs: number;
  now: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

type McpConnectionRecord = {
  id: number;
  ownerScope: string;
  owner?: string;
  requestId?: string;
  serverName: string;
  bookkeepingKey: string;
  runtime: McpRuntime;
  session: McpSessionConfig;
  startedAt?: number;
  lastUsedAt: number;
  connectStartedAt: number;
  connectAuditEmitted: boolean;
  activeOperations: number;
  sessionTimer?: ReturnType<typeof setTimeout>;
  sessionAbortController: AbortController;
  lifetimeStarted: boolean;
  evictionStarted: boolean;
  evictionReason?: McpEvictionReason;
  closePromise?: Promise<void>;
  evictionPromise?: Promise<void>;
  releaseImpl: () => void;
  forceCloseStarted: boolean;
  clientClosePromise?: Promise<boolean>;
  closeForceTimer?: ReturnType<typeof setTimeout>;
  rawClient?: McpClientLike;
  rawFactorySettled: boolean;
  rawFactoryPromise?: Promise<McpClientLike>;
  clientPromise?: Promise<McpClientLike>;
  closeTimeoutMs: number;
  onClosed?: () => void;
};

type McpConnectionLease = {
  record: McpConnectionRecord;
  release: () => void;
};

type McpClientHandle = {
  client: McpClientLike;
  record: McpConnectionRecord;
};

type McpRuntime = {
  connections: Map<number, McpConnectionRecord>;
  circuit: {
    state: McpCircuitState;
    consecutiveFailures: number;
    firstFailureAt?: number;
    openedAt?: number;
    probeInFlight: boolean;
  };
  inFlightCalls: number;
  ownerInFlightCalls: Map<string, number>;
  lastUsedAt: number;
};

type McpOperationPermit = {
  probe: boolean;
};

const mcpRuntimes = new Map<string, McpRuntime>();
let mcpConnectionSequence = 0;
let mcpBindingSequence = 0;

/**
 * A connected MCP client. The default implementation speaks the SSE transport
 * over a pinned, SSRF-validated connection; tests substitute a fake so the
 * tool-binding logic is exercised without a real server.
 */
export type McpClientLike = {
  listTools: () => Promise<{ tools: McpTool[] }>;
  callTool: (params: { name: string; arguments: Record<string, unknown> }) => Promise<McpCallResult>;
  close: () => Promise<void>;
  forceClose?: () => void | Promise<void>;
};

export type McpClientFactory = (
  server: McpServerConfig,
  deps: {
    trustedHosts: readonly string[];
    lookup?: LookupFn;
    mode?: Mode;
    signal?: AbortSignal;
    pinnedIps?: readonly string[];
  },
) => Promise<McpClientLike>;

export type McpBinding = {
  tools: DynamicStructuredTool[];
  dispose: () => Promise<void>;
};

type McpTransportLike = {
  close: () => Promise<void>;
};

type McpSdkClient = {
  connect: (transport: McpTransportLike) => Promise<void>;
  listTools: (
    params?: unknown,
    options?: { timeout?: number },
  ) => Promise<{ tools: McpTool[] }>;
  callTool: (
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ) => Promise<McpCallResult>;
  close: () => Promise<void>;
};

type McpAgentLike = {
  destroy: () => Promise<void>;
};

export type McpSseFactoryOverrides = {
  createAgent?: (
    hostname: string,
    parsed: URL,
    pinned: readonly string[],
  ) => McpAgentLike;
  createTransport?: (
    url: URL,
    options: {
      requestInit: RequestInit;
      fetch: (
        input: string | URL | Request,
        init?: RequestInit,
      ) => Promise<Response>;
    },
  ) => McpTransportLike;
  createClient?: (transport: McpTransportLike) => McpSdkClient;
  timeoutMs?: number;
};

export const MAX_MCP_RUNTIME_STATES = 256;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function resolveMcpLimits(overrides?: Partial<McpLimits>): McpLimits {
  const limits: McpLimits = {
    maxConnectionsPerServer: overrides?.maxConnectionsPerServer ?? DEFAULT_MCP_MAX_CONNECTIONS_PER_SERVER,
    maxInFlightCallsPerServer: overrides?.maxInFlightCallsPerServer ?? DEFAULT_MCP_MAX_IN_FLIGHT_CALLS_PER_SERVER,
    maxConnectionsPerOwner: overrides?.maxConnectionsPerOwner ?? DEFAULT_MCP_MAX_CONNECTIONS_PER_OWNER,
    maxInFlightCallsPerOwner: overrides?.maxInFlightCallsPerOwner ?? DEFAULT_MCP_MAX_IN_FLIGHT_CALLS_PER_OWNER,
    circuitFailureThreshold: overrides?.circuitFailureThreshold ?? DEFAULT_MCP_CIRCUIT_FAILURE_THRESHOLD,
    circuitFailureWindowMs: overrides?.circuitFailureWindowMs ?? DEFAULT_MCP_CIRCUIT_FAILURE_WINDOW_MS,
    circuitCooldownMs: overrides?.circuitCooldownMs ?? DEFAULT_MCP_CIRCUIT_COOLDOWN_MS,
    now: overrides?.now ?? Date.now,
  };
  positiveInteger(limits.maxConnectionsPerServer, "maxConnectionsPerServer");
  positiveInteger(limits.maxInFlightCallsPerServer, "maxInFlightCallsPerServer");
  positiveInteger(limits.maxConnectionsPerOwner, "maxConnectionsPerOwner");
  positiveInteger(limits.maxInFlightCallsPerOwner, "maxInFlightCallsPerOwner");
  positiveInteger(limits.circuitFailureThreshold, "circuitFailureThreshold");
  positiveInteger(limits.circuitFailureWindowMs, "circuitFailureWindowMs");
  positiveInteger(limits.circuitCooldownMs, "circuitCooldownMs");
  if (typeof limits.now !== "function") throw new TypeError("now must be a function");
  return limits;
}

function normalizedMcpOrigin(server: Pick<McpServerConfig, "url">): string {
  try {
    return new URL(server.url).origin.toLowerCase();
  } catch {
    return server.url;
  }
}

function serverRuntimeKey(server: Pick<McpServerConfig, "url">): string {
  return normalizedMcpOrigin(server);
}

function serverBookkeepingKey(
  server: Pick<McpServerConfig, "url" | "name" | "id">,
): string {
  let pathname = server.url;
  try {
    const parsed = new URL(server.url);
    pathname = `${parsed.pathname}${parsed.search}`;
  } catch {
  }
  const configuredId = server.id?.trim() || server.name.trim();
  return `${normalizedMcpOrigin(server)}\u0000${configuredId}\u0000${pathname}`;
}

export function mcpServerRuntimeKey(
  server: Pick<McpServerConfig, "url">,
): string {
  return serverRuntimeKey(server);
}

export function mcpServerBookkeepingKey(
  server: Pick<McpServerConfig, "url" | "name" | "id">,
): string {
  return serverBookkeepingKey(server);
}

function ownerScope(owner: string | undefined): string {
  if (!owner) return "global";
  return createHash("sha256").update(owner, "utf8").digest("hex");
}

function newRuntime(now: number): McpRuntime {
  return {
    connections: new Map(),
    circuit: {
      state: "closed",
      consecutiveFailures: 0,
      probeInFlight: false,
    },
    inFlightCalls: 0,
    ownerInFlightCalls: new Map(),
    lastUsedAt: now,
  };
}

function getRuntime(key: string, now: number): McpRuntime {
  let runtime = mcpRuntimes.get(key);
  if (!runtime) {
    if (mcpRuntimes.size >= MAX_MCP_RUNTIME_STATES) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidateKey, candidate] of mcpRuntimes) {
        if (
          candidate.connections.size === 0 &&
          candidate.circuit.state === "closed" &&
          candidate.circuit.consecutiveFailures === 0 &&
          candidate.lastUsedAt < oldestAt
        ) {
          oldestKey = candidateKey;
          oldestAt = candidate.lastUsedAt;
        }
      }
      if (oldestKey === undefined) {
        throw new McpError(
          `MCP runtime limit reached (max ${MAX_MCP_RUNTIME_STATES})`,
          MCP_RESOURCE_LIMIT_CODES.runtime,
        );
      }
      mcpRuntimes.delete(oldestKey);
    }
    runtime = newRuntime(now);
    mcpRuntimes.set(key, runtime);
  }
  runtime.lastUsedAt = now;
  return runtime;
}

function ownerConnectionCount(runtime: McpRuntime, scope: string): number {
  let count = 0;
  for (const connection of runtime.connections.values()) {
    if (connection.ownerScope === scope) count += 1;
  }
  return count;
}

function reserveMcpConnection(
  runtime: McpRuntime,
  scope: string,
  limits: McpLimits,
  closeTimeoutMs: number,
  session: McpSessionConfig,
  server: Pick<McpServerConfig, "name" | "url" | "id">,
  owner?: string,
  requestId?: string,
): McpConnectionLease {
  if (
    runtime.connections.size >= limits.maxConnectionsPerServer ||
    ownerConnectionCount(runtime, scope) >= limits.maxConnectionsPerOwner
  ) {
    throw new McpError(
      `MCP connection limit reached for server (max ${limits.maxConnectionsPerServer} per server, ${limits.maxConnectionsPerOwner} per owner)`,
      "MCP_CONCURRENCY_LIMIT",
    );
  }
  let released = false;
  const record: McpConnectionRecord = {
    id: ++mcpConnectionSequence,
    ownerScope: scope,
    owner,
    requestId,
    serverName: server.name,
    bookkeepingKey: serverBookkeepingKey(server),
    runtime,
    session,
     lastUsedAt: session.now(),
     connectStartedAt: session.now(),
     connectAuditEmitted: false,
     activeOperations: 0,
    sessionAbortController: new AbortController(),
    lifetimeStarted: false,
    evictionStarted: false,
    releaseImpl: () => {},
    forceCloseStarted: false,
    rawFactorySettled: false,
    closeTimeoutMs,
  };
  const release = (): void => {
    if (released) return;
    released = true;
    runtime.connections.delete(record.id);
  };
  record.releaseImpl = release;
  runtime.connections.set(record.id, record);
  return { record, release };
}

async function closeMcpClientOnce(
  record: McpConnectionRecord,
  client: McpClientLike,
): Promise<boolean> {
  if (record.clientClosePromise !== undefined) return record.clientClosePromise;
  const promise = (async (): Promise<boolean> => {
    try {
      await withMcpTimeout(
        () => client.close(),
        record.closeTimeoutMs,
        "close",
        "mcp-client",
      );
      return false;
    } catch {
      forceMcpClientClose(record, client);
      return true;
    }
  })();
  record.clientClosePromise = promise;
  return promise;
}

function forceMcpClientClose(
  record: McpConnectionRecord,
  candidate: McpClientLike | undefined = record.rawClient,
): void {
  if (record.forceCloseStarted || candidate === undefined) return;
  record.forceCloseStarted = true;
  try {
    void Promise.resolve(candidate.forceClose?.()).catch(() => undefined);
  } catch {
  }
}

async function closeMcpConnection(lease: McpConnectionLease): Promise<void> {
  const { record } = lease;
  if (record.closePromise !== undefined) return record.closePromise;
  clearMcpSessionTimer(record);
  if (!record.sessionAbortController.signal.aborted) {
    record.sessionAbortController.abort(mcpClosedError(record));
  }
  try {
    record.onClosed?.();
  } catch {
  }
  record.closePromise = (async () => {
    let forceReleaseTelemetryEmitted = false;
    const emitForceRelease = (): void => {
      if (forceReleaseTelemetryEmitted) return;
      forceReleaseTelemetryEmitted = true;
      emitAuditEvent({
        event: "mcp.connect",
        kind: "mcp",
        outcome: "cancelled",
        owner: record.owner,
        server: record.serverName,
        requestId: record.requestId,
        errorCode: MCP_RESOURCE_LIMIT_CODES.close,
        status: "force_released",
        ownerBound: record.owner !== undefined,
        circuitState: record.runtime.circuit.state,
      });
    };
    const finishClose = async (): Promise<boolean> => {
      if (record.rawFactorySettled) {
        if (record.rawClient === undefined) return false;
        return closeMcpClientOnce(record, record.rawClient);
      }
      if (record.rawFactoryPromise === undefined) return false;
      try {
        const client = await record.rawFactoryPromise;
        return closeMcpClientOnce(record, client);
      } catch {
        return false;
      }
    };
    const deadline = new Promise<"deadline">((resolve) => {
      record.closeForceTimer = record.session.setTimeout(
        () => resolve("deadline"),
        record.closeTimeoutMs,
      );
      if (typeof (record.closeForceTimer as { unref?: () => void }).unref === "function") {
        (record.closeForceTimer as { unref: () => void }).unref();
      }
    });
    try {
      const outcome = await Promise.race([
        finishClose().then((forced) => forced ? "forced" : "closed"),
        deadline,
      ]);
      if (outcome === "deadline") {
        forceMcpClientClose(record);
        emitForceRelease();
      } else if (outcome === "forced") {
        emitForceRelease();
      }
    } finally {
      if (record.closeForceTimer !== undefined) {
        record.session.clearTimeout(record.closeForceTimer);
        record.closeForceTimer = undefined;
      }
      lease.release();
    }
  })();
  return record.closePromise;
}

function mcpEvictionCode(reason: McpEvictionReason): string {
  return MCP_EVICTION_ERROR_CODES[reason];
}

function mcpClosedError(record: McpConnectionRecord): McpError {
  if (record.evictionReason) {
    return new McpError(
      `MCP client for '${redactForOutbound(record.serverName)}' was evicted (${record.evictionReason})`,
      mcpEvictionCode(record.evictionReason),
    );
  }
  return new McpError(
    `MCP client for '${redactForOutbound(record.serverName)}' is closed`,
    "MCP_DISPOSED",
  );
}

function clearMcpSessionTimer(record: McpConnectionRecord): void {
  if (record.sessionTimer === undefined) return;
  record.session.clearTimeout(record.sessionTimer);
  record.sessionTimer = undefined;
}

function scheduleMcpSessionTimer(record: McpConnectionRecord): void {
  if (
    record.evictionStarted ||
    record.closePromise !== undefined ||
    !record.lifetimeStarted ||
    record.startedAt === undefined
  ) {
    return;
  }
  clearMcpSessionTimer(record);
  const now = record.session.now();
  const maxDeadline = record.startedAt + record.session.maxSessionLifetimeMs;
  const idleDeadline = record.activeOperations === 0
    ? record.lastUsedAt + record.session.idleTimeoutMs
    : Number.POSITIVE_INFINITY;
  const deadline = Math.min(maxDeadline, idleDeadline);
  const handle = record.session.setTimeout(() => {
    record.sessionTimer = undefined;
    checkMcpSessionExpiry(record);
  }, Math.max(0, deadline - now));
  record.sessionTimer = handle;
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }
}

function startMcpSession(record: McpConnectionRecord): void {
  if (record.evictionStarted || record.closePromise !== undefined || record.lifetimeStarted) return;
  const now = record.session.now();
  record.startedAt = now;
  record.lastUsedAt = now;
  record.lifetimeStarted = true;
  scheduleMcpSessionTimer(record);
}

function startMcpEviction(
  record: McpConnectionRecord,
  reason: McpEvictionReason,
): Promise<void> {
  if (record.evictionPromise) return record.evictionPromise;
  if (record.evictionReason !== undefined) {
    return closeMcpConnection({ record, release: record.releaseImpl });
  }
  record.evictionStarted = true;
  record.evictionReason = reason;
  clearMcpSessionTimer(record);
  if (!record.sessionAbortController.signal.aborted) {
    record.sessionAbortController.abort(mcpClosedError(record));
  }
  emitMcpAudit({
    event: "mcp.connect",
    kind: "mcp",
    outcome: reason === "max_lifetime" ? "timeout" : "cancelled",
    owner: record.owner,
    server: record.serverName,
    requestId: record.requestId,
    errorCode: mcpEvictionCode(reason),
    status: reason,
    circuitState: record.runtime.circuit.state,
  });
  const promise = closeMcpConnection({ record, release: record.releaseImpl });
  record.evictionPromise = promise;
  return promise;
}

function checkMcpSessionExpiry(record: McpConnectionRecord): boolean {
  if (!record.lifetimeStarted || record.evictionStarted || record.closePromise !== undefined) {
    return false;
  }
  const now = record.session.now();
  if (record.startedAt !== undefined && now - record.startedAt >= record.session.maxSessionLifetimeMs) {
    void startMcpEviction(record, "max_lifetime");
    return true;
  }
  if (record.activeOperations === 0 && now - record.lastUsedAt >= record.session.idleTimeoutMs) {
    void startMcpEviction(record, "idle");
    return true;
  }
  scheduleMcpSessionTimer(record);
  return false;
}

function touchMcpConnection(record: McpConnectionRecord): void {
  if (record.evictionStarted || record.closePromise !== undefined || !record.lifetimeStarted) return;
  record.lastUsedAt = record.session.now();
  checkMcpSessionExpiry(record);
  if (!record.evictionStarted && record.closePromise === undefined) {
    scheduleMcpSessionTimer(record);
  }
}

async function runMcpClientOperation<T>(
  handle: McpClientHandle,
  externalSignal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const { record } = handle;
  if (checkMcpSessionExpiry(record) || record.evictionStarted || record.closePromise !== undefined) {
    throw mcpClosedError(record);
  }
  record.activeOperations += 1;
  record.lastUsedAt = record.session.now();
  scheduleMcpSessionTimer(record);
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        record.sessionAbortController.signal.removeEventListener("abort", onSessionAbort);
        externalSignal?.removeEventListener("abort", onExternalAbort);
      };
      const onSessionAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(mcpClosedError(record));
      };
      const onExternalAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new DOMException("MCP operation aborted", "AbortError"));
      };
      record.sessionAbortController.signal.addEventListener("abort", onSessionAbort, { once: true });
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
      if (externalSignal?.aborted) {
        onExternalAbort();
        return;
      }
      void Promise.resolve()
        .then(operation)
        .then(
          (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          },
        );
    });
  } finally {
    record.activeOperations = Math.max(0, record.activeOperations - 1);
    touchMcpConnection(record);
  }
}

function openMcpCircuit(runtime: McpRuntime, now: number): void {
  if (runtime.circuit.state === "open") return;
  runtime.circuit.state = "open";
  runtime.circuit.consecutiveFailures = Math.max(
    runtime.circuit.consecutiveFailures,
    1,
  );
  runtime.circuit.firstFailureAt = now;
  runtime.circuit.openedAt = now;
  runtime.circuit.probeInFlight = false;
  for (const record of [...runtime.connections.values()]) {
    void closeMcpConnection({ record, release: record.releaseImpl });
  }
}

function beginMcpOperation(
  runtime: McpRuntime,
  limits: McpLimits,
): McpOperationPermit {
  const now = limits.now();
  const circuit = runtime.circuit;
  if (circuit.state === "open") {
    const openedAt = circuit.openedAt ?? now;
    if (now - openedAt < limits.circuitCooldownMs) {
      throw new McpError("MCP circuit is open", "MCP_CIRCUIT_OPEN");
    }
    circuit.state = "half-open";
    circuit.probeInFlight = true;
    return { probe: true };
  }
  if (circuit.state === "half-open") {
    if (circuit.probeInFlight) {
      throw new McpError("MCP circuit is half-open and already probing", "MCP_CIRCUIT_OPEN");
    }
    circuit.probeInFlight = true;
    return { probe: true };
  }
  return { probe: false };
}

function completeMcpOperation(
  runtime: McpRuntime,
  permit: McpOperationPermit,
  limits: McpLimits,
  success: boolean,
  countableFailure: boolean,
): McpCircuitState {
  const now = limits.now();
  const circuit = runtime.circuit;
  if (permit.probe) {
    if (circuit.state !== "half-open") return circuit.state;
    circuit.probeInFlight = false;
    if (success) {
      circuit.state = "closed";
      circuit.consecutiveFailures = 0;
      circuit.firstFailureAt = undefined;
      circuit.openedAt = undefined;
    } else if (countableFailure) {
      openMcpCircuit(runtime, now);
    }
    return circuit.state;
  }
  if (circuit.state !== "closed") return circuit.state;
  if (success) {
    circuit.consecutiveFailures = 0;
    circuit.firstFailureAt = undefined;
    return circuit.state;
  }
  if (!countableFailure) return circuit.state;
  if (
    circuit.firstFailureAt === undefined ||
    now - circuit.firstFailureAt >= limits.circuitFailureWindowMs
  ) {
    circuit.firstFailureAt = now;
    circuit.consecutiveFailures = 1;
  } else {
    circuit.consecutiveFailures += 1;
  }
  if (circuit.consecutiveFailures >= limits.circuitFailureThreshold) {
    openMcpCircuit(runtime, now);
  }
  return circuit.state;
}

function reserveMcpCall(
  runtime: McpRuntime,
  scope: string,
  limits: McpLimits,
): () => void {
  const ownerCalls = runtime.ownerInFlightCalls.get(scope) ?? 0;
  if (
    runtime.inFlightCalls >= limits.maxInFlightCallsPerServer ||
    ownerCalls >= limits.maxInFlightCallsPerOwner
  ) {
    throw new McpError(
      `MCP in-flight limit reached (max ${limits.maxInFlightCallsPerServer} per server, ${limits.maxInFlightCallsPerOwner} per owner)`,
      "MCP_CONCURRENCY_LIMIT",
    );
  }
  runtime.inFlightCalls += 1;
  runtime.ownerInFlightCalls.set(scope, ownerCalls + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    runtime.inFlightCalls = Math.max(0, runtime.inFlightCalls - 1);
    const remaining = (runtime.ownerInFlightCalls.get(scope) ?? 1) - 1;
    if (remaining <= 0) runtime.ownerInFlightCalls.delete(scope);
    else runtime.ownerInFlightCalls.set(scope, remaining);
  };
}

export function getMcpCircuitState(
  server: Pick<McpServerConfig, "url" | "headers">,
): McpCircuitSnapshot {
  const runtime = mcpRuntimes.get(serverRuntimeKey(server));
  if (!runtime) {
    return { state: "closed", consecutiveFailures: 0, probeInFlight: false };
  }
  return {
    state: runtime.circuit.state,
    consecutiveFailures: runtime.circuit.consecutiveFailures,
    ...(runtime.circuit.openedAt === undefined ? {} : { openedAt: runtime.circuit.openedAt }),
    probeInFlight: runtime.circuit.probeInFlight,
  };
}

export function resetMcpRuntimeState(): void {
  const runtimes = [...mcpRuntimes.values()];
  mcpRuntimes.clear();
  for (const runtime of runtimes) {
    for (const record of [...runtime.connections.values()]) {
      void closeMcpConnection({ record, release: record.releaseImpl });
    }
  }
}

export type McpBindOptions = {
  signal?: AbortSignal;
  trustedHosts?: readonly string[];
  lookup?: LookupFn;
  mode?: Mode;
  clientFactory?: McpClientFactory;
  owner?: string;
  requestId?: string;
  timeoutMs?: number;
  closeTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxSessionLifetimeMs?: number;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  pinnedIps?: McpPinOption;
  resolvePins?: McpPinResolver;
  limits?: Partial<McpLimits>;
  bounds?: Partial<McpBoundaryLimits>;
  /**
   * Step 1.11: policy deps for the pipeline every MCP tool call dispatches
   * through. Interceptors close over the SAME budget/cache/ledger objects the
   * channel's plugin tools use, so MCP gains budget (D1) and read-only result
   * caching (D2). When omitted, MCP still dispatches through the engine, just
   * with an empty policy (the transport guard inside the body still applies).
   */
  budget?: BudgetManager;
  toolCache?: ToolResultCache;
  /** Job channel only: the ledger the `fence`/`replay` interceptors read. */
  ledger?: Ledger;
  /**
   * Channel the MCP calls belong to. `warmup` is not a valid MCP channel.
   * Defaults to `sync-stateless`.
   */
  channel?: "sync-stateless" | "sync-managed" | "job";
  /** Job channel: task-fence fields carried on the `ToolCall`. */
  taskId?: string;
  fenceToken?: string;
  allowMutatingRetry?: boolean;
  /** Job channel: task-fence re-check, also supplied to the `fence` interceptor. */
  assertActive?: () => void;
  /** Channel-owned tracked execution (job/sync `settle()` draining). */
  track?: <T>(run: () => Promise<T>) => Promise<T>;
  trackUntil?: (run: () => Promise<void>, maxDurationMs: number) => void;
  onToolStart?: (actionId: string) => void;
  onToolEnd?: (actionId: string) => void;
  /**
   * Plugin tool names already bound for this request. An MCP tool whose name is
   * in this set loses the tie (plugin wins) and is skipped with the same warning
   * the deleted `mergePluginAndMcpTools` emitted.
   */
  excludeToolNames?: ReadonlySet<string>;
  /** Warning prefix for the MCP-loses-tie message (`[chat]` / `[jobs]`). */
  duplicateLogPrefix?: string;
};

function resolveMcpSessionConfig(
  opts: McpBindOptions | undefined,
  limits: McpLimits,
): McpSessionConfig {
  const idleTimeoutMs = positiveInteger(
    opts?.idleTimeoutMs ?? opts?.limits?.idleTimeoutMs ?? DEFAULT_MCP_IDLE_TIMEOUT_MS,
    "MCP idle timeout",
  );
  const maxSessionLifetimeMs = positiveInteger(
    opts?.maxSessionLifetimeMs ?? opts?.limits?.maxSessionLifetimeMs ?? DEFAULT_MCP_MAX_SESSION_LIFETIME_MS,
    "MCP maximum session lifetime",
  );
  return {
    idleTimeoutMs,
    maxSessionLifetimeMs,
    now: opts?.now ?? limits.now,
    setTimeout: opts?.setTimeout ?? opts?.limits?.setTimeout ?? globalThis.setTimeout.bind(globalThis),
    clearTimeout: opts?.clearTimeout ?? opts?.limits?.clearTimeout ?? globalThis.clearTimeout.bind(globalThis),
  };
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  return positiveInteger(timeoutMs ?? env.MCP_CALL_TIMEOUT_MS, "MCP timeout");
}

function resolveMcpBoundaryLimits(
  overrides?: Partial<McpBoundaryLimits>,
): McpBoundaryLimits {
  const limits: McpBoundaryLimits = {
    maxToolCount: overrides?.maxToolCount ?? DEFAULT_MCP_BOUNDARY_LIMITS.maxToolCount,
    maxToolListBytes: overrides?.maxToolListBytes ?? DEFAULT_MCP_BOUNDARY_LIMITS.maxToolListBytes,
    maxToolStringChars: overrides?.maxToolStringChars ?? DEFAULT_MCP_BOUNDARY_LIMITS.maxToolStringChars,
    maxSchemaDepth: overrides?.maxSchemaDepth ?? DEFAULT_MCP_BOUNDARY_LIMITS.maxSchemaDepth,
    maxCallResultBytes: overrides?.maxCallResultBytes ?? DEFAULT_MCP_BOUNDARY_LIMITS.maxCallResultBytes,
    maxCallResultChars: overrides?.maxCallResultChars ?? DEFAULT_MCP_BOUNDARY_LIMITS.maxCallResultChars,
  };
  for (const [name, value] of Object.entries(limits)) {
    positiveInteger(value, name);
  }
  if (limits.maxCallResultChars <= TOOL_RESULT_TRUNCATION_MARKER.length) {
    throw new RangeError(
      `maxCallResultChars must exceed ${TOOL_RESULT_TRUNCATION_MARKER.length}`,
    );
  }
  if (limits.maxCallResultBytes <= Buffer.byteLength(TOOL_RESULT_TRUNCATION_MARKER, "utf8")) {
    throw new RangeError(
      `maxCallResultBytes must exceed ${Buffer.byteLength(TOOL_RESULT_TRUNCATION_MARKER, "utf8")}`,
    );
  }
  return limits;
}

function assertBoundedMcpStrings(
  value: unknown,
  maxChars: number,
  path: string,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (typeof value === "string") {
    if (value.length > maxChars) {
      throw new McpResourceError(
        "mcp_tool_string_limit",
        `MCP tool list string at ${path} exceeds ${maxChars} characters`,
        maxChars,
        "characters",
      );
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) {
    throw new McpResourceError(
      "mcp_tool_list_byte_limit",
      "MCP tool list is not a finite JSON value",
      maxChars,
      "bytes",
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertBoundedMcpStrings(entry, maxChars, `${path}[${index}]`, seen),
    );
  } else {
    for (const [key, entry] of Object.entries(value)) {
      assertBoundedMcpStrings(entry, maxChars, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function assertMcpSchemaDepth(
  value: unknown,
  maxDepth: number,
  depth: number,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (depth > maxDepth) {
    throw new McpResourceError(
      "mcp_tool_schema_depth_limit",
      `MCP tool schema exceeds depth ${maxDepth}`,
      maxDepth,
      "depth",
    );
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) {
    throw new McpResourceError(
      "mcp_tool_list_byte_limit",
      "MCP tool schema contains a cycle",
      maxDepth,
      "depth",
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => assertMcpSchemaDepth(entry, maxDepth, depth + 1, seen));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
        for (const child of Object.values(entry)) {
          assertMcpSchemaDepth(child, maxDepth, depth + 1, seen);
        }
      } else if (key === "items" || key === "prefixItems" || key === "anyOf" || key === "oneOf" || key === "allOf") {
        assertMcpSchemaDepth(entry, maxDepth, depth + 1, seen);
      } else if (Array.isArray(entry)) {
        if (entry.some((item) => item !== null && typeof item === "object")) {
          assertMcpSchemaDepth(entry, maxDepth, depth + 1, seen);
        }
      } else if (entry !== null && typeof entry === "object") {
        assertMcpSchemaDepth(entry, maxDepth, depth + 1, seen);
      }
    }
  }
  seen.delete(value);
}

export function assertMcpToolList(
  tools: McpTool[],
  limits: McpBoundaryLimits = DEFAULT_MCP_BOUNDARY_LIMITS,
): void {
  if (tools.length > limits.maxToolCount) {
    throw new McpResourceError(
      "mcp_tool_list_item_limit",
      `MCP tools/list returned more than ${limits.maxToolCount} tools`,
      limits.maxToolCount,
      "items",
    );
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(tools);
  } catch {
    throw new McpResourceError(
      "mcp_tool_list_byte_limit",
      "MCP tools/list result is not JSON-serializable",
      limits.maxToolListBytes,
      "bytes",
    );
  }
  const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
  if (bytes > limits.maxToolListBytes) {
    throw new McpResourceError(
      "mcp_tool_list_byte_limit",
      `MCP tools/list result exceeds ${limits.maxToolListBytes} bytes`,
      limits.maxToolListBytes,
      "bytes",
    );
  }
  assertBoundedMcpStrings(tools, limits.maxToolStringChars, "$.tools");
  for (const tool of tools) {
    if (tool.inputSchema !== undefined) {
      assertMcpSchemaDepth(tool.inputSchema, limits.maxSchemaDepth, 1);
    }
  }
}

function boundMcpText(
  value: string,
  limits: McpBoundaryLimits,
): string {
  const redacted = redactForOutbound(value);
  let text = boundToolResult(redacted, limits.maxCallResultChars);
  if (Buffer.byteLength(text, "utf8") <= limits.maxCallResultBytes) return text;
  const markerBytes = Buffer.byteLength(TOOL_RESULT_TRUNCATION_MARKER, "utf8");
  const availableBytes = Math.max(0, limits.maxCallResultBytes - markerBytes);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= availableBytes) low = middle;
    else high = middle - 1;
  }
  let prefix = text.slice(0, low);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix + TOOL_RESULT_TRUNCATION_MARKER;
}

function boundMcpCallResult(
  result: McpCallResult,
  limits: McpBoundaryLimits,
): McpCallResult {
  let text = "";
  const maxProbe = limits.maxCallResultChars + TOOL_RESULT_TRUNCATION_MARKER.length + 1;
  for (const item of result.content ?? []) {
    const piece = typeof item.text === "string" ? item.text : "";
    if (!piece) continue;
     const separator = text.length > 0 ? "\n" : "";
     const remaining = maxProbe - text.length - separator.length;
     if (remaining <= 0) break;
     if (separator) text += separator;
     if (piece.length > remaining) {
       text += piece.slice(0, remaining);
       break;
     }
     text += piece;

  }
  return {
    ...result,
    content: [{ type: "text", text: boundMcpText(text, limits) }],
  };
}
function withMcpTimeout<T>(
  operation: Promise<T> | (() => Promise<T>),
  timeoutMs: number,
  label: string,
  serverName: string,
): Promise<T> {
  const safeServerName = redactForOutbound(serverName);
  let promise: Promise<T>;
  try {
    promise = Promise.resolve(typeof operation === "function" ? operation() : operation);
  } catch (err) {
    promise = Promise.reject(err);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new McpError(
          `MCP ${label} to '${safeServerName}' timed out after ${timeoutMs}ms`,
          "MCP_TIMEOUT",
        ),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isAbortFailure(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

/**
 * True when `signal` was aborted by the pipeline's `execution` bound rather than
 * by the caller: `invokeBoundedToolHandler` aborts its controller with the
 * `tool_timeout` `ToolResourceError` as the reason (`tool_bounds.ts:146`). The
 * MCP body inspects the reason to attribute the resulting `AbortError` as an MCP
 * timeout (finding M1) instead of a cancellation.
 */
function isToolTimeoutAbort(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    "code" in reason &&
    (reason as { code?: unknown }).code === "tool_timeout"
  );
}

function isPolicyFailure(err: unknown): boolean {
  return err instanceof SsrfValidationError ||
    (err instanceof McpError && err.code === "MCP_POLICY_DENIED");
}

function errorCode(err: unknown): string {
  if (err instanceof McpError) return err.code;
  if (err instanceof McpResourceError) return "MCP_RESOURCE_LIMIT";
  if (err instanceof SsrfValidationError) return `MCP_POLICY_${err.code}`;
  if (err instanceof Error && err.name === "AbortError") return "MCP_ABORTED";
  return "MCP_ERROR";
}

function policyCode(err: unknown): string | undefined {
  if (err instanceof SsrfValidationError) return err.code;
  if (err instanceof McpError) return err.policyCode;
  return undefined;
}

type McpFailure = {
  outcome: AuditOutcome;
  errorCode: string;
  policyCode?: string;
  countable: boolean;
};

function classifyMcpFailure(err: unknown, signal?: AbortSignal): McpFailure {
  if (err instanceof McpResourceError) {
    return {
      outcome: "error",
      errorCode: "MCP_RESOURCE_LIMIT",
      countable: false,
    };
  }
  if (isAbortFailure(err, signal)) {
    return { outcome: "cancelled", errorCode: "MCP_ABORTED", countable: false };
  }
  if (isPolicyFailure(err)) {
    return {
      outcome: "policy-denied",
      errorCode: errorCode(err),
      ...(policyCode(err) === undefined ? {} : { policyCode: policyCode(err) }),
      countable: false,
    };
  }
  const code = errorCode(err);
  if (code === "MCP_TIMEOUT") {
    return { outcome: "timeout", errorCode: code, countable: true };
  }
  if (
    code === "MCP_CIRCUIT_OPEN" ||
    code === "MCP_CONCURRENCY_LIMIT" ||
    code === MCP_RESOURCE_LIMIT_CODES.runtime ||
    code === "MCP_DISPOSED" ||
    code === MCP_EVICTION_ERROR_CODES.idle ||
    code === MCP_EVICTION_ERROR_CODES.max_lifetime
  ) {
    return {
      outcome: code === "MCP_CIRCUIT_OPEN"
        ? "circuit-open"
        : code === "MCP_DISPOSED" || code === MCP_EVICTION_ERROR_CODES.idle || code === MCP_EVICTION_ERROR_CODES.max_lifetime
          ? "cancelled"
          : "error",
      errorCode: code,
      countable: false,
    };
  }
  return { outcome: "error", errorCode: code, countable: true };
}

function byteLength(value: unknown): number {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
  } catch {
    return 0;
  }
}

function listResultBytes(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  return byteLength((value as { tools?: unknown }).tools);
}

function callResultBytes(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const content = (value as { content?: { text?: string }[] }).content ?? [];
  return byteLength(redactForOutbound(content.map((item) => item.text ?? "").join("\n")));
}

type McpAuditEvent = "mcp.connect" | "mcp.list" | "mcp.tool";

function emitMcpAudit(event: AuditEventInput): void {
  try {
    emitAuditEvent(event);
  } catch {
  }
}

function emitMcpConnectAudit(
  record: McpConnectionRecord,
  outcome: AuditOutcome,
  errorCode?: string,
): void {
  if (record.connectAuditEmitted) return;
  record.connectAuditEmitted = true;
  emitMcpAudit({
    event: "mcp.connect",
    kind: "mcp",
    outcome,
    owner: record.owner,
    server: record.serverName,
    requestId: record.requestId,
    durationMs: Math.max(0, record.session.now() - record.connectStartedAt),
    ownerBound: record.owner !== undefined,
    circuitState: record.runtime.circuit.state,
    ...(errorCode === undefined ? {} : { errorCode }),
  });
}

function emitMcpCircuitTransition(
  server: McpServerConfig,
  owner: string | undefined,
  requestId: string | undefined,
  from: McpCircuitState,
  to: McpCircuitState,
): void {
  if (from === to) return;
  emitMcpAudit({
    event: "mcp.connect",
    kind: "mcp",
    outcome: to === "open" ? "circuit-open" : "ok",
    owner,
    server: server.name,
    requestId,
    status: to,
    circuitState: to,
    ownerBound: owner !== undefined,
  });
}

type McpOperationOptions<T> = {
  server: McpServerConfig;
  owner?: string;
  ownerKey?: string;
  requestId?: string;
  /**
   * The signal used to ATTRIBUTE a failure, not to cancel the outbound call
   * (finding M1). It is the CHANNEL signal (`call.signal`), captured before any
   * timeout controller exists — never the pipeline-composed `bodySignal`, which
   * the `execution` interceptor aborts on a handler timeout. Passing the
   * composed signal here would make `isAbortFailure` classify every genuine
   * timeout as a caller cancellation, so the circuit never counts it. The
   * outbound cancellation signal is passed directly to
   * `runMcpClientOperation`/`withMcpTimeout` by the caller.
   */
  attributionSignal?: AbortSignal;
  event: McpAuditEvent;
  tool?: string;
  cacheHit: boolean;
  inputBytes: number;
  limits: McpLimits;
  run: () => Promise<T>;
  onFailure: () => void;
  outputBytes?: (value: T) => number;
};

async function runMcpOperation<T>(
  options: McpOperationOptions<T>,
): Promise<T> {
  const { server, owner, limits } = options;
  const key = serverRuntimeKey(server);
  const scope = options.ownerKey ?? ownerScope(owner);
  const runtime = getRuntime(key, limits.now());
  const initialCircuitState = runtime.circuit.state;
  const startedAt = limits.now();
  let permit: McpOperationPermit | undefined;
  let releaseCall: (() => void) | undefined;
  try {
    permit = beginMcpOperation(runtime, limits);
    emitMcpCircuitTransition(
       server,
       owner,
      options.requestId,
      initialCircuitState,
      runtime.circuit.state,
    );
    try {
      releaseCall = reserveMcpCall(runtime, scope, limits);
    } catch (err) {
      if (permit.probe && runtime.circuit.state === "half-open") {
        runtime.circuit.probeInFlight = false;
      }
      throw err;
    }
    const value = await options.run();
    const state = completeMcpOperation(runtime, permit, limits, true, false);
    emitMcpCircuitTransition(
       server,
       owner,
      options.requestId,
      initialCircuitState,
      state,
    );
    emitMcpAudit({
      event: options.event,
      kind: "mcp",
      outcome: "ok",
      owner,
      server: server.name,
      tool: options.tool,
      requestId: options.requestId,
      durationMs: Math.max(0, limits.now() - startedAt),
      inputBytes: options.inputBytes,
      outputBytes: options.outputBytes?.(value),
      cacheHit: options.cacheHit,
      ownerBound: owner !== undefined,
      circuitState: state,
    });
    return value;
  } catch (err) {
    const failure = classifyMcpFailure(err, options.attributionSignal);
     if (permit) {
       const state = completeMcpOperation(runtime, permit, limits, false, failure.countable);
        emitMcpCircuitTransition(
          server,
          owner,
         options.requestId,
         initialCircuitState,
         state,
       );
       try {
        if (failure.countable || failure.outcome === "cancelled" || failure.outcome === "policy-denied") {
          options.onFailure();
        }
      } catch {
      }
    }
    const state = runtime.circuit.state;
    emitMcpAudit({
      event: failure.outcome === "policy-denied" ? "mcp.policy" : options.event,
      kind: "mcp",
      outcome: failure.outcome,
      owner,
      server: server.name,
      tool: options.tool,
      requestId: options.requestId,
      durationMs: Math.max(0, limits.now() - startedAt),
      inputBytes: options.inputBytes,
      errorCode: failure.errorCode,
      policyCode: failure.policyCode,
      ownerBound: owner !== undefined,
      circuitState: state,
    });
    throw err;
  } finally {
    releaseCall?.();
  }
}

// `jsonSchemaToZod` lives in the neutral `tools/schema.ts` (finding m2) so
// `tools/bind.ts` no longer has to import from this module, which imports
// `tools/bind.ts` back. Imported for local use above and re-exported here so
// existing importers (`test/agents/mcp.test.ts`) keep working unchanged.
export { jsonSchemaToZod } from "../tools/schema.ts";

function resolveMcpRequestHeaders(
  server: McpServerConfig,
): Record<string, string> | undefined {
  const references = server.headerRefs ?? server.headers;
  if (references === undefined) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(references)) {
    try {
      validateMcpHeaderName(name);
    } catch (err) {
      if (err instanceof SsrfValidationError) {
        throw new McpError(
          `MCP header name for '${name}' is invalid`,
          "MCP_POLICY_DENIED",
          err.code,
        );
      }
      throw err;
    }
    if (!isMcpHeaderReference(value)) {
      headers[name] = value;
      continue;
    }
    const variable = value.slice(2, -1);
    const resolved = process.env[variable];
    if (resolved === undefined || /[\r\n\u0000-\u001f]/.test(resolved)) {
      throw new McpError(
        `MCP header reference for '${name}' is unavailable or invalid`,
        "MCP_POLICY_DENIED",
        "INVALID_URL",
      );
    }
    headers[name] = resolved;
  }
  return headers;
}

async function validateMcpRetainedPins(
  parsed: URL,
  pinnedIps: readonly string[],
  trustedHosts: readonly string[],
  mode: Mode | undefined,
): Promise<readonly string[]> {
  const validationUrl = new URL(`${parsed.origin}${parsed.pathname}`);
  const policy = createEgressPolicy({
    subject: "mcp",
    destinations: [{
      baseUrl: validationUrl.href,
      pinnedIps,
      methods: ["GET", "POST"],
      exactPaths: [validationUrl.pathname],
    }],
    trustedHosts,
    httpAllowedHosts: trustedHosts,
    mode,
  });
  const authorized = await authorizeEgressRequest(policy, validationUrl.href, "GET");
  return authorized.pinnedIps;
}


export async function defaultSseClientFactory(
  server: McpServerConfig,
  deps: {
    trustedHosts: readonly string[];
    lookup?: LookupFn;
    mode?: Mode;
    signal?: AbortSignal;
    pinnedIps?: readonly string[];
  },
  overrides: McpSseFactoryOverrides = {},
): Promise<McpClientLike> {
  const trusted = deps.trustedHosts;
  const parsed = validateStaticUrl(server.url, {
    trustedHosts: trusted,
    httpAllowedHosts: trusted,
    mode: deps.mode,
  });
  const hostname = normalizeHostname(parsed.hostname);
  const retainedPins = deps.pinnedIps ?? server.pinnedIps;
  const pinned = retainedPins === undefined
    ? await resolveAndValidateHost(hostname, {
        trustedHosts: trusted,
        lookup: deps.lookup,
      })
    : await validateMcpRetainedPins(parsed, retainedPins, trusted, deps.mode);
  const agent = overrides.createAgent?.(hostname, parsed, pinned) ?? buildPinnedAgent(hostname, parsed, pinned);
  const mcpFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    validateStaticUrl(url, {
      trustedHosts: trusted,
      httpAllowedHosts: trusted,
      mode: deps.mode,
    });
    return globalThis.fetch(url, {
      ...init,
      redirect: "manual",
      dispatcher: agent,
    } as unknown as RequestInit);
  };
  const connectController = new AbortController();
  const connectSignal = deps.signal
    ? AbortSignal.any([deps.signal, connectController.signal])
    : connectController.signal;
  const transport: McpTransportLike =
    overrides.createTransport?.(new URL(server.url), {
      requestInit: { headers: resolveMcpRequestHeaders(server), signal: connectSignal },
      fetch: mcpFetch,
    }) ??
    new SSEClientTransport(new URL(server.url), {
      requestInit: { headers: resolveMcpRequestHeaders(server), signal: connectSignal },
      fetch: mcpFetch,
    });
  const client: McpSdkClient =
    overrides.createClient?.(transport) ??
    (new Client({ name: "ai-assistant-gateway", version: "0.1.0" }) as unknown as McpSdkClient);
   let closePromise: Promise<void> | undefined;
   let forceCloseStarted = false;
   const forceClose = (): void => {
     if (forceCloseStarted) return;
     forceCloseStarted = true;
     connectController.abort();
     void Promise.allSettled([
       agent.destroy(),
       transport.close(),
       client.close(),
     ]);
   };
   const closeClient = (): Promise<void> => {
     closePromise ??= (async () => {
       connectController.abort();
       await Promise.allSettled([agent.destroy(), client.close()]);
     })();
     return closePromise;
   };

  // The MCP_CALL_TIMEOUT_MS guard covers the JSON-RPC calls (listTools/
  // callTool) but NOT the SSE handshake — a reachable-but-unresponsive server
  // would otherwise hold the request (and, in the runner, the per-thread
  // mutex) until the client aborts. Race connect against the same timeout and
  // abort the underlying SSE fetch on timeout. The timer/controller is cleared
  // once the handshake resolves so the long-lived SSE stream stays live.
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectPromise: Promise<void> | undefined;
  try {
    const pendingConnect = client.connect(transport);
    connectPromise = pendingConnect;
    const timeoutMs = resolveTimeoutMs(overrides.timeoutMs);
    const timeout = new Promise<never>((_, reject) => {
      connectTimer = setTimeout(() => {
        connectController.abort();
        reject(
          new McpError(
            `MCP connect to '${redactForOutbound(server.name)}' timed out after ${timeoutMs}ms`,
            "MCP_TIMEOUT",
          ),
        );
      }, timeoutMs);
    });
    await Promise.race([pendingConnect, timeout]);
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = undefined;
  } catch (err) {
    if (connectTimer) clearTimeout(connectTimer);
    const pendingConnect = connectPromise;
    if (pendingConnect) {
      void pendingConnect
        .then(
          () => closeClient(),
          () => undefined,
        )
        .catch(() => {});
    }
    await closeClient();
    if (err instanceof McpError) throw err;
    if (err instanceof SsrfValidationError) {
      throw new McpError(
        `MCP policy denied (${err.code})`,
        "MCP_POLICY_DENIED",
        err.code,
      );
    }
    throw new McpError(redactForOutbound(err instanceof Error ? err.message : String(err)));
  }
  const rpcTimeoutMs = resolveTimeoutMs(overrides.timeoutMs);
  const runRpc = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await withMcpTimeout(run, rpcTimeoutMs, label, server.name);
    } catch (err) {
      if (err instanceof McpError && err.code === "MCP_TIMEOUT") {
        void closeClient();
      }
      throw err;
    }
  };
  return {
    listTools: async () => {
      const r = await runRpc("list", () =>
        client.listTools(undefined, { timeout: rpcTimeoutMs }),
      );
      return {
        tools: (r.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as JsonSchema,
          ...(t.annotations === undefined ? {} : { annotations: t.annotations }),
          ...(t.readOnly === undefined ? {} : { readOnly: t.readOnly }),
        })),
      };
    },
    callTool: async (params: { name: string; arguments: Record<string, unknown> }) => {
      const r = await runRpc("invoke", () =>
        client.callTool(params, undefined, { timeout: rpcTimeoutMs }),
      );
      return { content: r.content as McpCallResult["content"] };
    },
     close: closeClient,
     forceClose,
   };
 }


/**
 * Cache key for a server's tool list: the server URL plus a one-way
 * fingerprint of the resolved auth-header set. Raw header values NEVER
 * appear in the key (they may carry secrets) — reuse `credentialFingerprint`
 * (sorted JSON `[key, value]` pairs → versioned SHA-256), the same derivation
 * used for pin and credential-store identities. Absent headers fingerprint as
 * the empty set, so unkeyed servers dedupe too. NUL-joins like `internalKey` in
 * `middleware/cache.ts` (URLs cannot contain `\u0000`).
 */
export function mcpToolListCacheKey(
  server: Pick<McpServerConfig, "url" | "headers" | "headerRefs">,
): string {
  return `${server.url}\u0000${credentialFingerprint(server.headerRefs ?? server.headers ?? {})}`;
}

let toolListCache: McpToolListCache | undefined;

/**
 * Process-wide MCP tool-list cache singleton. Created on first use so
 * `bindMcpServers([])` never constructs it; sweep timer is unref'd.
 */
export function getMcpToolListCache(): McpToolListCache {
  toolListCache ??= createMcpToolListCache();
  return toolListCache;
}

/**
 * Test seam: install a (possibly fake-clock) cache; disposes the previous
 * instance unless it is the same one. `undefined` = reset.
 */
export function setMcpToolListCache(cache: McpToolListCache | undefined): void {
  if (toolListCache === cache) return;
  toolListCache?.dispose();
  toolListCache = cache;
}

/** Test seam: drop the singleton so the next use creates a fresh default. */
export function resetMcpToolListCache(): void {
  setMcpToolListCache(undefined);
}

/**
 * The D2 result-cache credential component: a one-way fingerprint of the
 * RESOLVED request headers for a server. Unlike `mcpToolListCacheKey` (which
 * fingerprints the literal `${REF}` strings so the tool-list entry stays stable
 * across rotations), this resolves `${MCP_TOKEN}` first, so rotating the env var
 * changes the fingerprint and a stale cached tool result cannot be served.
 * Returns undefined when a header reference cannot be resolved: the call will
 * fail at connect, and skipping the cache (rather than keying it under a bogus
 * value) is the safe behaviour.
 */
function mcpResolvedCredentialFingerprint(
  server: McpServerConfig,
): string | undefined {
  try {
    return credentialFingerprint(resolveMcpRequestHeaders(server) ?? {});
  } catch {
    return undefined;
  }
}

function requireJobLedger(opts: McpBindOptions | undefined): Ledger {
  if (opts?.ledger === undefined) {
    throw new Error("bindMcpServers: channel 'job' requires a ledger");
  }
  return opts.ledger;
}

export async function bindMcpServers(
  mcpServers: McpServerConfig[],
  opts?: McpBindOptions,
): Promise<McpBinding> {
  const tools: DynamicStructuredTool[] = [];
  const disposers: Array<() => Promise<void>> = [];
  const toolSafety = new Map<string, boolean>();
  const factory = opts?.clientFactory ?? defaultSseClientFactory;
  const limits = resolveMcpLimits(opts?.limits);
  const boundaryLimits = resolveMcpBoundaryLimits(opts?.bounds);
  const timeoutMs = resolveTimeoutMs(opts?.timeoutMs);
  const closeTimeoutMs = resolveTimeoutMs(opts?.closeTimeoutMs ?? opts?.timeoutMs);
  const session = resolveMcpSessionConfig(opts, limits);
  const bindingPins = new Map<string, Promise<readonly string[]>>();

  // Step 1.11: MCP calls dispatch through the SAME shared engine as plugin
  // tools. The interceptor set is per channel and closes over the SAME
  // budget/cache/ledger objects the channel's plugin tools use, so budget (D1)
  // and read-only result caching (D2) apply to MCP without a second policy path.
  // `onResult` is deliberately omitted: MCP audit stays in `runMcpOperation`
  // (D5), and the pipeline's `onResult` sink is plugin-source-only.
  const channel = opts?.channel ?? "sync-stateless";
  const scopeHooks: Omit<ToolCallScope, "rawSettled" | "onBodySkipped"> = {
    ...(opts?.track === undefined ? {} : { track: opts.track }),
    ...(opts?.trackUntil === undefined ? {} : { trackUntil: opts.trackUntil }),
    ...(opts?.onToolStart === undefined ? {} : { onToolStart: opts.onToolStart }),
    ...(opts?.onToolEnd === undefined ? {} : { onToolEnd: opts.onToolEnd }),
  };
  const pipeline = channel === "job"
    ? createToolPipeline({
        interceptors: createJobToolInterceptors({
          ledger: requireJobLedger(opts),
          ...(opts?.budget === undefined ? {} : { budget: opts.budget }),
          ...(opts?.toolCache === undefined ? {} : { cache: opts.toolCache }),
          ...(opts?.assertActive === undefined ? {} : { assertActive: opts.assertActive }),
        }),
      })
    : createToolPipeline({
        interceptors: createSyncToolInterceptors({
          ...(opts?.budget === undefined ? {} : { budget: opts.budget }),
          ...(opts?.toolCache === undefined ? {} : { cache: opts.toolCache }),
        }),
      });
  // Plugin-wins tie-break (the deleted `mergePluginAndMcpTools`): the set starts
  // with the plugin tool names and grows as MCP tools are added, so an MCP
  // duplicate against either a plugin or an earlier MCP tool is skipped with the
  // same warning. The anonymous `actionId` sequence is per binding, exactly like
  // `bindTools`.
  const pluginToolNames = opts?.excludeToolNames;
  const boundToolNames = new Set<string>(pluginToolNames ?? []);
  const duplicateLogPrefix = opts?.duplicateLogPrefix ?? "[mcp]";
  let mcpAnonymousToolSequence = 0;

  for (const server of mcpServers) {
    if (opts?.signal?.aborted) break;
    const cache = getMcpToolListCache();
    const cacheKey = mcpToolListCacheKey(server);
    const runtimeKey = serverRuntimeKey(server);
    const scope = ownerScope(opts?.owner ?? `binding-${++mcpBindingSequence}`);
    const records = new Set<McpConnectionLease>();
    let current: McpConnectionLease | undefined;
    let disposed = false;

    const removeRecord = (lease: McpConnectionLease): void => {
      records.delete(lease);
      if (current === lease) current = undefined;
    };
    const closeLease = (lease: McpConnectionLease): Promise<void> => {
      removeRecord(lease);
      return closeMcpConnection(lease);
    };
    const closeAll = async (): Promise<void> => {
      const leases = [...records];
      records.clear();
      current = undefined;
      await Promise.allSettled(leases.map((lease) => closeMcpConnection(lease)));
    };
    let retainedPins: readonly string[] | undefined = server.pinnedIps === undefined || server.pinnedIps.length === 0
      ? undefined
      : [...server.pinnedIps];
    let retainedPinsPromise: Promise<readonly string[] | undefined> | undefined;
    const resolvePinsForBinding = async (): Promise<readonly string[] | undefined> => {
      if (retainedPins !== undefined) return retainedPins;
      const configuredPinOption = opts?.resolvePins ?? opts?.pinnedIps;
      if (configuredPinOption !== undefined) {
        let configuredPins: readonly string[] | undefined;
        if (typeof configuredPinOption === "function") {
          if (retainedPinsPromise === undefined) {
            const pending = Promise.resolve(configuredPinOption(server)).then((pins) => {
              if (pins === undefined || pins.length === 0) return undefined;
              const retained = [...pins];
              retainedPins = retained;
              return retained;
            });
            retainedPinsPromise = pending;
            void pending.catch(() => {
              if (retainedPinsPromise === pending) retainedPinsPromise = undefined;
            });
          }
          configuredPins = await retainedPinsPromise;
        } else if (configuredPinOption.length > 0) {
          configuredPins = [...configuredPinOption];
          retainedPins = configuredPins;
        }
        if (configuredPins !== undefined && configuredPins.length > 0) return configuredPins;
      }
      if (factory !== defaultSseClientFactory && opts?.lookup === undefined) {
        return undefined;
      }
      let pending = bindingPins.get(runtimeKey);
      if (pending === undefined) {
        pending = Promise.resolve().then(async () => {
          const parsed = validateStaticUrl(server.url, {
            trustedHosts: opts?.trustedHosts ?? env.MCP_TRUSTED_HOSTS,
            httpAllowedHosts: opts?.trustedHosts ?? env.MCP_TRUSTED_HOSTS,
            mode: opts?.mode,
          });
          const pins = await resolveAndValidateHost(normalizeHostname(parsed.hostname), {
            trustedHosts: opts?.trustedHosts ?? env.MCP_TRUSTED_HOSTS,
            lookup: opts?.lookup,
          });
          retainedPins = pins;
          return pins;
        });
        bindingPins.set(runtimeKey, pending);
        void pending.catch(() => {
          if (bindingPins.get(runtimeKey) === pending) bindingPins.delete(runtimeKey);
        });
      }
      return pending;
    };
    const getClient = async (): Promise<McpClientHandle> => {
      if (disposed) {
        throw new McpError(
          `MCP binding for '${redactForOutbound(server.name)}' already disposed`,
          "MCP_DISPOSED",
        );
      }
      const existing = current;
      if (existing?.record.clientPromise !== undefined) {
        const client = await existing.record.clientPromise;
        if (
          checkMcpSessionExpiry(existing.record) ||
          existing.record.evictionStarted ||
          existing.record.closePromise !== undefined
        ) {
          throw mcpClosedError(existing.record);
        }
        return { client, record: existing.record };
      }
      const runtime = getRuntime(runtimeKey, limits.now());
      const lease = reserveMcpConnection(
        runtime,
        scope,
        limits,
        closeTimeoutMs,
        session,
        server,
        opts?.owner,
        opts?.requestId,
      );
      records.add(lease);
      current = lease;
      lease.record.onClosed = () => removeRecord(lease);

      const factorySignal = opts?.signal
        ? AbortSignal.any([opts.signal, lease.record.sessionAbortController.signal])
        : lease.record.sessionAbortController.signal;
      const rawFactoryPromise = Promise.resolve().then(async () => {
        const pinnedIps = await resolvePinsForBinding();
        return factory(server, {
          trustedHosts: opts?.trustedHosts ?? env.MCP_TRUSTED_HOSTS,
          lookup: opts?.lookup,
          mode: opts?.mode,
          signal: factorySignal,
          pinnedIps,
        });
      });
      lease.record.rawFactoryPromise = rawFactoryPromise;
      void rawFactoryPromise.then(
        (client) => {
          lease.record.rawFactorySettled = true;
          lease.record.rawClient = client;
          if (lease.record.closePromise === undefined) {
            startMcpSession(lease.record);
          } else {
            void closeMcpClientOnce(lease.record, client);
          }
        },
        () => {
          lease.record.rawFactorySettled = true;
        },
      );
      const clientPromise = withMcpTimeout(
        rawFactoryPromise,
        timeoutMs,
        "connect",
        server.name,
      );
       lease.record.clientPromise = clientPromise;
       void clientPromise.then(
         () => {
           emitMcpConnectAudit(lease.record, "ok");
         },
         (error: unknown) => {
           const failure = classifyMcpFailure(error, factorySignal);
           emitMcpConnectAudit(lease.record, failure.outcome, failure.errorCode);
           removeRecord(lease);
           void closeMcpConnection(lease);
         },
       );
      return clientPromise.then((client) => ({ client, record: lease.record }));
    };
    const invalidateCurrent = (): void => {
      if (current) void closeLease(current);
    };
    const dispose = (): Promise<void> => {
      disposed = true;
      return closeAll();
    };

    try {
      let listed = cache.get(cacheKey);
       if (listed !== undefined) {
         assertMcpToolList(listed, boundaryLimits);
         emitMcpAudit({
           event: "mcp.list",
           kind: "mcp",
           outcome: "ok",
           owner: opts?.owner,
           server: server.name,
           requestId: opts?.requestId,
           cacheHit: true,
           outputBytes: listResultBytes(listed),
           ownerBound: opts?.owner !== undefined,
           circuitState: getMcpCircuitState(server).state,
         });
       }
      if (listed === undefined) {
        const result = await runMcpOperation({
           server,
           owner: opts?.owner,
           ownerKey: scope,
           requestId: opts?.requestId,
           // Attribution only; the outbound list call is cancelled by the same
           // channel signal passed to `runMcpClientOperation` below.
           attributionSignal: opts?.signal,

          event: "mcp.list",
          cacheHit: false,
           inputBytes: 0,
           limits,

           run: async () => {
             const handle = await getClient();
             const result = await runMcpClientOperation(
               handle,
               opts?.signal,
               () => withMcpTimeout(
                 () => handle.client.listTools(),
                 timeoutMs,
                 "list",
                 server.name,
               ),
             );
             assertMcpToolList(result.tools, boundaryLimits);
             return result;

           },
          onFailure: invalidateCurrent,
           outputBytes: listResultBytes,

         });
         assertMcpToolList(result.tools, boundaryLimits);
         listed = result.tools;
         cache.set(cacheKey, listed);

      }
      const resolvedFingerprint = mcpResolvedCredentialFingerprint(server);
      for (const tool of listed) {
        if (!tool.name) continue;
        const safe = isMcpToolSafeToRepeat(tool);
        toolSafety.set(tool.name, (toolSafety.get(tool.name) ?? true) && safe);
        // Plugin-wins tie-break, exactly as the deleted `mergePluginAndMcpTools`:
        // the first occurrence wins and an MCP duplicate (against a plugin or an
        // earlier MCP tool) is skipped with the same warning.
        if (boundToolNames.has(tool.name)) {
          // Finding m4: name the actual owners. A duplicate is either against a
          // plugin tool (the seeded set) or against an earlier MCP server.
          const owner =
            pluginToolNames?.has(tool.name) === true
              ? "both a plugin and an MCP server"
              : "multiple MCP servers";
          console.warn(
            `${duplicateLogPrefix} tool '${tool.name}' defined by ${owner}; skipping MCP version`,
          );
          continue;
        }
        boundToolNames.add(tool.name);
        const schema = tool.inputSchema
          ? jsonSchemaToZod(tool.inputSchema as JsonSchema)
          : z.object({});

        tools.push(
          createBoundTool({
            pipeline,
            name: tool.name,
            description: tool.description ?? "",
            schema,
            actionIdPrefix: `mcp:${server.name}:${tool.name}`,
            bindingSignal: opts?.signal,
            nextAnonymousToolSequence: () => ++mcpAnonymousToolSequence,
            prepare: (ctx) => {
              // Sync account-deletion tombstone, mirroring the plugin channel's
              // `buildCall` pre-check (the job channel's fence interceptor owns
              // this instead). Runs before `serialize`/`cache` via `dispatch`.
              if (channel !== "job") opts?.assertActive?.();
              const { bodies, scope: bodyScope } = makeToolBodies({
                source: "mcp",
                channelLabel: "mcp",
                scope: scopeHooks,
                invoke: (bodySignal, dispatch) =>
                  runMcpOperation({
                    server,
                    owner: opts?.owner,
                    ownerKey: scope,
                    requestId: opts?.requestId,
                    // Finding M1: attribute the failure with the CHANNEL signal
                    // (`call.signal`), NOT the pipeline-composed `bodySignal`,
                    // which the `execution` interceptor aborts on timeout. The
                    // composed signal still reaches the outbound call below so a
                    // timeout/cancel genuinely aborts it (contract 3, N1).
                    attributionSignal: dispatch.call.signal,
                    event: "mcp.tool",
                    tool: tool.name,
                    // Finding m1: this audit describes the TOOL call, not the
                    // tool-LIST cache. The list cache already emits its own
                    // `mcp.list` audit; claiming the list hit here would falsely
                    // report a result-cache hit on every warm-bind invocation.
                    cacheHit: false,
                    inputBytes: dispatch.inputBytes,
                    limits,
                    run: async () => {
                      const handle = await getClient();
                      try {
                        const raw = await runMcpClientOperation(
                          handle,
                          bodySignal,
                          () => withMcpTimeout(
                            () => handle.client.callTool({ name: tool.name, arguments: ctx.args }),
                            timeoutMs,
                            "invoke",
                            server.name,
                          ),
                        );
                        return boundMcpCallResult(raw, boundaryLimits);
                      } catch (error) {
                        // The pipeline's `execution` bound shares `timeoutMs`
                        // with MCP's own `withMcpTimeout` and schedules its timer
                        // first, so a timeout surfaces here as the bare
                        // `AbortError` from `runMcpClientOperation`. Attribute it
                        // as MCP's own timeout so `classifyMcpFailure` (reading
                        // the non-aborted channel signal) counts it toward the
                        // circuit instead of recording a cancellation (M1).
                        if (
                          error instanceof Error &&
                          error.name === "AbortError" &&
                          isToolTimeoutAbort(bodySignal)
                        ) {
                          throw new McpError(
                            `MCP invoke to '${redactForOutbound(server.name)}' timed out after ${timeoutMs}ms`,
                            "MCP_TIMEOUT",
                          );
                        }
                        throw error;
                      }
                    },
                    onFailure: invalidateCurrent,
                    outputBytes: callResultBytes,
                  }).then((result) => {
                    // Post-execution tombstone re-check: do not cache a result
                    // produced after the owner began deleting (mirrors plugin sync).
                    if (channel !== "job") opts?.assertActive?.();
                    const content = result.content ?? [];
                    return content.map((item) => item.text ?? "").join("\n");
                  }),
              });
              const call: ToolCall = {
                source: "mcp",
                pluginId: `mcp:${server.name}`,
                // The tool-list cache identity: URL + (unresolved) header
                // fingerprint. The result-cache key's credential component is the
                // RESOLVED-header fingerprint below (D2), so a rotated
                // `${MCP_TOKEN}` cannot serve a stale entry even though this
                // component stays stable.
                pluginVersion: cacheKey,
                tool: tool.name,
                args: ctx.args,
                // Finding M5: conservative AND-merge across ALL servers, read at
                // invocation time. `safe` is the FIRST occurrence's value, but a
                // later server (whose duplicate tool is skipped) may declare the
                // same name destructive; `toolSafety` holds the AND of every
                // occurrence, so a name any server declares non-repeatable is
                // never treated as read-only (and therefore never cached or
                // job-replayed).
                readOnly: toolSafety.get(tool.name) ?? safe,
                ...(opts?.owner === undefined ? {} : { owner: opts.owner }),
                ...(opts?.requestId === undefined ? {} : { requestId: opts.requestId }),
                ...(resolvedFingerprint === undefined
                  ? {}
                  : { credentialFingerprint: resolvedFingerprint }),
                ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
                channel,
                ...(ctx.toolCallId === undefined ? {} : { toolCallId: ctx.toolCallId }),
                actionId: ctx.actionId,
                // Requirement 7: the pipeline's execution bound agrees exactly
                // with MCP's own `withMcpTimeout` transport guard.
                timeoutMs,
                maxResultChars: DEFAULT_TOOL_RESULT_MAX_CHARS,
                ...(channel === "job"
                  ? {
                      ...(opts?.taskId === undefined ? {} : { taskId: opts.taskId }),
                      ...(opts?.fenceToken === undefined ? {} : { fenceToken: opts.fenceToken }),
                      ...(opts?.allowMutatingRetry === undefined
                        ? {}
                        : { allowMutatingRetry: opts.allowMutatingRetry }),
                    }
                  : {}),
              };
              return { call, bodies, scope: bodyScope };
            },
          }),
        );
      }
      disposers.push(dispose);
    } catch (err) {
      await closeAll();
      if (
        err instanceof McpResourceError ||
        (err instanceof McpError && err.code === MCP_RESOURCE_LIMIT_CODES.runtime)
      ) {
        throw err;
      }
      const code = errorCode(err);
      logger.warn(
        `[mcp] failed to bind tools from server '${redactForOutbound(server.name)}' (${code})`,
      );
    }
  }

  let disposePromise: Promise<void> | undefined;
  const disposeBinding = (): Promise<void> => {
    disposePromise ??= Promise.allSettled(
      disposers.map((disposeServer) => Promise.resolve().then(disposeServer)),
    ).then(() => undefined);
    return disposePromise;
  };
  return {
    tools,
    dispose: disposeBinding,
  };
}
