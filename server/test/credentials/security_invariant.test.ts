import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { DynamicStructuredTool } from "@langchain/core/tools";

import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import { createPluginRoutes } from "../../src/plugins/routes.ts";
import type { VerifyApiKeyFn } from "../../src/plugins/routes.ts";
import { createModelsRoutes } from "../../src/transport/models.ts";
import { createAgentsRoutes } from "../../src/transport/agents.ts";
import { createSkillsRoutes } from "../../src/transport/skills.ts";
import { createMcpRoutes } from "../../src/transport/mcps.ts";
import type { Catalogs } from "../../src/catalog/index.ts";
import {
  credentialFingerprint,
  validateCredentials,
} from "../../src/plugins/credential.ts";
import type {
  ModelPluginDefinition,
  ToolPluginDefinition,
} from "../../src/plugins/types.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import { RequestBodyCredentialResolver } from "../../src/credentials/request_body.ts";
import { PinStoreCredentialResolver } from "../../src/credentials/pin_store.ts";
import { CredentialPinStore } from "../../src/credentials/pins.ts";
import { bindPluginTools } from "../../src/agents/orchestrator.ts";
import type { ToolCallHandler } from "../../src/agents/orchestrator.ts";
import type {
  ToolCall,
  ToolPipeline,
} from "../../src/tools/pipeline.ts";
import { buildPipelineForChannel } from "../../src/tools/channel.ts";
import { JobError } from "../../src/jobs/errors.ts";
import { logger } from "../../src/logger.ts";
import {
  configureAuditTelemetry,
  flushAuditTelemetry,
  resetAuditTelemetryConfig,
} from "../../src/audit/telemetry.ts";

/**
 * Phase 3.5 — the credential security invariant, tested end to end.
 *
 * Plan §5 Phase 3: "credentials are never persisted, logged, or returned by a
 * list/detail endpoint. `credentialFingerprint` stays the only derived
 * representation; `plugins/store.ts`'s `assertNoCredentialValues` /
 * `assertCredentialsSpecOnly` continue to gate persistence."
 *
 * The existing suites cover the individual guards (see the per-describe notes
 * below); this file adds the cross-cutting end-to-end canary: one unmistakable
 * value is driven through the real route factories, the real bind/credential
 * providers, the real store, and the real log/audit sinks, and is asserted to
 * appear nowhere it should not.
 *
 * A single, distinctive sentinel (never a real-looking key shape) makes any
 * leak unambiguous. It is deliberately NOT a value `redactForOutbound` would
 * rewrite, so a hit means a genuine leak rather than redaction masking it.
 */
const SENTINEL = "CANARY-CREDENTIAL-7f3e1d9c2b4a68590fedcba9876543210";
const OTHER_SENTINEL = "CANARY-CREDENTIAL-0000000000000000000000000000";

// ── fixtures ────────────────────────────────────────────────────────────────

function openRouterBuiltin(): ModelPluginDefinition {
  return {
    id: "openrouter",
    version: "1.0.0",
    schemaVersion: 1,
    type: "model",
    name: "OpenRouter",
    description: "Aggregated LLM inference",
    inference: {
      endpoint: "https://openrouter.ai/api/v1",
      defaultModel: "anthropic/claude-3.5-sonnet",
      tokenLimit: 200_000,
      supportsStreaming: true,
      visionCapable: true,
      parameters: {},
    },
    baseUrls: [{ id: "openrouter-api", url: "https://openrouter.ai" }],
    credentials: { apiKey: { label: "OpenRouter API key", required: true } },
  };
}

function vikunjaManifest(): ToolPluginDefinition {
  return {
    id: "vikunja",
    version: "1.4.0",
    schemaVersion: 1,
    type: "tool",
    name: "Vikunja",
    description: "Task management tools",
    tools: [
      {
        name: "list_tasks",
        description: "List tasks from a project",
        readOnly: true,
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" } },
          required: ["projectId"],
        },
      },
    ],
    baseUrls: [{ id: "vikunja-api", url: "https://vikunja.example.com" }],
    credentials: { apiKey: { label: "Personal access token", required: true } },
  };
}

const DNS: Record<string, readonly LookupAddress[]> = {
  "openrouter.ai": [{ address: "1.1.1.1", family: 4 }],
  "vikunja.example.com": [{ address: "1.1.1.1", family: 4 }],
};

function fakeLookup(
  records: Record<string, readonly LookupAddress[]> = DNS,
): LookupFn {
  return async (hostname, _options) => {
    const recs = records[hostname.toLowerCase()];
    return recs ? [...recs] : [];
  };
}

/**
 * Catalogs whose redactable fields all carry the sentinel. `/v1/mcps` strips
 * `url`/`headers`, `/v1/skills` strips `content`, and `/v1/agents` strips
 * `systemPrompt`/skill content — so a leak here is a real endpoint regression,
 * not a fixture artefact.
 */
function poisonedCatalogs(): Catalogs {
  return {
    skills: [
      {
        id: "security-skill",
        title: "Security Skill",
        content: `skill body ${SENTINEL}`,
      },
    ],
    mcps: [
      {
        name: "security-mcp",
        url: `https://mcp.example.com/${SENTINEL}`,
        headers: {
          Authorization: `Bearer ${SENTINEL}`,
          "X-Api-Key": SENTINEL,
        },
      },
    ],
    agents: [
      {
        id: "security-agent",
        name: "Security Agent",
        description: "agent",
        systemPrompt: `secret system prompt ${SENTINEL}`,
        skills: [
          {
            id: "security-skill",
            title: "Security Skill",
            content: `skill body ${SENTINEL}`,
          },
        ],
        mcpServers: [
          {
            name: "security-mcp",
            url: `https://mcp.example.com/${SENTINEL}`,
            headers: { Authorization: `Bearer ${SENTINEL}` },
          },
        ],
        tools: [],
      },
    ],
  };
}

async function makeEnv(t: TestContext): Promise<{
  store: PluginStore;
  registry: PluginRegistry;
  storePath: string;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "cred-security-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storePath = join(dir, "plugins.json");
  const store = new PluginStore({
    storePath,
    trustedHosts: [],
    builtinPlugins: [openRouterBuiltin()],
    manifests: [vikunjaManifest()],
    lookup: fakeLookup(),
  });
  await store.load();
  await store.install("vikunja");
  return { store, registry: new PluginRegistry(store), storePath, dir };
}

const verifyKey: VerifyApiKeyFn = async () => ({ ok: true, owner: "test-user" });

/** The real route factories, mounted the way `index.ts` mounts them. */
function makeApp(registry: PluginRegistry, store: PluginStore): Hono {
  const catalogs = poisonedCatalogs();
  const app = new Hono();
  app.route("/v1", createPluginRoutes({ registry, store, verifyKey }));
  app.route("/v1", createModelsRoutes({ registry, verifyKey }));
  app.route("/v1", createAgentsRoutes({ registry, catalogs, verifyKey }));
  app.route("/v1", createSkillsRoutes({ catalogs, verifyKey }));
  app.route("/v1", createMcpRoutes({ catalogs, verifyKey }));
  return app;
}

/** Wraps the real pipeline so tests can inspect the exact `ToolCall` built. */
function recordingPipeline(
  inner: ToolPipeline,
  calls: ToolCall[],
): ToolPipeline {
  return {
    interceptorNames: inner.interceptorNames,
    dispatch: async (input) => {
      calls.push(input.call);
      return inner.dispatch(input);
    },
    dispose: () => inner.dispose(),
  };
}

/**
 * Binds the installed vikunja tool through the real `bindPluginTools` seam with
 * the supplied credential resolver and handler. Returns the first bound tool
 * plus every `ToolCall` the pipeline dispatched, so a test can assert both what
 * the handler received and what the call carried.
 */
function bindOne(
  registry: PluginRegistry,
  handler: ToolCallHandler,
  resolver: ReturnType<typeof makeResolver>,
): { tool: DynamicStructuredTool; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const pipeline = recordingPipeline(
    buildPipelineForChannel("sync-stateless"),
    calls,
  );
  const tools = bindPluginTools(registry, handler, undefined, {
    channel: "sync-stateless",
    owner: "user-1",
    requestId: "req-security",
    credentialsResolver: resolver,
    pipeline,
  });
  const tool = tools.find((entry) => entry.name === "list_tasks");
  assert.ok(tool, "vikunja's list_tasks must be bound");
  return { tool, calls };
}

function makeResolver(): RequestBodyCredentialResolver | PinStoreCredentialResolver {
  return new RequestBodyCredentialResolver({
    toolCredentialsByPlugin: { vikunja: { apiKey: SENTINEL } },
  });
}

/** A handler that records the credentials it received and returns a result. */
function recordingHandler(
  received: Array<Record<string, unknown> | undefined>,
): ToolCallHandler {
  return {
    async execute(_pluginId, _toolName, _args, credentials) {
      received.push(credentials);
      return "tool result";
    },
  };
}

// ── log capture ─────────────────────────────────────────────────────────────

type LogCapture = { lines: string[]; restore: () => void };

/**
 * Captures every console level and every `logger` level. Audit records are
 * emitted through `logger.info`/`warn`/`error` (`audit/telemetry.ts`), so
 * overriding both surfaces observes the audit sink too.
 */
function captureLogs(): LogCapture {
  const lines: string[] = [];
  const push = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    loggerInfo: logger.info,
    loggerWarn: logger.warn,
    loggerError: logger.error,
    loggerDebug: logger.debug,
  };
  console.log = push;
  console.info = push;
  console.warn = push;
  console.error = push;
  logger.info = push;
  logger.warn = push;
  logger.error = push;
  logger.debug = push;
  return {
    lines,
    restore: () => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      logger.info = original.loggerInfo;
      logger.warn = original.loggerWarn;
      logger.error = original.loggerError;
      logger.debug = original.loggerDebug;
    },
  };
}

const ENDPOINT_CASES: Array<{ path: string; marker: string }> = [
  { path: "/v1/plugins", marker: "vikunja" },
  { path: "/v1/plugins/vikunja", marker: "vikunja" },
  { path: "/v1/models", marker: "openrouter" },
  { path: "/v1/agents", marker: "security-agent" },
  { path: "/v1/skills", marker: "security-skill" },
  { path: "/v1/mcps", marker: "security-mcp" },
];

// ── 1. no list/detail endpoint returns a value ──────────────────────────────

describe("credential security invariant — no list/detail endpoint leaks a value", () => {
  test("request-supplied credential material appears in no body or header of any GET list/detail endpoint", async (t) => {
    const { store, registry } = await makeEnv(t);
    const app = makeApp(registry, store);

    for (const { path, marker } of ENDPOINT_CASES) {
      // A GET cannot carry a body, so the sentinel rides every request position
      // that *can* carry it: the model-key Authorization header, a custom
      // credential header, and the query string.
      const url = `${path}?apiKey=${encodeURIComponent(SENTINEL)}`;
      const res = await app.request(url, {
        headers: {
          authorization: `Bearer ${SENTINEL}`,
          "x-credential-canary": SENTINEL,
        },
      });
      assert.equal(res.status, 200, `${path} must succeed`);

      const bodyText = await res.text();
      assert.equal(
        bodyText.includes(SENTINEL),
        false,
        `${path} response body must not carry the request's credential value`,
      );
      assert.ok(
        bodyText.includes(marker),
        `${path} must return its normal payload (marker '${marker}') so the leak check is not vacuous`,
      );

      for (const [name, value] of res.headers.entries()) {
        assert.equal(
          `${name}: ${value}`.includes(SENTINEL),
          false,
          `${path} response header '${name}' must not carry the credential value`,
        );
      }
    }
  });

  test("credential material planted in catalog entries is stripped by /v1/skills, /v1/mcps and /v1/agents", async (t) => {
    const { store, registry } = await makeEnv(t);
    const app = makeApp(registry, store);

    for (const { path } of ENDPOINT_CASES) {
      const res = await app.request(path, { headers: { authorization: "Bearer test-key" } });
      assert.equal(res.status, 200, path);
      const text = await res.text();
      // No redactable field in any of the poisoned catalogs may surface.
      assert.equal(
        text.includes(SENTINEL),
        false,
        `${path} must strip catalog credential material (headers/url/content/systemPrompt)`,
      );
    }

    // Specifically assert the stripping, not just absence.
    const mcps = (await (
      await app.request("/v1/mcps", { headers: { authorization: "Bearer test-key" } })
    ).json()) as { data: Array<Record<string, unknown>> };
    assert.deepEqual(mcps.data, [{ name: "security-mcp" }]);

    const skills = (await (
      await app.request("/v1/skills", { headers: { authorization: "Bearer test-key" } })
    ).json()) as { data: Array<Record<string, unknown>> };
    assert.deepEqual(skills.data, [{ id: "security-skill", title: "Security Skill" }]);
  });
});

// ── 2. not persisted ────────────────────────────────────────────────────────

describe("credential security invariant — not persisted", () => {
  test("a request that carries the sentinel leaves no occurrence on disk or in the installed set", async (t) => {
    const { store, registry, storePath } = await makeEnv(t);

    // Drive the sentinel through the real credential seam (resolver → bound
    // tool → handler) before writing the store again, so the persistence check
    // runs after a genuine credential-carrying request.
    const received: Array<Record<string, unknown> | undefined> = [];
    const { tool } = bindOne(registry, recordingHandler(received), makeResolver());
    await tool.invoke({ projectId: "p-1" });
    assert.deepEqual(received, [{ apiKey: SENTINEL }], "the handler received the sentinel (real seam)");

    // Re-save, then read the store file back.
    await store.save();
    const raw = await readFile(storePath, "utf8");
    assert.equal(raw.includes(SENTINEL), false, "plugins.json must never contain a credential value");
    assert.equal(
      JSON.stringify(registry.listInstalledPlugins()).includes(SENTINEL),
      false,
      "the in-memory installed set must never contain a credential value",
    );
  });

  // The store's own `assertNoCredentialValues` / `assertCredentialsSpecOnly`
  // rejection is already covered by `test/plugins/store.test.ts`
  // ("assertNoCredentialValues hardening (Fix 9)", the MCP literal-header test
  // around line 1196, and "credential VALUES are never written to plugins.json"
  // around line 1332). This file deliberately does not duplicate those; the
  // validator's non-echo property is asserted under "not logged" below.
});

// ── 3. not logged ───────────────────────────────────────────────────────────

describe("credential security invariant — not logged", () => {
  test("the sentinel reaches no console, logger, or audit sink across a failing credential-carrying dispatch and route requests", async (t) => {
    const { store, registry } = await makeEnv(t);
    const received: Array<Record<string, unknown> | undefined> = [];
    const capture = captureLogs();
    configureAuditTelemetry({ enabled: true, level: "info" });
    try {
      // A downstream handler that fails is the interesting path for "not
      // logged": the error propagates through execution → budget → dispatch.
      const failing = bindOne(
        registry,
        {
          async execute(_pluginId, _toolName, _args, credentials) {
            received.push(credentials);
            throw new JobError("job_failed", "downstream transport exploded");
          },
        },
        makeResolver(),
      );
      await assert.rejects(
        failing.tool.invoke({ projectId: "p-1" }),
        /downstream transport exploded/,
      );

      // Route requests also carry the sentinel; the management audit path runs.
      const app = makeApp(registry, store);
      for (const { path } of ENDPOINT_CASES) {
        await app.request(`${path}?apiKey=${encodeURIComponent(SENTINEL)}`, {
          headers: { authorization: `Bearer ${SENTINEL}` },
        });
      }
      await flushAuditTelemetry();
    } finally {
      await flushAuditTelemetry();
      capture.restore();
      resetAuditTelemetryConfig();
    }

    assert.deepEqual(received, [{ apiKey: SENTINEL }], "the dispatch really carried the sentinel");
    const leaked = capture.lines.filter((line) => line.includes(SENTINEL));
    assert.deepEqual(
      leaked,
      [],
      `no log/audit line may contain the credential value; got:\n${leaked.join("\n")}`,
    );
  });

  test("the credential validator rejects malformed key material without echoing the value", () => {
    // Complements the log capture above: a rejection path must not smuggle the
    // rejected value into the surfaced error message. `test/plugins/credential.test.ts`
    // covers the code/message shape; this pins the non-echo property with the
    // canary.
    assert.throws(
      () =>
        validateCredentials(
          { apiKey: { label: "Token", required: true } },
          { apiKey: `bad value ${SENTINEL}` },
          "vikunja",
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message.includes(SENTINEL),
          false,
          "the rejection message must not echo the rejected credential value",
        );
        return true;
      },
    );
  });
});

// ── 4. the fingerprint is one-way ───────────────────────────────────────────

describe("credential security invariant — one-way fingerprint", () => {
  test("credentialFingerprint of the sentinel is a stable, versioned, value-free digest", () => {
    const fingerprint = credentialFingerprint({ apiKey: SENTINEL });
    assert.equal(fingerprint.includes(SENTINEL), false, "the digest must not embed the input");
    assert.match(fingerprint, /^[0-9a-f]{64}$/);

    // Versioned (`v2\0`) canonical JSON of sorted [key, value] pairs.
    const canonicalJson = JSON.stringify([["apiKey", SENTINEL]]);
    const expected = createHash("sha256")
      .update(`v2\0${canonicalJson}`, "utf8")
      .digest("hex");
    assert.equal(fingerprint, expected, "the digest must be the documented versioned encoding");
    assert.equal(
      fingerprint,
      credentialFingerprint({ apiKey: SENTINEL }),
      "the digest must be stable",
    );
    assert.notEqual(
      fingerprint,
      credentialFingerprint({ apiKey: OTHER_SENTINEL }),
      "a different value must produce a different digest",
    );
  });

  test("the bound call carries the digest, never the value, and no route exposes a fingerprint", async (t) => {
    const { store, registry } = await makeEnv(t);
    const received: Array<Record<string, unknown> | undefined> = [];
    const { tool, calls } = bindOne(registry, recordingHandler(received), makeResolver());
    await tool.invoke({ projectId: "p-1" });

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.deepEqual(call.credentials, { apiKey: SENTINEL }, "the raw value rides the call for the outbound request");
    assert.equal(call.credentialFingerprint, credentialFingerprint({ apiKey: SENTINEL }));
    assert.equal(
      call.credentialFingerprint!.includes(SENTINEL),
      false,
      "the cache-key representation must be the digest, not the value",
    );

    // No list/detail endpoint exposes a fingerprint at all today; if one is ever
    // added, it must be the digest (never the value). Assert the current
    // absence explicitly so a new surface fails this test rather than silently
    // shipping a value or an unversioned stand-in.
    const app = makeApp(registry, store);
    for (const { path } of ENDPOINT_CASES) {
      const res = await app.request(path, { headers: { authorization: "Bearer test-key" } });
      const text = await res.text();
      assert.equal(text.includes(SENTINEL), false, `${path} must not expose the value`);
      assert.equal(
        text.includes(call.credentialFingerprint!),
        false,
        `${path} must not expose a credential fingerprint today`,
      );
    }
  });
});

// ── 5. providers do not widen exposure ──────────────────────────────────────

describe("credential security invariant — providers do not widen exposure", () => {
  test("a downstream failure does not echo a request-body-resolved credential", async (t) => {
    const { registry } = await makeEnv(t);
    const received: Array<Record<string, unknown> | undefined> = [];
    const { tool } = bindOne(
      registry,
      {
        async execute(_pluginId, _toolName, _args, credentials) {
          received.push(credentials);
          throw new JobError("job_failed", "upstream returned 500");
        },
      },
      makeResolver(),
    );

    await assert.rejects(tool.invoke({ projectId: "p-1" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message.includes(SENTINEL),
        false,
        "a downstream failure must not echo the resolved credential value",
      );
      return true;
    });
    assert.deepEqual(received, [{ apiKey: SENTINEL }]);
  });

  test("a downstream failure does not echo a pin-store-resolved credential", async (t) => {
    const { registry } = await makeEnv(t);
    const pins = new CredentialPinStore();
    const pin = pins.pin("user-1", "vikunja", { apiKey: SENTINEL });
    const resolver = new PinStoreCredentialResolver({
      pins,
      owner: "user-1",
      pinHandles: { vikunja: pin.handle },
      assertActive: () => undefined,
    });

    const received: Array<Record<string, unknown> | undefined> = [];
    const { calls, tool } = bindOne(
      registry,
      {
        async execute(_pluginId, _toolName, _args, credentials) {
          received.push(credentials);
          throw new JobError("job_failed", "upstream returned 500");
        },
      },
      resolver,
    );

    await assert.rejects(tool.invoke({ projectId: "p-1" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(SENTINEL), false);
      return true;
    });
    assert.deepEqual(received, [{ apiKey: SENTINEL }]);
    assert.equal(calls[0]!.credentialFingerprint, pin.fingerprint);
    assert.equal(calls[0]!.credentialFingerprint!.includes(SENTINEL), false);
  });

  test("the pin-store provider's credentials_expired path never echoes the pin value", () => {
    const pins = new CredentialPinStore();
    pins.pin("user-1", "vikunja", { apiKey: SENTINEL });
    const resolver = new PinStoreCredentialResolver({
      pins,
      owner: "user-1",
      // No admitted handle for vikunja, even though a pin exists for the owner.
      pinHandles: {},
      assertActive: () => undefined,
    });

    assert.throws(
      () =>
        resolver.resolve({
          owner: "user-1",
          pluginId: "vikunja",
          kind: "tool",
          channel: "job",
        }),
      (error: unknown) => {
        assert.ok(error instanceof JobError);
        assert.equal(error.code, "credentials_expired");
        assert.equal(
          error.message.includes(SENTINEL),
          false,
          "the credentials_expired message must name the plugin, never the value",
        );
        return true;
      },
    );
  });
});
