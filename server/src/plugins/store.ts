import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
  isAgentPlugin,
  isModelPlugin,
  isToolPlugin,
  pluginDefinitionSchema,
  parsePluginStoreConfig,
  PluginSchemaError,
} from "./types.ts";
import type {
  CredentialSpec,
  PluginDefinition,
  PluginStoreConfig,
  ToolPluginDefinition,
} from "./types.ts";
import {
  NODE_ENV,
  SsrfValidationError,
  resolveAndValidateHost,
  validateMcpHeaderName,
  validateStaticUrl,
} from "./ssrf.ts";
import type { LookupFn, Mode } from "./ssrf.ts";

/**
 * `PluginStore` persists which tool-plugin manifests an admin has installed
 * (admin-curated), as a JSON file (`PLUGINS_STORE_PATH`, default
 * `./data/plugins.json`).
 *
 * Builtin plugins (shipped in the build, injected via `builtinPlugins`) are
 * ALWAYS available and are NEVER persisted: `install`/`uninstall` operate on
 * manifests only, and uninstalling a builtin is a `BUILTIN_UNINSTALL` error.
 * This keeps the decision minimal — there is no disabling toggle for builtins
 * in Phase 1; a "disable openrouter" knob can be added later as a distinct
 * `toggleBuiltin` operation without disturbing the manifest lifecycle.
 *
 * SSRF posture (see `ssrf.ts`): EVERY allowlisted baseUrl of a plugin being
 * installed is re-validated (`validateStaticUrl` for scheme + literal-IP
 * ranges, plus `resolveAndValidateHost` for per-record DNS-rebinding defense —
 * a hostname resolving to a private address is rejected unless admin-trusted),
 * and the SAME pass runs over every persisted URL on `load()`/`reload()`, so a
 * store written under an older/looser trusted-hosts policy cannot survive a
 * tightening. Validation failures at load/reload leave the store unapplied
 * (last known-good config wins on reload). Validated resolutions are retained
 * (`getPinnedIps`) so Phase 2/3 outbound calls consume the pins instead of
 * re-resolving. `trustedHosts` (from `PLUGINS_TRUSTED_HOSTS`) bypasses RANGE
 * checks only; scheme enforcement (https in prod) is never bypassed.
 *
 * Accidental-publication safety: the persisted store is re-validated with
 * `parsePluginStoreConfig` on load and each install goes through
 * `pluginDefinitionSchema`, whose zod object shapes STRIP unknown keys — a
 * manifest carrying raw credential values (e.g. `credentials.apiKey.value`)
 * loses them before serialization. `save()` also runs a defensive
 * `assertNoCredentialValues` pass so a hand-built config can never write a
 * secret to disk.
 */

export type PluginStoreErrorCode =
  | "NOT_LOADED"
  | "MANIFEST_NOT_FOUND"
  | "PLUGIN_NOT_FOUND"
  | "BUILTIN_UNINSTALL"
  | "INVALID_PLUGIN"
  | "SSRF_REJECTED"
  | "CREDENTIAL_VALUES_FORBIDDEN"
  | "FILE_IO"
  | "CONFIG";

export class PluginStoreError extends Error {
  readonly code: PluginStoreErrorCode;

  constructor(code: PluginStoreErrorCode, message: string) {
    super(message);
    this.name = "PluginStoreError";
    this.code = code;
  }
}

export type PluginStoreOptions = {
  storePath: string;
  /** Admin-trusted hostnames/IPs bypassing SSRF private-range rejection. */
  trustedHosts: readonly string[];
  /** Always-available plugins shipped in the build. Never persisted. */
  builtinPlugins: readonly PluginDefinition[];
  /** Curated installable manifests (the "marketplace"). */
  manifests: readonly ToolPluginDefinition[];
  /**
   * Injectable DNS resolver for install-time SSRF checks. Defaults to
   * `node:dns/promises`; tests inject a mapping so no network is needed.
   */
  lookup?: LookupFn;
  /**
   * Override NODE_ENV for SSRF validation. Defaults to the process NODE_ENV.
   * Pass "production" to enforce https-only at validation time.
   */
  mode?: Mode;
};

function emptyStore(): PluginStoreConfig {
  return {
    schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
    plugins: [],
  };
}

export class PluginStore {
  private config: PluginStoreConfig | null = null;
  private loaded = false;
  /**
   * The exact JSON this instance last wrote. `reload()` skips a re-read that
   * matches it, so a self-save triggered file-watch event is a no-op instead
   * of a reload loop.
   */
  private lastWrittenContent: string | null = null;

  private readonly storePath: string;
  private readonly trustedHosts: readonly string[];
  private readonly builtinPlugins: readonly PluginDefinition[];
  private readonly manifests: readonly ToolPluginDefinition[];
  private readonly lookup?: LookupFn;
  private readonly mode: Mode;
  /**
   * Validated, pinned IPs per plugin, populated whenever a plugin's URLs pass
   * SSRF validation (install and store load/reload). Phase 2/3 outbound-call
   * consumers fetch these via `getPinnedIps` instead of re-resolving, so the
   * resolve-then-validate result is never discarded.
   */
  private readonly pinnedUrls = new Map<
    string,
    Array<{ entryId: string; url: string; pinned: string[] }>
  >();

  constructor(opts: PluginStoreOptions) {
    this.storePath = opts.storePath;
    this.trustedHosts = opts.trustedHosts;
    this.builtinPlugins = opts.builtinPlugins;
    this.manifests = opts.manifests;
    this.lookup = opts.lookup;
    this.mode = opts.mode ?? NODE_ENV;
    this.assertUniqueIds();
  }

  /** Absolute/configured path of the store file (used by the file watcher). */
  get path(): string {
    return this.storePath;
  }

  private assertUniqueIds(): void {
    const seen = new Set<string>();
    for (const plugin of [...this.builtinPlugins, ...this.manifests]) {
      if (seen.has(plugin.id)) {
        throw new PluginStoreError(
          "CONFIG",
          `duplicate plugin id '${plugin.id}' across builtins and manifests; ids must be globally unique`,
        );
      }
      seen.add(plugin.id);
    }
  }

  private assertLoaded(): void {
    if (!this.loaded || this.config === null) {
      throw new PluginStoreError(
        "NOT_LOADED",
        "plugin store is not loaded; call load() before using it",
      );
    }
  }

  private get installedIds(): ReadonlySet<string> {
    return new Set(this.config!.plugins.map((p) => p.id));
  }

  /**
   * Reject a persisted store that defines a plugin id already owned by a
   * builtin. Builtins are always available; an installed copy of the same id
   * would make `getInstalled()`/`getPlugin()` ambiguous. The manifest-vs-
   * builtin side is already rejected by the constructor (`assertUniqueIds`).
   */
  private assertNoBuiltinCollisions(config: PluginStoreConfig): void {
    for (const plugin of config.plugins) {
      if (this.builtinPlugins.some((b) => b.id === plugin.id)) {
        throw new PluginStoreError(
          "CONFIG",
          `plugin store ${this.storePath} contains an installed plugin '${plugin.id}' that ` +
            `collides with a builtin; remove it from plugins.json (builtins are always available)`,
        );
      }
    }
  }

  /** Read the store file. Missing file → empty store written with schemaVersion. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.storePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.config = emptyStore();
        this.loaded = true;
        await this.save();
        return;
      }
      throw new PluginStoreError(
        "FILE_IO",
        `could not read plugin store ${this.storePath}: ${String(err)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new PluginSchemaError(
        `Invalid plugin store JSON at ${this.storePath}: ${(err as Error).message}`,
      );
    }
    // Fail-fast on schema shape AND on schemaVersion mismatch (Step 1's
    // parsePluginStoreConfig throws PluginSchemaError either way), then
    // re-validate the persisted URLs against the CURRENT network policy so a
    // store written under a looser trusted-hosts setting cannot survive a
    // policy tightening (Fix 6).
    const config = parsePluginStoreConfig(parsed);
    this.assertNoBuiltinCollisions(config);
    await this.revalidateSsrSafe(config);
    this.config = config;
    this.loaded = true;
  }

  /**
   * Re-read the store from disk (hot-reload). Ignores a transiently missing
   * file (keeps the last good config) and skips content this instance wrote
   * itself, coordinating with `fs.watch` so a self-save is never a reload.
   */
  async reload(): Promise<void> {
    this.assertLoaded();
    let raw: string;
    try {
      raw = await readFile(this.storePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw new PluginStoreError(
        "FILE_IO",
        `could not read plugin store ${this.storePath}: ${String(err)}`,
      );
    }
    if (raw === this.lastWrittenContent) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new PluginSchemaError(
        `Invalid plugin store JSON at ${this.storePath}: ${(err as Error).message}`,
      );
    }
    // Same revalidation as load(): shape, builtin collisions, then a full SSRF
    // pass over every persisted URL. On failure the previous config stays in
    // effect (the store is left untouched), so a bad hand-edit never activates.
    const config = parsePluginStoreConfig(parsed);
    this.assertNoBuiltinCollisions(config);
    await this.revalidateSsrSafe(config);
    this.config = config;
  }

  /** Installed plugins = builtins (always available) + user-installed manifests. */
  getInstalled(): PluginDefinition[] {
    this.assertLoaded();
    return [...this.builtinPlugins, ...this.config!.plugins];
  }

  getPlugin(id: string): PluginDefinition | undefined {
    return this.getInstalled().find((p) => p.id === id);
  }

  /** Everything the client can see/use: installed + still-installable manifests. */
  listAvailable(): PluginDefinition[] {
    return [...this.getInstalled(), ...this.listInstallableManifests()];
  }

  /** Manifests the user has NOT installed yet. */
  listInstallableManifests(): ToolPluginDefinition[] {
    this.assertLoaded();
    return this.manifests.filter((m) => !this.installedIds.has(m.id));
  }

  /**
   * Install a manifest. Idempotent when already installed. The manifest's
   * allowlisted baseUrls are SSRF-validated first; if any fails, the plugin is
   * NOT installed and an `SSRF_REJECTED` error carries the per-entry reasons.
   */
  async install(manifestId: string): Promise<void> {
    this.assertLoaded();
    const manifest = this.manifests.find((m) => m.id === manifestId);
    if (!manifest) {
      throw new PluginStoreError(
        "MANIFEST_NOT_FOUND",
        `no installable manifest '${manifestId}'; ensure it is curated in the plugin manifests`,
      );
    }
    if (this.installedIds.has(manifest.id)) return;

    const validated = await this.validateAllowedUrls(manifest);

    const mcpValidated = await this.validateMcpUrls(manifest);

    // Re-validate against the plugin schema so unknown keys — including any
    // smuggled credential VALUES — are stripped before the definition reaches
    // disk or memory.
    let definition: PluginDefinition;
    try {
      definition = pluginDefinitionSchema.parse(manifest);
    } catch (err) {
      throw new PluginStoreError(
        "INVALID_PLUGIN",
        `manifest '${manifest.id}' failed plugin schema validation: ${(err as Error).message}`,
      );
    }
    this.config!.plugins.push(definition);
    this.pinnedUrls.set(manifest.id, validated);
    for (const entry of mcpValidated) {
      this.pinnedUrls.set(`${manifest.id}:${entry.entryId}`, [entry]);
    }
    await this.save();
  }

  /**
   * Remove an installed manifest. Builtins can never be uninstalled
   * (`BUILTIN_UNINSTALL`) — they ship with the gateway and are always
   * available.
   */
  async uninstall(pluginId: string): Promise<void> {
    this.assertLoaded();
    if (this.builtinPlugins.some((b) => b.id === pluginId)) {
      throw new PluginStoreError(
        "BUILTIN_UNINSTALL",
        `plugin '${pluginId}' is a builtin and cannot be uninstalled; builtins are always available`,
      );
    }
    const index = this.config!.plugins.findIndex((p) => p.id === pluginId);
    if (index === -1) {
      throw new PluginStoreError(
        "PLUGIN_NOT_FOUND",
        `plugin '${pluginId}' is not installed; nothing to uninstall`,
      );
    }
    this.config!.plugins.splice(index, 1);
    this.pinnedUrls.delete(pluginId);
    for (const key of this.pinnedUrls.keys()) {
      if (key.startsWith(`${pluginId}:mcp:`)) {
        this.pinnedUrls.delete(key);
      }
    }
    await this.save();
  }

  /**
   * Persist atomically: write a temp file in the same directory (same
   * filesystem → rename is atomic), chmod `0600`, then rename over the target.
   * `lastWrittenContent` is snapshotted so the file watcher's reload is a no-op.
   */
  async save(): Promise<void> {
    this.assertLoaded();
    this.assertNoCredentialValues(this.config!);

    const json = `${JSON.stringify(this.config, null, 2)}\n`;
    const tmpPath = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.storePath), { recursive: true });
      await writeFile(tmpPath, json, { encoding: "utf8" });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, this.storePath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw new PluginStoreError(
        "FILE_IO",
        `could not write plugin store ${this.storePath}: ${String(err)}`,
      );
    }
    this.lastWrittenContent = json;
  }

  /** Collect the allowlisted URLs of a plugin (tool baseUrls; model endpoint + baseUrls). */
  private urlEntries(plugin: PluginDefinition): Array<{ id: string; url: string }> {
    const entries: Array<{ id: string; url: string }> = [];
    if (isToolPlugin(plugin)) {
      for (const entry of plugin.baseUrls) {
        entries.push({ id: entry.id, url: entry.url });
      }
    } else if (isModelPlugin(plugin)) {
      entries.push({ id: "inference.endpoint", url: plugin.inference.endpoint });
      for (const entry of plugin.baseUrls ?? []) {
        entries.push({ id: entry.id, url: entry.url });
      }
    }
    return entries;
  }

  private mcpEntries(plugin: PluginDefinition): Array<{ id: string; url: string }> {
    if (!isAgentPlugin(plugin)) return [];
    return (plugin.mcpServers ?? []).map((server) => ({
      id: `mcp:${server.name}`,
      url: server.url,
    }));
  }

  private async validateMcpUrls(
    plugin: PluginDefinition,
  ): Promise<Array<{ entryId: string; url: string; pinned: string[] }>> {
    if (!isAgentPlugin(plugin)) return [];
    const servers = plugin.mcpServers ?? [];
    for (const server of servers) {
      if (server.headers) {
        this.validateMcpHeaders(plugin.id, server.name, server.headers);
      }
    }
    return this.validateUrlEntries(plugin.id, this.mcpEntries(plugin), "MCP server URLs");
  }

  private validateMcpHeaders(
    pluginId: string,
    serverName: string,
    headers: Record<string, string>,
  ): void {
    for (const name of Object.keys(headers)) {
      if (name === "") {
        throw new PluginStoreError(
          "SSRF_REJECTED",
          `plugin '${pluginId}' MCP server '${serverName}' has an empty header name`,
        );
      }
      try {
        validateMcpHeaderName(name);
      } catch (e) {
        if (e instanceof SsrfValidationError) {
          if (e.message.includes("invalid characters")) {
            throw new PluginStoreError(
              "SSRF_REJECTED",
              `plugin '${pluginId}' MCP server '${serverName}' header '${name}' contains invalid characters; ` +
                "header names may only contain a-z, A-Z, 0-9, underscore, and hyphen",
            );
          }
          throw new PluginStoreError(
            "SSRF_REJECTED",
            `plugin '${pluginId}' MCP server '${serverName}' header '${name}' is a known-dangerous override ` +
              "and is rejected",
          );
        }
        throw e;
      }
    }
  }

  /**
   * Install-time SSRF gate: every allowlisted URL is statically + DNS-validated.
   * Returns per-entry pinned IPs (never discarded — it is the only place that
   * resolves the URL, and Phase 2/3 outbound callers consume them via
   * `getPinnedIps`).
   */
  private async validateAllowedUrls(
    plugin: PluginDefinition,
  ): Promise<Array<{ entryId: string; url: string; pinned: string[] }>> {
    return this.validateUrlEntries(plugin.id, this.urlEntries(plugin));
  }

  /**
   * Validate a set of URL entries: `validateStaticUrl` for scheme + literal-IP
   * ranges, then `resolveAndValidateHost` for per-record DNS-rebinding defense
   * (a hostname resolving to a private address is rejected unless
   * admin-trusted). Aggregates per-entry reasons into one SSRF_REJECTED error.
   * Returns the validated pin list on success.
   */
  private async validateUrlEntries(
    pluginId: string,
    entries: Array<{ id: string; url: string }>,
    context: string = "baseUrls",
  ): Promise<Array<{ entryId: string; url: string; pinned: string[] }>> {
    const failures: string[] = [];
    const validated: Array<{ entryId: string; url: string; pinned: string[] }> = [];
    for (const entry of entries) {
      try {
        validateStaticUrl(entry.url, { trustedHosts: this.trustedHosts, mode: this.mode });
        const { hostname } = new URL(entry.url);
        const pinned = await resolveAndValidateHost(hostname, {
          trustedHosts: this.trustedHosts,
          lookup: this.lookup,
        });
        validated.push({ entryId: entry.id, url: entry.url, pinned });
      } catch (err) {
        if (err instanceof SsrfValidationError) {
          failures.push(`  ${entry.id} (${entry.url}): ${err.message}`);
        } else {
          throw err;
        }
      }
    }
    if (failures.length > 0) {
      throw new PluginStoreError(
        "SSRF_REJECTED",
        `plugin '${pluginId}' ${context} are not SSRF-safe under the configured trusted hosts:\n${failures.join("\n")}\n` +
          `list any legitimately-internal hosts in PLUGINS_TRUSTED_HOSTS`,
      );
    }
    return validated;
  }

  /**
   * Load/reload-time SSRF gate over the persisted store: URLs installed under
   * an older/looser policy — or hand-edited into `plugins.json` — are
   * re-validated against the CURRENT trusted hosts on every read, so tightening
   * the policy can never leave stale unsafe entries active. On any disallowed
   * entry throws SSRF_REJECTED and the configuration is NOT applied (reload
   * keeps the last known-good config).
   */
  private async revalidateSsrSafe(config: PluginStoreConfig): Promise<void> {
    const failures: string[] = [];
    for (const plugin of config.plugins) {
      try {
        const validated = await this.validateUrlEntries(plugin.id, this.urlEntries(plugin));
        this.pinnedUrls.set(plugin.id, validated);
        const mcpValidated = await this.validateMcpUrls(plugin);
        for (const entry of mcpValidated) {
          this.pinnedUrls.set(`${plugin.id}:${entry.entryId}`, [entry]);
        }
      } catch (err) {
        if (err instanceof PluginStoreError && err.code === "SSRF_REJECTED") {
          failures.push(`  ${err.message}`);
        } else {
          throw err;
        }
      }
    }
    if (failures.length > 0) {
      throw new PluginStoreError(
        "SSRF_REJECTED",
        `persisted plugin store ${this.storePath} contains base URLs that are not SSRF-safe ` +
          `under the configured trusted hosts:\n${failures.join("\n")}\n` +
          `fix plugins.json or PLUGINS_TRUSTED_HOSTS`,
      );
    }
  }

  /**
   * Validated, pinned IP addresses for a plugin's allowlisted URLs (populated
   * at install and store load/reload). Phase 2/3 consumers building an outbound
   * call MUST pass these pins (the resolve-then-validate result) into
   * `validatedFetch`; never resolve a plugin URL ad-hoc.
   */
  getPinnedIps(
    pluginId: string,
  ): Array<{ entryId: string; url: string; pinned: string[] }> | undefined {
    return this.pinnedUrls.get(pluginId);
  }

  hasMcpPins(pluginId: string): boolean {
    for (const key of this.pinnedUrls.keys()) {
      if (key.startsWith(`${pluginId}:mcp:`)) return true;
    }
    return false;
  }

  /**
   * Defense-in-depth: the persisted config may only carry credential SPECS
   * (`label`/`required`), never values. zod already strips unknown keys on the
   * way in; this guards hand-built configs from ever serializing a secret. The
   * check is recursive over the whole `credentials` subtree — a `credentials`
   * object is a container of references (each reference a spec descriptor whose
   * own keys must be exactly `label`/`required`) — so smuggled sibling keys
   * (`apiKeySecret`) and nested values (`apiKey.value`) are caught, and a
   * non-object node throws instead of crashing.
   */
  private assertNoCredentialValues(config: PluginStoreConfig): void {
    for (const plugin of config.plugins) {
      const credentials = pluginCredentials(plugin);
      if (credentials === undefined) continue;
      this.assertCredentialsSpecOnly(plugin.id, credentials, "$.credentials");
    }
  }

  private assertCredentialsSpecOnly(
    pluginId: string,
    node: unknown,
    path: string,
  ): void {
    if (!isRecord(node)) {
      throw new PluginStoreError(
        "CREDENTIAL_VALUES_FORBIDDEN",
        `plugin '${pluginId}' ${path} must be an object of credential references, but is not`,
      );
    }
    for (const [reference, value] of Object.entries(node)) {
      if (reference === "label" || reference === "required") {
        if (isRecord(value)) {
          throw new PluginStoreError(
            "CREDENTIAL_VALUES_FORBIDDEN",
            `plugin '${pluginId}' carries a nested object under ${path}.${reference}; ` +
              "credential spec fields must be primitives (label: string, required: boolean)",
          );
        }
        continue;
      }
      if (!isRecord(value)) {
        throw new PluginStoreError(
          "CREDENTIAL_VALUES_FORBIDDEN",
          `plugin '${pluginId}' carries raw credential payloads (${path}.${reference}) in its ` +
            "definition; credentials must be spec-only (label/required) and are never " +
            "written to plugins.json",
        );
      }
      this.assertCredentialsSpecOnly(pluginId, value, `${path}.${reference}`);
    }
  }
}

/** True for a plain (non-null, non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Credential spec of a plugin, narrowing the tool/model variants. */
function pluginCredentials(
  plugin: PluginDefinition,
): CredentialSpec | undefined {
  if (isToolPlugin(plugin)) return plugin.credentials;
  if (isModelPlugin(plugin)) return plugin.credentials;
  return undefined;
}