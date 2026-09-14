import { HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
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
import type { CredentialPinStore } from "../credentials/pins.ts";
import { credentialFingerprint } from "../plugins/credential.ts";
import type { ToolCacheKey, ToolResultCache } from "../middleware/cache.ts";
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
  | "tool_retry_forbidden";

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
  ): Promise<string> {
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
    const response = await validatedFetch(
      url,
      {
        method: "POST",
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
    if (response.status >= 300) {
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

export type JobDescriptor = {
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
  /** Override the real executor (tests use a recording fake). */
  toolHandler?: ToolCallHandler;
  /** Invoke input; defaults to `{ messages: [new HumanMessage(spec)] }`. */
  input?: Record<string, unknown>;
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
  /**
   * Shared in-memory tool-result cache (Phase 4, Wave B). Wraps the async
   * tool handler so a repeated READ-ONLY tool call — same (owner, pluginId,
   * pluginVersion, credentialFingerprint, tool, argsHash) — is served without
   * re-executing the backend, even across different tasks/jobs. Mutating
   * tools are never cached; the per-task ledger replay dedupe ALWAYS wins over
   * this cache. Construct ONE instance in index.ts and share it with the sync
   * transport.
   */
  toolCache?: ToolResultCache;
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
  handler: ToolCallHandler;
  credentialsByPlugin: Record<string, Record<string, string>>;
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
    if (!isToolPlugin(plugin)) continue;
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
      const toolCallId = (
        config as { toolCall?: { id?: string } } | undefined
      )?.toolCall?.id;
      if (!toolCallId) {
        return opts.handler.execute(
          plugin.id,
          toolDef.name,
          input as Record<string, unknown>,
          credentials,
        );
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
            opts.fingerprintsByPlugin?.[plugin.id] ??
            credentialFingerprint(credentials),
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
      const result = String(
        await opts.handler.execute(
          plugin.id,
          toolDef.name,
          input as Record<string, unknown>,
          credentials,
        ),
      );
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

export class JobRunner {
  private readonly threadLocks: ThreadLockRegistry;
  private readonly deps: JobRunnerDeps;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

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

    try {
      heartbeat = this.deps.ledger.startHeartbeat(claimed.id, owner, fenceToken, {
        ...(this.deps.heartbeatIntervalMs
          ? { intervalMs: this.deps.heartbeatIntervalMs }
          : {}),
        onError: (err) => {
          console.warn(`[jobs] heartbeat error for task ${claimed.id}:`, err);
        },
      });

      // 5. Pin credentials per plugin. A missing/expired pin fails the job
      //    BEFORE any graph invoke.
      const credentialsByPlugin: Record<string, Record<string, string>> = {};
      // Phase 4, Wave B: reuse the pin's precomputed credential fingerprint as
      // the cache-key component (never re-derive, never store raw values).
      const fingerprintsByPlugin: Record<string, string> = {};
      for (const pluginId of toolPlugins) {
        const pin = this.deps.pins.get(owner, pluginId);
        credentialsByPlugin[pluginId] = pin.credentials;
        fingerprintsByPlugin[pluginId] = pin.fingerprint;
      }

      // 6. Build the agent with the real executor + replay dedupe. Replays
      //    bind with `allowMutatingRetry: false` (H3): a mutating tool with no
      //    stored result throws `tool_retry_forbidden` rather than re-applying
      //    a side effect the crashed run may already have executed.
      const model = await this.resolveModel(descriptor);
      const executor = this.deps.executor ?? this.createDefaultExecutor();
      const handler = descriptor.toolHandler ?? executor;
      const tools = bindJobTools({
        registry: this.deps.registry,
        handler,
        credentialsByPlugin,
        fingerprintsByPlugin,
        toolCache: this.deps.toolCache,
        ledger: this.deps.ledger,
        taskId: claimed.id,
        owner,
        fenceToken,
        allowMutatingRetry: !replaying,
      });
      const graph = compileGraphWithCheckpointer(
        createAgentGraph({ model, tools }),
        this.deps.checkpointer,
      );

      // 7. Per-thread mutex + checkpoint_id optimistic locking. The owner
      //    mapping for the thread is recorded (M1) so the /v1/threads surface
      //    can resolve ownership. The mutex is the SHARED ThreadLockRegistry
      //    when the transport supplied one (Wave C2): a sync stream and a
      //    background job on the same thread serialize against each other.
      const input = descriptor.input ?? { messages: [new HumanMessage(spec)] };
      this.deps.touchThread?.(owner, threadId);
      const result = await this.threadLocks.runExclusive(threadId, () =>
        this.invokeWithCheckpointLock(graph, threadId, input),
      );

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
      // Release the tool-plugin pins AND the model-plugin pin (Wave C2). The
      // model pin is minted by the transport at admission; the runner owns its
      // lifecycle for the duration of the job. A duplicate (`in_flight`) /
      // terminal re-submit returns BEFORE this try, so the original job's
      // finally is the single release point — never a concurrent racer's.
      for (const pluginId of toolPlugins) {
        this.deps.pins.release(owner, pluginId);
      }
      if (descriptor.modelPluginId !== "") {
        this.deps.pins.release(owner, descriptor.modelPluginId);
      }
      this.sweepPins();
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

  private async resolveModel(descriptor: JobDescriptor): Promise<BaseChatModel> {
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
    input: Record<string, unknown>,
  ): Promise<any> {
    const beforeId = await this.readCheckpointId(threadId);
    const result = await graph.invoke(input, {
      configurable: { thread_id: threadId },
    });
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
      return graph.invoke(
        input,
        { configurable: { thread_id: threadId } },
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
    if (!current || current.fence_token !== fenceToken) return;
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
      if (current && current.fence_token === fenceToken) {
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
  if (e instanceof CredentialPinError) return "credentials_expired";
  return "job_failed";
}

function errorMessageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}