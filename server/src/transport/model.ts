import { ChatOpenAI } from "@langchain/openai";
import type { ChatOpenAIFields } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { env } from "../env.ts";
import { PluginRegistryError } from "../plugins/registry.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { PluginStore } from "../plugins/store.ts";
import { isModelPlugin } from "../plugins/types.ts";
import type { ModelPluginDefinition } from "../plugins/types.ts";
import {
  createEgressPolicy,
  resolveAndValidateHost,
  SsrfValidationError,
} from "../plugins/ssrf.ts";
import type { EgressPolicy, LookupFn, Mode } from "../plugins/ssrf.ts";
import { createPinnedEgressClient } from "../egress/client.ts";

/**
 * Model construction (Phase 3, Wave C1).
 *
 * Turns a model-plugin id + per-request credentials into a ready-to-stream
 * `ChatOpenAI` (the OpenAI-compatible client used by every model plugin — the
 * builtin OpenRouter endpoint and admin-installed providers alike). The
 * provider endpoint/parameters come from the plugin definition; the apiKey
 * comes from the request's validated `credentials`; the model name is the
 * request's `model` override (when present) or the plugin's `defaultModel`.
 *
 * SSRF BOUNDARY (the one hard rule): ChatOpenAI's underlying OpenAI SDK client
 * MUST NOT use the global fetch. The SDK's `ClientOptions` accepts a custom
 * `fetch`, and {@link buildModel} wires an egress-client adapter
 * (`policyFetch` under the hood — plugins/ssrf.ts, the ONLY sanctioned
 * outbound path) into
 * `configuration.fetch`, so every provider call enforces the manifest-derived
 * origin/method/path policy and connects only through validated retained pins,
 * with `redirect: "manual"`. An admin-trusted internal endpoint (e.g.
 * `vikunja.local` behind `*.local`) keeps working because the handler's
 * `PLUGINS_TRUSTED_HOSTS` list is forwarded into the adapter. If the SDK ever
 * stops threading `configuration.fetch`, this module must throw a clear error
 * rather than silently fall back to raw fetch.
 *
 * The seam found in `@langchain/openai@1.5.13`: `BaseChatOpenAIFields.configuration
 * is `ClientOptions` (`openai` SDK), which includes both `baseURL` and `fetch`.
 * `BaseChatOpenAI`'s constructor spreads `...fields.configuration` into its
 * `clientConfig` and instantiates `new OpenAI({ ...clientConfig, baseURL })` —
 * verified at the version pinned in package.json. `baseURL` is passed through
 * verbatim (no `/v1` mangling; the OpenRouter builtin endpoint already carries
 * it). The custom `fetch` is invoked with the fully-resolved request URL (e.g.
 * `https://openrouter.ai/api/v1/chat/completions`), which is exactly the URL
 * the egress policy must see.
 *
 * CREDENTIALS: ChatOpenAI requires a non-empty apiKey to construct its OpenAI
 * client, and the gateway must NEVER fall back to the server host's
 * `OPENAI_API_KEY` env var (that env lookup is built into ChatOpenAI's
 * constructor). A missing/blank apiKey is therefore a `missing_credentials`
 * error even when a plugin's spec marks it optional — the client object is
 * unusable without one, and silently borrowing the host env would leak it onto
 * the wire.
 *
 * `pluginStore` is accepted now to keep the seam stable: Wave C2's background
 * delegation reuses this builder per job and hands the store's `getPinnedIps`
 * to the tool executor; `buildModel` itself reads the plugin definition via the
 * registry.
 */

export type ModelBuildErrorCode =
  | "plugin_not_found"
  | "plugin_not_model"
  | "missing_credentials"
  | "unsupported";

/** Raised by {@link buildModel} before any stream starts. Never carries key values. */
export class ModelBuildError extends Error {
  readonly code: ModelBuildErrorCode;

  constructor(code: ModelBuildErrorCode, message: string) {
    super(message);
    this.name = "ModelBuildError";
    this.code = code;
  }
}

export type BuildModelInput = {
  registry: PluginRegistry;
  pluginStore: PluginStore;
  modelPluginId: string;
  /** Provider model override; defaults to the plugin's `inference.defaultModel`. */
  requestModel?: string;
  /** Validated (spec-scoped, trimmed) credentials for THIS plugin. */
  credentials: Record<string, string>;
  /**
   * Request-level parameter overrides (e.g. the legacy `temperature` /
   * `max_tokens` body fields). Merged over the plugin's `inference.parameters`;
   * explicit model fields always win over both.
   */
  requestParameters?: Record<string, unknown>;
  /** Admin-trusted hosts forwarded into the egress policy (bypass RANGE checks,
   *  never scheme enforcement). Must match the store's trusted-host policy. */
  trustedHosts?: readonly string[];
  /** Scheme-enforcement mode override for the egress policy. */
  mode?: Mode;
  /** Injectable DNS resolver for a missing retained model pin (tests). */
  lookup?: LookupFn;
  /** Injectable fetch for the egress client (tests). */
  fetchFn?: typeof fetch;
};

type ModelPinnedEntry = { entryId: string; url: string; pinned: string[] };

function canonicalEndpoint(value: string): string {
  return new URL(value).href;
}

function modelEgressPolicy(
  plugin: ModelPluginDefinition,
  selectedBaseUrl: string,
  pinnedEntries: ModelPinnedEntry[] | undefined,
  trustedHosts: readonly string[] | undefined,
  mode: Mode | undefined,
  lookup: LookupFn | undefined,
): EgressPolicy {
  const declared = [
    plugin.inference.endpoint,
    ...(plugin.baseUrls ?? []).map((entry) => entry.url),
  ];
  if (!declared.some((url) => canonicalEndpoint(url) === canonicalEndpoint(selectedBaseUrl))) {
    throw new SsrfValidationError(
      "EGRESS_DENIED",
      `model plugin '${plugin.id}' selected a base URL outside its manifest policy`,
    );
  }
  const resolvedFallbacks = new Map<string, Promise<readonly string[]>>();
  return createEgressPolicy({
    subject: `model:${plugin.id}`,
    destinations: declared.map((baseUrl) => {
      const retained = pinnedEntries?.find(
        (entry) => canonicalEndpoint(entry.url) === canonicalEndpoint(baseUrl),
      );
      return {
        baseUrl,
        pinnedIps: retained?.pinned ?? [],
        resolvePins: retained
          ? undefined
          : (hostname) => {
              let pending = resolvedFallbacks.get(hostname);
              if (!pending) {
                pending = resolveAndValidateHost(hostname, {
                  trustedHosts,
                  lookup,
                });
                resolvedFallbacks.set(hostname, pending);
              }
              return pending;
            },
        methods: ["POST"],
        pathPrefixes: [new URL(baseUrl).pathname],
      };
    }),
    trustedHosts,
    mode,
  });
}

/**
 * Build the chat model for one request. `pluginStore` is accepted for the
 * stable seam (Wave C2's background jobs); `buildModel` resolves the plugin
 * definition through the registry and routes all outbound traffic through the
 * egress client (`policyFetch` under the hood).
 */
export function buildModel(input: BuildModelInput): BaseChatModel {
  let plugin;
  try {
    plugin = input.registry.requirePlugin(input.modelPluginId);
  } catch (err) {
    if (err instanceof PluginRegistryError) {
      throw new ModelBuildError("plugin_not_found", err.message);
    }
    throw err;
  }
  if (!isModelPlugin(plugin)) {
    throw new ModelBuildError(
      "plugin_not_model",
      `plugin '${input.modelPluginId}' is not a model plugin; cannot build a chat model from it`,
    );
  }
  if (!plugin.inference.supportsStreaming) {
    throw new ModelBuildError(
      "unsupported",
      `plugin '${input.modelPluginId}' does not support streaming; cannot serve /v1/chat/completions`,
    );
  }
  if (typeof input.credentials.apiKey !== "string" || input.credentials.apiKey.trim() === "") {
    throw new ModelBuildError(
      "missing_credentials",
      `plugin '${input.modelPluginId}' requires an apiKey credential; none was supplied`,
    );
  }

  // The client may select a base-URL instance from the plugin's allowlisted
  // `baseUrls` via the non-secret `baseUrlEntry` routing credential (the
  // per-plugin `{ apiKey, baseUrlEntry }` contract, docs/archive/backend-langchain-plan.md
  // §329-335). Resolve the id against the plugin's OWN allowlist; an
  // unknown/blank id — e.g. a stale client selection after the admin rotated
  // the plugin — FALLS BACK to `plugin.inference.endpoint` rather than
  // failing. A client can never supply an arbitrary URL: only ids present in
  // the server-side allowlist may select an endpoint.
  const baseUrlEntry = input.credentials["baseUrlEntry"];
  const selectedEntry =
    typeof baseUrlEntry === "string" && baseUrlEntry.trim() !== ""
      ? plugin.baseUrls?.find((candidate) => candidate.id === baseUrlEntry.trim())
      : undefined;
  const baseURL = selectedEntry?.url ?? plugin.inference.endpoint;

  const configuration = {
    maxRetries: 0,
    baseURL,
    fetch: createValidatedFetchAdapter({
      policy: modelEgressPolicy(
        plugin,
        baseURL,
        input.pluginStore.getPinnedIps(input.modelPluginId),
        input.trustedHosts,
        input.mode,
        input.lookup,
      ),
      fetchFn: input.fetchFn,
    }),
  };

  // Explicit fields win over plugin parameters / request overrides (a plugin's
  // `parameters` must never be able to override the endpoint key or model).
  const fields = {
    ...plugin.inference.parameters,
    ...input.requestParameters,
    model: input.requestModel ?? plugin.inference.defaultModel,
    apiKey: input.credentials.apiKey,
    streaming: true,
    maxRetries: 0,
    timeout: env.MODEL_CALL_TIMEOUT_MS,
    configuration,
  } as unknown as ChatOpenAIFields;

  return new ChatOpenAI(fields);
}

export type ValidatedFetchAdapterOptions = {
  policy: EgressPolicy;
  fetchFn?: typeof fetch;
};

/**
 * The custom `fetch` handed to the OpenAI SDK via `configuration.fetch`.
 * Routes EVERY provider call through the egress client (`policyFetch` under
 * the hood) — the only sanctioned outbound path — with the manifest-derived
 * egress policy and any injected fetchFn. Exported so the SSRF contract can be
 * unit-tested without constructing a real `ChatOpenAI`.
 *
 * The policy already carries the trust/allowlist and the fallback resolver, so
 * the client only needs to supply the injected `fetchFn` test seam.
 */
export function createValidatedFetchAdapter(
  opts: ValidatedFetchAdapterOptions,
): typeof fetch {
  const egress = createPinnedEgressClient({ fetchFn: opts.fetchFn });
  return (url, init) => egress.fetch(resolveFetchUrl(url), init, opts.policy);
}

/**
 * The OpenAI SDK calls the custom fetch with a string URL (verified against
 * 1.5.13), but tolerate `URL`/`Request` objects so a future SDK revision or a
 * direct test cannot slip a `[object Request]` into the egress client.
 */
function resolveFetchUrl(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return url.url;
}