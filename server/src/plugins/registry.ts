import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { isModelPlugin, isToolPlugin, isAgentPlugin } from "./types.ts";
import type { CredentialSpec, PluginDefinition, ToolDefinition } from "./types.ts";
import { PluginStore } from "./store.ts";

/**
 * `PluginRegistry` is the read-side lifecycle view over a `PluginStore` —
 * what the plugin routes and (later) the chat route resolve plugin IDs
 * against.
 *
 * SECURITY CONTRACT (Phase 1, plan §3.3): `GET /v1/models` and
 * `GET /v1/plugins` must never leak allowlisted base URLs — they can point at
 * admin-trusted internal hosts (`vikunja.local`, RFC1918 IPs, ...). That is
 * enforced here by design: `listAvailablePlugins()` REDACTS `baseUrls` url
 * strings and a model plugin's `inference.endpoint` (ids + display labels
 * only). Only `getPluginDetails()` (reserved for the auth-gated
 * `GET /v1/plugins/:id`) may include URLs. Neither shape ever carries
 * credential VALUES — the store persists spec-only credentials.
 */

export type PluginRegistryErrorCode =
  | "PLUGIN_NOT_FOUND"
  | "PLUGIN_DISABLED"
  | "PLUGIN_REMOVED";

export class PluginRegistryError extends Error {
  readonly code: PluginRegistryErrorCode;

  constructor(code: PluginRegistryErrorCode, message: string) {
    super(message);
    this.name = "PluginRegistryError";
    this.code = code;
  }
}

export type PluginSummary = {
  id: string;
  type: "tool" | "model" | "agent";
  name: string;
  description: string;
  version: string;
  schemaVersion: number;
  installed: boolean;
  /** Redacted: id + label only — url values never leave the registry. */
  baseUrls: Array<{ id: string; label?: string }>;
  /** Spec-only (label/required flags) — never values; safe for client UI. */
  credentials?: CredentialSpec;
  /** Tool plugins only. */
  tools?: ToolDefinition[];
  /** Model plugins only — `endpoint` deliberately omitted (redacted). */
  inference?: {
    defaultModel: string;
    tokenLimit: number;
    supportsStreaming: boolean;
    visionCapable: boolean;
  };
  /** Agent plugins only — redacted summary (no systemPrompt/skills contents). */
  agent?: {
    modelRef?: string;
    toolGrants?: { pluginId: string; required: boolean }[];
    temperature?: number;
    maxTokens?: number;
    visionCapable: boolean;
    skillCount: number;
  };
};

export type WatchOptions = {
  debounceMs?: number;
  signal?: AbortSignal;
  onError?: (err: unknown) => void;
};

export class PluginRegistry {
  private watcher: FSWatcher | null = null;
  private watchAbort: AbortController | null = null;
  private watchTimer: NodeJS.Timeout | null = null;

  constructor(private readonly store: PluginStore) {}

  listInstalledPlugins(): PluginDefinition[] {
    return this.store.getInstalled();
  }

  /**
   * Public list payload (`GET /v1/plugins`). Redacts url values by design (see
   * the module-level security contract).
   */
  listAvailablePlugins(): PluginSummary[] {
    const installedIds = new Set(this.listInstalledPlugins().map((p) => p.id));
    return this.store
      .listAvailable()
      .map((plugin) => summarizePlugin(plugin, installedIds.has(plugin.id)));
  }

  /**
   * Auth-gated detail payload (`GET /v1/plugins/:id`). Full definition —
   * baseUrls include their url values here, but credentials remain spec-only.
   */
  getPluginDetails(id: string): (PluginDefinition & { installed: boolean }) | undefined {
    const installedIds = new Set(this.listInstalledPlugins().map((p) => p.id));
    const plugin = this.store.listAvailable().find((p) => p.id === id);
    if (!plugin) return undefined;
    return { ...plugin, installed: installedIds.has(id) };
  }

  /**
   * Resolve a plugin the chat/tool route is about to use. Installed plugins
   * resolve; known-but-not-installed → `PLUGIN_DISABLED`; unknown →
   * `PLUGIN_NOT_FOUND`. Messages are actionable so the client can render
   * "enable it in the plugin store". `PLUGIN_REMOVED` is reserved for callers
   * that previously resolved a plugin and must distinguish a vanished
   * definition (e.g. after a hot-reload dropped it) from a never-known id.
   */
  requirePlugin(id: string): PluginDefinition {
    const installed = this.store.getPlugin(id);
    if (installed) return installed;

    if (this.store.listAvailable().some((p) => p.id === id)) {
      throw new PluginRegistryError(
        "PLUGIN_DISABLED",
        `plugin '${id}' is available but not installed; install it in the plugin store to use it`,
      );
    }
    throw new PluginRegistryError(
      "PLUGIN_NOT_FOUND",
      `plugin '${id}' is not installed; enable it in the plugin store, or verify the id`,
    );
  }

  canResolveModelPlugin(id: string): boolean {
    return this.store.getPlugin(id)?.type === "model";
  }

  canResolveToolPlugin(id: string): boolean {
    return this.store.getPlugin(id)?.type === "tool";
  }

  canResolveAgentPlugin(id: string): boolean {
    return this.store.getPlugin(id)?.type === "agent";
  }

  /** Re-read the store file (called after fs.watch fires, or by an endpoint). */
  async hotReload(): Promise<void> {
    await this.store.reload();
  }

  /**
   * Hot-reload wiring: `fs.watch` on the store's parent DIRECTORY (survives
   * the rename-over that atomic saves use), filtered to the store file,
   * debounced, error-tolerant, with an AbortSignal for tests. Self-saves are
   * coordinated via the store's content snapshot, so a save can never trigger
   * a reload loop.
   */
  watch(opts: WatchOptions = {}): void {
    const debounceMs = opts.debounceMs ?? 150;
    const dir = dirname(this.store.path);
    const fileName = basename(this.store.path);

    this.disposeWatch();

    const abort = new AbortController();
    this.watchAbort = abort;
    const signal = opts.signal ?? abort.signal;
    const isAborted = (): boolean =>
      abort.signal.aborted || opts.signal?.aborted === true;

    const watcher = watch(dir, { signal }, (_eventType, filename) => {
      if (filename !== null && filename !== fileName) return;
      if (isAborted()) return;
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        this.watchTimer = null;
        this.hotReload().catch((err) => {
          if (isAborted()) return;
          if (opts.onError) opts.onError(err);
          else console.error("plugin registry: store hot-reload failed:", err);
        });
      }, debounceMs);
    });

    watcher.on("error", (err) => {
      if (isAborted()) return;
      if (opts.onError) opts.onError(err);
      else console.error("plugin registry: store file watch error:", err);
    });

    this.watcher = watcher;
  }

  /** Stop watching; also invoked implicitly when `watch()` is re-entered. */
  disposeWatch(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    this.watchAbort?.abort();
    this.watchAbort = null;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // already closed via signal abort; ignore
      }
      this.watcher = null;
    }
  }
}

/** Redact an allowlist entry to its id + label (url values never exposed). */
function redactEntry(entry: { id: string; label?: string }): {
  id: string;
  label?: string;
} {
  return entry.label === undefined ? { id: entry.id } : { id: entry.id, label: entry.label };
}

function summarizePlugin(plugin: PluginDefinition, installed: boolean): PluginSummary {
  const summary: PluginSummary = {
    id: plugin.id,
    type: plugin.type,
    name: plugin.name,
    description: plugin.description,
    version: plugin.version,
    schemaVersion: plugin.schemaVersion,
    installed,
    baseUrls: [],
  };

  if (isToolPlugin(plugin)) {
    summary.baseUrls = plugin.baseUrls.map(redactEntry);
    summary.tools = plugin.tools;
    if (plugin.credentials) summary.credentials = plugin.credentials;
  } else if (isModelPlugin(plugin)) {
    summary.baseUrls = (plugin.baseUrls ?? []).map(redactEntry);
    summary.inference = {
      defaultModel: plugin.inference.defaultModel,
      tokenLimit: plugin.inference.tokenLimit,
      supportsStreaming: plugin.inference.supportsStreaming,
      visionCapable: plugin.inference.visionCapable,
    };
    if (plugin.credentials) summary.credentials = plugin.credentials;
  } else if (isAgentPlugin(plugin)) {
    summary.baseUrls = (plugin.baseUrls ?? []).map(redactEntry);
    if (plugin.credentials) summary.credentials = plugin.credentials;
    summary.agent = {
      modelRef: plugin.modelRef,
      toolGrants: plugin.tools,
      temperature: plugin.inference?.temperature,
      maxTokens: plugin.inference?.maxTokens,
      visionCapable: plugin.inference?.visionCapable ?? false,
      skillCount: plugin.skills?.length ?? 0,
    };
  }
  return summary;
}