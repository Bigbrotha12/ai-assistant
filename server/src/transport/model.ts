import { ChatOpenAI } from "@langchain/openai";
import type { ChatOpenAIFields } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { PluginRegistryError } from "../plugins/registry.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { PluginStore } from "../plugins/store.ts";
import { isModelPlugin } from "../plugins/types.ts";
import { validatedFetch } from "../plugins/ssrf.ts";
import type { LookupFn, Mode } from "../plugins/ssrf.ts";

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
 * `fetch`, and {@link buildModel} wires a `validatedFetch` adapter
 * (plugins/ssrf.ts — the ONLY sanctioned outbound path) into
 * `configuration.fetch`, so every provider call re-validates scheme + literal
 * IP ranges + resolves and validates EVERY A/AAAA record before connecting,
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
 * `validatedFetch` must see.
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
  /** Admin-trusted hosts forwarded into `validatedFetch` (bypass RANGE checks,
   *  never scheme enforcement). Must match the store's trusted-host policy. */
  trustedHosts?: readonly string[];
  /** Scheme-enforcement mode override for `validatedFetch`. */
  mode?: Mode;
  /** Injectable DNS resolver for `validatedFetch` (tests). */
  lookup?: LookupFn;
  /** Injectable fetch for `validatedFetch` (tests). */
  fetchFn?: typeof fetch;
};

/**
 * Build the chat model for one request. `pluginStore` is accepted for the
 * stable seam (Wave C2's background jobs); `buildModel` resolves the plugin
 * definition through the registry and routes all outbound traffic through
 * `validatedFetch`.
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

  const configuration = {
    baseURL: plugin.inference.endpoint,
    fetch: createValidatedFetchAdapter({
      trustedHosts: input.trustedHosts,
      lookup: input.lookup,
      fetchFn: input.fetchFn,
      mode: input.mode,
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
    configuration,
  } as unknown as ChatOpenAIFields;

  return new ChatOpenAI(fields);
}

export type ValidatedFetchAdapterOptions = {
  trustedHosts?: readonly string[];
  lookup?: LookupFn;
  fetchFn?: typeof fetch;
  mode?: Mode;
};

/**
 * The custom `fetch` handed to the OpenAI SDK via `configuration.fetch`.
 * Routes EVERY provider call through `validatedFetch` — the only sanctioned
 * outbound path — with the plugin's trusted hosts and any injected
 * lookup/fetchFn/mode. Exported so the SSRF contract can be unit-tested
 * without constructing a real `ChatOpenAI`.
 */
export function createValidatedFetchAdapter(
  opts: ValidatedFetchAdapterOptions = {},
): typeof fetch {
  return (url, init) =>
    validatedFetch(resolveFetchUrl(url), init, {
      trustedHosts: opts.trustedHosts,
      lookup: opts.lookup,
      fetchFn: opts.fetchFn,
      mode: opts.mode,
    });
}

/**
 * The OpenAI SDK calls the custom fetch with a string URL (verified against
 * 1.5.13), but tolerate `URL`/`Request` objects so a future SDK revision or a
 * direct test cannot slip a `[object Request]` into `validatedFetch`.
 */
function resolveFetchUrl(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return url.url;
}