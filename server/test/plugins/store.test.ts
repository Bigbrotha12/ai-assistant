import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginStore, PluginStoreError } from "../../src/plugins/store.ts";
import {
  CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
  PluginSchemaError,
} from "../../src/plugins/types.ts";
import type {
  ModelPluginDefinition,
  PluginStoreConfig,
  ToolPluginDefinition,
} from "../../src/plugins/types.ts";
import type { LookupFn } from "../../src/plugins/ssrf.ts";

function openRouterBuiltin(): ModelPluginDefinition {
  return {
    id: "openrouter",
    version: "0.1.0",
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

function vikunjaManifest(
  overrides: Partial<ToolPluginDefinition> = {},
): ToolPluginDefinition {
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
        inputSchema: { type: "object" },
      },
    ],
    baseUrls: [{ id: "vikunja-api", url: "https://vikunja.example.com" }],
    ...overrides,
  };
}

function mealieManifest(): ToolPluginDefinition {
  return {
    id: "mealie",
    version: "0.9.0",
    schemaVersion: 1,
    type: "tool",
    name: "Mealie",
    description: "Recipe management",
    tools: [
      {
        name: "list_recipes",
        description: "List recipes",
        readOnly: true,
        inputSchema: { type: "object" },
      },
    ],
    baseUrls: [{ id: "mealie-api", url: "https://mealie.example.com" }],
  };
}

const DNS: Record<string, LookupAddress[]> = {
  "vikunja.example.com": [{ address: "1.1.1.1", family: 4 }],
  "mealie.example.com": [{ address: "1.1.1.1", family: 4 }],
  "openrouter.ai": [{ address: "1.1.1.1", family: 4 }],
  "vikunja.local": [{ address: "10.0.0.5", family: 4 }],
};

function fakeLookup(
  records: Record<string, readonly LookupAddress[]> = DNS,
): LookupFn {
  return async (hostname, _options) => {
    const recs = records[hostname.toLowerCase()];
    return recs ? [...recs] : [];
  };
}

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "plugin-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeStore(
  dir: string,
  opts: Partial<{
    trustedHosts: readonly string[];
    builtinPlugins: readonly ModelPluginDefinition[];
    manifests: readonly ToolPluginDefinition[];
    lookup: LookupFn;
  }> = {},
): Promise<{ store: PluginStore; storePath: string }> {
  const storePath = join(dir, "plugins.json");
  const store = new PluginStore({
    storePath,
    trustedHosts: opts.trustedHosts ?? [],
    builtinPlugins: opts.builtinPlugins ?? [openRouterBuiltin()],
    manifests: opts.manifests ?? [vikunjaManifest(), mealieManifest()],
    lookup: opts.lookup ?? fakeLookup(),
  });
  await store.load();
  return { store, storePath };
}

describe("PluginStore init", () => {
  test("missing plugins.json bootstraps an empty store, written with 0600", async (t) => {
    const dir = await makeTempDir(t);
    const { store, storePath } = await makeStore(dir);
    assert.deepEqual(
      store.getInstalled().map((p) => p.id),
      ["openrouter"],
    );
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.equal(parsed.schemaVersion, CURRENT_PLUGIN_STORE_SCHEMA_VERSION);
    assert.deepEqual(parsed.plugins, []);
    if (process.platform !== "win32") {
      assert.equal((await stat(storePath)).mode & 0o777, 0o600);
    }
  });

  test("invalid JSON fails fast with PluginSchemaError", async (t) => {
    const dir = await makeTempDir(t);
    const storePath = join(dir, "plugins.json");
    await writeFile(storePath, "{ definitely not json", "utf8");
    const store = new PluginStore({
      storePath,
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [],
      lookup: fakeLookup(),
    });
    await assert.rejects(
      store.load(),
      (e: unknown) => e instanceof PluginSchemaError,
    );
  });

  test("schemaVersion mismatch fails fast", async (t) => {
    const dir = await makeTempDir(t);
    const storePath = join(dir, "plugins.json");
    await writeFile(
      storePath,
      JSON.stringify({ schemaVersion: 99, plugins: [] }),
      "utf8",
    );
    const store = new PluginStore({
      storePath,
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [],
      lookup: fakeLookup(),
    });
    await assert.rejects(
      store.load(),
      (e: unknown) =>
        e instanceof PluginSchemaError && e.message.includes("schemaVersion"),
    );
  });

  test("a pre-existing valid store is honored", async (t) => {
    const dir = await makeTempDir(t);
    const storePath = join(dir, "plugins.json");
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
        plugins: [vikunjaManifest()],
      }),
      "utf8",
    );
    const store = new PluginStore({
      storePath,
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [vikunjaManifest()],
      lookup: fakeLookup(),
    });
    await store.load();
    assert.deepEqual(
      store.getInstalled().map((p) => p.id),
      ["openrouter", "vikunja"],
    );
  });

  test("duplicate ids across builtins and manifests are rejected", (t) => {
    assert.throws(
      () =>
        new PluginStore({
          storePath: join(t.name, "unused.json"),
          trustedHosts: [],
          builtinPlugins: [openRouterBuiltin()],
          manifests: [openRouterBuiltin() as unknown as ToolPluginDefinition],
        }),
      (e: unknown) => e instanceof PluginStoreError && e.code === "CONFIG",
    );
  });
});

describe("PluginStore install/uninstall lifecycle", () => {
  test("install adds the manifest and persists it; install is idempotent", async (t) => {
    const dir = await makeTempDir(t);
    const { store, storePath } = await makeStore(dir);

    await store.install("vikunja");
    assert.deepEqual(
      store.getInstalled().map((p) => p.id),
      ["openrouter", "vikunja"],
    );
    const raw1 = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.deepEqual(
      raw1.plugins.map((p) => p.id),
      ["vikunja"],
    );

    await store.install("vikunja");
    const raw2 = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.deepEqual(
      raw2.plugins.map((p) => p.id),
      ["vikunja"],
    );
  });

  test("install of an unknown manifest fails and installs nothing", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir);
    await assert.rejects(
      store.install("ghost"),
      (e: unknown) =>
        e instanceof PluginStoreError && e.code === "MANIFEST_NOT_FOUND",
    );
    assert.deepEqual(
      store.getInstalled().map((p) => p.id),
      ["openrouter"],
    );
  });

  test("uninstall removes a manifest; unknown and builtin uninstalls fail", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir);

    await store.install("vikunja");
    await store.uninstall("vikunja");
    assert.deepEqual(
      store.getInstalled().map((p) => p.id),
      ["openrouter"],
    );

    await assert.rejects(
      store.uninstall("nope"),
      (e: unknown) => e instanceof PluginStoreError && e.code === "PLUGIN_NOT_FOUND",
    );
    await assert.rejects(
      store.uninstall("openrouter"),
      (e: unknown) => e instanceof PluginStoreError && e.code === "BUILTIN_UNINSTALL",
    );
  });

  test("getPlugin returns undefined for a not-installed available manifest", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir);
    assert.equal(store.getPlugin("vikunja"), undefined);
    assert.ok(store.getPlugin("openrouter"));
  });
});

describe("PluginStore availability views", () => {
  test("listAvailable = builtins + installable manifests, excluding installed", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir);
    assert.deepEqual(
      store.listAvailable().map((p) => p.id),
      ["openrouter", "vikunja", "mealie"],
    );
    assert.deepEqual(
      store.listInstallableManifests().map((p) => p.id),
      ["vikunja", "mealie"],
    );

    await store.install("vikunja");
    assert.deepEqual(
      store.listAvailable().map((p) => p.id),
      ["openrouter", "vikunja", "mealie"],
    );
    assert.deepEqual(
      store.listInstallableManifests().map((p) => p.id),
      ["mealie"],
    );
    assert.deepEqual(
      store.getInstalled().map((p) => p.id),
      ["openrouter", "vikunja"],
    );
  });

  test("builtins always remain available regardless of installs", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir);
    await store.install("mealie");
    await store.install("vikunja");
    assert.ok(store.listAvailable().some((p) => p.id === "openrouter"));
  });
});

describe("PluginStore SSRF validation on install", () => {
  test("a private-range literal IP baseUrl is rejected", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [
        vikunjaManifest({
          baseUrls: [{ id: "private", url: "http://10.0.0.5" }],
        }),
      ],
    });
    await assert.rejects(
      store.install("vikunja"),
      (e: unknown) =>
        e instanceof PluginStoreError && e.code === "SSRF_REJECTED",
    );
    assert.equal(store.getPlugin("vikunja"), undefined);
  });

  test("a hostname resolving to a private IP (DNS rebinding) is rejected", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [
        vikunjaManifest({ baseUrls: [{ id: "vikunja", url: "http://vikunja.local" }] }),
      ],
    });
    await assert.rejects(
      store.install("vikunja"),
      (e: unknown) =>
        e instanceof PluginStoreError && e.code === "SSRF_REJECTED",
    );
    assert.equal(store.getPlugin("vikunja"), undefined);
  });

  test("trustedHosts allow an internal hostname that resolves privately", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      trustedHosts: ["vikunja.local"],
      manifests: [
        vikunjaManifest({ baseUrls: [{ id: "vikunja", url: "http://vikunja.local" }] }),
      ],
    });
    await store.install("vikunja");
    assert.ok(store.getPlugin("vikunja"));
  });

  test("trustedHosts allow a private literal IP", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      trustedHosts: ["10.0.0.5"],
      manifests: [
        vikunjaManifest({ baseUrls: [{ id: "private", url: "http://10.0.0.5" }] }),
      ],
    });
    await store.install("vikunja");
    assert.ok(store.getPlugin("vikunja"));
  });

  test("an unknown hostname (no DNS records) is rejected as DNS_RESOLUTION_FAILED", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [
        vikunjaManifest({
          baseUrls: [{ id: "bad", url: "https://nxdomain.invalid" }],
        }),
      ],
    });
    await assert.rejects(
      store.install("vikunja"),
      (e: unknown) =>
        e instanceof PluginStoreError && e.code === "SSRF_REJECTED",
    );
  });
});

describe("PluginStore SSRF re-validation on load (Fix 6)", () => {
  test("a persisted private-range literal IP URL fails load with SSRF_REJECTED", async (t) => {
    const dir = await makeTempDir(t);
    const storePath = join(dir, "plugins.json");
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
        plugins: [vikunjaManifest({ baseUrls: [{ id: "private", url: "http://10.0.0.5" }] })],
      } satisfies PluginStoreConfig),
      "utf8",
    );
    const store = new PluginStore({
      storePath,
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [],
      lookup: fakeLookup(),
    });
    await assert.rejects(
      store.load(),
      (e: unknown) =>
        e instanceof PluginStoreError &&
        e.code === "SSRF_REJECTED" &&
        e.message.includes("SSRF"),
    );
    // Fail-closed: a rejected load leaves the store unloaded.
    assert.throws(
      () => store.getInstalled(),
      (e: unknown) => e instanceof PluginStoreError && e.code === "NOT_LOADED",
    );
  });

  test("a model plugin's inference.endpoint is re-validated on load", async (t) => {
    const dir = await makeTempDir(t);
    const storePath = join(dir, "plugins.json");
    const builtin = openRouterBuiltin();
    const model: ModelPluginDefinition = {
      ...builtin,
      id: "custom-model",
      inference: { ...builtin.inference, endpoint: "http://10.0.0.5/llm" },
    };
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
        plugins: [model],
      } satisfies PluginStoreConfig),
      "utf8",
    );
    const store = new PluginStore({
      storePath,
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [],
      lookup: fakeLookup(),
    });
    await assert.rejects(
      store.load(),
      (e: unknown) => e instanceof PluginStoreError && e.code === "SSRF_REJECTED",
    );
  });

  test("policy tightening is enforced: a host tolerated before is rejected now", async (t) => {
    const dir = await makeTempDir(t);
    const storePath = join(dir, "plugins.json");
    const writeStore = () =>
      writeFile(
        storePath,
        JSON.stringify({
          schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
          plugins: [vikunjaManifest({ baseUrls: [{ id: "vikunja", url: "https://vikunja.local" }] })],
        } satisfies PluginStoreConfig),
        "utf8",
      );

    // With the trusted host configured, load succeeds.
    await writeStore();
    const trusted = new PluginStore({
      storePath,
      trustedHosts: ["vikunja.local"],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [],
      lookup: fakeLookup(),
    });
    await trusted.load();
    assert.ok(trusted.getPlugin("vikunja"));

    // Without it (tightened policy), the SAME store file now fails load.
    await writeStore();
    const strict = new PluginStore({
      storePath,
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [],
      lookup: fakeLookup(),
    });
    await assert.rejects(
      strict.load(),
      (e: unknown) => e instanceof PluginStoreError && e.code === "SSRF_REJECTED",
    );
  });

  test("reload() re-validates and keeps the last known-good config on failure", async (t) => {
    const dir = await makeTempDir(t);
    const { store, storePath } = await makeStore(dir, {
      trustedHosts: ["vikunja.local"],
      manifests: [vikunjaManifest({ baseUrls: [{ id: "vikunja", url: "https://vikunja.local" }] })],
    });
    await store.install("vikunja");
    assert.ok(store.getPlugin("vikunja"));

    // Admin tightens the policy on disk (drops the trusted host from env via a
    // reload with a fresh lookup map that resolves it privately is not possible
    // — instead simulate a bad hand-edit: replace the plugin with a private URL.
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
        plugins: [vikunjaManifest({ baseUrls: [{ id: "private", url: "http://10.0.0.5" }] })],
      } satisfies PluginStoreConfig),
      "utf8",
    );
    await assert.rejects(
      store.reload(),
      (e: unknown) => e instanceof PluginStoreError && e.code === "SSRF_REJECTED",
    );
    // Last known-good config stays in force: vikunja remains installed.
    assert.ok(store.getPlugin("vikunja"));
  });
});

describe("PluginStore pinned-IP retention (Fix 1)", () => {
  test("install retains validated pins; uninstall drops them", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [vikunjaManifest()],
    });
    assert.equal(store.getPinnedIps("vikunja"), undefined);

    await store.install("vikunja");
    const pins = store.getPinnedIps("vikunja");
    assert.ok(pins, "pins must be retained after install");
    assert.deepEqual(pins, [
      { entryId: "vikunja-api", url: "https://vikunja.example.com", pinned: ["1.1.1.1"] },
    ]);

    await store.uninstall("vikunja");
    assert.equal(store.getPinnedIps("vikunja"), undefined);
  });
});

describe("PluginStore duplicate-id rejection at load (Fix 10)", () => {
  test("two same-id plugins in the store file fail load", async (t) => {
    const dir = await makeTempDir(t);
    const storePath = join(dir, "plugins.json");
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
        plugins: [vikunjaManifest(), vikunjaManifest({ version: "9.9.9" })],
      } satisfies PluginStoreConfig),
      "utf8",
    );
    const store = new PluginStore({
      storePath,
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [],
      lookup: fakeLookup(),
    });
    await assert.rejects(
      store.load(),
      (e: unknown) =>
        e instanceof PluginSchemaError && e.message.includes("Duplicate plugin id"),
    );
  });

  test("an installed plugin colliding with a builtin id fails load", async (t) => {
    const dir = await makeTempDir(t);
    const storePath = join(dir, "plugins.json");
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
        plugins: [openRouterBuiltin()],
      } satisfies PluginStoreConfig),
      "utf8",
    );
    const store = new PluginStore({
      storePath,
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [],
      lookup: fakeLookup(),
    });
    await assert.rejects(
      store.load(),
      (e: unknown) => e instanceof PluginStoreError && e.code === "CONFIG",
    );
  });
});

describe("PluginStore persistence", () => {
  test("save is atomic: no .tmp leftovers, 0600 perms, valid JSON", async (t) => {
    const dir = await makeTempDir(t);
    const { store, storePath } = await makeStore(dir);

    await store.install("vikunja");

    const parsed = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.deepEqual(
      parsed.plugins.map((p) => p.id),
      ["vikunja"],
    );
    const entries = await readdir(dir);
    assert.ok(
      !entries.some((e) => e.includes(".tmp")),
      `no temp files should remain, got: ${entries.join(", ")}`,
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(storePath)).mode & 0o777, 0o600);
    }
  });

  test("credential VALUES are never written to plugins.json (spec-only)", async (t) => {
    const dir = await makeTempDir(t);
    const manifest = vikunjaManifest();
    (manifest as unknown as { credentials: { apiKey: Record<string, unknown> } }).credentials =
      { apiKey: { label: "Vikunja token", required: true, value: "sk-super-secret" } };
    const { store, storePath } = await makeStore(dir, {
      manifests: [manifest],
    });

    await store.install("vikunja");

    const raw = await readFile(storePath, "utf8");
    assert.ok(!raw.includes("sk-super-secret"), "secret must not appear on disk");
    const parsed = JSON.parse(raw) as PluginStoreConfig;
    const installed = parsed.plugins.find((p) => p.id === "vikunja")! as ToolPluginDefinition;
    const apiKey = (
      installed.credentials as unknown as { apiKey: Record<string, unknown> }
    ).apiKey;
    assert.deepEqual(Object.keys(apiKey).sort(), ["label", "required"]);
  });

  test("save() rejects a hand-built config carrying credential values", async (t) => {
    const dir = await makeTempDir(t);
    const store = new PluginStore({
      storePath: join(dir, "plugins.json"),
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [],
      lookup: fakeLookup(),
    });
    await store.load();

    const poisoned = vikunjaManifest() as unknown as ToolPluginDefinition & {
      credentials: { apiKey: { label: string; required: boolean; value: string } };
    };
    (poisoned as unknown as { credentials: unknown }).credentials = {
      apiKey: { label: "x", required: true, value: "shh" },
    };
    const storeAny = store as unknown as {
      config: PluginStoreConfig;
      save(): Promise<void>;
    };
    storeAny.config = {
      schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
      plugins: [poisoned],
    };
    await assert.rejects(
      storeAny.save(),
      (e: unknown) =>
        e instanceof PluginStoreError && e.code === "CREDENTIAL_VALUES_FORBIDDEN",
    );
  });

  test("reload() matches a self-write without clobbering state", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir);
    await store.install("vikunja");
    await store.reload();
    assert.deepEqual(
      store.getInstalled().map((p) => p.id),
      ["openrouter", "vikunja"],
    );
  });
});

describe("PluginStore assertNoCredentialValues hardening (Fix 9)", () => {
  async function makePoisonedStore(
    t: TestContext,
    credentials: unknown,
  ): Promise<PluginStore> {
    const dir = await makeTempDir(t);
    const store = new PluginStore({
      storePath: join(dir, "plugins.json"),
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [],
      lookup: fakeLookup(),
    });
    await store.load();
    const poisoned = vikunjaManifest() as unknown as ToolPluginDefinition;
    (poisoned as unknown as { credentials: unknown }).credentials = credentials;
    const storeAny = store as unknown as {
      config: PluginStoreConfig;
      save(): Promise<void>;
    };
    storeAny.config = {
      schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
      plugins: [poisoned],
    };
    return store;
  }

  test("non-object credentials throw CREDENTIAL_VALUES_FORBIDDEN, not a TypeError", async (t) => {
    for (const credentials of ["sk-plain-value", 42, null]) {
      const store = await makePoisonedStore(t, credentials);
      await assert.rejects(
        store.save(),
        (e: unknown) =>
          e instanceof PluginStoreError && e.code === "CREDENTIAL_VALUES_FORBIDDEN",
        `credentials=${String(credentials)} must not crash`,
      );
    }
  });

  test("a sibling secret key next to apiKey is rejected", async (t) => {
    const store = await makePoisonedStore(t, {
      apiKey: { label: "x", required: true },
      apiKeySecret: "sk-super-secret",
    });
    await assert.rejects(
      store.save(),
      (e: unknown) =>
        e instanceof PluginStoreError &&
        e.code === "CREDENTIAL_VALUES_FORBIDDEN" &&
        e.message.includes("apiKeySecret"),
    );
  });

  test("a nested value under apiKey is rejected (deeply smuggled)", async (t) => {
    const store = await makePoisonedStore(t, {
      apiKey: { label: "x", required: true, value: { credential: "sk-nested" } },
    });
    await assert.rejects(
      store.save(),
      (e: unknown) =>
        e instanceof PluginStoreError &&
        e.code === "CREDENTIAL_VALUES_FORBIDDEN" &&
        e.message.includes("value"),
    );
  });

  test("spec-only credentials still pass", async (t) => {
    const store = await makePoisonedStore(t, {
      apiKey: { label: "x", required: true },
    });
    await store.save();
  });
});