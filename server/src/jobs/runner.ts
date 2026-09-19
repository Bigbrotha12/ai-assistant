import { HumanMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { BaseCheckpointSaver, CompiledStateGraph } from "@langchain/langgraph";
import { createAgentGraph } from "../agents/graph.ts";
import { compileGraphWithCheckpointer } from "../agents/compile.ts";
import { jsonSchemaToZod } from "../agents/orchestrator.ts";
import type { ToolCallHandler } from "../agents/orchestrator.ts";
import { checkpointThreadId, redactForCheckpoint } from "../checkpoints/store.ts";
import {
  canRetryTool,
  getOrCreateTask,
  hasToolResult,
  recordToolResult,
} from "../credentials/idempotency.ts";
import { CredentialPinError } from "../credentials/pins.ts";
import type { CredentialPin, CredentialPinHandle, CredentialPinStore } from "../credentials/pins.ts";
import { credentialFingerprint } from "../plugins/credential.ts";
import type { ToolCacheKey, ToolResultCache } from "../middleware/cache.ts";
import type { BudgetManager } from "../middleware/budget.ts";
import type { ContextManager } from "../middleware/context.ts";
import { BudgetExhaustedError } from "../middleware/budget.ts";
import { ContextBudgetError } from "../middleware/context.ts";
import type { Ledger } from "../ledger.ts";
import type { TaskRow, TaskStatus } from "../ledger.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { isToolPlugin } from "../plugins/types.ts";
import type { ToolDefinition, ToolPluginDefinition } from "../plugins/types.ts";
import { validatedFetch } from "../plugins/ssrf.ts";
import type { LookupFn, Mode } from "../plugins/ssrf.ts";
import { AsyncMutex } from "./mutex.ts";
import { ThreadLockRegistry } from "./thread_lock.ts";

/**
 * Async job runner (Phase 2, Wave C1: background jobs).
 *
 * The orchestrator delegates work to a background job that runs the LangGraph
 * agent on its own checkpoint thread: owner-scoped idempotent admission
 * (`getOrCreateTask`), a fenced claim (`claimTask`), per-plugin credential
 * pins, a timer heartbeat that keeps the task alive for the WHOLE job, and a
 * checkpointed `graph.invoke` guarded by a per-thread mutex + `checkpoint_id`
 * optimistic locking.
 *
 * FLOW (`runJob`):
 *
 *   1. `getOrCreateTask(ledger, { owner, intentKey, spec })` — owner-scoped
 *      idempotent admission. A repeat (owner, intentKey) returns the EXISTING
 *      task instead of creating a duplicate row.
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
 *   6. Build the agent (`createAgentGraph` + `compileGraphWithCheckpointer`)
 *      with a REAL `ToolCallHandler`: the {@link ToolExecutor} (validatedFetch
 *      + pinned IPs + credentials + trusted hosts) wrapped with tool-call replay
 *      dedupe (`hasToolResult`/`recordToolResult`, `tool_retry_forbidden` for
 *      mutating tools that cannot be proven never-run when `isReplay`/stuck).
 *   7. `graph.invoke` under the per-thread mutex + `checkpoint_id` optimistic
 *      lock (see {@link JobRunner.invokeWithCheckpointLock}). The thread's
 *      owner mapping is recorded via the `touchThread` seam.
 *   8. On success: `completeTask(..., "succeeded")` + the notification hook.
 *      On error: fail the task with a redacted error step. Pins are released
 *      and swept, the per-thread mutex is GC'd, and the heartbeat is stopped in
 *      the finally.
 *
 * RESTART-LOSS (`resumeStuckJobs`): `ledger.reconcileOrphans()` (Wave A2) runs
 * at boot and marks orphaned `running` tasks `stuck`. The pin store is
 * in-memory, so after a restart the pins are GONE. This best-effort startup
 * pass tries to re-establish them via the optional `credentialSource` seam;
 * when pins cannot be re-established (the honest story — an orphaned job can't
 * resume without the user's key), the task is failed cleanly with
 * `credentials_expired` and the notification hook fires. The ntfy push itself
 * lands in Phase 5/6; {@link noopNotificationHook} is the default.
 *
 * The runner is NOT wired into the HTTP transport yet (Phase 3). `index.ts`
 * may instantiate it lazily/guarded so boot never breaks when deps are absent.
 */

/** Any compiled state graph (the runner's graph is built via `createAgentGraph`). */
type AnyCompiledGraph = CompiledStateGraph<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

/** Job error codes surfaced to callers and recorded as ledger steps. */
export type JobErrorCode =
  | "credentials_expired"
  | "task_conflict"
  | "plugin_unavailable"
  | "job_failed"
  | "tool_retry_forbidden"
  | "budget_exhausted"
  | "context_length_exceeded";

/** Raised by the job runner / tool executor. Never carries credential values. */
export class JobError extends Error {
  readonly code: JobErrorCode;

  constructor(code: JobErrorCode, message: string) {
    super(message);
    this.name = "JobError";
    this.code = code;
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
  return `${base}/${toolName}`;
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
  /** Injectable fetch for `validatedFetch` (tests stub this; never the network). */
  fetchFn?: typeof fetch;
  /** Injectable DNS resolver for `validatedFetch` (tests stub this). */
  lookup?: LookupFn;
  /** Scheme enforcement mode override for `validatedFetch`. */
  mode?: Mode;
  /**
   * Admin-trusted hostnames/IPs forwarded into `validatedFetch`. The pins were
   * computed WITH the trusted-hosts list at install/load time (a `*.local` /
   * RFC1918 backend is allowed because the admin vouched for it); a call-time
   * re-resolution WITHOUT the same list would reject those hosts as
   * DNS_REBINDING. This MUST carry the plugin store's trusted hosts so an
   * admin-trusted internal plugin keeps working.
   */
  trustedHosts?: readonly string[];
};

/**
 * The REAL `ToolCallHandler` (exported separately so tests can exercise it
 * without the full runner). For every call it:
 *
 *   - resolves the plugin's pinned IPs (`getPinnedIps`) — a plugin with no
 *     pins is `plugin_unavailable` (the pins are the SSRF-validated resolve
 *     result; a job must never ad-hoc resolve a plugin URL),
 *   - calls `validatedFetch` — the ONLY sanctioned outbound path — against the
 *     allowlisted URL with the pinned credentials (bearer header),
 *   - refuses any 3xx (validatedFetch does this; redirects are never followed),
 *   - redacts the result with `redactForCheckpoint` before it is returned so
 *     credential-shaped material never reaches checkpoint state.
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
    const pinned = this.opts.getPinnedIps(pluginId);
    if (!pinned || pinned.length === 0) {
      throw new JobError(
        "plugin_unavailable",
        `plugin '${pluginId}' has no SSRF-validated pinned IPs; reload the ` +
          "plugin store or reinstall the plugin before running background jobs",
      );
    }
    const resolveEndpoint =
      this.opts.resolveEndpoint ?? DEFAULT_ENDPOINT_RESOLVER;
    const url = await resolveEndpoint(pluginId, toolName, args, pinned);
    signal?.throwIfAborted();
    const response = await validatedFetch(
      url,
      {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...buildAuthHeader(credentials),
        },
        body: JSON.stringify(args ?? {}),
      },
      {
        mode: this.opts.mode,
        lookup: this.opts.lookup,
        fetchFn: this.opts.fetchFn,
        // Re-resolution must apply the SAME trusted-hosts policy the pins were
        // computed under, or an admin-trusted internal plugin (e.g. `vikunja.local`
        // behind `*.local`) would be rejected at call time (see ToolExecutorOptions).
        trustedHosts: this.opts.trustedHosts,
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new JobError(
        "job_failed",
        `tool '${toolName}' of plugin '${pluginId}' failed with HTTP ${response.status}`,
      );
    }
    const text = await response.text();
    return redactForCheckpoint(text);
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

export type JobInputFactory = (context: {
  graph: AnyCompiledGraph;
  threadId: string;
  isReplay: boolean;
  signal: AbortSignal;
}) => JobInput | Promise<JobInput>;

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
  inputFactory?: JobInputFactory;
  signal?: AbortSignal;
  /** API-key referenceId; every ledger/pin/checkpoint operation is owner-scoped. */
  owner: string;
  /** Client idempotency key (messageId) — maps to exactly ONE task. */
  intentKey: string;
  /** Human-readable intent; default invoke input when `input` is absent. */
  spec: string;
  /** RAW client conversation thread id (the app's messageId-scoped thread id).
   *  `runJob` hashes it into the checkpoint thread key via
   *  `checkpointThreadId(owner, clientThreadId)`, so a client cannot guess or
   *  collide with another owner's thread id. */
  clientThreadId: string;
  /** Tool plugins this job may call; each must have a credential pin. */
  toolPlugins: string[];
  /** Model plugin id — forwarded to the `buildModel` seam (Phase 3 wires it). */
  modelPluginId: string;
  /** Provider request config forwarded to `buildModel`. */
  modelRequestConfig?: unknown;
  /** Agent system prompt override (Wave 1, Step 4). */
  systemPrompt?: string;
  /** Override the real executor (tests use a recording fake). */
  toolHandler?: JobToolHandler;
  /** Invoke input; defaults to `{ messages: [new HumanMessage(spec)] }`. */
  input?: JobInput;
  /**
   * True when this run is a REPLAY (a resumed stuck task, a restart, or any
   * caller re-running a previously-started job). Replays bind tools with
   * `allowMutatingRetry: false`: a mutating tool whose result is NOT already
   * stored is refused with `tool_retry_forbidden` instead of re-executing a
   * possibly-applied side effect. A task that is `stuck` at admission is a
   * replay regardless of this flag.
   */
  isReplay?: boolean;
};

export type RunJobResult =
  | { status: "succeeded"; taskId: string; threadId: string }
  | { status: "failed"; taskId: string; threadId: string; code: JobErrorCode; error: string }
  | { status: "in_flight"; taskId: string; threadId: string }
  | { status: "already_terminal"; taskId: string; threadId: string; terminalStatus: TaskStatus };

export type StuckTaskOutcome = {
  taskId: string;
  owner: string;
  outcome: "credentials_expired" | "repinned" | JobErrorCode;
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
  registry: PluginRegistry;
  /** In-memory credential pin store. */
  pins: CredentialPinStore;
  /** LangGraph checkpointer shared by every job's graph. */
  checkpointer: BaseCheckpointSaver;
  /** SSRF-validated pins per plugin (defaults to a no-pins resolver). */
  getPinnedIps?: (pluginId: string) => PinnedUrlEntry[] | undefined;
  notification?: NotificationHook;
  /** Model factory seam (Phase 3 transport provides it; absent → plugin_unavailable). */
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
   * Admin-trusted hosts forwarded into the default executor's `validatedFetch`
   * (see `ToolExecutorOptions.trustedHosts`). Wire the plugin store's
   * trusted-host list (env `PLUGINS_TRUSTED_HOSTS`) so admin-trusted internal
   * plugin backends are not rejected at call time.
   */
  trustedHosts?: readonly string[];
  /**
   * Owner-scoped thread-metadata upsert (the checkpoint store's `touchThread`).
   * Populates the thread_owner table so the `/v1/threads` surface works. Runs
   * around every invoke; on failure the error is recorded as the thread's
   * `lastError`. Absent (tests / no store) → no-op.
   */
  touchThread?: (
    owner: string,
    threadId: string,
    lastError?: string | null,
  ) => void;
  /**
   * Shared per-thread lock registry (Phase 3, Wave C2). When supplied, the
   * runner serializes every invoke on a checkpoint thread through the SAME
   * locks the synchronous transport uses, so a background job and a sync
   * stream on one thread cannot interleave. Defaults to a private registry.
   */
  threadLocks?: ThreadLockRegistry;
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
   * Context manager (Phase 4, Wave C). When supplied, `prepareMessages`
   * truncates every model round pair-aware to the configured token limit and
   * `maybeCompactAfterStream` runs INSIDE the held thread lock after a
   * successful invoke. Absent → no truncation, no compaction.
   */
  contextManager?: ContextManager;
  /**
   * Budget manager (Phase 4, Wave A). When supplied, every model dispatch
   * (after fence/pin checks) consumes one `beforeModelCall(owner, "async")`
   * slot; an exhausted window fails the job `budget_exhausted`. Absent →
   * no per-owner model-call budget.
   */
  budget?: BudgetManager;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
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
};

/**
 * Bind the installed tool plugins into `DynamicStructuredTool`s, injecting the
 * pinned credentials per plugin AND tool-call replay dedupe:
 *
 *   - before executing, `hasToolResult(taskId, owner, toolCallId)` → a stored
 *     result is returned WITHOUT re-executing (checkpoint-resume safety);
 *   - after executing, `recordToolResult(...)` persists the result atomically
 *     with the tool-call id and the fence token;
 *   - only `readOnly` tools may be re-run when `allowMutatingRetry` is false
 *     and no stored result exists — a mutating tool that cannot be proven
 *     never-run throws `tool_retry_forbidden`.
 *
 * A tool call invoked WITHOUT a tool-call context (direct/unit invocation)
 * executes immediately with no dedupe — there is no id to dedupe against.
 */
export function bindJobTools(opts: BindJobToolsOptions): DynamicStructuredTool[] {
  const tools: DynamicStructuredTool[] = [];
  const seen = new Set<string>();
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
      tools.push(bindJobTool(opts, plugin, toolDef, credentials));
    }
  }
  return tools;
}

function bindJobTool(
  opts: BindJobToolsOptions,
  plugin: ToolPluginDefinition,
  toolDef: ToolDefinition,
  credentials: Record<string, string>,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: toolDef.name,
    description: toolDef.description,
    schema: jsonSchemaToZod(toolDef.inputSchema),
    func: async (input, _runManager, config) => {
      const assertActive = () => {
        opts.signal?.throwIfAborted();
        config?.signal?.throwIfAborted();
        const task = opts.ledger.getTask(opts.taskId, opts.owner);
        if (!task || task.status !== "running" || task.fence_token !== opts.fenceToken) {
          throw new JobError("task_conflict", "background job no longer holds a running task fence");
        }
        opts.assertActive?.();
      };
      assertActive();
      const pin = opts.getCredentials?.(plugin.id);
      const invocationCredentials = pin?.credentials ?? { ...credentials };
      const signal = opts.signal && config?.signal
        ? AbortSignal.any([opts.signal, config.signal])
        : opts.signal ?? config?.signal;
      const execute = async () => {
        assertActive();
        const result = await opts.handler.execute(
          plugin.id,
          toolDef.name,
          input as Record<string, unknown>,
          invocationCredentials,
          signal,
        );
        assertActive();
        return result;
      };
      const toolCallId = (
        config as { toolCall?: { id?: string } } | undefined
      )?.toolCall?.id;
      if (!toolCallId) {
        if (!opts.allowMutatingRetry && !canRetryTool({ readOnly: toolDef.readOnly })) {
          throw new JobError("tool_retry_forbidden", "cannot replay a mutating tool without a stored result");
        }
        return execute();
      }
      if (
        hasToolResult(opts.ledger, {
          taskId: opts.taskId,
          owner: opts.owner,
          toolCallId,
        })
      ) {
        const step = opts.ledger.getStepByToolCallId(
          opts.taskId,
          toolCallId,
          opts.owner,
        );
        return step?.result ?? "";
      }
      // Phase 4, Wave B: the in-memory tool-result cache sits AFTER the ledger
      // replay dedupe (a stored step is always authoritative, never shadowed
      // by a warm cache) and BEFORE the mutating-retry guard (read-only tools
      // may be served from the cache even during a replay). Only read-only
      // tools are cacheable; a hit returns the redacted cached result and
      // SKIPS recordToolResult — the per-task ledger stays untouched for a
      // cached serve.
      const cache = opts.toolCache;
      let cacheKey: ToolCacheKey | undefined;
      if (cache && canRetryTool({ readOnly: toolDef.readOnly })) {
        cacheKey = {
          owner: opts.owner,
          pluginId: plugin.id,
          pluginVersion: plugin.version,
          credentialFingerprint:
            pin?.fingerprint ?? opts.fingerprintsByPlugin?.[plugin.id] ??
            credentialFingerprint(invocationCredentials),
          tool: toolDef.name,
          argsHash: cache.argsHash(input as Record<string, unknown>),
        };
        const cached = cache.get(cacheKey);
        if (cached !== undefined) return redactForCheckpoint(cached);
      }
      if (!opts.allowMutatingRetry && !canRetryTool({ readOnly: toolDef.readOnly })) {
        throw new JobError(
          "tool_retry_forbidden",
          `tool '${toolDef.name}' of plugin '${plugin.id}' is not read-only and has ` +
            "no stored result; refusing to re-execute a possibly-applied side effect",
        );
      }
      const result = String(await execute());
      if (cacheKey) cache?.set(cacheKey, result);
      recordToolResult(opts.ledger, {
        taskId: opts.taskId,
        owner: opts.owner,
        fenceToken: opts.fenceToken,
        toolCallId,
        toolName: toolDef.name,
        result,
      });
      return result;
    },
  });
}

function createJobExecution(signal: AbortSignal) {
  const pending = new Set<Promise<unknown>>();
  return {
    signal,
    async track<T>(run: () => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      const work = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return run();
      });
      pending.add(work);
      try {
        return await work;
      } finally {
        pending.delete(work);
      }
    },
    async settle(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

function trackJobModelExecution(
  model: BaseChatModel,
  execution: ReturnType<typeof createJobExecution>,
): void {
  const seen = new WeakSet<object>();
  const wrap = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (!(candidate instanceof BaseChatModel)) {
      if ("bound" in candidate) wrap(candidate.bound);
      return;
    }
    const generate = candidate._generate.bind(candidate);
    candidate._generate = (...args) => execution.track(() => generate(...args));
    const chunks = candidate._streamResponseChunks.bind(candidate);
    if (candidate._streamResponseChunks !== BaseChatModel.prototype._streamResponseChunks) {
      candidate._streamResponseChunks = async function* (...args) {
        let finish!: () => void;
        const done = new Promise<void>((resolve) => { finish = resolve; });
        const tracked = execution.track(() => done);
        try {
          execution.signal.throwIfAborted();
          yield* chunks(...args);
        } finally {
          finish();
          await tracked;
        }
      };
    }
    const bind = candidate.bindTools?.bind(candidate);
    if (bind) {
      candidate.bindTools = (...args) => {
        const bound = bind(...args);
        wrap(bound);
        return bound;
      };
    }
  };
  wrap(model);
}

export class JobRunner {
  private readonly threadLocks: ThreadLockRegistry;
  private readonly deps: JobRunnerDeps;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly pinUsers = new Map<CredentialPinHandle, number>();
  private readonly controllers = new Set<AbortController>();

  constructor(deps: JobRunnerDeps) {
    this.deps = deps;
    this.threadLocks = deps.threadLocks ?? new ThreadLockRegistry();
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

  /** Live per-thread mutex map (tests assert the GC behavior). */
  get mutexes(): Map<string, AsyncMutex> {
    return this.threadLocks.mutexes;
  }

  /** Owner-scoped status-by-idempotency-key (the client's poll-after-drop). */
  getJobStatus(owner: string, intentKey: string): TaskRow | null {
    return this.deps.ledger.getTaskByIntentKey(owner, intentKey);
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
    const { owner, intentKey, spec, clientThreadId, toolPlugins } = descriptor;
    // The checkpoint thread key is the owner-bound hash of the RAW client
    // thread id (checkpoints/store.ts): an unguessable, owner-scoped key.
    const threadId = checkpointThreadId(owner, clientThreadId);

    // 1. Owner-scoped idempotent admission.
    let task = await getOrCreateTask(this.deps.ledger, {
      owner,
      intentKey,
      spec,
    });

    // 2. Duplicate/in-flight handling — never double-execute. M6: a running
    //    task whose heartbeat has gone stale past the stuck-timeout means the
    //    worker crashed — mark it `stuck` and treat THIS call as the resume
    //    instead of returning `in_flight` forever (which would wedge the
    //    intentKey until a reboot).
    if (task.status === "running") {
      const marked = this.deps.ledger.markStuckIfHeartbeatStale(task.id);
      if (marked && marked.status === "stuck") {
        task = marked;
      } else {
        return { status: "in_flight", taskId: task.id, threadId };
      }
    }

    // 2b. Replay semantics (H3): a task admitted as `stuck` (crashed/restarted
    //     worker) IS a resume, so mutating tools with no stored result must
    //     not re-execute; an explicit `isReplay` forces the same for any
    //     caller. Fresh (queued) jobs may retry mutating tools.
    const replaying = descriptor.isReplay === true || task.status === "stuck";

    // 3. Claim: lease + fresh fence token. A `stuck` task is resumed (new
    //    fence) so the checkpoint re-run owns a live lease.
    let claimed: TaskRow;
    if (task.status === "queued") {
      try {
        claimed = this.deps.ledger.claimTask(task.id, owner);
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
    const fenceToken = claimed.fence_token;

    // 4. Timer heartbeat covers the WHOLE job (pin fetch → graph invoke →
    //    tool execution); started INSIDE the try so a misconfigured interval
    //    (H2) fails the job cleanly with an error step + pin release instead
    //    of orphaning the task as `running` forever. Stopped in the finally.
    let heartbeat: { stop(): void } | undefined;
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = descriptor.signal
      ? AbortSignal.any([descriptor.signal, controller.signal])
      : controller.signal;
    const assertActive = () => {
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
      //    a side effect the crashed run may already have executed.
      const assertDispatch = () => {
        assertActive();
        for (const pluginId of Object.keys(descriptor.pinHandles ?? {})) getCredentials(pluginId);
      };
      const beforeModelCall = (messages: unknown) => {
        void messages;
        assertDispatch();
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
      const execution = createJobExecution(signal);
      trackJobModelExecution(model, execution);
      const executor = this.deps.executor ?? this.createDefaultExecutor();
      const handler = descriptor.toolHandler ?? executor;
      const tools = bindJobTools({
        registry: this.deps.registry,
        handler: {
          execute: (...args) => execution.track(() => handler.execute(...args)),
        },
        credentialsByPlugin,
        getCredentials,
        assertActive,
        signal,
        fingerprintsByPlugin,
        toolCache: this.deps.toolCache,
        ledger: this.deps.ledger,
        taskId: claimed.id,
        owner,
        fenceToken,
        allowMutatingRetry: !replaying,
      });
      const graph = compileGraphWithCheckpointer(
        createAgentGraph({
          model,
          tools,
          systemPrompt: descriptor.systemPrompt,
          beforeModelCall,
          prepareMessages: this.deps.contextManager?.prepareMessages,
        }),
        this.deps.checkpointer,
      );

      // 7. Per-thread mutex + checkpoint_id optimistic locking. The owner
      //    mapping for the thread is recorded (M1) so the /v1/threads surface
      //    can resolve ownership. The mutex is the SHARED ThreadLockRegistry
      //    when the transport supplied one (Wave C2): a sync stream and a
      //    background job on the same thread serialize against each other.
      this.deps.touchThread?.(owner, threadId);
      const result = await this.threadLocks.runExclusive(threadId, async () => {
        try {
          assertDispatch();
          let input: JobInput;
          const state = replaying
            ? await graph.getState({ configurable: { thread_id: threadId } })
            : undefined;
          if (state?.next?.length) {
            input = null;
          } else if (descriptor.inputFactory) {
            input = await descriptor.inputFactory({ graph, threadId, isReplay: replaying, signal });
          } else {
            input = descriptor.input === undefined
              ? { messages: [new HumanMessage(spec)] }
              : descriptor.input;
          }
          assertDispatch();
          const invokeResult = await this.invokeWithCheckpointLock(graph, threadId, input, signal, assertDispatch);
          await execution.settle();
          assertDispatch();
          await this.deps.contextManager?.maybeCompactAfterStream({
            graph,
            owner,
            clientThreadId,
            threadId,
            lockHeld: true,
          });
          return invokeResult;
        } catch (error) {
          controller.abort(error);
          throw error;
        } finally {
          await execution.settle();
        }
      });
      assertActive();

      // 8. Success.
      this.safeComplete(claimed.id, owner, fenceToken, "succeeded");
      const summary = JSON.stringify({
        status: "succeeded",
        messages: Array.isArray(result?.messages) ? result.messages.length : 0,
      });
      await this.notify(owner, claimed.id, summary);
      return { status: "succeeded", taskId: claimed.id, threadId };
    } catch (e) {
      const code = jobErrorCodeOf(e);
      this.deps.touchThread?.(owner, threadId, errorMessageOf(e));
      return this.failJob(claimed, owner, fenceToken, threadId, code, errorMessageOf(e));
    } finally {
      heartbeat?.stop();
      controller.abort();
      this.controllers.delete(controller);
    }
  }

  /**
   * Best-effort startup pass for the restart-loss story. Finds `stuck` tasks
   * (already marked by `ledger.reconcileOrphans()` at boot) and tries to
   * re-establish their credential pins via the `credentialSource` seam. When
   * pins can't be re-established — the honest default, since the in-memory pin
   * store is empty after a restart and Wave C1 has no vault — the task fails
   * cleanly with `credentials_expired` and the notification hook fires.
   *
   * The ledger persists owner/spec only (not the job's plugin set), so every
   * `stuck` task in the gateway's ledger is processed and the `credentialSource`
   * seam resolves keys by (owner, task). When a source re-establishes pins AND
   * a `buildModel` seam is wired, the task is re-run through the full `runJob`
   * path as a REPLAY (H3) — mutating tools with no stored result fail
   * `tool_retry_forbidden`; without a model seam the task is resumed so a later
   * scheduler pass (Phase 3 transport) can re-run it from the checkpoint.
   */
  async resumeStuckJobs(): Promise<ResumeStuckJobsResult> {
    const stuck = this.deps.ledger
      .listTasks()
      .filter((task) => task.status === "stuck");
    const outcomes: StuckTaskOutcome[] = [];
    for (const task of stuck) {
      try {
        const reestablished = this.deps.credentialSource
          ? await this.deps.credentialSource(task.owner, task)
          : null;
        if (reestablished !== null && reestablished !== undefined) {
          for (const [pluginId, credentials] of Object.entries(reestablished)) {
            this.deps.pins.pin(task.owner, pluginId, credentials);
          }
          if (this.deps.buildModel) {
            // Pins restored AND a model seam is wired: identify the model
            // plugin among the restored pins (the registry distinguishes model
            // from tool plugins). A task whose restored pins carry NO model
            // plugin cannot be resumed — the honest restart-loss story is to
            // fail it `plugin_unavailable` (M2), NOT to replay it with an empty
            // model-plugin id (which the seam would mis-map to
            // `credentials_expired`) or with a wrong checkpoint thread.
            const modelPluginId = this.findModelPluginId(reestablished);
            if (modelPluginId === null) {
              outcomes.push(await this.failStuck(task, "plugin_unavailable"));
              continue;
            }
            // Re-run the task through the full runJob path (H3). The task is
            // still `stuck` here, so runJob's admission treats it as a replay —
            // it resumes it under a fresh fence and binds tools with
            // `allowMutatingRetry: false`, so a mutating tool with no stored
            // result fails `tool_retry_forbidden` instead of re-executing a
            // possibly-applied side effect.
            const replay = await this.runJob({
              owner: task.owner,
              intentKey: task.intent_key,
              spec: task.spec,
              // M2: replay on the thread the ORIGINAL job actually used — the
              // transport stores the raw client thread id in the task's
              // `worker` column at admission — never `intent_key` (re-hashing
              // the intent key would checkpoint a DIFFERENT thread and silently
              // replay the job against empty state).
              clientThreadId: task.worker ?? task.intent_key,
              toolPlugins: Object.keys(reestablished).filter(
                (pluginId) => pluginId !== modelPluginId,
              ),
              modelPluginId,
              isReplay: true,
            });
            outcomes.push({
              taskId: task.id,
              owner: task.owner,
              outcome:
                replay.status === "failed" ? replay.code : "repinned",
            });
          } else {
            // No model seam (Phase 3 transport): resume the task so a later
            // scheduler pass can re-run its graph from the checkpoint.
            this.deps.ledger.resumeTask(task.id, task.owner);
            outcomes.push({ taskId: task.id, owner: task.owner, outcome: "repinned" });
          }
        } else {
          outcomes.push(await this.failStuck(task, "credentials_expired"));
        }
      } catch (e) {
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
    if (this.sweepTimer) {
      const clearInterval =
        this.deps.clearInterval ?? globalThis.clearInterval.bind(globalThis);
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
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
    });
  }

  /**
   * The model plugin id among a restored pin set, or null when the set carries
   * no installed model plugin. `resumeStuckJobs` uses this to re-run a stuck
   * task through `runJob` — an empty/missing model plugin id must fail
   * `plugin_unavailable`, never replay onto a mis-identified model (M2).
   */
  private findModelPluginId(
    restored: Record<string, Record<string, string>>,
  ): string | null {
    for (const pluginId of Object.keys(restored)) {
      let plugin;
      try {
        plugin = this.deps.registry.requirePlugin(pluginId);
      } catch {
        continue; // not installed anymore — cannot be the model plugin
      }
      if (isToolPlugin(plugin)) continue;
      if (plugin.type === "model") return pluginId;
    }
    return null;
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
        "no buildModel seam is wired (the Phase 3 transport supplies it); " +
          "cannot build a chat model for a background job",
      );
    }
    return this.deps.buildModel(
      descriptor.modelPluginId,
      descriptor.modelRequestConfig,
      context,
    );
  }

  /**
   * Per-thread invocation mutex + `checkpoint_id` optimistic locking.
   *
   * The mutex (an {@link AsyncMutex} per thread_id) guarantees that only ONE
   * `graph.invoke` runs against a given checkpoint thread at a time within this
   * process — Node is single-threaded, but concurrent jobs would otherwise
   * interleave at await points and clobber each other's checkpoint writes.
   *
   * The optimistic lock is defense-in-depth for writers the mutex cannot see
   * (Phase 3's synchronous transport on the same thread, or a second gateway
   * instance sharing the checkpoint DB). It reads the thread's checkpoint_id
   * before the invoke, runs the invoke, then re-reads:
   *
   *   - our invoke's final checkpoint id (`ownFinalId`, via `graph.getState`);
   *   - the thread's CURRENT checkpoint id after that.
   *
   * If the current id advanced PAST our own write (`ownFinalId !== currentId`),
   * another writer interleaved: we RE-READ the merged graph state and
   * RE-EVALUATE once — re-applying the ORIGINAL input messages on top of the
   * merged state so the user's input survives a superseding writer (M5), and
   * never more than one re-evaluation.
   */
  private async invokeWithCheckpointLock(
    graph: AnyCompiledGraph,
    threadId: string,
    input: JobInput,
    signal: AbortSignal,
    assertActive: () => void,
  ): Promise<any> {
    const beforeId = await this.readCheckpointId(threadId);
    assertActive();
    const result = await graph.invoke(input, {
      configurable: { thread_id: threadId },
      signal,
    });
    assertActive();
    const ownFinalId = await this.readOwnFinalCheckpointId(graph, threadId);
    const currentId = await this.readCheckpointId(threadId);
    if (
      beforeId !== null &&
      ownFinalId !== null &&
      currentId !== null &&
      ownFinalId !== currentId
    ) {
      console.warn(
        `[jobs] thread ${threadId}: checkpoint advanced past our write ` +
          `(${ownFinalId} -> ${currentId}); re-reading state and re-evaluating ` +
          "once with the original input",
      );
      assertActive();
      return graph.invoke(
        input,
        { configurable: { thread_id: threadId }, signal },
      );
    }
    return result;
  }

  private async readCheckpointId(threadId: string): Promise<string | null> {
    try {
      const checkpoint = await this.deps.checkpointer.get({
        configurable: { thread_id: threadId },
      });
      return checkpoint?.id ?? null;
    } catch {
      return null;
    }
  }

  private async readOwnFinalCheckpointId(
    graph: AnyCompiledGraph,
    threadId: string,
  ): Promise<string | null> {
    try {
      const state = await graph.getState({
        configurable: { thread_id: threadId },
      });
      const id = state?.config?.configurable?.checkpoint_id;
      return typeof id === "string" ? id : null;
    } catch {
      return null;
    }
  }

  /** Completes a task only if we still hold its fence (never clobber a successor). */
  private safeComplete(
    taskId: string,
    owner: string,
    fenceToken: string,
    to: "succeeded" | "failed" | "cancelled" | "awaiting_review",
  ): void {
    const current = this.deps.ledger.getTask(taskId, owner);
    if (!current || current.status !== "running" || current.fence_token !== fenceToken) {
      throw new JobError("task_conflict", "background job cannot complete without its running task fence");
    }
    this.deps.ledger.completeTask(taskId, owner, to);
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
    const redacted = redactForCheckpoint(message);
    try {
      const current = this.deps.ledger.getTask(claimed.id, owner);
      if (current?.status === "running" && current.fence_token === fenceToken) {
        this.deps.ledger.appendStep(
          claimed.id,
          owner,
          { stage: "error", action: `error:${code}`, result: redacted },
          fenceToken,
        );
        this.deps.ledger.completeTask(claimed.id, owner, "failed");
      }
    } catch (err) {
      // Best-effort: another pass already moved the task; never throw out.
      console.warn(`[jobs] failed to record failure for task ${claimed.id}:`, err);
    }
    void this.notify(owner, claimed.id, `failed: ${code}`);
    return { status: "failed", taskId: claimed.id, threadId, code, error: redacted };
  }

  /** Fails a `stuck` task (resume → step → failed) and notifies. Best-effort. */
  private async failStuck(
    task: TaskRow,
    code: JobErrorCode,
  ): Promise<StuckTaskOutcome> {
    try {
      const resumed = this.deps.ledger.resumeTask(task.id, task.owner);
      this.deps.ledger.appendStep(
        task.id,
        task.owner,
        {
          stage: "error",
          action: `error:${code}`,
          result: redactForCheckpoint(
            `orphaned background job cannot resume after restart: ${code}`,
          ),
        },
        resumed.fence_token,
      );
      this.deps.ledger.completeTask(task.id, task.owner, "failed");
    } catch (err) {
      // Best-effort: another pass already handled this task.
      console.warn(`[jobs] failed to fail stuck task ${task.id}:`, err);
    }
    await this.notify(task.owner, task.id, `failed: ${code} (restart loss)`);
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