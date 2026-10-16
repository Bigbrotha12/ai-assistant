import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  DECISION_ENDPOINT_PATH,
  buildDecisionClient,
} from "../../src/transport/decisions.ts";
import type {
  DecisionAnswer,
  DecisionAnswers,
  DecisionQuestion,
} from "../../src/transport/decisions.ts";
import { createModelsRoutes } from "../../src/transport/models.ts";
import { createPluginRoutes } from "../../src/plugins/routes.ts";
import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import { SsrfValidationError } from "../../src/plugins/ssrf.ts";
import { kev4bPlugin } from "../../src/plugins/builtin/kev4b.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import type { ModelPluginDefinition } from "../../src/plugins/types.ts";
import { isModelPlugin } from "../../src/plugins/types.ts";

/**
 * Decision transport: one POST per question to the internal
 * `{baseUrl}/v1/systemone` System One contract (homelab `semantic_eval.py`),
 * bounded timeout/concurrency, classified failures, and the same
 * pinned/validated egress path as the model/tool transports.
 *
 * Every test stubs BOTH DNS (`lookup`) and the network caller (`fetchFn`), so
 * nothing touches the real network.
 */

function fakeLookup(records: Record<string, readonly LookupAddress[]>): LookupFn {
  return async (hostname) => {
    const recs = records[hostname.toLowerCase()];
    return recs ? [...recs] : [];
  };
}

const PUBLIC_LOOKUP = fakeLookup({
  "decision.example": [{ address: "1.1.1.1", family: 4 }],
  "llama-kev.local": [{ address: "10.0.0.9", family: 4 }],
});

function decisionPlugin(endpoint = "https://decision.example"): ModelPluginDefinition {
  return {
    id: "kev-4b",
    version: "1.0.0",
    schemaVersion: 1,
    type: "model",
    name: "Kev-4B",
    description: "Internal decision model",
    inference: {
      endpoint,
      defaultModel: "Kev-4B-Q8_0.gguf",
      tokenLimit: 512,
      supportsStreaming: false,
      visionCapable: false,
      parameters: {},
      mode: "decisions",
    },
  };
}

type FetchCall = { readonly url: string; readonly init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/** The single question id echoed by the request body (one question per POST). */
function questionIdOf(call: FetchCall): string {
  const questions = bodyOf(call).questions as Record<string, unknown>;
  return Object.keys(questions)[0]!;
}

/** Answer the question id in the request with `probability` (or raw `answer`). */
function answeringFetch(
  answer: (call: FetchCall) => unknown = (call) => ({
    answers: { [questionIdOf(call)]: { noul: 0.9 } },
  }),
): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return jsonResponse(answer(call));
  }) as typeof fetch;
  return { fn, calls };
}

function recordingFetch(
  handler: (call: FetchCall) => Promise<Response> | Response,
): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fn, calls };
}

const NOUL = (instructions: string): DecisionQuestion => ({ type: "noul", instructions });

function probabilityOf(answer: DecisionAnswer | undefined): number {
  assert.ok(answer && answer.ok, "expected an ok answer");
  return answer.probability;
}

describe("buildDecisionClient — request shape", () => {
  test("POSTs exactly one request per question to {baseUrl}/v1/systemone", async () => {
    const { fn, calls } = answeringFetch();
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
    });
    assert.equal(client.endpoint, `https://decision.example${DECISION_ENDPOINT_PATH}`);
    assert.equal(client.tokenLimit, 512, "the plugin token budget is exposed to callers");

    const answers = await client.decide("some state", {
      self_harm: NOUL("Does the text concern self-harm or suicide?"),
      violence: NOUL("Does the text concern harming other people?"),
      illegal: NOUL("Does the text concern weapons, fraud, or drugs?"),
    });

    assert.equal(calls.length, 3, "one request per question, never a batch");
    for (const call of calls) {
      assert.equal(call.url, "https://decision.example/v1/systemone");
      assert.equal(call.init.method, "POST");
      assert.equal(call.init.redirect, "manual", "egress forces redirect: manual");
      const headers = call.init.headers as Record<string, string>;
      assert.equal(headers["content-type"], "application/json");
      // Exactly one question per body, keyed by its id.
      const body = bodyOf(call);
      assert.deepEqual(Object.keys(body), ["state", "questions"]);
      assert.equal(body.state, "some state");
      assert.equal(Object.keys(body.questions as object).length, 1);
    }
    // Every requested question came back with its validated probability.
    assert.deepEqual(Object.keys(answers), ["self_harm", "violence", "illegal"]);
    for (const id of ["self_harm", "violence", "illegal"]) {
      assert.equal(probabilityOf(answers[id]), 0.9);
    }
  });

  test("sends the noul question verbatim (type + instructions)", async () => {
    const { fn, calls } = answeringFetch();
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
    });
    await client.decide("state", {
      pii: NOUL("Does the text concern personal identifying information?"),
    });
    assert.deepEqual(bodyOf(calls[0]!).questions, {
      pii: { type: "noul", instructions: "Does the text concern personal identifying information?" },
    });
  });

  test("a private http endpoint is reachable in production only via trustedHosts", async () => {
    const { fn } = answeringFetch();
    const client = buildDecisionClient(decisionPlugin("http://llama-kev.local:19096"), {
      trustedHosts: ["llama-kev.local"],
      mode: "production",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
    });
    const answers = await client.decide("trusted private host", { q: NOUL("?") });
    assert.equal(probabilityOf(answers.q), 0.9);

    // Same endpoint with no trust: refused before any request (scheme carve-out
    // and range bypass move together).
    assert.throws(
      () =>
        buildDecisionClient(decisionPlugin("http://llama-kev.local:19096"), {
          mode: "production",
          lookup: PUBLIC_LOOKUP,
          fetchFn: fn,
        }),
      SsrfValidationError,
    );
  });
});

describe("buildDecisionClient — all-question shape", () => {
  test("answers every question id, keyed in input order", async () => {
    const { fn, calls } = answeringFetch((call) => ({
      answers: { [questionIdOf(call)]: { noul: 0.5 } },
    }));
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
    });
    const questions = {
      first: NOUL("first?"),
      second: NOUL("second?"),
      third: NOUL("third?"),
      fourth: NOUL("fourth?"),
    };
    const answers: DecisionAnswers = await client.decide("state", questions);
    assert.deepEqual(Object.keys(answers), Object.keys(questions));
    assert.equal(calls.length, 4);
    // Each request carried a single, distinct question id.
    assert.deepEqual(
      calls.map((call) => questionIdOf(call)).sort(),
      ["first", "fourth", "second", "third"],
    );
  });

  test("empty questions resolves to an empty answer map without a request", async () => {
    const { fn, calls } = answeringFetch();
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
    });
    assert.deepEqual(await client.decide("state", {}), {});
    assert.equal(calls.length, 0);
  });
});

describe("buildDecisionClient — probability validation", () => {
  const cases: Array<[string, unknown]> = [
    ["a probability above 1", { noul: 1.5 }],
    ["a negative probability", { noul: -0.1 }],
    ["a non-numeric probability", { noul: "0.9" }],
    ["a non-finite probability", { noul: Number.NaN }],
    ["a missing noul field", { confidence: 0.9 }],
  ];
  for (const [name, entry] of cases) {
    test(`classifies ${name} as invalid_response`, async () => {
      const { fn } = answeringFetch(() => ({
        answers: { q: entry },
      }));
      const client = buildDecisionClient(decisionPlugin(), {
        mode: "test",
        lookup: PUBLIC_LOOKUP,
        fetchFn: fn,
      });
      const answers = await client.decide("state", { q: NOUL("?") });
      assert.equal(answers.q?.ok, false);
      if (answers.q && !answers.q.ok) assert.equal(answers.q.error, "invalid_response");
    });
  }

  test("classifies a missing answer entry as invalid_response", async () => {
    const { fn } = answeringFetch(() => ({ answers: {} }));
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
    });
    const answers = await client.decide("state", { q: NOUL("?") });
    assert.equal(answers.q?.ok, false);
  });

  test("accepts the boundary probabilities 0 and 1", async () => {
    const { fn } = answeringFetch((call) => ({
      answers: { [questionIdOf(call)]: { noul: questionIdOf(call) === "zero" ? 0 : 1 } },
    }));
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
    });
    const answers = await client.decide("state", { zero: NOUL("?"), one: NOUL("?") });
    assert.equal(probabilityOf(answers.zero), 0);
    assert.equal(probabilityOf(answers.one), 1);
  });
});

describe("buildDecisionClient — failure classification", () => {
  test("rejects a disallowed literal at construction (no request)", () => {
    assert.throws(
      () =>
        buildDecisionClient(decisionPlugin("http://10.0.0.9:19096"), {
          mode: "test",
          fetchFn: answeringFetch().fn,
        }),
      (error: unknown) =>
        error instanceof SsrfValidationError && error.code === "DISALLOWED_HOST",
    );
  });

  test("classifies a request-time SSRF rejection without fetching", async () => {
    const { fn, calls } = answeringFetch();
    const client = buildDecisionClient(decisionPlugin("https://decision.internal"), {
      mode: "test",
      lookup: fakeLookup({ "decision.internal": [{ address: "10.0.0.5", family: 4 }] }),
      fetchFn: fn,
    });
    const answers = await client.decide("state", { q: NOUL("rebind?") });
    assert.equal(answers.q?.ok, false);
    if (answers.q && !answers.q.ok) assert.equal(answers.q.error, "egress_rejected");
    assert.equal(calls.length, 0, "the network is never reached");
  });

  test("classifies a per-question timeout", async () => {
    const { fn } = recordingFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal | undefined;
          const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
          if (signal?.aborted) reject(abortError);
          else signal?.addEventListener("abort", () => reject(abortError), { once: true });
        }),
    );
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
      timeoutMs: 20,
    });
    const answers = await client.decide("state", { q: NOUL("slow?") });
    assert.equal(answers.q?.ok, false);
    if (answers.q && !answers.q.ok) {
      assert.equal(answers.q.error, "timeout");
      assert.equal(answers.q.status, undefined);
    }
  });

  test("a stalled DNS resolver returns by the deadline instead of hanging", async () => {
    // `LookupFn` is not abortable, so `controller.abort()` cannot unblock it;
    // the whole operation must race the deadline or this never settles.
    const stalledLookup: LookupFn = () => new Promise<LookupAddress[]>(() => {});
    const { fn, calls } = answeringFetch();
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: stalledLookup,
      fetchFn: fn,
      timeoutMs: 20,
    });
    const answers = await client.decide("state", { q: NOUL("dns stall?") });
    assert.equal(answers.q?.ok, false);
    if (answers.q && !answers.q.ok) {
      assert.equal(answers.q.error, "timeout");
      assert.equal(answers.q.status, undefined);
    }
    assert.equal(calls.length, 0, "the network is never reached while DNS is stalled");
  });

  test("classifies a stalled response body on a 200 as timeout", async () => {
    const { fn } = recordingFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Never enqueue or close: `response.json()` stalls forever.
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
      timeoutMs: 20,
    });
    const answers = await client.decide("state", { q: NOUL("body stall?") });
    assert.equal(answers.q?.ok, false);
    if (answers.q && !answers.q.ok) {
      assert.equal(answers.q.error, "timeout", "a body read that outlives the deadline is a timeout");
      assert.equal(answers.q.status, undefined);
    }
  });

  test("clears the deadline after a successful response", async () => {
    let signal: AbortSignal | undefined;
    const { fn } = recordingFetch((call) => {
      signal = call.init.signal as AbortSignal | undefined;
      return jsonResponse({ answers: { [questionIdOf(call)]: { noul: 0.9 } } });
    });
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
      timeoutMs: 30,
    });
    const answers = await client.decide("state", { q: NOUL("fast?") });
    assert.equal(probabilityOf(answers.q), 0.9);
    assert.equal(signal?.aborted, false, "no abort fired before the response settled");
    // Wait past the deadline: a leaked timer would abort the (finished) request.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(signal?.aborted, false, "the deadline timer is cleared on success");
  });

  test("classifies a non-2xx status", async () => {
    const { fn } = recordingFetch(() => new Response("nope", { status: 503 }));
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
    });
    const answers = await client.decide("state", { q: NOUL("unavailable?") });
    assert.equal(answers.q?.ok, false);
    if (answers.q && !answers.q.ok) {
      assert.equal(answers.q.error, "http_status");
      assert.equal(answers.q.status, 503);
    }
  });

  test("classifies a 2xx non-JSON body as invalid_response", async () => {
    const { fn } = recordingFetch(() => new Response("not json", { status: 200 }));
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
    });
    const answers = await client.decide("state", { q: NOUL("garbage?") });
    assert.equal(answers.q?.ok, false);
    if (answers.q && !answers.q.ok) assert.equal(answers.q.error, "invalid_response");
  });

  test("classifies a transport failure as network", async () => {
    const { fn } = recordingFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
    });
    const answers = await client.decide("state", { q: NOUL("down?") });
    assert.equal(answers.q?.ok, false);
    if (answers.q && !answers.q.ok) assert.equal(answers.q.error, "network");
  });

  test("a failed question does not collapse the answered ones", async () => {
    const { fn } = recordingFetch((call) => {
      if (questionIdOf(call) === "boom") return new Response("nope", { status: 500 });
      return jsonResponse({ answers: { [questionIdOf(call)]: { noul: 0.4 } } });
    });
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
    });
    const answers = await client.decide("state", { ok1: NOUL("?"), boom: NOUL("?"), ok2: NOUL("?") });
    assert.equal(probabilityOf(answers.ok1), 0.4);
    assert.equal(probabilityOf(answers.ok2), 0.4);
    assert.equal(answers.boom?.ok, false);
    assert.deepEqual(Object.keys(answers), ["ok1", "boom", "ok2"]);
  });
});

describe("buildDecisionClient — bounded concurrency", () => {
  test("never exceeds maxConcurrency in flight and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const { fn } = recordingFetch(async (call) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return jsonResponse({ answers: { [questionIdOf(call)]: { noul: 0.9 } } });
    });
    const client = buildDecisionClient(decisionPlugin(), {
      mode: "test",
      lookup: PUBLIC_LOOKUP,
      fetchFn: fn,
      maxConcurrency: 2,
    });

    const questions = Object.fromEntries(
      Array.from({ length: 6 }, (_v, i) => [`q${i}`, NOUL(`q${i}?`)]),
    );
    const answers = await client.decide("state", questions);

    assert.equal(Object.keys(answers).length, 6);
    assert.ok(peak <= 2, `peak in-flight ${peak} exceeded maxConcurrency 2`);
    assert.equal(peak, 2, "concurrency should be saturated, not serialized");
    assert.deepEqual(Object.keys(answers), Object.keys(questions), "answers must match input order");
  });

  test("uses bounded defaults when options are omitted (backward compatible)", async () => {
    const { fn, calls } = answeringFetch();
    // No options at all: default timeout/concurrency and an empty trust list.
    const client = buildDecisionClient(decisionPlugin(), { mode: "test", fetchFn: fn, lookup: PUBLIC_LOOKUP });
    assert.equal(client.endpoint, `https://decision.example${DECISION_ENDPOINT_PATH}`);
    const answers = await client.decide("state", { q: NOUL("?") });
    assert.equal(probabilityOf(answers.q), 0.9);
    assert.equal(calls.length, 1);
  });
});

describe("buildDecisionClient — type contract", () => {
  test("DecisionQuestion is the noul wire shape (type test)", () => {
    const question: DecisionQuestion = { type: "noul", instructions: "Does the text concern X?" };
    assert.deepEqual(question, { type: "noul", instructions: "Does the text concern X?" });
    // @ts-expect-error the only supported question type is "noul"
    const invalid: DecisionQuestion = { type: "choice", instructions: "?" };
    void invalid;
  });
});

describe("decisions plugin is hidden from chat-facing surfaces", () => {
  function chatPlugin(): ModelPluginDefinition {
    return {
      id: "chat-model",
      version: "1.0.0",
      schemaVersion: 1,
      type: "model",
      name: "Chat",
      description: "A chat model",
      inference: {
        endpoint: "https://chat.example/api",
        defaultModel: "chat-1",
        tokenLimit: 1024,
        supportsStreaming: true,
        visionCapable: false,
        parameters: {},
        mode: "chat",
      },
    };
  }

  async function makeEnv(
    t: TestContext,
  ): Promise<{ store: PluginStore; registry: PluginRegistry }> {
    const dir = await mkdtemp(join(tmpdir(), "decisions-routes-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new PluginStore({
      storePath: join(dir, "plugins.json"),
      trustedHosts: [],
      builtinPlugins: [chatPlugin(), kev4bPlugin],
      manifests: [],
      lookup: PUBLIC_LOOKUP,
    });
    await store.load();
    return { store, registry: new PluginRegistry(store) };
  }

  test("the registry still resolves kev-4b for the internal path", async (t) => {
    const { registry } = await makeEnv(t);
    const resolved = registry.requirePlugin("kev-4b");
    assert.equal(resolved.id, "kev-4b");
    assert.ok(isModelPlugin(resolved));
    assert.equal(resolved.inference.mode, "decisions");
    assert.equal(resolved.inference.endpoint, "http://llama-kev.local:19096");
  });

  test("listAvailablePlugins and getPluginDetails hide it, including its endpoint", async (t) => {
    const { registry } = await makeEnv(t);
    const ids = registry.listAvailablePlugins().map((p) => p.id);
    assert.deepEqual(ids, ["chat-model"]);
    assert.equal(registry.getPluginDetails("kev-4b"), undefined);
    assert.equal(registry.getPluginDetails("chat-model")?.id, "chat-model");
    assert.equal(
      JSON.stringify(registry.listAvailablePlugins()).includes("llama-kev.local"),
      false,
    );
  });

  test("GET /v1/models excludes it", async (t) => {
    const { registry } = await makeEnv(t);
    const app = new Hono();
    app.route(
      "/v1",
      createModelsRoutes({
        registry,
        verifyKey: async () => ({ ok: true as const, owner: "test-user" }),
      }),
    );
    const res = await app.request("/v1/models", {
      headers: { authorization: "Bearer test-key" },
    });
    assert.equal(res.status, 200);
    const bodyText = await res.text();
    assert.equal(bodyText.includes("kev-4b"), false);
    assert.equal(bodyText.includes("llama-kev.local"), false);
    const body = JSON.parse(bodyText) as { data: Array<{ id: string }> };
    assert.deepEqual(body.data.map((d) => d.id), ["chat-model"]);
  });

  test("GET /v1/plugins and /v1/plugins/kev-4b do not expose it", async (t) => {
    const { store, registry } = await makeEnv(t);
    const app = new Hono();
    app.route(
      "/v1",
      createPluginRoutes({
        registry,
        store,
        verifyKey: async () => ({ ok: true as const, owner: "test-user" }),
        superuserKeys: ["test-key"],
      }),
    );
    const headers = { authorization: "Bearer test-key" };

    const list = await app.request("/v1/plugins", { headers });
    assert.equal(list.status, 200);
    const listText = await list.text();
    assert.equal(listText.includes("kev-4b"), false);
    assert.equal(listText.includes("llama-kev.local"), false);

    const detail = await app.request("/v1/plugins/kev-4b", { headers });
    assert.equal(detail.status, 404);
    assert.deepEqual(await detail.json(), { error: "plugin_not_found" });
  });
});
