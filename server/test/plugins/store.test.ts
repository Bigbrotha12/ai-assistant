import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LookupAddress } from "node:dns";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginStore, PluginStoreError } from "../../src/plugins/store.ts";
import { computeManifestDigest } from "../../src/plugins/digest.ts";
import { PluginRegistry, PluginRegistryError } from "../../src/plugins/registry.ts";
import {
  CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
  PluginSchemaError,
} from "../../src/plugins/types.ts";
import type {
  AgentPluginDefinition,
  ModelPluginDefinition,
  PluginDefinition,
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

function persistedConfig(plugins: PluginDefinition[]): PluginStoreConfig {
  return {
    schemaVersion: CURRENT_PLUGIN_STORE_SCHEMA_VERSION,
    plugins,
    approvedDigests: Object.fromEntries(
      plugins.map((plugin) => [plugin.id, computeManifestDigest(plugin)]),
    ),
  };
}

function agentManifest(
  overrides: Partial<AgentPluginDefinition> = {},
): AgentPluginDefinition {
  return {
    id: "custom-agent",
    version: "1.0.0",
    schemaVersion: 1,
    type: "agent",
    name: "Custom Agent",
    description: "A custom agent plugin",
    systemPrompt: "You are a helpful assistant",
    ...overrides,
  };
}

const DNS: Record<string, LookupAddress[]> = {
  "vikunja.example.com": [{ address: "1.1.1.1", family: 4 }],
  "mealie.example.com": [{ address: "1.1.1.1", family: 4 }],
  "openrouter.ai": [{ address: "1.1.1.1", family: 4 }],
  "vikunja.local": [{ address: "10.0.0.5", family: 4 }],
  "mcp.example.com": [{ address: "1.1.1.1", family: 4 }],
  "mcp-private.local": [{ address: "10.0.0.5", family: 4 }],
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
    mode: "production" | "development" | "test";
    writeFile: typeof writeFile;
  }> = {},
): Promise<{ store: PluginStore; storePath: string }> {
  const storePath = join(dir, "plugins.json");
  const store = new PluginStore({
    storePath,
    trustedHosts: opts.trustedHosts ?? [],
    builtinPlugins: opts.builtinPlugins ?? [openRouterBuiltin()],
    manifests: opts.manifests ?? [vikunjaManifest(), mealieManifest()],
    lookup: opts.lookup ?? fakeLookup(),
    mode: opts.mode,
    writeFile: opts.writeFile,
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

  test("v1 stores migrate to v2 but remain unapproved until reinstall", async (t) => {
    const dir = await makeTempDir(t);
    const storePath = join(dir, "plugins.json");
    const manifest = vikunjaManifest();
    await writeFile(
      storePath,
      JSON.stringify({ schemaVersion: 1, plugins: [manifest] }),
      "utf8",
    );
    const store = new PluginStore({
      storePath,
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [manifest],
      lookup: fakeLookup(),
    });

    await store.load();
    const persisted = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.equal(persisted.schemaVersion, CURRENT_PLUGIN_STORE_SCHEMA_VERSION);
    assert.deepEqual(persisted.approvedDigests, {});
    assert.equal(store.needsManifestReapproval("vikunja"), true);
    assert.throws(
      () => new PluginRegistry(store).requirePlugin("vikunja"),
      (error: unknown) =>
        error instanceof PluginRegistryError && error.code === "PIN_MISMATCH",
    );

    await store.install("vikunja");
    const approved = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.equal(approved.approvedDigests?.vikunja, computeManifestDigest(manifest));
  });

  test("a pre-existing valid store is honored", async (t) => {
    const dir = await makeTempDir(t);
    const storePath = join(dir, "plugins.json");
    await writeFile(
      storePath,
      JSON.stringify(persistedConfig([vikunjaManifest()])),
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

describe("PluginStore manifest digest pinning", () => {
  test("digest is stable across key order and changes for security-relevant fields", () => {
    const manifest = vikunjaManifest({
      credentials: { apiKey: { label: "Personal access token", required: true } },
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
    });
    const reordered = {
      baseUrls: manifest.baseUrls,
      tools: [
        {
          inputSchema: {
            type: "object",
            required: ["projectId"],
            properties: { projectId: { type: "string" } },
          },
          readOnly: true,
          description: manifest.tools[0]!.description,
          name: manifest.tools[0]!.name,
        },
      ],
      credentials: manifest.credentials,
      description: manifest.description,
      name: manifest.name,
      type: manifest.type,
      schemaVersion: manifest.schemaVersion,
      version: manifest.version,
      id: manifest.id,
    } satisfies ToolPluginDefinition;

    const digest = computeManifestDigest(manifest);
    assert.match(digest, /^sha256:v1:[0-9a-f]{64}$/);
    assert.equal(computeManifestDigest(reordered), digest);
    const compact = JSON.stringify(reordered);
    const pretty = JSON.stringify(JSON.parse(compact), null, 4);
    assert.equal(computeManifestDigest(JSON.parse(compact)), computeManifestDigest(JSON.parse(pretty)));

    const changedUrl = structuredClone(manifest);
    changedUrl.baseUrls[0]!.url = "https://other.example.com";
    assert.notEqual(computeManifestDigest(changedUrl), digest);

    const changedSchema = structuredClone(manifest);
    changedSchema.tools[0]!.inputSchema.required = ["otherId"];
    assert.notEqual(computeManifestDigest(changedSchema), digest);

    const changedReadOnly = structuredClone(manifest);
    changedReadOnly.tools[0]!.readOnly = false;
    assert.notEqual(computeManifestDigest(changedReadOnly), digest);

    const changedCredentialSpec = structuredClone(manifest);
    changedCredentialSpec.credentials!.apiKey.required = false;
    assert.notEqual(computeManifestDigest(changedCredentialSpec), digest);

    const withCredentialValue = structuredClone(manifest) as ToolPluginDefinition & {
      credentials: { apiKey: Record<string, unknown> };
    };
    withCredentialValue.credentials.apiKey.value = "sk-not-persisted";
    assert.equal(computeManifestDigest(withCredentialValue), digest);
  });

  test("install persists the approved digest alongside the definition", async (t) => {
    const dir = await makeTempDir(t);
    const { store, storePath } = await makeStore(dir);
    await store.install("vikunja");

    const persisted = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    const definition = persisted.plugins.find((plugin) => plugin.id === "vikunja")!;
    const expected = computeManifestDigest(definition);
    assert.equal(persisted.approvedDigests?.vikunja, expected);
    assert.equal(store.getApprovedManifestDigest("vikunja"), expected);
  });

  test("reload reports a pin mismatch, blocks resolution, and reinstall clears it", async (t) => {
    const dir = await makeTempDir(t);
    const { store, storePath } = await makeStore(dir);
    await store.install("vikunja");

    const original = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    const expected = original.approvedDigests!.vikunja;
    const changed = structuredClone(original.plugins[0]!) as ToolPluginDefinition;
    changed.tools[0]!.inputSchema.required = ["changedId"];
    const actual = computeManifestDigest(changed);
    await writeFile(
      storePath,
      JSON.stringify({ ...original, plugins: [changed] }),
      "utf8",
    );

    await assert.rejects(
      store.reload(),
      (error: unknown) =>
        error instanceof PluginStoreError &&
        error.code === "PIN_MISMATCH" &&
        error.mismatches?.[0]?.expected === expected &&
        error.mismatches?.[0]?.actual === actual,
    );
    assert.deepEqual(store.getManifestHashMismatch("vikunja"), {
      pluginId: "vikunja",
      expected,
      actual,
    });
    assert.equal(store.getPinnedIps("vikunja")?.[0]?.url, "https://vikunja.example.com");

    const registry = new PluginRegistry(store);
    assert.equal(registry.canResolveToolPlugin("vikunja"), false);
    assert.throws(
      () => registry.requirePlugin("vikunja"),
      (error: unknown) => error instanceof PluginRegistryError && error.code === "PIN_MISMATCH",
    );

    await store.install("vikunja");
    assert.equal(store.getManifestHashMismatch("vikunja"), undefined);
    assert.equal(store.getApprovedManifestDigest("vikunja"), expected);
    const afterReinstall = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.equal(afterReinstall.approvedDigests?.vikunja, expected);
    await store.reload();
    assert.equal(store.getManifestHashMismatch("vikunja"), undefined);
  });

  test("a fresh load surfaces a changed persisted definition as PIN_MISMATCH", async (t) => {
    const dir = await makeTempDir(t);
    const { store, storePath } = await makeStore(dir);
    await store.install("vikunja");
    const original = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    const changed = structuredClone(original.plugins[0]!) as ToolPluginDefinition;
    changed.baseUrls[0]!.url = "https://other.example.com";
    await writeFile(
      storePath,
      JSON.stringify({ ...original, plugins: [changed] }),
      "utf8",
    );

    const fresh = new PluginStore({
      storePath,
      trustedHosts: [],
      builtinPlugins: [openRouterBuiltin()],
      manifests: [vikunjaManifest()],
      lookup: fakeLookup(),
    });
    await assert.rejects(
      fresh.load(),
      (error: unknown) =>
        error instanceof PluginStoreError &&
        error.code === "PIN_MISMATCH" &&
        error.mismatches?.[0]?.pluginId === "vikunja",
    );
  });

  test("a store with no digest map is also fail-closed", async (t) => {
    const dir = await makeTempDir(t);
    const { store, storePath } = await makeStore(dir);
    await store.install("vikunja");
    const persisted = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: persisted.schemaVersion,
        plugins: persisted.plugins,
      }),
      "utf8",
    );

    await assert.rejects(
      store.reload(),
      (error: unknown) =>
        error instanceof PluginStoreError &&
        error.code === "PIN_MISMATCH" &&
        error.mismatches?.[0]?.expected === null,
    );
    assert.equal(store.getPlugin("vikunja")?.id, "vikunja");
  });

  test("uninstall removes the persisted digest pin", async (t) => {
    const dir = await makeTempDir(t);
    const { store, storePath } = await makeStore(dir);
    await store.install("vikunja");
    await store.uninstall("vikunja");

    const persisted = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.equal(persisted.approvedDigests?.vikunja, undefined);
    assert.equal(store.getManifestHashMismatch("vikunja"), undefined);
    assert.deepEqual(store.listInstallableManifests().map((plugin) => plugin.id), ["vikunja", "mealie"]);
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

describe("PluginStore mutation serialization", () => {
  test("concurrent installs validate and persist exactly one manifest", async (t) => {
    const dir = await makeTempDir(t);
    let releaseDns!: () => void;
    let enterDns!: () => void;
    const dnsGate = new Promise<void>((resolve) => {
      releaseDns = resolve;
    });
    const dnsEntered = new Promise<void>((resolve) => {
      enterDns = resolve;
    });
    let lookupCount = 0;
    const lookup: LookupFn = async (hostname, _options) => {
      lookupCount += 1;
      if (lookupCount === 1) {
        enterDns();
        await dnsGate;
      }
      return [...(DNS[hostname.toLowerCase()] ?? [])];
    };
    const { store, storePath } = await makeStore(dir, { lookup });

    const first = store.install("vikunja");
    await dnsEntered;
    const second = store.install("vikunja");
    releaseDns();

    assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
    assert.equal(lookupCount, 1);
    assert.deepEqual(
      store.getInstalled().map((p) => p.id),
      ["openrouter", "vikunja"],
    );
    const persisted = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.deepEqual(
      persisted.plugins.map((p) => p.id),
      ["vikunja"],
    );
    assert.equal(
      persisted.plugins.filter((p) => p.id === "vikunja").length,
      1,
    );
  });

  test("concurrent install and uninstall serialize to a matching disk snapshot", async (t) => {
    const dir = await makeTempDir(t);
    const { store, storePath } = await makeStore(dir);

    const install = store.install("vikunja");
    const uninstall = store.uninstall("vikunja");
    assert.deepEqual(await Promise.all([install, uninstall]), [undefined, undefined]);

    assert.deepEqual(
      store.getInstalled().map((p) => p.id),
      ["openrouter"],
    );
    const persisted = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.deepEqual(
      persisted.plugins.map((p) => p.id),
      [],
    );
    assert.deepEqual(
      persisted.plugins.map((p) => p.id),
      store.getInstalled().slice(1).map((p) => p.id),
    );
  });

  test("readers see old state until a delayed install save commits", async (t) => {
    const dir = await makeTempDir(t);
    let releaseSave!: () => void;
    let enterSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const saveEntered = new Promise<void>((resolve) => {
      enterSave = resolve;
    });
    let delayNextSave = false;
    const writeFileSeam = (async (
      path: string,
      data: string,
      options: { encoding: "utf8" },
    ) => {
      if (delayNextSave) {
        delayNextSave = false;
        enterSave();
        await saveGate;
      }
      return writeFile(path, data, options);
    }) as typeof writeFile;
    const { store, storePath } = await makeStore(dir, { writeFile: writeFileSeam });
    const idsBefore = store.getInstalled().map((p) => p.id);
    const diskBefore = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;

    delayNextSave = true;
    const install = store.install("vikunja");
    const reload = store.reload();
    await saveEntered;
    try {
      assert.deepEqual(store.getInstalled().map((p) => p.id), idsBefore);
      assert.equal(store.getPinnedIps("vikunja"), undefined);
      const diskDuringSave = JSON.parse(
        await readFile(storePath, "utf8"),
      ) as PluginStoreConfig;
      assert.deepEqual(diskDuringSave, diskBefore);
    } finally {
      releaseSave();
    }

    await install;
    assert.deepEqual(
      store.getInstalled().map((p) => p.id),
      ["openrouter", "vikunja"],
    );
    assert.deepEqual(store.getPinnedIps("vikunja"), [
      { entryId: "vikunja-api", url: "https://vikunja.example.com", pinned: ["1.1.1.1"] },
    ]);
    await reload;
    const diskAfterSave = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.deepEqual(
      diskAfterSave.plugins.map((p) => p.id),
      ["vikunja"],
    );
  });

  test("reload called during an in-flight install cannot clobber it", async (t) => {
    const dir = await makeTempDir(t);
    let releaseInstallDns!: () => void;
    let enterInstallDns!: () => void;
    const installDnsGate = new Promise<void>((resolve) => {
      releaseInstallDns = resolve;
    });
    const installDnsEntered = new Promise<void>((resolve) => {
      enterInstallDns = resolve;
    });
    let releaseReload!: () => void;
    let enterReload!: () => void;
    const reloadGate = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    const reloadEntered = new Promise<void>((resolve) => {
      enterReload = resolve;
    });
    let holdReload = false;
    const lookup: LookupFn = async (hostname, _options) => {
      const normalized = hostname.toLowerCase();
      if (normalized === "vikunja.example.com") {
        enterInstallDns();
        await installDnsGate;
      }
      if (holdReload && normalized === "mealie.example.com") {
        enterReload();
        await reloadGate;
      }
      return [...(DNS[normalized] ?? [])];
    };
    const { store, storePath } = await makeStore(dir, { lookup });
    await store.install("mealie");
    await writeFile(
      storePath,
      JSON.stringify(
        persistedConfig([{ ...mealieManifest(), version: "2.0.0" }]),
      ),
      "utf8",
    );

    holdReload = true;
    const install = store.install("vikunja");
    await installDnsEntered;
    const reload = store.reload();
    let reloadEntryTimer: ReturnType<typeof setTimeout> | undefined;
    const reloadEnteredBeforeInstall = await Promise.race([
      reloadEntered.then(() => true),
      new Promise<boolean>((resolve) => {
        reloadEntryTimer = setTimeout(() => resolve(false), 100);
      }),
    ]);
    try {
      releaseInstallDns();
      await install;
      releaseReload();
      await reload;
    } finally {
      if (reloadEntryTimer !== undefined) clearTimeout(reloadEntryTimer);
      releaseInstallDns();
      releaseReload();
    }

    assert.equal(reloadEnteredBeforeInstall, false);
    assert.deepEqual(
      store.getInstalled().map((p) => p.id),
      ["openrouter", "mealie", "vikunja"],
    );
    const persisted = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.deepEqual(
      persisted.plugins.map((p) => p.id),
      ["mealie", "vikunja"],
    );
  });

  test("a failed save leaves live state unchanged and releases the mutex", async (t) => {
    const dir = await makeTempDir(t);
    let failNextSave = false;
    let releaseFailedSave!: () => void;
    let enterFailedSave!: () => void;
    const failedSaveGate = new Promise<void>((resolve) => {
      releaseFailedSave = resolve;
    });
    const failedSaveEntered = new Promise<void>((resolve) => {
      enterFailedSave = resolve;
    });
    const writeFileSeam = (async (
      path: string,
      data: string,
      options: { encoding: "utf8" },
    ) => {
      if (failNextSave) {
        failNextSave = false;
        enterFailedSave();
        await failedSaveGate;
        throw new Error("injected write failure");
      }
      return writeFile(path, data, options);
    }) as typeof writeFile;
    const { store, storePath } = await makeStore(dir, {
      writeFile: writeFileSeam,
      manifests: [vikunjaManifest(), mealieManifest()],
    });
    await store.install("vikunja");
    const pinsBefore = structuredClone(store.getPinnedIps("vikunja"));
    const idsBefore = store.getInstalled().map((p) => p.id);
    const diskBefore = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;

    failNextSave = true;
    const uninstall = store.uninstall("vikunja");
    await failedSaveEntered;
    try {
      assert.deepEqual(store.getInstalled().map((p) => p.id), idsBefore);
      assert.deepEqual(store.getPinnedIps("vikunja"), pinsBefore);
    } finally {
      releaseFailedSave();
    }

    await assert.rejects(
      uninstall,
      (e: unknown) => e instanceof PluginStoreError && e.code === "FILE_IO",
    );
    assert.deepEqual(store.getInstalled().map((p) => p.id), idsBefore);
    assert.deepEqual(store.getPinnedIps("vikunja"), pinsBefore);
    const diskAfterFailure = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.deepEqual(diskAfterFailure, diskBefore);

    await store.install("mealie");
    const diskAfterRetry = JSON.parse(await readFile(storePath, "utf8")) as PluginStoreConfig;
    assert.deepEqual(
      diskAfterRetry.plugins.map((p) => p.id),
      ["vikunja", "mealie"],
    );
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
      JSON.stringify(
        persistedConfig([
          vikunjaManifest({ baseUrls: [{ id: "private", url: "http://10.0.0.5" }] }),
        ]),
      ),
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
      JSON.stringify(persistedConfig([model])),
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
        JSON.stringify(
          persistedConfig([
            vikunjaManifest({ baseUrls: [{ id: "vikunja", url: "https://vikunja.local" }] }),
          ]),
        ),
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
      JSON.stringify(
        persistedConfig([
          vikunjaManifest({ baseUrls: [{ id: "private", url: "http://10.0.0.5" }] }),
        ]),
      ),
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

describe("PluginStore MCP server SSRF validation", () => {
  test("catalog-validated MCP pins use the retained agent/server key", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir);
    store.retainCatalogMcpPins([{
      agentPluginId: "catalog-agent",
      serverName: "filesystem",
      url: "https://mcp.example.com",
      pinnedIps: ["1.1.1.1"],
    }]);
    assert.deepEqual(store.getPinnedIps("catalog-agent:mcp:filesystem"), [{
      entryId: "mcp:filesystem",
      url: "https://mcp.example.com",
      pinned: ["1.1.1.1"],
    }]);
    assert.equal(store.hasMcpPins("catalog-agent"), true);
  });

  test("installing an agent plugin with valid mcpServers passes", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [agentManifest({
        mcpServers: [{ name: "mcp-public", url: "https://mcp.example.com" }],
      }) as unknown as ToolPluginDefinition],
    });
    await store.install("custom-agent");
    assert.ok(store.getPlugin("custom-agent"));
    const pin = store.getPinnedIps("custom-agent:mcp:mcp-public");
    assert.ok(pin, "MCP pin must be retained");
    assert.deepEqual(pin, [
      { entryId: "mcp:mcp-public", url: "https://mcp.example.com", pinned: ["1.1.1.1"] },
    ]);
  });

  test("MCP URL pointing to a private IP is rejected", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [agentManifest({
        mcpServers: [{ name: "mcp-private", url: "http://mcp-private.local" }],
      }) as unknown as ToolPluginDefinition],
    });
    await assert.rejects(
      store.install("custom-agent"),
      (e: unknown) =>
        e instanceof PluginStoreError && e.code === "SSRF_REJECTED",
    );
    assert.equal(store.getPlugin("custom-agent"), undefined);
  });

  test("http: MCP URL is rejected in production mode", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [agentManifest({
        mcpServers: [{ name: "mcp-http", url: "http://mcp.example.com" }],
      }) as unknown as ToolPluginDefinition],
      mode: "production",
    });
    await assert.rejects(
      store.install("custom-agent"),
      (e: unknown) =>
        e instanceof PluginStoreError && e.code === "SSRF_REJECTED",
    );
    assert.equal(store.getPlugin("custom-agent"), undefined);
  });

  test("reload() re-validates MCP URLs same as baseUrls", async (t) => {
    const dir = await makeTempDir(t);
    const { store, storePath } = await makeStore(dir, {
      manifests: [agentManifest({
        mcpServers: [{ name: "mcp-public", url: "https://mcp.example.com" }],
      }) as unknown as ToolPluginDefinition],
    });
    await store.install("custom-agent");
    assert.ok(store.getPlugin("custom-agent"));

    // Hand-edit the store with a bad MCP URL
    await writeFile(
      storePath,
      JSON.stringify(
        persistedConfig([
          agentManifest({
            mcpServers: [{ name: "mcp-private", url: "http://10.0.0.5" }],
          }),
        ]),
      ),
      "utf8",
    );
    await assert.rejects(
      store.reload(),
      (e: unknown) =>
        e instanceof PluginStoreError && e.code === "SSRF_REJECTED",
    );
    // Last known-good config stays in force
    assert.ok(store.getPlugin("custom-agent"));
  });

  test("no mcpServers triggers no MCP validation", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [agentManifest() as unknown as ToolPluginDefinition],
    });
    await store.install("custom-agent");
    assert.ok(store.getPlugin("custom-agent"));
    // No MCP pins should exist
    assert.equal(store.hasMcpPins("custom-agent"), false);
  });
});

describe("PluginStore MCP header validation", () => {
  function headerManifest(headers: Record<string, string> | undefined): ToolPluginDefinition {
    return agentManifest({
      mcpServers: [{ name: "mcp-hdrs", url: "https://mcp.example.com", headers }],
    }) as unknown as ToolPluginDefinition;
  }

  test("valid header name 'X-Api-Key' is allowed", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [headerManifest({ "X-Api-Key": "${MCP_TEST_TOKEN}" })],
    });
    await store.install("custom-agent");
    assert.ok(store.getPlugin("custom-agent"));
  });

  test("literal header values are rejected and never persisted", async (t) => {
    const dir = await makeTempDir(t);
    const { store, storePath } = await makeStore(dir, {
      manifests: [headerManifest({ "X-Api-Key": "secret-value" })],
    });
    await assert.rejects(
      store.install("custom-agent"),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === "CREDENTIAL_VALUES_FORBIDDEN",
    );
    assert.equal(store.getPlugin("custom-agent"), undefined);
    const raw = await readFile(storePath, "utf8");
    assert.equal(raw.includes("secret-value"), false);
  });

  test("header name with colon 'Bad:Header' is rejected", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [headerManifest({ "Bad:Header": "val" })],
    });
    await assert.rejects(
      store.install("custom-agent"),
      (e: unknown) =>
        e instanceof PluginStoreError && e.code === "SSRF_REJECTED" && e.message.includes("invalid characters"),
    );
    assert.equal(store.getPlugin("custom-agent"), undefined);
  });

  test("header name 'Content-Type' is rejected (dangerous override)", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [headerManifest({ "Content-Type": "text/plain" })],
    });
    await assert.rejects(
      store.install("custom-agent"),
      (e: unknown) =>
        e instanceof PluginStoreError && e.code === "SSRF_REJECTED" && e.message.includes("dangerous override"),
    );
    assert.equal(store.getPlugin("custom-agent"), undefined);
  });

  test("empty header name '' is rejected", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [headerManifest({ "": "val" })],
    });
    await assert.rejects(
      store.install("custom-agent"),
      (e: unknown) =>
        e instanceof PluginStoreError && e.code === "SSRF_REJECTED" && e.message.includes("empty header name"),
    );
    assert.equal(store.getPlugin("custom-agent"), undefined);
  });

  test("no headers passes validation (no-op)", async (t) => {
    const dir = await makeTempDir(t);
    const { store } = await makeStore(dir, {
      manifests: [headerManifest(undefined)],
    });
    await store.install("custom-agent");
    assert.ok(store.getPlugin("custom-agent"));
  });
});

describe("PluginStore duplicate-id rejection at load (Fix 10)", () => {
  test("two same-id plugins in the store file fail load", async (t) => {
    const dir = await makeTempDir(t);
    const storePath = join(dir, "plugins.json");
    await writeFile(
      storePath,
      JSON.stringify(
        persistedConfig([
          vikunjaManifest(),
          vikunjaManifest({ version: "9.9.9" }),
        ]),
      ),
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
      JSON.stringify(persistedConfig([openRouterBuiltin()])),
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
      approvedDigests: {},
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
      approvedDigests: {},
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