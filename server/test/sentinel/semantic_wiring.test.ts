import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Ledger, migrateLedger } from "../../src/ledger/index.ts";
import { PluginStore } from "../../src/plugins/store.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import { kev4bPlugin } from "../../src/plugins/builtin/kev4b.ts";
import { buildSentinelSemanticOptions } from "../../src/sentinel/semantic_wiring.ts";
import type { SentinelSemanticWiringInput } from "../../src/sentinel/semantic_wiring.ts";
import { SentinelSemanticCache } from "../../src/sentinel/semantic.ts";
import { SentinelService } from "../../src/sentinel/service.ts";
import { SENTINEL_CATEGORIES } from "../../src/sentinel/types.ts";
import type { SentinelShadowMetadataV2 } from "../../src/sentinel/shadow.ts";
import type {
  DecisionAnswer,
  DecisionAnswers,
  DecisionClient,
} from "../../src/transport/decisions.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";
import type { ModelPluginDefinition } from "../../src/plugins/types.ts";

/**
 * Composition-root wiring for the Sentinel semantic stage. These cover the boot
 * decisions the unit-level semantic/shadow/service tests cannot: build only
 * when enabled, build only after the plugin store loaded, and fail open (app
 * still starts, L1 fallback) on a missing plugin, a plugin-mode mismatch, or a
 * client-construction failure — with a redacted warning and no client.
 */

function fakeLookup(records: Record<string, readonly LookupAddress[]>): LookupFn {
  return async (hostname) => {
    const recs = records[hostname.toLowerCase()];
    return recs ? [...recs] : [];
  };
}

const LOOKUP = fakeLookup({
  "llama-kev.local": [{ address: "10.0.0.9", family: 4 }],
  "chat.example": [{ address: "1.1.1.1", family: 4 }],
});

function chatPlugin(id = "chat-model"): ModelPluginDefinition {
  return {
    id,
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

async function makeRegistry(
  t: TestContext,
  builtins: readonly ModelPluginDefinition[],
): Promise<{ store: PluginStore; registry: PluginRegistry }> {
  const dir = await mkdtemp(join(tmpdir(), "sentinel-wiring-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new PluginStore({
    storePath: join(dir, "plugins.json"),
    trustedHosts: [],
    builtinPlugins: builtins,
    manifests: [],
    lookup: LOOKUP,
  });
  await store.load();
  return { store, registry: new PluginRegistry(store) };
}

function baseInput(overrides: Partial<SentinelSemanticWiringInput> = {}): SentinelSemanticWiringInput {
  return {
    enabled: true,
    pluginId: "kev-4b",
    threshold: 0.5,
    contextAware: true,
    timeoutMs: 2_000,
    trustedHosts: [],
    registry: { requirePlugin() { throw new Error("registry not injected"); } } as unknown as PluginRegistry,
    pluginStore: { getPinnedIps() { return undefined; } } as unknown as PluginStore,
    ...overrides,
  };
}

function fakeClient(onDecide: () => void): DecisionClient {
  return {
    endpoint: "https://decision.example/v1/systemone",
    tokenLimit: 512,
    async decide(): Promise<DecisionAnswers> {
      onDecide();
      const answers: Record<string, DecisionAnswer> = {};
      for (const category of SENTINEL_CATEGORIES) {
        answers[category] = { ok: true, probability: 0.01 };
      }
      return answers;
    },
  };
}

describe("buildSentinelSemanticOptions", () => {
  test("disabled builds no client, warns nothing, and persists unavailable v2 metadata", async (t) => {
    let built = 0;
    const warnings: string[] = [];
    const options = buildSentinelSemanticOptions(
      baseInput({
        enabled: false,
        buildClient: () => {
          built += 1;
          return fakeClient(() => {});
        },
        warn: (message) => warnings.push(message),
      }),
    );

    assert.ok(options, "a disabled stage still yields an options object");
    assert.equal(options.enabled, false);
    assert.equal(options.threshold, 0.5);
    assert.equal(options.contextAware, true);
    assert.equal(options.modelVersion, "kev-4b@unavailable");
    assert.equal(options.client, undefined, "no client is built or carried");
    assert.equal(options.evaluate, undefined, "no evaluator is injected");
    assert.equal(built, 0, "buildClient is never called when disabled");
    assert.equal(warnings.length, 0, "a disabled stage emits no warning");

    const db = new Database(":memory:");
    t.after(() => db.close());
    migrateLedger(db);
    const service = new SentinelService({ ledger: new Ledger(db), semantic: options });
    const written = await service.recordShadow("owner-1", {
      text: "hello world",
      direction: "input",
      requestId: "turn-disabled",
    });
    await service.shadow.flush();

    assert.ok(written, "the disabled stage still persists a report");
    const report = written.report as SentinelShadowMetadataV2;
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.mode, "l1_only");
    assert.equal(report.semanticAvailable, false);
    assert.equal(report.semanticModelVersion, "kev-4b@unavailable");
    assert.deepEqual(report.semanticFindings, []);
    assert.equal(built, 0, "the drain never built a client");
  });

  test("disabled resolves the installed plugin version locally without building a client", async (t) => {
    const { store, registry } = await makeRegistry(t, [kev4bPlugin]);
    let built = 0;
    const options = buildSentinelSemanticOptions(
      baseInput({
        enabled: false,
        registry,
        pluginStore: store,
        buildClient: () => {
          built += 1;
          return fakeClient(() => {});
        },
      }),
    );

    assert.ok(options);
    assert.equal(options.enabled, false);
    assert.equal(options.modelVersion, "kev-4b@1.0.0");
    assert.equal(options.client, undefined);
    assert.equal(options.evaluate, undefined);
    assert.equal(built, 0, "resolving local version metadata builds no client");
  });

  test("enabled builds the client after the store loaded, with matching pins", async (t) => {
    const { registry } = await makeRegistry(t, [kev4bPlugin]);
    // Builtins are never persisted, so a real store retains no pins for
    // `kev-4b`. Stub the retained entries a load/install would produce for the
    // matching endpoint so the pass-through is asserted against a concrete
    // list instead of `undefined === undefined`. The second, non-matching
    // entry proves the endpoint filter selects only the right pins.
    const retained = ["10.0.0.9"];
    const pluginStore = {
      getPinnedIps(pluginId: string) {
        assert.equal(pluginId, "kev-4b");
        return [
          { entryId: "inference.endpoint", url: "http://llama-kev.local:19096", pinned: retained },
          { entryId: "other", url: "http://elsewhere.local:1234", pinned: ["10.9.9.9"] },
        ];
      },
    } as unknown as PluginStore;
    let captured: Parameters<NonNullable<SentinelSemanticWiringInput["buildClient"]>>[1] | undefined;
    const client = fakeClient(() => {});

    const options = buildSentinelSemanticOptions(
      baseInput({
        registry,
        pluginStore,
        trustedHosts: ["llama-kev.local"],
        buildClient: (_plugin, clientOptions) => {
          captured = clientOptions;
          return client;
        },
      }),
    );

    assert.ok(options, "an enabled, resolvable stage yields options");
    assert.equal(options.enabled, true);
    assert.equal(options.threshold, 0.5);
    assert.equal(options.contextAware, true);
    assert.equal(options.modelVersion, "kev-4b@1.0.0");
    assert.equal(options.client, client);
    assert.equal(options.evaluate, undefined);
    assert.ok(options.cache instanceof SentinelSemanticCache, "shares one bounded cache");

    assert.ok(captured);
    assert.deepEqual(captured!.trustedHosts, ["llama-kev.local"]);
    assert.equal(captured!.timeoutMs, 2_000);
    assert.deepEqual(
      captured!.pinnedIps,
      retained,
      "the matching endpoint's retained pins reach buildDecisionClient",
    );
  });

  test("missing plugin fails open with a redacted warning", () => {
    const warnings: string[] = [];
    const options = buildSentinelSemanticOptions(
      baseInput({
        registry: { requirePlugin() { throw new Error("PLUGIN_NOT_FOUND"); } } as unknown as PluginRegistry,
        warn: (message) => warnings.push(message),
      }),
    );

    assert.ok(options);
    assert.equal(options.enabled, true);
    assert.ok(options.evaluate, "injects a fail-open evaluator");
    assert.equal(options.modelVersion, "kev-4b");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /kev-4b/);
  });

  test("a chat-mode plugin is a mode mismatch and fails open", async (t) => {
    const { store, registry } = await makeRegistry(t, [chatPlugin("kev-4b")]);
    const warnings: string[] = [];
    const options = buildSentinelSemanticOptions(
      baseInput({ registry, pluginStore: store, warn: (message) => warnings.push(message) }),
    );

    assert.ok(options);
    assert.equal(options.enabled, true);
    assert.ok(options.evaluate);
    assert.equal(options.modelVersion, "kev-4b@1.0.0");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /decisions-mode/);
  });

  test("a client-construction failure fails open without leaking the endpoint", async (t) => {
    const { store, registry } = await makeRegistry(t, [kev4bPlugin]);
    const warnings: string[] = [];
    const options = buildSentinelSemanticOptions(
      baseInput({
        registry,
        pluginStore: store,
        buildClient: () => {
          throw new Error("boom http://llama-kev.local:19096");
        },
        warn: (message) => warnings.push(message),
      }),
    );

    assert.ok(options);
    assert.ok(options.evaluate);
    assert.equal(warnings.length, 1);
    assert.equal(
      warnings[0]!.includes("llama-kev.local"),
      false,
      "the warning must not leak the endpoint",
    );
    const evaluation = await options.evaluate!("text");
    assert.deepEqual(evaluation, { available: false, fallback: "l1", reason: "client_error" });
  });

  test("the check and shadow paths share one client and one cache", async (t) => {
    const { store, registry } = await makeRegistry(t, [kev4bPlugin]);
    let decisions = 0;
    const client = fakeClient(() => {
      decisions += 1;
    });
    const options = buildSentinelSemanticOptions(
      baseInput({
        registry,
        pluginStore: store,
        buildClient: () => client,
      }),
    );
    assert.ok(options);

    const db = new Database(":memory:");
    t.after(() => db.close());
    migrateLedger(db);
    const service = new SentinelService({ ledger: new Ledger(db), semantic: options });

    await service.check("owner-1", { text: "hello world", direction: "output" });
    assert.equal(decisions, 1, "the check path asked the client once");

    await service.recordShadow("owner-1", {
      text: "hello world",
      direction: "input",
      requestId: "turn-1",
    });
    assert.equal(decisions, 1, "the shadow path reused the shared cache");
  });
});
