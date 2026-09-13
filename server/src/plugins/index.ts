import { env } from "../env.ts";
import { builtinPlugins } from "./builtin/openrouter.ts";
import { availableToolManifests } from "./manifests/index.ts";
import { PluginRegistry } from "./registry.ts";
import { PluginStore } from "./store.ts";

/**
 * Composition root for the plugin subsystem (Phase 1, Step 4).
 *
 * DEFAULT wiring only: env-provided store path/trusted hosts + the bundled
 * builtin plugins (`builtin/openrouter.ts`) + the curated manifest catalog
 * (`manifests/index.ts`), both owned by a parallel agent. Tests construct
 * `PluginStore`/`PluginRegistry` directly with injected fixtures and never
 * import this module, so the wired defaults stay out of the test graph.
 *
 * Store decision (documented in store.ts): builtins are always available and
 * never persisted; install/uninstall touch manifests only.
 */
function createDefaultPluginStore(): PluginStore {
  return new PluginStore({
    storePath: env.PLUGINS_STORE_PATH,
    trustedHosts: env.PLUGINS_TRUSTED_HOSTS,
    builtinPlugins,
    manifests: availableToolManifests,
  });
}

/** The configured, singleton-ready registry used by the plugin routes. */
export function createPluginRegistry(): PluginRegistry {
  return new PluginRegistry(createDefaultPluginStore());
}

/**
 * App-facing composition (Step 6 routes): hands back BOTH the registry and its
 * backing store so the app can construct `/v1/plugins` routes and load the
 * store once at startup. The registry alone cannot install/uninstall, and the
 * store alone cannot resolve/hot-reload; the routes need both, pinned to the
 * SAME store instance so state stays consistent.
 */
export function createPluginWiring(): { registry: PluginRegistry; store: PluginStore } {
  const store = createDefaultPluginStore();
  return { store, registry: new PluginRegistry(store) };
}

export { PluginRegistry, PluginRegistryError } from "./registry.ts";
export { PluginStore, PluginStoreError } from "./store.ts";