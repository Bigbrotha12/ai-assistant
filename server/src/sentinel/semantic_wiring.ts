import type { PluginRegistry } from "../plugins/registry.ts";
import type { PluginStore } from "../plugins/store.ts";
import { isDecisionModelPlugin } from "../plugins/types.ts";
import type { ModelPluginDefinition } from "../plugins/types.ts";
import { buildDecisionClient } from "../transport/decisions.ts";
import type { DecisionClient, DecisionClientOptions } from "../transport/decisions.ts";
import { SentinelSemanticCache, semanticModelVersion } from "./semantic.ts";
import type { SemanticEvaluation } from "./semantic.ts";
import type { SentinelShadowSemanticOptions } from "./shadow.ts";

/**
 * Composition-root helper for the Sentinel semantic (Kev-4B) stage.
 *
 * Boot wiring lives here rather than inline in `index.ts` so the seam is
 * unit-testable without starting the gateway: it resolves the decision plugin
 * from the plugin registry, builds the shared decision client once, and hands
 * back the ONE options object the service passes to both its shadow reporter
 * and its `check()` path (same client, same bounded cache).
 *
 * The plugin registry/store is a boot dependency: call this ONLY after the
 * store has loaded, or the decision plugin is not yet resolvable. A disabled
 * stage (`enabled:false`) still returns an options object so the shadow
 * reporter writes v2 metadata with `semanticAvailable:false`; it resolves only
 * the locally-installed plugin's version token (falling back to a stable
 * `${pluginId}@unavailable`), builds no client, and makes zero model calls.
 * When enabled but the plugin cannot be resolved, is not a `decisions`-mode
 * model plugin, or the client cannot be constructed, this fails open: it logs a
 * REDACTED warning and returns an options object whose evaluator reports the
 * stage unavailable, so the app still starts and both the check and shadow
 * paths fall back to L1.
 *
 * Egress: the client is built through `buildDecisionClient`, which pairs the
 * private-range bypass with the production `http:` carve-out via
 * `egressTrustOptions`. This module never performs egress itself and adds no
 * raw fetch path.
 */

export type SentinelSemanticWiringInput = {
  enabled: boolean;
  /** Model plugin id backing the internal decision server. */
  pluginId: string;
  /** Confidence at or above which a semantic category fires (0..1). */
  threshold: number;
  contextAware: boolean;
  /** Per-question decision-model timeout (ms). */
  timeoutMs: number;
  /** Admin-vouched hosts forwarded to the decision client's egress policy. */
  trustedHosts: readonly string[];
  registry: PluginRegistry;
  pluginStore: PluginStore;
  /** Injectable client builder (tests). Defaults to {@link buildDecisionClient}. */
  buildClient?: (
    plugin: ModelPluginDefinition,
    options: DecisionClientOptions,
  ) => DecisionClient;
  /** Redacted warning sink (tests). Defaults to `console.warn`. */
  warn?: (message: string) => void;
};

/** The fail-open evaluator: always reports the semantic stage unavailable. */
function unavailableEvaluation(): Promise<SemanticEvaluation> {
  return Promise.resolve({ available: false, fallback: "l1", reason: "client_error" });
}

/**
 * A semantic stage configured but unable to run. `enabled:true` keeps the
 * service and shadow reporter in `l1_semantic` mode (so the fallback is visible
 * in reports), while the injected evaluator resolves L1-unavailable without a
 * model call.
 */
function failOpenOptions(
  input: SentinelSemanticWiringInput,
  modelVersion: string,
): SentinelShadowSemanticOptions {
  return {
    enabled: true,
    threshold: input.threshold,
    contextAware: input.contextAware,
    modelVersion,
    evaluate: unavailableEvaluation,
  };
}

function canonicalUrl(value: string): string | null {
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

/**
 * The retained, install-validated pins for the plugin's `inference.endpoint`,
 * when the store has them. The client consumes pins instead of re-resolving, so
 * passing the matching entry keeps the decision path on the same DNS-rebinding
 * defense as the model path.
 */
function matchingPinnedIps(
  store: PluginStore,
  plugin: ModelPluginDefinition,
): readonly string[] | undefined {
  const entries = store.getPinnedIps(plugin.id);
  if (entries === undefined) return undefined;
  const endpoint = canonicalUrl(plugin.inference.endpoint);
  if (endpoint === null) return undefined;
  return entries.find((entry) => canonicalUrl(entry.url) === endpoint)?.pinned;
}

/**
 * A disabled stage still yields an options object: the shadow reporter then
 * writes v2 metadata with `mode:"l1_only"` and `semanticAvailable:false`. It
 * carries the configured threshold/phrasing so the report's independent fields
 * stay populated, but no client and no evaluator, so it makes zero model calls.
 */
function disabledOptions(
  input: SentinelSemanticWiringInput,
  modelVersion: string,
): SentinelShadowSemanticOptions {
  return {
    enabled: false,
    threshold: input.threshold,
    contextAware: input.contextAware,
    modelVersion,
  };
}

/**
 * The disabled stage's model-version token: the locally-installed plugin's
 * `id@version` when the registry resolves it, otherwise a stable
 * `${pluginId}@unavailable`. Reading the registry is local — this never builds a
 * client or performs egress.
 */
function disabledModelVersion(input: SentinelSemanticWiringInput): string {
  try {
    return semanticModelVersion(input.registry.requirePlugin(input.pluginId));
  } catch {
    return `${input.pluginId}@unavailable`;
  }
}

export function buildSentinelSemanticOptions(
  input: SentinelSemanticWiringInput,
): SentinelShadowSemanticOptions {
  if (!input.enabled) {
    return disabledOptions(input, disabledModelVersion(input));
  }
  const warn = input.warn ?? ((message: string) => console.warn(message));

  let plugin;
  try {
    plugin = input.registry.requirePlugin(input.pluginId);
  } catch {
    warn(
      `sentinel: semantic stage enabled but plugin '${input.pluginId}' is unavailable; using L1 fallback`,
    );
    return failOpenOptions(input, input.pluginId);
  }

  if (!isDecisionModelPlugin(plugin)) {
    warn(
      `sentinel: semantic plugin '${input.pluginId}' is not a decisions-mode model plugin; using L1 fallback`,
    );
    return failOpenOptions(input, semanticModelVersion(plugin));
  }

  try {
    const build = input.buildClient ?? buildDecisionClient;
    const client = build(plugin, {
      trustedHosts: input.trustedHosts,
      pinnedIps: matchingPinnedIps(input.pluginStore, plugin),
      timeoutMs: input.timeoutMs,
    });
    return {
      enabled: true,
      threshold: input.threshold,
      contextAware: input.contextAware,
      modelVersion: semanticModelVersion(plugin),
      client,
      cache: new SentinelSemanticCache(),
    };
  } catch {
    warn(
      `sentinel: semantic plugin '${input.pluginId}' could not be constructed; using L1 fallback`,
    );
    return failOpenOptions(input, semanticModelVersion(plugin));
  }
}
