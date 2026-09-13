import { Hono } from "hono";
import type { Context } from "hono";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { inferenceLimiter, requireApiKey, unauthorized } from "../inference.ts";
import { bindPluginTools } from "../agents/orchestrator.ts";
import { createAgentGraph } from "../agents/graph.ts";
import { compileGraphWithCheckpointer } from "../agents/compile.ts";
import { ToolExecutor } from "../jobs/runner.ts";
import { checkpointThreadId } from "../checkpoints/store.ts";
import type { CheckpointStore } from "../checkpoints/store.ts";
import {
  extractCredentialsFromBody,
  PluginCredentialError,
  validateCredentials,
} from "../plugins/credential.ts";
import { PluginRegistryError } from "../plugins/registry.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { PluginStoreError } from "../plugins/store.ts";
import type { PluginStore } from "../plugins/store.ts";
import { isModelPlugin } from "../plugins/types.ts";
import type { ModelPluginDefinition } from "../plugins/types.ts";
import type { RateLimiterFn, VerifyApiKeyFn } from "../plugins/routes.ts";
import type { Ledger } from "../ledger.ts";
import { toOpenAiSse } from "./openai.ts";
import { buildModel, ModelBuildError } from "./model.ts";
import type { BuildModelInput } from "./model.ts";

/**
 * OpenAI-compatible `POST /v1/chat/completions` transport (Phase 3, Wave C1).
 *
 * Replaces the Phase 1 proxy in `inference.ts` that forwarded the request to
 * `INFERENCE_URL`. The handler now builds a LangChain agent from the installed
 * MODEL plugin + per-request credentials, runs the supervisor graph, and
 * streams the result through the SSE adapter (`transport/openai.ts`) — the
 * Flutter client talks to the LangChain server end-to-end.
 *
 * FLOW (per request):
 *   1. gateway auth (`verifyKey`) -> 401
 *   2. per-owner token bucket (`limiter`) -> 429
 *   3. parse JSON body -> 400 on invalid JSON / missing model / empty messages
 *   4. resolve the model plugin from `body.model` (see MODEL SELECTION)
 *   5. extract + validate the plugin's credentials from `body.credentials`
 *      (see CREDENTIAL SOURCING) -> 400 invalid_credentials
 *   6. thread handling (see SEED/RESUME)
 *   7. build the model (`transport/model.ts`) + bind the real `ToolExecutor`,
 *      compile the agent graph over the checkpoint store (or checkpointer-free)
 *   8. `graph.streamEvents(input, { version: "v2", ... })` piped through
 *      `toOpenAiSse` as an SSE response (`text/event-stream`, `no-cache`).
 *
 * MODEL SELECTION: `body.model` is the model-plugin id (the client sends the id
 * it got from `GET /v1/models`). An optional `body.model_plugin` field
 * disambiguates a request that wants to override the provider model name: when
 * `model_plugin` is present, it wins as the plugin id and `body.model` is
 * treated as the provider model override (`requestModel`). Otherwise
 * `body.model` alone is the plugin id and the provider model falls back to the
 * plugin's `defaultModel`.
 *
 * CREDENTIAL SOURCING: the model key comes from the BODY —
 * `body.credentials[modelPluginId].apiKey` — NEVER from the Authorization
 * header. The header is gateway auth only; using it as the provider key would
 * let the gateway's own key leak to the provider and would make per-plugin key
 * rotation impossible. Missing/invalid -> 400 invalid_credentials.
 *
 * SEED/RESUME (conversation identity, plan Phase 3): when `body.thread_id` AND
 * a checkpoint store are both present, the handler maps the thread to an
 * owner-bound key (`checkpointThreadId`) and streams the graph with
 * `{ configurable: { thread_id } }`. The rule:
 *   - NO checkpoint yet for the thread -> SEED: the graph input is the client's
 *     full `messages` (client history creates the checkpoint).
 *   - A checkpoint EXISTS -> RESUME: only the LAST user message is appended
 *     (`{ messages: [lastUserMessage] }`); the client's history is ignored
 *     (checkpointed state is the source of truth). A resume with no user
 *     message degrades to `{ messages: [] }` (the graph re-runs on checkpointed
 *     state). "Has checkpoint" is detected via the CHECKPOINTER's `get`, never
 *     the `thread_owner` metadata row — `touchThread` writes that row before
 *     any checkpoint exists, so it cannot signal "already seeded".
 * When `thread_id` is absent OR no checkpoint store is available (boot
 * degraded, see index.ts), the run is STATELESS: the client's `messages` are
 * used verbatim and no checkpoint is written (documented degradation).
 *
 * ASYNC DELEGATION: `body.background` is NOT implemented in this wave. A
 * truthy value returns 501 { error: "not_implemented" } so a client can never
 * silently fall back to a synchronous run when it expects a job id. Wave C2
 * (background jobs + idempotency) owns this path and will consume the `ledger`
 * seam accepted below.
 *
 * ERROR MAPPING (pre-stream; flat `{"error": <code>}` for consistency with the
 * sibling plugin/checkpoint surfaces — the wire-spec §5.1 categories are noted):
 *   401 unauthorized              no/invalid gateway key (auth_error)
 *   429 rate_limited              per-owner limiter rejected (rate_limited)
 *   400 invalid_request           invalid JSON; missing/unknown/non-model/
 *                                 non-streaming plugin; missing/empty messages
 *                                 (invalid_request_error)
 *   400 invalid_credentials       missing/invalid model-plugin credentials
 *                                 (auth_error, user-fixable)
 *   502 inference_unavailable     plugin registry unavailable (NOT_LOADED)
 *   500 internal                  anything else (server_error; logged)
 * Mid-stream failures never change the HTTP status: the SSE adapter emits one
 * error envelope then [DONE] (§5.2).
 */

export type ChatRoutesOptions = {
  registry: PluginRegistry;
  pluginStore: PluginStore;
  /** Optional — when absent (boot failed), every run is stateless. */
  checkpointStore?: CheckpointStore;
  /** Accepted now for Wave C2 idempotency (async delegation). Unused today. */
  ledger?: Ledger;
  /** Test seam; defaults to the real `requireApiKey` from inference.ts. */
  verifyKey?: VerifyApiKeyFn;
  /** Test seam; defaults to the per-owner `inferenceLimiter` token bucket. */
  limiter?: RateLimiterFn;
  /** Test seam; defaults to the real model builder (transport/model.ts). */
  buildModel?: typeof buildModel;
  /** Admin-trusted hosts for every outbound `validatedFetch` (model + tools). */
  trustedHosts?: readonly string[];
};

export function createChatRoutes(opts: ChatRoutesOptions): Hono {
  const { registry, pluginStore } = opts;
  const verifyKey = opts.verifyKey ?? requireApiKey;
  const limiter = opts.limiter ?? inferenceLimiter;
  const buildModelFn = opts.buildModel ?? buildModel;

  const routes = new Hono();

  routes.post("/chat/completions", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);
    if (!limiter(owner)) return c.json({ error: "rate_limited" }, 429);

    const body = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: "invalid_request" }, 400);

    // Wave C2 owns async delegation; never silently fall back to sync.
    if (body["background"] !== undefined && body["background"] !== false) {
      return c.json(
        { error: "not_implemented", message: "async background delegation is not yet supported" },
        501,
      );
    }

    const selection = resolveModelSelection(body);
    if (!selection) return c.json({ error: "invalid_request" }, 400);
    const { modelPluginId, requestModel } = selection;

    let plugin: ModelPluginDefinition;
    try {
      const resolved = registry.requirePlugin(modelPluginId);
      if (!isModelPlugin(resolved) || !resolved.inference.supportsStreaming) {
        return c.json({ error: "invalid_request" }, 400);
      }
      plugin = resolved;
    } catch (err) {
      if (err instanceof PluginRegistryError) {
        return c.json({ error: "invalid_request" }, 400);
      }
      if (err instanceof PluginStoreError && err.code === "NOT_LOADED") {
        return c.json({ error: "inference_unavailable" }, 502);
      }
      return c.json({ error: "internal" }, 500);
    }

    let credentials: Record<string, string>;
    try {
      const input = extractCredentialsFromBody(body, modelPluginId, plugin.credentials);
      credentials = validateCredentials(plugin.credentials, input, modelPluginId);
    } catch (err) {
      if (err instanceof PluginCredentialError) {
        return c.json({ error: "invalid_credentials" }, 400);
      }
      return c.json({ error: "internal" }, 500);
    }

    const rawMessages = Array.isArray(body["messages"]) ? body["messages"] : [];
    if (rawMessages.length === 0) return c.json({ error: "invalid_request" }, 400);

    // Legacy-field tolerance: `chat_template_kwargs` / `enable_thinking` are
    // simply ignored; `temperature` / `max_tokens` / `top_p` are forwarded as
    // parameter overrides so an older client's tuning still applies.
    const requestParameters: Record<string, unknown> = {};
    if (typeof body["temperature"] === "number") requestParameters["temperature"] = body["temperature"];
    if (typeof body["max_tokens"] === "number") requestParameters["maxTokens"] = body["max_tokens"];
    if (typeof body["top_p"] === "number") requestParameters["topP"] = body["top_p"];

    // SEED/RESUME decision.
    const clientThreadId =
      typeof body["thread_id"] === "string" && body["thread_id"].trim() !== ""
        ? body["thread_id"]
        : undefined;
    const checkpointStore = opts.checkpointStore;
    const threadId =
      clientThreadId !== undefined && checkpointStore
        ? checkpointThreadId(owner, clientThreadId)
        : undefined;

    let input: Record<string, unknown>;
    let streamOptions: { version: "v2"; configurable?: Record<string, unknown> };
    if (threadId !== undefined && checkpointStore) {
      const checkpoint = await checkpointStore.checkpointer.get({
        configurable: { thread_id: threadId },
      });
      checkpointStore.touchThread(owner, threadId);
      if (checkpoint) {
        const lastUser = lastUserMessage(rawMessages);
        input = { messages: lastUser ? [lastUser] : [] };
      } else {
        input = { messages: toLangChainMessages(rawMessages) };
      }
      streamOptions = { version: "v2", configurable: { thread_id: threadId } };
    } else {
      input = { messages: toLangChainMessages(rawMessages) };
      streamOptions = { version: "v2" };
    }

    // Build the agent: model from the plugin + request, real ToolExecutor
    // (validatedFetch + pinned IPs + trusted hosts), compiled over the
    // checkpoint store when available.
    let model;
    try {
      model = buildModelFn({
        registry,
        pluginStore,
        modelPluginId,
        requestModel,
        requestParameters,
        credentials,
        trustedHosts: opts.trustedHosts,
      } satisfies BuildModelInput);
    } catch (err) {
      return preStreamError(c, err);
    }

    const toolHandler = new ToolExecutor({
      registry,
      getPinnedIps: pluginStore.getPinnedIps.bind(pluginStore),
      trustedHosts: opts.trustedHosts,
    });
    const tools = bindPluginTools(registry, toolHandler);
    const base = createAgentGraph({ model, tools });
    const graph = checkpointStore
      ? compileGraphWithCheckpointer(base, checkpointStore.checkpointer)
      : base;

    const events = graph.streamEvents(input, streamOptions);
    const sse = toOpenAiSse(events, {
      modelId: requestModel ?? plugin.inference.defaultModel,
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const frame of sse) {
            controller.enqueue(encoder.encode(frame));
          }
        } catch (err) {
          console.error("chat: SSE stream error", err);
          controller.error(err);
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  });

  return routes;
}

/** Pre-stream failures return JSON per §5.1 (never SSE). */
function preStreamError(c: Context, err: unknown): Response {
  if (err instanceof ModelBuildError) {
    if (err.code === "missing_credentials") {
      return c.json({ error: "invalid_credentials" }, 400);
    }
    return c.json({ error: "invalid_request" }, 400);
  }
  console.error("chat: unexpected pre-stream error", err);
  return c.json({ error: "internal" }, 500);
}

type ModelSelection = { modelPluginId: string; requestModel: string | undefined };

/**
 * Resolve the plugin id + optional provider-model override from the body. See
 * the module doc (MODEL SELECTION): `model` is the plugin id; an explicit
 * `model_plugin` lets `model` double as the provider model override. Returns
 * null when neither id is present.
 */
function resolveModelSelection(body: Record<string, unknown>): ModelSelection | null {
  const model = typeof body["model"] === "string" ? body["model"].trim() : "";
  const modelPlugin =
    typeof body["model_plugin"] === "string" ? body["model_plugin"].trim() : "";
  const modelPluginId = modelPlugin !== "" ? modelPlugin : model;
  if (modelPluginId === "") return null;
  const requestModel = model !== "" && model !== modelPluginId ? model : undefined;
  return { modelPluginId, requestModel };
}

/**
 * Translate OpenAI chat messages into LangChain messages (Phase 3 wave C1).
 * Roles: system -> SystemMessage, user -> HumanMessage, assistant -> AIMessage
 * (with `tool_calls` normalized from the OpenAI shape), tool/function ->
 * ToolMessage (a missing `tool_call_id` gets a stable synthetic id so a
 * legacy `function`-role result never fails construction).
 */
export function toLangChainMessages(messages: unknown[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const role = raw["role"];
    const content = raw["content"] as string | unknown;
    const toolCallId =
      typeof raw["tool_call_id"] === "string" ? raw["tool_call_id"] : undefined;
    switch (role) {
      case "system":
        out.push(new SystemMessage(content as string));
        break;
      case "user":
        out.push(new HumanMessage(content as string));
        break;
      case "assistant": {
        const toolCalls = normalizeToolCalls(raw["tool_calls"]);
        // Note: `tool_call_id` on assistant messages is informational (LangChain
        // v1's AIMessageFields does not accept it); the graph only needs the
        // content + tool_calls for context.
        out.push(
          new AIMessage({
            content: content as string,
            ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
          }),
        );
        break;
      }
      case "tool":
      case "function":
        out.push(
          new ToolMessage({
            content: content as string,
            tool_call_id: toolCallId ?? `tool_call_${out.length}`,
          }),
        );
        break;
      default:
        break;
    }
  }
  return out;
}

/** The LAST `user` message, for resume mode. */
function lastUserMessage(messages: unknown[]): HumanMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i];
    if (isRecord(raw) && raw["role"] === "user") {
      return new HumanMessage(raw["content"] as string);
    }
  }
  return null;
}

/**
 * Normalize OpenAI-style `tool_calls` (`[{id, type, function:{name,
 * arguments}}]`) to LangChain `{id, name, args, type:"tool_call"}`. Arguments
 * are decoded from the raw-JSON string when possible. `undefined` when absent
 * or empty (an assistant message without tool calls).
 */
function normalizeToolCalls(
  raw: unknown,
): Array<{ id: string; name: string; args: Record<string, any>; type: "tool_call" }> | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((entry, i) => {
    const e = isRecord(entry) ? entry : {};
    const fn = isRecord(e["function"]) ? e["function"] : {};
    const name =
      typeof fn["name"] === "string" && fn["name"] !== ""
        ? fn["name"]
        : typeof e["name"] === "string"
          ? e["name"]
          : "";
    const args = parseToolArgs(fn["arguments"] ?? e["args"]);
    const id = typeof e["id"] === "string" && e["id"] !== "" ? e["id"] : `call_${i}`;
    return { id, name, args, type: "tool_call" as const };
  });
}

/** Decode raw-JSON tool arguments; LangChain wants an object (never a string). */
function parseToolArgs(args: unknown): Record<string, any> {
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return (args as Record<string, any>) ?? {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}