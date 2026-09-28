import {
  AIMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { createAgentGraph } from "../agents/graph.ts";
import {
  bindMcpServers,
  type McpBinding,
  type McpClientFactory,
  type McpServerConfig,
} from "../agents/mcp.ts";
import { createTrackedExecution, trackModelExecution } from "../agents/execution.ts";
import type { TrackedExecution } from "../agents/execution.ts";
import { jsonSchemaToZod, mergePluginAndMcpTools } from "../agents/orchestrator.ts";
import type { ToolCallHandler } from "../agents/orchestrator.ts";
import {
  lastUserTextFromMessages,
  tryReportSentinelShadow,
} from "../sentinel/shadow.ts";
import type { SentinelShadowSink } from "../sentinel/shadow.ts";
import { redactForOutbound, redactMessages } from "../redact.ts";
import { AccountDeletedError, isDeleting } from "../account_deletion.ts";
import { env } from "../env.ts";
import {
  getOrCreateTask,
  hasToolResult,
  recordToolResult,
} from "../credentials/idempotency.ts";
import { CredentialPinError } from "../credentials/pins.ts";
import type { CredentialPin, CredentialPinHandle, CredentialPinStore } from "../credentials/pins.ts";
import { credentialFingerprint } from "../plugins/credential.ts";
import type { ToolResultCache } from "../middleware/cache.ts";
import type { BudgetManager } from "../middleware/budget.ts";
import { BudgetExhaustedError } from "../middleware/budget.ts";
import { createToolPipeline } from "../tools/pipeline.ts";
import type {
  ToolBody,
  ToolCall,
  ToolCallScope,
  ToolPipeline,
} from "../tools/pipeline.ts";
import { createJobToolInterceptors } from "../tools/interceptors/order.ts";
import { createPluginAuditSink } from "../tools/audit.ts";
import { ContextBudgetError } from "../middleware/context.ts";
import { JobError } from "./errors.ts";
import type { JobErrorCode } from "./errors.ts";
import { LedgerError, projectTaskProgress } from "../ledger.ts";
import type {
  Ledger,
  TaskEffectState,
  TaskLiveProjection,
  TaskProgress,
  TaskRow,
  TaskStatus,
} from "../ledger.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { isMcpHeaderReference, isToolPlugin } from "../plugins/types.ts";
import type { ToolDefinition, ToolPluginDefinition } from "../plugins/types.ts";
import {
  createEgressPolicy,
  policyFetch,
  SsrfValidationError,
  validateMcpHeaderName,
} from "../plugins/ssrf.ts";
import type { Mode } from "../plugins/ssrf.ts";
import {
  boundToolResult,
  DEFAULT_TOOL_RESPONSE_MAX_BYTES,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  serializeBoundedToolArguments,
  readBoundedResponseText,
  ToolResourceError,
} from "../tool_bounds.ts";

/**
 * Async job runner (stateless-gateway, step 8 — Phase C part 2 rewrite).
 *
 * Background jobs run on a SELF-CONTAINED message snapshot (`input`), compiled
 * WITHOUT a checkpointer: no checkpoint thread, no `ThreadLockRegistry`, no
 * optimistic locking, no post-stream compaction. The ledger is a transient
 * job journal (status/lease/fence + in-flight tool-result replay).
 *
 * FLOW (`runJob`):
 *
 *   1. `getOrCreateTask(ledger, { owner, intentKey, spec, payload })` —
 *      owner-scoped idempotent admission. `payload` is the JSON-encoded
 *      snapshot messages (ledger v5) — the ONLY durable place a snapshot can
 *      live now that the checkpointer is gone, so `resumeStuckJobs` can re-run
 *      from it after a crash. A repeat (owner, intentKey) returns the EXISTING
 *      task instead of creating a duplicate row (a task admitted by a caller
 *      that stored no payload is backfilled after the claim).
 *   2. Already `running` → if the heartbeat is STALE (`markStuckIfHeartbeatStale`)
 *      the crashed worker is marked `stuck` and this call becomes the resume;
 *      otherwise return early as `in_flight` (never double-execute). Any other
 *      non-queued/non-stuck status → return early as `already_terminal`.
 *   3. `claimTask` (queued) or `resumeTask` (stuck — a replay) → the fence token.
 *      A concurrent claim that wins between admission and claim surfaces as
 *      `in_flight`.
 *   4. `ledger.startHeartbeat(taskId, owner, fenceToken, ...)` — INSIDE the try,
 *      so a misconfigured interval fails the job cleanly. Runs for the whole job
 *      (pin fetch → graph invoke → tool execution), stopped in a finally.
 *   5. Fetch a credential pin per plugin (`CredentialPinStore.get(owner,
 *      pluginId)`). A `credentials_expired` pin fails the job with a
 *      `credentials_expired` step — no graph invoke happens.
 *   6. Build the agent (`createAgentGraph`, NO checkpointer) with a REAL
 *      `ToolCallHandler`: the {@link ToolExecutor} (policyFetch + pinned IPs
 *      + credentials + trusted hosts) wrapped with tool-call replay dedupe
 *      (`hasToolResult`/`recordToolResult`, `tool_retry_forbidden` for mutating
 *      tools that cannot be proven never-run when the task is a replay).
 *   7. `graph.invoke(descriptor.input, { signal })` — the snapshot IS the
 *      input; there is no `getState` resume branch.
 *   8. On success: `completeTask(..., "succeeded")` + the notification hook.
 *      On error: fail the task with a redacted error step. Pins are released
 *      and swept, and the heartbeat is stopped in the finally.
 *
 * RESTART-LOSS (`resumeStuckJobs`): `ledger.reconcileOrphans()` (ledger.routes.ts)
 * runs at boot and marks orphaned `running` tasks `stuck`. The pin store is
 * in-memory, so after a restart the pins are GONE. This best-effort startup
 * pass tries to re-establish them via the optional `credentialSource` seam;
 * when pins cannot be re-established (the honest story — an orphaned job can't
 * resume without the user's key), the task is failed cleanly with
 * `credentials_expired` and the notification hook fires. When pins ARE
 * restored and a `buildModel` seam is wired, the task is re-run through the
 * full `runJob` path FROM THE STORED SNAPSHOT (`task.payload` → messages) as a
 * replay (H3) — never `graph.getState` on a checkpointer-free graph. A task
 * with no stored payload (admitted before v5 / by a route) is failed cleanly
 * rather than fabricating input. Without a model seam the task is failed
 * `plugin_unavailable` (there is no checkpoint scheduler pass anymore).
 */

// Job error primitives live in a leaf module so the tool-pipeline interceptors
// can import them without importing this file (which would close the
// `runner → pipeline → interceptors → runner` cycle in Phase 1.9). Re-exported
// here so every existing importer is unaffected.
export { JobError } from "./errors.ts";
export type { JobErrorCode } from "./errors.ts";

export const TASK_CANCEL_SCHEMA_VERSION = 1 as const;
const TASK_CANCEL_COMPLETED_ACTIONS_LIMIT = 64;

export type TaskCancelStage =
  | "cancelling"
  | "cancelled"
  | "already-terminal"
  | "not-cancellable";

export type TaskCancelReachedStage =
  | "queued"
  | "admitted"
  | "running"
  | "already-terminal"
  | "stuck";

export type TaskActionSummary = {
  id: string;
  stage: string;
  action: string;
  toolCallId?: string;
  completed: true;
};

export type TaskCancelReport = {
  schemaVersion: typeof TASK_CANCEL_SCHEMA_VERSION;
  taskId: string;
  stage: TaskCancelStage;
  reachedStage: TaskCancelReachedStage;
  taskStatus: TaskStatus;
  cancellable: boolean;
  terminalStatus?: Extract<
    TaskStatus,
    "succeeded" | "failed" | "cancelled" | "awaiting_review"
  >;
  effectState: TaskEffectState;
  completedActions: TaskActionSummary[];
  projection: TaskProgress;
};

class JobCancelledError extends Error {
  constructor(taskId: string) {
    super(`background task ${taskId} cancellation requested`);
    this.name = "JobCancelledError";
  }
}

/** A pre-validated, IP-pinned allowlist entry for a plugin (store.ts shape). */
export type PinnedUrlEntry = { entryId: string; url: string; pinned: string[] };

/** Resolves the concrete URL for a tool call from the plugin's pinned entries. */
export type ToolEndpointResolver = (
  pluginId: string,
  toolName: string,
  args: Record<string, unknown>,
  pinned: PinnedUrlEntry[],
) => string | Promise<string>;

/**
 * The sanctioned outbound-call convention for Wave C1: the FIRST allowlisted
 * base URL + `/<toolName>`. Phase 3/5 refines per-plugin endpoint routing.
 */
const DEFAULT_ENDPOINT_RESOLVER: ToolEndpointResolver = (
  _pluginId,
  toolName,
  _args,
  pinned,
) => {
  const entry = pinned[0];
  if (!entry) {
    throw new JobError(
      "plugin_unavailable",
      `no pinned allowlist entry to resolve a tool endpoint for '${toolName}'`,
    );
  }
  const base = entry.url.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(toolName)}`;
};

function buildAuthHeader(
  credentials?: Record<string, unknown>,
): Record<string, string> {
  if (!credentials) return {};
  const apiKey = credentials["apiKey"];
  if (typeof apiKey === "string" && apiKey.length > 0) {
    return { authorization: `Bearer ${apiKey}` };
  }
  return {};
}

export type ToolExecutorOptions = {
  /** Plugin registry — resolves the installed plugin definition for a tool. */
  registry: PluginRegistry;
  /** SSRF-validated pins per plugin (from `PluginStore.getPinnedIps`). */
  getPinnedIps: (pluginId: string) => PinnedUrlEntry[] | undefined;
  /** Endpoint resolution; defaults to first pinned base URL + `/<toolName>`. */
  resolveEndpoint?: ToolEndpointResolver;
  /** Injectable fetch for `policyFetch` (tests stub this; never the network). */
  fetchFn?: typeof fetch;
  /** Scheme enforcement mode override for `policyFetch`. */
  mode?: Mode;
  /**
   * Admin-trusted hostnames/IPs used to validate the retained store pins and
   * construct the per-call egress policy.
   */
  trustedHosts?: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxResultChars?: number;
};

function toolEndpointPath(baseUrl: string, toolName: string): string {
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  return `${basePath || ""}/${encodeURIComponent(toolName)}`;
}

function toolEgressPolicy(
  registry: PluginRegistry,
  pluginId: string,
  toolName: string,
  pinned: readonly PinnedUrlEntry[],
  trustedHosts: readonly string[] | undefined,
  mode: Mode | undefined,
) {
  let plugin;
  try {
    plugin = registry.requirePlugin(pluginId);
  } catch {
    throw new SsrfValidationError(
      "EGRESS_DENIED",
      `tool plugin '${pluginId}' is not available for an egress-authorized call`,
    );
  }
  if (!isToolPlugin(plugin) || !plugin.tools.some((tool) => tool.name === toolName)) {
    throw new SsrfValidationError(
      "EGRESS_DENIED",
      `tool '${toolName}' is not declared by installed plugin '${pluginId}'`,
    );
  }
  return createEgressPolicy({
    subject: `tool:${pluginId}`,
    destinations: pinned.map((entry) => ({
      baseUrl: entry.url,
      pinnedIps: entry.pinned,
      methods: ["POST"],
      exactPaths: [toolEndpointPath(entry.url, toolName)],
    })),
    trustedHosts,
    mode,
  });
}

/**
 * The REAL `ToolCallHandler` (exported separately so tests can exercise it
 * without the full runner). For every call it:
 *
 *   - resolves the plugin's pinned IPs (`getPinnedIps`) — a plugin with no
 *     pins is `plugin_unavailable` (the pins are the SSRF-validated resolve
 *     result; a job must never ad-hoc resolve a plugin URL),
 *   - calls `policyFetch` — the ONLY sanctioned outbound path — against the
 *     allowlisted URL with the pinned credentials (bearer header),
 *   - refuses any 3xx (policyFetch does this; redirects are never followed),
 *   - redacts the result with `redactForOutbound` before it is returned so
 *     credential-shaped material never reaches graph state.
 *
 * Credentials arrive as a single-invocation COPY per call — the executor holds
 * no handle to the pin store (the threat model in pins.ts).
 */
export class ToolExecutor implements ToolCallHandler {
  constructor(private readonly opts: ToolExecutorOptions) {}

  async execute(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>,
    credentials?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const serializedArgs = serializeBoundedToolArguments(args);
    const pinned = this.opts.getPinnedIps(pluginId);
    if (!pinned || pinned.length === 0) {
      throw new JobError(
        "plugin_unavailable",
        `plugin '${pluginId}' has no SSRF-validated pinned IPs; reload the ` +
          "plugin store or reinstall the plugin before running background jobs",
      );
    }
    const policy = toolEgressPolicy(
      this.opts.registry,
      pluginId,
      toolName,
      pinned,
      this.opts.trustedHosts,
      this.opts.mode,
    );
    const resolveEndpoint =
      this.opts.resolveEndpoint ?? DEFAULT_ENDPOINT_RESOLVER;
    const url = await resolveEndpoint(pluginId, toolName, args, pinned);
    signal?.throwIfAborted();
    const timeoutMs = this.opts.timeoutMs ?? env.TOOL_CALL_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer");
    }
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => {
      timeoutController.abort(new DOMException("tool call timed out", "TimeoutError"));
    }, timeoutMs);
    const timeoutSignal = timeoutController.signal;
    const callSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    try {
      const response = await policyFetch(
        url,
        {
          method: "POST",
          signal: callSignal,
          headers: {
            "content-type": "application/json",
            ...buildAuthHeader(credentials),
          },
          body: serializedArgs,
        },
        {
          policy,
          fetchFn: this.opts.fetchFn,
        },
      );
      callSignal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new JobError(
          "job_failed",
          `tool '${toolName}' of plugin '${pluginId}' failed with HTTP ${response.status}`,
        );
      }
      const text = await readBoundedResponseText(
        response,
        this.opts.maxResponseBytes ?? DEFAULT_TOOL_RESPONSE_MAX_BYTES,
        callSignal,
      );
      return boundToolResult(
        text,
        this.opts.maxResultChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
      );
    } catch (error) {
      if (!signal?.aborted && timeoutSignal.aborted) {
        throw new ToolResourceError(
          "tool_timeout",
          `tool '${toolName}' of plugin '${pluginId}' exceeded ${timeoutMs}ms`,
          timeoutMs,
          "milliseconds",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }
}

/** Notification seam (Phase 5 wires the real ntfy push; no-op for now). */
export interface NotificationHook {
  notifyJobComplete(owner: string, taskId: string, summary: string): void | Promise<void>;
}

/** Default: no-op. The real ntfy target resolution lands in Phase 5/6. */
export const noopNotificationHook: NotificationHook = {
  notifyJobComplete() {},
};

export type JobInput = Record<string, unknown> | null;

export type JobToolHandler = {
  execute(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>,
    credentials?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>;
};

export type JobDescriptor = {
  pinHandles?: Readonly<Record<string, CredentialPinHandle>>;
  signal?: AbortSignal;
  /** API-key referenceId; every ledger/pin operation is owner-scoped. */
  owner: string;
  /** Client idempotency key (messageId) — maps to exactly ONE task. */
  intentKey: string;
  requestId?: string;
  shadowRequestId?: string;
  /** Short, non-sensitive job label (ledger `spec`; notify title). */
  spec: string;
  /**
   * RAW client conversation thread id (worker label). Stored in the ledger's
   * `worker` column at admission so a restart-loss replay resumes on the same
   * label; there is no checkpoint thread to hash it into anymore.
   */
  clientThreadId: string;
  /** Tool plugins this job may call; each must have a credential pin. */
  toolPlugins: string[];
  /** Model plugin id — forwarded to the `buildModel` seam. */
  modelPluginId: string;
  /** Provider request config forwarded to `buildModel`. */
  modelRequestConfig?: unknown;
  /** Agent system prompt override (Wave 1, Step 4). */
  systemPrompt?: string;
  /** Override the real executor (tests use a recording fake). */
  toolHandler?: JobToolHandler;
  /**
   * The job's SNAPSHOT input (`{ messages: [...] }`) built by the transport
   * from the request body. REQUIRED — the job runs on this snapshot, never a
   * live session/checkpoint, and it is persisted as the ledger payload for
   * crash-resume. A null input fails the job.
   */
  input: JobInput;
  /** MCP server configurations bound alongside plugin tools (agent override). */
  mcpServers?: McpServerConfig[];
};

export const JOB_SPEC_SCHEMA_VERSION = 1 as const;

export type PersistedJobSpec = {
  schemaVersion: typeof JOB_SPEC_SCHEMA_VERSION;
  clientThreadId: string;
  toolPlugins: string[];
  modelPluginId: string;
  modelRequestConfig?: unknown;
  systemPrompt?: string;
  mcpServers?: {
    name: string;
    url: string;
    id?: string;
    pinnedIps?: readonly string[];
    headers?: Record<string, string>;
  }[];
};

export function serializeJobSpec(
  descriptor: Pick<
    JobDescriptor,
    "clientThreadId" | "toolPlugins" | "modelPluginId" | "modelRequestConfig" | "systemPrompt" | "mcpServers"
  >,
): string {
  const mcpServers = descriptor.mcpServers?.map((server) => {
    const headerRefs: Record<string, string> = { ...(server.headerRefs ?? {}) };
    let unresolvedHeaders = false;
    for (const [name, value] of Object.entries(server.headers ?? {})) {
      if (isMcpHeaderReference(value)) {
        headerRefs[name] ??= value;
      } else if (headerRefs[name] === undefined) {
        unresolvedHeaders = true;
      }
    }
     return {
       name: server.name,
       url: server.url,
       ...(server.id === undefined ? {} : { id: server.id }),
       ...(server.pinnedIps === undefined ? {} : { pinnedIps: [...server.pinnedIps] }),
       ...(Object.keys(headerRefs).length > 0 ? { headerRefs } : {}),
      ...(unresolvedHeaders ? { unresolvedHeaders: true } : {}),
    };
  });
  return JSON.stringify({
    schemaVersion: JOB_SPEC_SCHEMA_VERSION,
    clientThreadId: descriptor.clientThreadId,
    toolPlugins: [...descriptor.toolPlugins],
    modelPluginId: descriptor.modelPluginId,
    ...(descriptor.modelRequestConfig === undefined
      ? {}
      : { modelRequestConfig: descriptor.modelRequestConfig }),
    ...(descriptor.systemPrompt === undefined
      ? {}
      : { systemPrompt: descriptor.systemPrompt }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });
}

export function parsePersistedJobSpec(
  value: string | null | undefined,
): PersistedJobSpec | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== JOB_SPEC_SCHEMA_VERSION) return null;
  if (typeof record.clientThreadId !== "string" || record.clientThreadId === "") return null;
  if (!Array.isArray(record.toolPlugins) || record.toolPlugins.some((id) => typeof id !== "string")) {
    return null;
  }
  if (typeof record.modelPluginId !== "string" || record.modelPluginId === "") return null;
  if (
    record.systemPrompt !== undefined &&
    typeof record.systemPrompt !== "string"
  ) return null;
  const mcpServers: PersistedJobSpec["mcpServers"] = [];
  if (record.mcpServers !== undefined) {
    if (!Array.isArray(record.mcpServers)) return null;
    for (const item of record.mcpServers) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
      const server = item as Record<string, unknown>;
       if (server.unresolvedHeaders === true) return null;
       if (typeof server.name !== "string" || typeof server.url !== "string") return null;
       if (server.id !== undefined && (typeof server.id !== "string" || server.id.trim() === "")) {
         return null;
       }
       let pinnedIps: string[] | undefined;
       if (server.pinnedIps !== undefined) {
         if (
           !Array.isArray(server.pinnedIps) ||
           server.pinnedIps.length === 0 ||
           server.pinnedIps.length > 32 ||
           server.pinnedIps.some(
             (pin) => typeof pin !== "string" || pin.length === 0 || pin.length > 64 || /[\r\n\u0000]/.test(pin),
           )
         ) return null;
         pinnedIps = [...server.pinnedIps] as string[];
       }
       const headers: Record<string, string> = {};
      if (server.headerRefs !== undefined) {
        if (typeof server.headerRefs !== "object" || server.headerRefs === null || Array.isArray(server.headerRefs)) {
          return null;
        }
        for (const [name, reference] of Object.entries(server.headerRefs)) {
          try {
            validateMcpHeaderName(name);
          } catch {
            return null;
          }
          if (typeof reference !== "string" || !isMcpHeaderReference(reference)) return null;
          const variable = reference.slice(2, -1);
          const resolved = process.env[variable];
          if (resolved === undefined || /[\r\n\u0000-\u001f]/.test(resolved)) return null;
          headers[name] = resolved;
        }
      }
       mcpServers.push({
         name: server.name,
         url: server.url,
         ...(server.id === undefined ? {} : { id: server.id as string }),
         ...(pinnedIps === undefined ? {} : { pinnedIps }),
         ...(Object.keys(headers).length > 0 ? { headers } : {}),
       });
    }
  }
  return {
    schemaVersion: JOB_SPEC_SCHEMA_VERSION,
    clientThreadId: record.clientThreadId,
    toolPlugins: record.toolPlugins as string[],
    modelPluginId: record.modelPluginId,
    ...(record.modelRequestConfig === undefined
      ? {}
      : { modelRequestConfig: record.modelRequestConfig }),
    ...(record.systemPrompt === undefined
      ? {}
      : { systemPrompt: record.systemPrompt }),
    ...(record.mcpServers === undefined ? {} : { mcpServers }),
  };
}

export function serializeJobPayload(input: JobInput): string | null {
  if (input == null) return null;
  return JSON.stringify(
    mapChatMessagesToStoredMessages(
      redactMessages((input as { messages?: BaseMessage[] }).messages ?? []),
    ),
  );
}

export type RunJobResult =
  | { status: "succeeded"; taskId: string; threadId: string }
  | { status: "failed"; taskId: string; threadId: string; code: JobErrorCode; error: string }
  | { status: "cancelled"; taskId: string; threadId: string }
  | { status: "in_flight"; taskId: string; threadId: string }
  | { status: "already_terminal"; taskId: string; threadId: string; terminalStatus: TaskStatus }
  | { status: "account_deleted"; taskId?: string; threadId: string; error: string };

function accountDeletedResult(
  threadId: string,
  taskId?: string,
): Extract<RunJobResult, { status: "account_deleted" }> {
  return taskId === undefined
    ? { status: "account_deleted", threadId, error: "account_deleted" }
    : { status: "account_deleted", taskId, threadId, error: "account_deleted" };
}

export type StuckTaskOutcome = {
  taskId: string;
  owner: string;
  outcome: "credentials_expired" | "repinned" | "cancelled" | JobErrorCode;
};

export type ResumeStuckJobsResult = {
  processed: number;
  outcomes: StuckTaskOutcome[];
};

/**
 * Wave C1 re-pin seam. After a restart the in-memory pin store is empty; the
 * honest restart-loss story is that an orphaned job CANNOT resume without the
 * user's key, so it fails `credentials_expired` and the user is notified. Phase
 * 5 supplies a real credential source that resolves keys by owner + task; until
 * then this is absent and every stuck task fails cleanly.
 */
export type CredentialSource = (
  owner: string,
  task: TaskRow,
) =>
  | Promise<Record<string, Record<string, string>> | null>
  | Record<string, Record<string, string>>
  | null;

export type JobRunnerDeps = {
  ledger: Ledger;
  shadowReporter?: SentinelShadowSink;
  registry: PluginRegistry;
  /** In-memory credential pin store. */
  pins: CredentialPinStore;
  /** SSRF-validated pins per plugin (defaults to a no-pins resolver). */
  getPinnedIps?: (pluginId: string) => PinnedUrlEntry[] | undefined;
  mcpClientFactory?: McpClientFactory;
  notification?: NotificationHook;
  /** Model factory seam (the transport provides it; absent → plugin_unavailable). */
  buildModel?: (
    modelPluginId: string,
    requestConfig: unknown,
    context: {
      credentials?: Record<string, string>;
      signal: AbortSignal;
      assertActive: () => void;
    },
  ) => Promise<BaseChatModel> | BaseChatModel;
  /** Restart-loss re-pin seam (Phase 5 credential vault). */
  credentialSource?: CredentialSource;
  /** Override the real ToolExecutor (tests inject a real one with a stubbed fetch). */
  executor?: ToolExecutor;
  /**
    * Admin-trusted hosts forwarded into the default executor's `policyFetch`
   * (see `ToolExecutorOptions.trustedHosts`). Wire the plugin store's
   * trusted-host list (env `PLUGINS_TRUSTED_HOSTS`) so admin-trusted internal
   * plugin backends are not rejected at call time.
   */
  trustedHosts?: readonly string[];
  /** Explicit heartbeat interval; defaults to the ledger's floor(stuck/3). */
  heartbeatIntervalMs?: number;
  /** Optional periodic pin GC. `dispose()` stops it. */
  sweepIntervalMs?: number;
  /** Shared in-memory tool-result cache (Phase 4, Wave B). Wraps the async
   * tool handler so a repeated READ-ONLY tool call — same (owner, pluginId,
   * pluginVersion, credentialFingerprint, tool, argsHash) — is served without
   * re-executing the backend, even across different tasks/jobs. Mutating
   * tools are never cached; the per-task ledger replay dedupe ALWAYS wins over
   * this cache. Construct ONE instance in index.ts and share it with the sync
   * transport.
   */
  toolCache?: ToolResultCache;
  /**
   * Budget manager (Phase 4, Wave A). When supplied, every model dispatch
   * (after fence/pin checks) consumes one `beforeModelCall(owner, "async")`
   * slot; an exhausted window fails the job `budget_exhausted`. Absent →
   * no per-owner model-call budget.
   */
  budget?: BudgetManager;
  toolHandlerTimeoutMs?: number;
  maxToolResultChars?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

type ActiveJob = {
  taskId: string;
  owner: string;
  threadId: string;
  fenceToken: string;
  controller: AbortController;
  stage: "admitted" | "running";
  activeToolCallIds: Set<string>;
  cancelRequested: boolean;
  cancelFromStage?: "admitted" | "running";
};

function isConflict(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: string }).code === "INVALID_TRANSITION"
  );
}

export type BindJobToolsOptions = {
  registry: PluginRegistry;
  handler: JobToolHandler;
  credentialsByPlugin: Record<string, Record<string, string>>;
  getCredentials?: (pluginId: string) => CredentialPin;
  assertActive?: () => void;
  signal?: AbortSignal;
  ledger: Ledger;
  taskId: string;
  owner: string;
  fenceToken: string;
  /** True for a fresh run; false in a replay/resume context where a mutating
   *  tool with no stored result must NOT be re-executed. */
  allowMutatingRetry: boolean;
  requestId?: string;
  handlerTimeoutMs?: number;
  maxResultChars?: number;
  /**
   * Optional in-memory tool-result cache (Phase 4, Wave B): a READ-ONLY tool
   * call that missed the ledger replay dedupe is served from here when
   * (owner, pluginId, pluginVersion, credentialFingerprint, tool, argsHash)
   * match, without re-executing the backend. Mutating tools are never cached,
   * and the ledger dedupe (`hasToolResult`) above always wins. The cache
   * stores raw handler output; hits are redacted at serve time.
   */
  toolCache?: ToolResultCache;
  /**
   * Precomputed credential fingerprint per plugin (the pinned
   * `CredentialPin.fingerprint` when available). Falls back to re-deriving it
   * from the validated credentials — never from raw values in the key.
   */
  fingerprintsByPlugin?: Record<string, string>;
  onToolStart?: (actionId: string) => void;
  onToolEnd?: (actionId: string) => void;
  track?: <T>(run: () => Promise<T>) => Promise<T>;
  trackUntil?: <T>(run: () => Promise<T>, maxDurationMs: number) => Promise<T | undefined>;
  budget?: BudgetManager;
};

/**
 * Bind the installed tool plugins into `DynamicStructuredTool`s.
 *
 * The whole job-channel policy now lives in the shared `ToolPipeline`: this
 * function only assembles the binding layer — the duplicate-name gate, the
 * per-binding anonymous-sequence counter, and the per-call `ToolCall` +
 * `ToolCallScope` — and dispatches. The interceptor set
 * (`fence → serialize → replay → cache → budget → execution`, built by
 * `createJobToolInterceptors`) reproduces the previous inline body exactly:
 *
 *   - `fence` guards the task's running fence pre/post/before-body;
 *   - `serialize` bounds and measures the args (`task_conflict` still wins over
 *     `tool_args_too_large` because it is ordered after `fence`);
 *   - `replay` returns a stored result WITHOUT re-executing (crash-resume
 *     safety) and records the result on a fresh execution only;
 *   - `cache` serves/stores read-only results;
 *   - `budget` gates per owner+plugin and quarantines an unsettled raw body;
 *   - `execution` bounds the handler, propagates the abort signal, and owns the
 *     body-scoped cancellation telemetry.
 *   - `onResult` emits the `plugin.tool` audit the per-call `finally` used to.
 *
 * A tool call invoked WITHOUT a tool-call context (direct/unit invocation)
 * executes immediately with no dedupe — there is no id to dedupe against.
 */
export function bindJobTools(opts: BindJobToolsOptions): DynamicStructuredTool[] {
  const tools: DynamicStructuredTool[] = [];
  const seen = new Set<string>();
  let anonymousToolSequence = 0;
  // One pipeline per binding: `createJobToolInterceptors` closes over this
  // job's ledger/budget/cache/dispatch guard, while every per-call value rides
  // `ToolCall`/`ToolCallScope` (plan §4.1/§4.2). The pipeline is stateless
  // between dispatches.
  const pipeline = createToolPipeline({
    interceptors: createJobToolInterceptors({
      ledger: opts.ledger,
      ...(opts.budget === undefined ? {} : { budget: opts.budget }),
      ...(opts.toolCache === undefined ? {} : { cache: opts.toolCache }),
      ...(opts.assertActive === undefined ? {} : { assertActive: opts.assertActive }),
    }),
    onResult: createPluginAuditSink(),
  });
  for (const plugin of opts.registry.listInstalledPlugins()) {
    if (!isToolPlugin(plugin) || !Object.hasOwn(opts.credentialsByPlugin, plugin.id)) continue;
    const credentials = opts.credentialsByPlugin[plugin.id] ?? {};
    for (const toolDef of plugin.tools) {
      if (seen.has(toolDef.name)) {
        console.warn(
          `[jobs] skipping duplicate tool '${toolDef.name}' from plugin '${plugin.id}'`,
        );
        continue;
      }
      seen.add(toolDef.name);
      tools.push(
        bindJobTool(
          opts,
          pipeline,
          plugin,
          toolDef,
          credentials,
          () => ++anonymousToolSequence,
        ),
      );
    }
  }
  return tools;
}

function bindJobTool(
  opts: BindJobToolsOptions,
  pipeline: ToolPipeline,
  plugin: ToolPluginDefinition,
  toolDef: ToolDefinition,
  credentials: Record<string, string>,
  nextAnonymousToolSequence: () => number,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: toolDef.name,
    description: toolDef.description,
    schema: jsonSchemaToZod(toolDef.inputSchema),
    func: async (input, _runManager, config) => {
      const pluginId = plugin.id;
      const toolName = toolDef.name;
      const args = input as Record<string, unknown>;
      const configSignal = (config as { signal?: AbortSignal } | undefined)?.signal;
      // The channel signal is the composition of the job's own signal and the
      // LangChain run signal. Captured before any timeout controller exists;
      // the `execution` interceptor composes its timeout on top via next(signal).
      const signal = opts.signal && configSignal
        ? AbortSignal.any([opts.signal, configSignal])
        : opts.signal ?? configSignal;
      const toolCallId = (
        config as { toolCall?: { id?: string } } | undefined
      )?.toolCall?.id;
      // The anonymous sequence counter belongs to the binding layer; it is only
      // consulted when the model supplied no tool-call id (plan §4.1).
      const actionId =
        toolCallId ?? `tool:${pluginId}:${toolName}:${nextAnonymousToolSequence()}`;
      const pin = opts.getCredentials?.(pluginId);
      const invocationCredentials = pin?.credentials ?? { ...credentials };
      const call: ToolCall = {
        source: "plugin",
        pluginId,
        pluginVersion: plugin.version,
        tool: toolName,
        args,
        readOnly: toolDef.readOnly,
        owner: opts.owner,
        ...(opts.requestId === undefined ? {} : { requestId: opts.requestId }),
        credentials: invocationCredentials,
        credentialFingerprint:
          pin?.fingerprint ?? opts.fingerprintsByPlugin?.[pluginId] ??
          credentialFingerprint(invocationCredentials),
        ...(signal === undefined ? {} : { signal }),
        channel: "job",
        ...(toolCallId === undefined ? {} : { toolCallId }),
        actionId,
        timeoutMs: opts.handlerTimeoutMs ?? env.TOOL_CALL_TIMEOUT_MS,
        maxResultChars: opts.maxResultChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
        taskId: opts.taskId,
        fenceToken: opts.fenceToken,
        allowMutatingRetry: opts.allowMutatingRetry,
      };

      // The channel owns the raw-body promise: `rawSettled` resolves when the
      // RAW (unbounded) handler settles, NOT when the bounded race does. The
      // `budget` interceptor reads it before `execution` runs so it can tell an
      // unsettled timeout (quarantine) from a release. When the body never
      // starts, the core calls `onBodySkipped`, which resolves the SAME
      // deferred so the budget slot releases rather than quarantines and the
      // job's `settle()` is not held open for the quarantine deadline (D9).
      let settleRaw!: () => void;
      const rawSettled = new Promise<void>((resolve) => { settleRaw = resolve; });
      const pluginBody: ToolBody = async (_dispatch, bodySignal) => {
        let raw: Promise<string>;
        try {
          raw = Promise.resolve(
            opts.handler.execute(
              pluginId,
              toolName,
              args,
              invocationCredentials,
              bodySignal,
            ),
          );
        } catch (error) {
          // The body was invoked (so the core will NOT fire `onBodySkipped`),
          // but the raw work never started; settle now so budget releases.
          settleRaw();
          throw error;
        }
        void raw.then(settleRaw, settleRaw);
        return raw;
      };
      const scope: ToolCallScope = {
        rawSettled,
        onBodySkipped: () => settleRaw(),
        ...(opts.track === undefined ? {} : { track: opts.track }),
        ...(opts.trackUntil === undefined ? {} : { trackUntil: opts.trackUntil }),
        ...(opts.onToolStart === undefined ? {} : { onToolStart: opts.onToolStart }),
        ...(opts.onToolEnd === undefined ? {} : { onToolEnd: opts.onToolEnd }),
      };

      return pipeline.dispatch({
        call,
        bodies: { plugin: pluginBody, mcp: async () => "" },
        scope,
      });
    },
  });
}

type McpReplayOptions = {
  ledger: Ledger;
  taskId: string;
  owner: string;
  fenceToken: string;
  allowMutatingRetry: boolean;
  requestId: string;
  safeToolNames: ReadonlySet<string>;
  assertActive: () => void;
};

function trackMcpTools(
  tools: readonly DynamicStructuredTool[],
  execution: TrackedExecution,
  onToolStart: (actionId: string) => void,
  onToolEnd: (actionId: string) => void,
  replay: McpReplayOptions,
): DynamicStructuredTool[] {
  let sequence = 0;
  return tools.map((tool) =>
    new DynamicStructuredTool({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      func: async (input, _runManager, config) => {
        const toolCallId = (
          config as { toolCall?: { id?: string } } | undefined
        )?.toolCall?.id;
        const actionId = toolCallId ?? `mcp:${tool.name}:${++sequence}`;
        onToolStart(actionId);
        try {
          serializeBoundedToolArguments(input);
          replay.assertActive();
          if (toolCallId && hasToolResult(replay.ledger, {
            taskId: replay.taskId,
            owner: replay.owner,
            toolCallId,
          })) {
            const step = replay.ledger.getStepByToolCallId(
              replay.taskId,
              toolCallId,
              replay.owner,
            );
            return boundToolResult(step?.result ?? "");
          }
          if (!replay.allowMutatingRetry && !replay.safeToolNames.has(tool.name)) {
            throw new JobError(
              "tool_retry_forbidden",
              `MCP tool '${tool.name}' is not explicitly read-only and has no stored result; ` +
                "refusing to re-execute a possibly-applied side effect",
            );
          }
           const raw = await execution.track(async () => tool.func(input));
           const result = boundToolResult(String(raw));
          replay.assertActive();
          if (toolCallId) {
            recordToolResult(replay.ledger, {
              taskId: replay.taskId,
              owner: replay.owner,
              fenceToken: replay.fenceToken,
              toolCallId,
              toolName: tool.name,
              result,
            });
          }
          return result;
        } finally {
          onToolEnd(actionId);
        }
      },
    }),
  );
}

export class JobRunner {
  private readonly deps: JobRunnerDeps;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly pinUsers = new Map<CredentialPinHandle, number>();
  private readonly controllers = new Set<AbortController>();
  private readonly controllersByOwner = new Map<string, Set<AbortController>>();
  private readonly activeJobs = new Map<string, ActiveJob>();

  constructor(deps: JobRunnerDeps) {
    this.deps = deps;
    if (deps.sweepIntervalMs && deps.sweepIntervalMs > 0) {
      const setInterval =
        deps.setInterval ?? globalThis.setInterval.bind(globalThis);
      this.sweepTimer = setInterval(() => {
        try {
          this.sweepPins();
        } catch (err) {
          console.warn("[jobs] pin sweep failed:", err);
        }
      }, deps.sweepIntervalMs);
      if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    }
  }

  private registerController(owner: string, controller: AbortController): void {
    let byController = this.controllersByOwner.get(owner);
    if (!byController) {
      byController = new Set();
      this.controllersByOwner.set(owner, byController);
    }
    byController.add(controller);
  }

  private unregisterController(owner: string, controller: AbortController): void {
    const byController = this.controllersByOwner.get(owner);
    if (!byController) return;
    byController.delete(controller);
    if (byController.size === 0) this.controllersByOwner.delete(owner);
  }

  abortOwner(owner: string): number {
    const byController = this.controllersByOwner.get(owner);
    if (!byController) return 0;
    const controllers = [...byController];
    this.controllersByOwner.delete(owner);
    for (const controller of controllers) {
      if (!controller.signal.aborted) {
        controller.abort(new AccountDeletedError(owner));
      }
    }
    return controllers.length;
  }

  /** Owner-scoped status-by-idempotency-key (the client's poll-after-drop). */
  getJobStatus(owner: string, intentKey: string): TaskRow | null {
    return this.deps.ledger.getTaskByIntentKey(owner, intentKey);
  }

  getTaskExecution(taskId: string, owner: string): TaskLiveProjection | undefined {
    const active = this.activeJobs.get(taskId);
    if (active === undefined || active.owner !== owner) return undefined;
    return this.liveProjection(active);
  }

  cancelTask(taskId: string, owner: string): TaskCancelReport | null {
    let task = this.deps.ledger.getTask(taskId, owner);
    if (task === null) return null;

    if (task.status === "queued") {
      try {
        const cancelled = this.deps.ledger.completeTask(task.id, owner, "cancelled");
        return this.cancelReport(cancelled, "cancelled", "queued");
      } catch (error) {
        if (!(error instanceof LedgerError) || error.code !== "INVALID_TRANSITION") {
          throw error;
        }
        task = this.deps.ledger.getTask(taskId, owner);
        if (task === null) return null;
        if (task.status === "queued") throw error;
      }
    }

    if (task.status === "running") {
      const active = this.activeJobs.get(task.id);
      if (
        active === undefined ||
        active.owner !== owner ||
        active.fenceToken !== task.fence_token
      ) {
        return this.cancelReport(task, "not-cancellable", "running");
      }
      if (!active.cancelRequested) {
        active.cancelRequested = true;
        active.cancelFromStage = active.stage;
        active.controller.abort(new JobCancelledError(active.taskId));
      }
      return this.cancelReport(
        task,
        "cancelling",
        active.cancelFromStage ?? active.stage,
        this.liveProjection(active),
      );
    }

    if (task.status === "stuck") {
      return this.cancelReport(task, "not-cancellable", "stuck");
    }

    return this.cancelReport(task, "already-terminal", "already-terminal");
  }

  /** GC for expired credential pins. Call periodically or rely on `sweepIntervalMs`. */
  sweepPins(): number {
    return this.deps.pins.sweep();
  }

  /**
   * Runs a background job end-to-end. Idempotent by (owner, intentKey): a
   * second call while the first is running returns `in_flight` and never
   * double-executes the graph.
   */
  async runJob(descriptor: JobDescriptor): Promise<RunJobResult> {
    const pinHandles: Record<string, CredentialPinHandle> = { ...descriptor.pinHandles };
    let pinError: unknown;
    if (descriptor.pinHandles === undefined) {
      for (const pluginId of new Set([...descriptor.toolPlugins, descriptor.modelPluginId])) {
        try {
          pinHandles[pluginId] = this.deps.pins.get(descriptor.owner, pluginId).handle;
        } catch (error) {
          if (descriptor.toolPlugins.includes(pluginId) ||
              !(error instanceof CredentialPinError && error.code === "pin_not_found")) {
            pinError ??= error;
          }
        }
      }
    }
    for (const handle of new Set(Object.values(pinHandles))) {
      this.pinUsers.set(handle, (this.pinUsers.get(handle) ?? 0) + 1);
    }
    try {
      if (isDeleting(descriptor.owner)) {
        return accountDeletedResult(descriptor.clientThreadId);
      }
      return await this.runAdmittedJob({ ...descriptor, toolPlugins: [...descriptor.toolPlugins], pinHandles }, pinError);
    } finally {
      for (const [pluginId, handle] of Object.entries(pinHandles)) {
        const users = (this.pinUsers.get(handle) ?? 1) - 1;
        if (users > 0) {
          this.pinUsers.set(handle, users);
        } else {
          this.pinUsers.delete(handle);
          this.deps.pins.release(descriptor.owner, pluginId, handle);
        }
      }
      this.sweepPins();
    }
  }

  private async runAdmittedJob(descriptor: JobDescriptor, pinError?: unknown): Promise<RunJobResult> {
    let { owner, intentKey, spec, clientThreadId, toolPlugins, input } = descriptor;
    if (isDeleting(owner)) return accountDeletedResult(clientThreadId);
    // No checkpoint thread: the raw client thread id IS the public thread
    // handle surfaced in results (and the ledger `worker` label).
    let threadId = clientThreadId;
    // Snapshot payload (ledger v5): the JSON-encoded messages the job runs on.
    // This is the ONLY durable place the snapshot can live now that the
    // checkpointer is gone; `resumeStuckJobs` reads it after a crash. Messages
    // are serialized in LangChain's stored-message format (a plain
    // `JSON.stringify(BaseMessage[])` would emit the `lc:1` constructor shape,
    // which is not re-coercible).
    const payload = serializeJobPayload(input);
    const jobSpec = serializeJobSpec(descriptor);

    // 1. Owner-scoped idempotent admission (persists the snapshot payload on
    //    first creation).
    let task: TaskRow;
    try {
      if (isDeleting(owner)) return accountDeletedResult(threadId);
      task = await getOrCreateTask(this.deps.ledger, {
        owner,
        intentKey,
         spec,
         worker: clientThreadId,
         payload,
         jobSpec,
       });

    } catch (error) {
      if (error instanceof AccountDeletedError || isDeleting(owner)) {
        return accountDeletedResult(threadId);
      }
      throw error;
    }
    if (isDeleting(owner)) return accountDeletedResult(threadId, task.id);

    // 2. Duplicate/in-flight handling — never double-execute. M6: a running
    //    task whose heartbeat has gone stale past the stuck-timeout means the
    //    worker crashed — mark it `stuck` and treat THIS call as the resume
    //    instead of returning `in_flight` forever (which would wedge the
    //    intentKey until a reboot).
    if (task.status === "running") {
      if (isDeleting(owner)) return accountDeletedResult(threadId, task.id);
      const marked = this.deps.ledger.markStuckIfHeartbeatStale(task.id);
      if (isDeleting(owner)) return accountDeletedResult(threadId, task.id);
      if (marked && marked.status === "stuck") {
        task = marked;
      } else {
        return { status: "in_flight", taskId: task.id, threadId };
      }
    }

    // 2b. Replay semantics (H3): a task admitted as `stuck` (crashed/restarted
    //     worker) IS a resume, so mutating tools with no stored result must
    //     not re-execute. Fresh (queued) jobs may retry mutating tools.
    const replaying = task.status === "stuck";

    // 3. Claim: lease + fresh fence token. A `stuck` task is resumed (new
    //    fence) so the snapshot re-run owns a live lease.
    let claimed: TaskRow;
    if (isDeleting(owner)) return accountDeletedResult(threadId, task.id);
    if (task.status === "queued") {
      try {
        claimed = this.deps.ledger.claimTask(task.id, owner);
        if (isDeleting(owner)) return accountDeletedResult(threadId, task.id);
      } catch (e) {
        if (isConflict(e)) {
          // A concurrent worker won the claim between admission and claim.
          return { status: "in_flight", taskId: task.id, threadId };
        }
        throw e;
      }
    } else if (task.status === "stuck") {
      try {
        claimed = this.deps.ledger.resumeTask(task.id, owner);
        if (isDeleting(owner)) return accountDeletedResult(threadId, task.id);
      } catch (e) {
        if (isConflict(e)) {
          // A concurrent worker resumed the stuck task first.
          return { status: "in_flight", taskId: task.id, threadId };
        }
        throw e;
      }
    } else {
      // Terminal — re-submitting a finished intentKey is an idempotent no-op.
      return {
        status: "already_terminal",
        taskId: task.id,
        threadId,
        terminalStatus: task.status,
      };
    }
    if (isDeleting(owner)) return accountDeletedResult(threadId, task.id);
    const fenceToken = claimed.fence_token;
    if (isDeleting(owner)) return accountDeletedResult(threadId, claimed.id);
    const storedSpec = parsePersistedJobSpec(claimed.job_spec);
    const storedMessages = snapshotMessagesFromPayload(claimed);
    if (storedSpec === null || storedMessages === null) {
      return this.failJob(
        claimed,
        owner,
        fenceToken,
        threadId,
        "job_failed",
        storedSpec === null
          ? "stored background job configuration is missing or invalid; the job cannot be re-run"
          : "no stored message snapshot to resume from; the job cannot be re-run",
      );
    }
    owner = claimed.owner;
    intentKey = claimed.intent_key;
    spec = claimed.spec;
    clientThreadId = storedSpec.clientThreadId;
    toolPlugins = storedSpec.toolPlugins;
    input = { messages: storedMessages };
    const requestId = descriptor.requestId ?? descriptor.shadowRequestId ?? intentKey;
    descriptor = {
      ...descriptor,
       owner,
       intentKey,
       requestId,
       spec,
       clientThreadId,
      toolPlugins,
      modelPluginId: storedSpec.modelPluginId,
      modelRequestConfig: storedSpec.modelRequestConfig,
      systemPrompt: storedSpec.systemPrompt,
      mcpServers: storedSpec.mcpServers,
      input,
    };
    threadId = clientThreadId;
    const shadowRequestId = requestId;
    const shadowInput = lastUserTextFromMessages(storedMessages);
    if (shadowInput !== null) {
      tryReportSentinelShadow(this.deps.shadowReporter, {
        owner,
        text: shadowInput,
        direction: "input",
        requestId: shadowRequestId,
        taskId: claimed.id,
        reportKey: `input:${shadowRequestId}`,
      });
    }
    if (isDeleting(owner)) return accountDeletedResult(threadId, claimed.id);


    // 4. Timer heartbeat covers the WHOLE job (pin fetch → graph invoke →
    //    tool execution); started INSIDE the try so a misconfigured interval
    //    (H2) fails the job cleanly with an error step + pin release instead
    //    of orphaning the task as `running` forever. Stopped in the finally.
    let heartbeat: { stop(): void } | undefined;
    const controller = new AbortController();
    const activeJob: ActiveJob = {
      taskId: claimed.id,
      owner,
      threadId,
      fenceToken,
      controller,
      stage: "admitted",
      activeToolCallIds: new Set(),
      cancelRequested: false,
    };
    this.controllers.add(controller);
    this.registerController(owner, controller);
    this.activeJobs.set(claimed.id, activeJob);
    const signal = descriptor.signal
      ? AbortSignal.any([descriptor.signal, controller.signal])
      : controller.signal;
    const assertActive = () => {
      if (isDeleting(owner)) controller.abort(new AccountDeletedError(owner));
      if (this.disposed) controller.abort(new JobError("task_conflict", "job runner disposed"));
      const current = this.deps.ledger.getTask(claimed.id, owner);
      if (!current || current.status !== "running" || current.fence_token !== fenceToken) {
        controller.abort(new JobError("task_conflict", "background job lost its running task fence"));
      }
      signal.throwIfAborted();
    };
    const getCredentials = (pluginId: string) => {
      assertActive();
      const handle = descriptor.pinHandles?.[pluginId];
      if (handle === undefined) {
        throw new JobError("credentials_expired", `no admitted credential pin for plugin '${pluginId}'`);
      }
      return this.deps.pins.get(owner, pluginId, handle);
    };

    try {
      if (isDeleting(owner)) return accountDeletedResult(threadId, claimed.id);
      if (pinError) throw pinError;
      assertActive();
      heartbeat = this.deps.ledger.startHeartbeat(claimed.id, owner, fenceToken, {
        ...(this.deps.heartbeatIntervalMs
          ? { intervalMs: this.deps.heartbeatIntervalMs }
          : {}),
        onError: () => {
          controller.abort(new JobError("task_conflict", "background job heartbeat failed"));
        },
      });

      // 5. Pin credentials per plugin. A missing/expired pin fails the job
      //    BEFORE any graph invoke.
      const credentialsByPlugin: Record<string, Record<string, string>> = {};
      // Phase 4, Wave B: reuse the pin's precomputed credential fingerprint as
      // the cache-key component (never re-derive, never store raw values).
      const fingerprintsByPlugin: Record<string, string> = {};
      for (const pluginId of toolPlugins) {
        const pin = getCredentials(pluginId);
        credentialsByPlugin[pluginId] = pin.credentials;
        fingerprintsByPlugin[pluginId] = pin.fingerprint;
      }

      // 6. Build the agent with the real executor + replay dedupe. Replays
      //    bind with `allowMutatingRetry: false` (H3): a mutating tool with no
      //    stored result throws `tool_retry_forbidden` rather than re-applying
      //    a side effect the crashed run may already have executed. NO
      //    checkpointer — the graph runs on the submitted snapshot.
      const assertDispatch = () => {
        assertActive();
        for (const pluginId of Object.keys(descriptor.pinHandles ?? {})) getCredentials(pluginId);
      };
      const beforeModelCall = (messages: unknown) => {
        void messages;
        assertDispatch();
        if (!activeJob.cancelRequested) activeJob.stage = "running";
        this.deps.budget?.beforeModelCall(owner, "async");
      };
      const model = await this.resolveModel(descriptor, {
        credentials: descriptor.pinHandles?.[descriptor.modelPluginId]
          ? getCredentials(descriptor.modelPluginId).credentials
          : undefined,
        signal,
        assertActive: assertDispatch,
      });
      assertDispatch();
      const execution = createTrackedExecution(signal);
      trackModelExecution(model, execution);
      const executor = this.deps.executor ?? this.createDefaultExecutor();
      const handler = descriptor.toolHandler ?? executor;
      const tools = bindJobTools({
        registry: this.deps.registry,
         handler,
         credentialsByPlugin,
        getCredentials,
        assertActive,
        signal,
        fingerprintsByPlugin,
        onToolStart: (actionId) => {
          if (!activeJob.cancelRequested) activeJob.stage = "running";
          activeJob.activeToolCallIds.add(actionId);
        },
         onToolEnd: (actionId) => {
           activeJob.activeToolCallIds.delete(actionId);
         },
         track: (run) => execution.track(run),
         trackUntil: (run, maxDurationMs) => execution.trackUntil(run, maxDurationMs),
         toolCache: this.deps.toolCache,
        budget: this.deps.budget,
        ledger: this.deps.ledger,
        taskId: claimed.id,
        owner,
         fenceToken,
         allowMutatingRetry: !replaying,
          requestId,
          handlerTimeoutMs: this.deps.toolHandlerTimeoutMs,
          maxResultChars: this.deps.maxToolResultChars,
        });
      const mcpBinding: McpBinding | undefined = descriptor.mcpServers
        ? await bindMcpServers(descriptor.mcpServers, {
            owner,
            requestId,
            signal,
             trustedHosts: env.MCP_TRUSTED_HOSTS,
             clientFactory: this.deps.mcpClientFactory,
             resolvePins: async (server) => {
              const agentPluginId = server.id?.trim();
              if (!agentPluginId) return undefined;
              const entry = this.deps.getPinnedIps?.(
                `${agentPluginId}:mcp:${server.name}`,
              )?.[0];
               return entry?.pinned === undefined ? undefined : [...entry.pinned];
            },
          })
        : undefined;
      const mcpTools = trackMcpTools(
        mcpBinding?.tools ?? [],
        execution,
        (actionId) => {
          if (!activeJob.cancelRequested) activeJob.stage = "running";
          activeJob.activeToolCallIds.add(actionId);
        },
         (actionId) => {
           activeJob.activeToolCallIds.delete(actionId);
         },
         {
           ledger: this.deps.ledger,
           taskId: claimed.id,
           owner,
           fenceToken,
           allowMutatingRetry: !replaying,
           requestId,
           safeToolNames: mcpBinding?.toolReadOnly ?? new Set<string>(),
           assertActive,
         },
       );
      const allTools = mergePluginAndMcpTools(tools, mcpTools, "[jobs]");
      const graph = createAgentGraph({
        model,
        tools: allTools,
        systemPrompt: descriptor.systemPrompt,
        beforeModelCall,
        onToolResult: (content, observation) => {
          tryReportSentinelShadow(this.deps.shadowReporter, {
            owner,
            text: content,
            direction: "tool_result",
            requestId: shadowRequestId,
            taskId: claimed.id,
            reportKey: `tool:${shadowRequestId}:${observation.toolCallId ?? observation.sequence}`,
          });
        },
      });


      // 7. Run the graph on the SNAPSHOT. No thread lock, no `getState` resume
      //    branch, no compaction — the checkpointer is gone.
      try {
        assertDispatch();
        if (input == null) {
          throw new JobError(
            "job_failed",
            "a background job requires a non-null input snapshot",
          );
        }
        const invokeResult = await graph.invoke(input, { signal });
        await execution.settle();
        assertDispatch();

        // 8. Success. Store the final assistant reply as a ledger `reply` step
        //    (step 9 — the checkpointer is gone, so the ledger is the ONLY
        //    place a background job's reply can live for the client to read
        //    back after polling terminal). Best-effort: a failed append must
        //    never fail the job — the `succeeded` status was already won, and
        //    the step is transient (purged with the task by the retention
        //    sweep).
        const reply = lastAssistantReply(invokeResult);
        if (reply !== null) {
          const persistedReply = redactForOutbound(reply);
          tryReportSentinelShadow(this.deps.shadowReporter, {
            owner,
            text: persistedReply,
            direction: "output",
            requestId: shadowRequestId,
            taskId: claimed.id,
            reportKey: `output:${shadowRequestId}`,
          });
          try {
            this.deps.ledger.appendStep(
              claimed.id,
              owner,
              {
                stage: "reply",
                action: "assistant_message",
                // Persisted replies are state: redact at this seam rather than altering model output.
                result: persistedReply,
              },
              fenceToken,
            );
          } catch (err) {
            console.warn(
              `[jobs] failed to store reply step for task ${claimed.id}:`,
              err,
            );
          }
        }
        const completion = this.deps.ledger.completeTaskWithFence(
          claimed.id,
          owner,
          "succeeded",
          fenceToken,
        );
        if (!completion.transitioned) {
          const current = this.deps.ledger.getTask(claimed.id, owner);
          if (current && current.status !== "running") {
            return {
              status: "already_terminal",
              taskId: claimed.id,
              threadId,
              terminalStatus: current.status,
            };
          }
          return { status: "in_flight", taskId: claimed.id, threadId };
        }
        const summary = JSON.stringify({
          status: "succeeded",
          messages: Array.isArray(invokeResult?.messages) ? invokeResult.messages.length : 0,
        });
        await this.notify(owner, claimed.id, summary);
        return { status: "succeeded", taskId: claimed.id, threadId };
      } finally {
        await execution.settle();
        try {
          await mcpBinding?.dispose();
        } catch (err) {
          // A rejected MCP close must never fail the job's cleanup path.
          console.warn("[jobs] MCP binding dispose failed:", err);
        }
      }
    } catch (e) {
      if (isDeleting(owner) || e instanceof AccountDeletedError) {
        return accountDeletedResult(threadId, claimed.id);
      }
      if (activeJob.cancelRequested) {
        return this.finishCancellation(activeJob);
      }
      const code = jobErrorCodeOf(e);
      return this.failJob(claimed, owner, fenceToken, threadId, code, errorMessageOf(e));
    } finally {
      heartbeat?.stop();
      controller.abort();
      this.controllers.delete(controller);
      this.unregisterController(owner, controller);
      if (this.activeJobs.get(activeJob.taskId) === activeJob) {
        this.activeJobs.delete(activeJob.taskId);
      }
    }
  }

  /**
   * Best-effort startup pass for the restart-loss story. Finds `stuck` tasks
   * (already marked by `ledger.reconcileOrphans()` at boot) and tries to
   * re-establish their credential pins via the `credentialSource` seam. When
   * pins can't be re-established — the honest default, since the in-memory pin
   * store is empty after a restart and there is no vault — the task fails
   * cleanly with `credentials_expired` and the notification hook fires.
   *
   * The ledger persists owner/spec only (not the job's plugin set), so every
   * `stuck` task in the gateway's ledger is processed and the `credentialSource`
   * seam resolves keys by (owner, task). When a source re-establishes pins AND
   * a `buildModel` seam is wired, the task is re-run through the full `runJob`
   * path FROM THE STORED SNAPSHOT (`task.payload` → JSON.parse → messages) as a
   * REPLAY (H3) — mutating tools with no stored result fail
   * `tool_retry_forbidden`. A task with no stored payload (admitted before v5
   * or by a route) is failed cleanly — never fabricated input. Without a model
   * seam the task is failed `plugin_unavailable` (there is no checkpoint
   * scheduler pass to defer to anymore).
   */
  async resumeStuckJobs(): Promise<ResumeStuckJobsResult> {
    const recoverable = this.deps.ledger
      .listTasks()
      .filter((task) => task.status === "queued" || task.status === "stuck");
    const outcomes: StuckTaskOutcome[] = [];
    for (const task of recoverable) {
      if (isDeleting(task.owner)) {
        outcomes.push({ taskId: task.id, owner: task.owner, outcome: "account_deleted" });
        continue;
      }
      const storedSpec = parsePersistedJobSpec(task.job_spec);
      const messages = snapshotMessagesFromPayload(task);
      if (storedSpec === null || messages === null) {
        outcomes.push(
          await this.failStuck(
            task,
            "job_failed",
            storedSpec === null
              ? "stored background job configuration is missing or invalid; the job cannot be re-run"
              : "no stored message snapshot to resume from (ledger payload missing or invalid); the job cannot be re-run",
          ),
        );
        continue;
      }
      try {
        const reestablished = this.deps.credentialSource
          ? await this.deps.credentialSource(task.owner, task)
          : null;
        if (isDeleting(task.owner)) {
          this.deps.pins.releaseOwner(task.owner);
          outcomes.push({ taskId: task.id, owner: task.owner, outcome: "account_deleted" });
          continue;
        }
        if (reestablished === null || reestablished === undefined) {
          outcomes.push(await this.failStuck(task, "credentials_expired"));
          continue;
        }
        for (const [pluginId, credentials] of Object.entries(reestablished)) {
          if (isDeleting(task.owner)) break;
          this.deps.pins.pin(task.owner, pluginId, credentials);
        }
        if (isDeleting(task.owner)) {
          this.deps.pins.releaseOwner(task.owner);
          outcomes.push({ taskId: task.id, owner: task.owner, outcome: "account_deleted" });
          continue;
        }
        if (!this.deps.buildModel) {
          outcomes.push(
            await this.failStuck(
              task,
              "plugin_unavailable",
              "cannot resume a background job without a buildModel seam",
            ),
          );
          continue;
        }
        const modelPlugin = (() => {
          try {
            return this.deps.registry.requirePlugin(storedSpec.modelPluginId);
          } catch {
            return null;
          }
        })();
        if (
          modelPlugin === null ||
          modelPlugin.type !== "model" ||
          reestablished[storedSpec.modelPluginId] === undefined
        ) {
          outcomes.push(await this.failStuck(task, "plugin_unavailable"));
          continue;
        }
        const replay = await this.runJob({
           owner: task.owner,
           intentKey: task.intent_key,
           requestId: task.intent_key,
           spec: task.spec,
          clientThreadId: task.worker ?? storedSpec.clientThreadId,
          toolPlugins: storedSpec.toolPlugins,
          modelPluginId: storedSpec.modelPluginId,
          modelRequestConfig: storedSpec.modelRequestConfig,
          systemPrompt: storedSpec.systemPrompt,
          mcpServers: storedSpec.mcpServers,
          input: { messages },
        });
        outcomes.push({
          taskId: task.id,
          owner: task.owner,
          outcome:
            replay.status === "account_deleted"
              ? "account_deleted"
              : replay.status === "failed"
                ? replay.code
                : replay.status === "cancelled"
                  ? "cancelled"
                  : "repinned",
        });
      } catch (e) {
        if (isDeleting(task.owner) || e instanceof AccountDeletedError) {
          this.deps.pins.releaseOwner(task.owner);
          outcomes.push({ taskId: task.id, owner: task.owner, outcome: "account_deleted" });
          continue;
        }
        outcomes.push(await this.failStuck(task, jobErrorCodeOf(e)));
      }
    }
    return { processed: outcomes.length, outcomes };
  }

  /** Stops the optional periodic sweep timer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers) {
      controller.abort(new JobError("task_conflict", "job runner disposed"));
    }
    this.controllersByOwner.clear();
    this.activeJobs.clear();
    if (this.sweepTimer) {
      const clearInterval =
        this.deps.clearInterval ?? globalThis.clearInterval.bind(globalThis);
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private liveProjection(active: ActiveJob): TaskLiveProjection {
    const stage: TaskLiveProjection["stage"] = active.cancelRequested
      ? "cancelling"
      : active.activeToolCallIds.size > 0
        ? "running_tool"
        : active.stage === "admitted"
          ? "admitted"
          : "running_model";
    return {
      stage,
      activeToolCallIds: [...active.activeToolCallIds],
    };
  }

  private cancelReport(
    task: TaskRow,
    stage: TaskCancelStage,
    reachedStage: TaskCancelReachedStage,
    live?: TaskLiveProjection,
  ): TaskCancelReport {
    const steps = this.deps.ledger.listSteps(task.id, task.owner);
    const projection = projectTaskProgress(task, steps, live);
    return {
      schemaVersion: TASK_CANCEL_SCHEMA_VERSION,
      taskId: task.id,
      stage,
      reachedStage,
      taskStatus: task.status,
      cancellable: projection.canCancel,
      ...(projection.terminalStatus === undefined
        ? {}
        : { terminalStatus: projection.terminalStatus }),
      effectState: projection.effectState,
      completedActions: steps.slice(-TASK_CANCEL_COMPLETED_ACTIONS_LIMIT).map((step) => ({
        id: step.id,
        stage: step.stage,
        action: step.action,
        ...(step.tool_call_id === null
          ? {}
          : { toolCallId: step.tool_call_id }),
        completed: true as const,
      })),
      projection,
    };
  }

  /**
   * The real executor built from the runner deps. `getPinnedIps` defaults to a
   * no-pins resolver so construction never throws; the executor fails with
   * `plugin_unavailable` at call time if the store was never wired.
   */
  private createDefaultExecutor(): ToolExecutor {
    return new ToolExecutor({
      registry: this.deps.registry,
      getPinnedIps: this.deps.getPinnedIps ?? (() => undefined),
      trustedHosts: this.deps.trustedHosts,
      // D3: honor the job's effective handler bound at the executor's HTTP
      // guard too, so a `toolHandlerTimeoutMs` override is not silently capped
      // by `env.TOOL_CALL_TIMEOUT_MS`. Absent (the default) preserves today's
      // env-derived executor timeout exactly.
      ...(this.deps.toolHandlerTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.deps.toolHandlerTimeoutMs }),
    });
  }

  private async resolveModel(
    descriptor: JobDescriptor,
    context: Parameters<NonNullable<JobRunnerDeps["buildModel"]>>[2],
  ): Promise<BaseChatModel> {
    // M2: an empty model-plugin id means the resumer could not identify the
    // model the original job used. Fail `plugin_unavailable` — the honest,
    // correct code — NOT `credentials_expired`, which a pin-store miss on an
    // empty id would otherwise produce and which misleads the client into
    // re-supplying a key when the real problem is a missing model plugin.
    if (descriptor.modelPluginId === "") {
      throw new JobError(
        "plugin_unavailable",
        "cannot resume a background job without a model plugin id; " +
          "re-establish credentials with a model plugin before resuming",
      );
    }
    if (!this.deps.buildModel) {
      throw new JobError(
        "plugin_unavailable",
        "no buildModel seam is wired (the transport supplies it); " +
          "cannot build a chat model for a background job",
      );
    }
    return this.deps.buildModel(
      descriptor.modelPluginId,
      descriptor.modelRequestConfig,
      context,
    );
  }

  private async finishCancellation(active: ActiveJob): Promise<RunJobResult> {
    let transitioned = false;
    try {
      transitioned = this.deps.ledger.completeTaskWithFence(
        active.taskId,
        active.owner,
        "cancelled",
        active.fenceToken,
      ).transitioned;
    } catch (error) {
      if (!(error instanceof LedgerError) || error.code !== "FENCE_CONFLICT") {
        throw error;
      }
    }
    if (!transitioned) {
      const current = this.deps.ledger.getTask(active.taskId, active.owner);
      if (current?.status === "succeeded" || current?.status === "failed" || current?.status === "cancelled" || current?.status === "awaiting_review") {
        return {
          status: "already_terminal",
          taskId: active.taskId,
          threadId: active.threadId,
          terminalStatus: current.status,
        };
      }
      return { status: "in_flight", taskId: active.taskId, threadId: active.threadId };
    }
    await this.notify(active.owner, active.taskId, "cancelled");
    return {
      status: "cancelled",
      taskId: active.taskId,
      threadId: active.threadId,
    };
  }

  /** Appends a redacted error step + fails the task; superseded workers no-op. */
  private failJob(
    claimed: TaskRow,
    owner: string,
    fenceToken: string,
    threadId: string,
    code: JobErrorCode,
    message: string,
  ): RunJobResult & { status: "failed" } {
    const redacted = redactForOutbound(message);
    let transitioned = false;
    try {
      const current = this.deps.ledger.getTask(claimed.id, owner);
      if (current?.status === "running" && current.fence_token === fenceToken) {
        this.deps.ledger.appendStep(
          claimed.id,
          owner,
          { stage: "error", action: `error:${code}`, result: redacted },
          fenceToken,
        );
        transitioned = this.deps.ledger.completeTaskWithFence(
          claimed.id,
          owner,
          "failed",
          fenceToken,
        ).transitioned;
      }
    } catch (err) {
      // Best-effort: another pass already moved the task; never throw out.
      console.warn(`[jobs] failed to record failure for task ${claimed.id}:`, err);
    }
    if (transitioned) void this.notify(owner, claimed.id, `failed: ${code}`);
    return { status: "failed", taskId: claimed.id, threadId, code, error: redacted };
  }

  /** Fails a `stuck` task (resume → step → failed) and notifies. Best-effort. */
  private async failStuck(
    task: TaskRow,
    code: JobErrorCode,
    reason?: string,
  ): Promise<StuckTaskOutcome> {
    if (isDeleting(task.owner)) {
      return { taskId: task.id, owner: task.owner, outcome: "account_deleted" };
    }
    let transitioned = false;
    try {
      const claimed = task.status === "queued"
        ? this.deps.ledger.claimTask(task.id, task.owner)
        : this.deps.ledger.resumeTask(task.id, task.owner);
      if (isDeleting(task.owner)) {
        return { taskId: task.id, owner: task.owner, outcome: "account_deleted" };
      }
      this.deps.ledger.appendStep(
        task.id,
        task.owner,
        {
          stage: "error",
          action: `error:${code}`,
          result: redactForOutbound(
            reason ?? `orphaned background job cannot resume after restart: ${code}`,
          ),
        },
        claimed.fence_token,
      );
      if (isDeleting(task.owner)) {
        return { taskId: task.id, owner: task.owner, outcome: "account_deleted" };
      }
      transitioned = this.deps.ledger.completeTaskWithFence(
        task.id,
        task.owner,
        "failed",
        claimed.fence_token,
      ).transitioned;
    } catch (err) {
      // Best-effort: another pass already handled this task.
      console.warn(`[jobs] failed to fail stuck task ${task.id}:`, err);
    }
    if (transitioned) {
      await this.notify(task.owner, task.id, `failed: ${code} (restart loss)`);
    }
    return { taskId: task.id, owner: task.owner, outcome: code };
  }

  private async notify(owner: string, taskId: string, summary: string): Promise<void> {
    const hook = this.deps.notification ?? noopNotificationHook;
    try {
      await hook.notifyJobComplete(owner, taskId, summary);
    } catch (err) {
      console.warn(`[jobs] notification hook failed for task ${taskId}:`, err);
    }
  }
}

/** Factory parity with the plan's composition root; same as `new JobRunner(deps)`. */
export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  return new JobRunner(deps);
}

function jobErrorCodeOf(e: unknown): JobErrorCode {
  if (e instanceof JobError) return e.code;
  if (e instanceof AccountDeletedError) return "account_deleted";
  if (e instanceof BudgetExhaustedError) return "budget_exhausted";
  if (e instanceof ContextBudgetError) return "context_length_exceeded";
  if (e instanceof CredentialPinError) return "credentials_expired";
  if (e instanceof Error && e.name === "AbortError") return "task_conflict";
  return "job_failed";
}

function errorMessageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * The final assistant reply text from a completed graph state, or null when the
 * state carries no assistant message. Mirrors the sync path's reply capture
 * (`captureAssistantReply`): the final state's last AIMessage is the turn's
 * output (tool-calling included); its text content is the reply. The content is
 * stored as plain text so the client can append it directly as the assistant
 * message's content (no per-step JSON decoding on read-back).
 */
function lastAssistantReply(state: unknown): string | null {
  if (state === null || typeof state !== "object") return null;
  const messages = (state as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!(message instanceof AIMessage)) continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (block): block is { type: string; text?: unknown } =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "text",
        )
        .map((block) => String(block.text ?? ""))
        .join("");
      return text;
    }
    return null;
  }
  return null;
}

/**
 * Decodes a stored snapshot payload (ledger v5) back into LangChain messages.
 * The payload is the JSON-encoded stored-message array (`mapChatMessagesToStoredMessages`)
 * written at admission, so a resume re-hydrates it with
 * `mapStoredMessagesToChatMessages`. Returns null when the payload is
 * missing/empty/not a valid stored-message array — a resume must fail cleanly
 * then, never fabricate input.
 */
function snapshotMessagesFromPayload(task: TaskRow): BaseMessage[] | null {
  if (task.payload == null || task.payload.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(task.payload);
    if (!Array.isArray(parsed)) return null;
    return redactMessages(mapStoredMessagesToChatMessages(parsed as never[]));
  } catch {
    return null;
  }
}