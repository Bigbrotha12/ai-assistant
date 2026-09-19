import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Hono } from "hono";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatRoutesOptions } from "../src/transport/chat.ts";
import type { JobRunnerDeps } from "../src/jobs/runner.ts";
import type { BuildModelInput } from "../src/transport/model.ts";
import type { ToolPluginDefinition } from "../src/plugins/types.ts";

const plugin: ToolPluginDefinition = {
  id: "vikunja",
  version: "1.0.0",
  schemaVersion: 1,
  type: "tool",
  name: "Tasks",
  description: "Tasks",
  tools: [{ name: "list_tasks", description: "List", readOnly: true, inputSchema: { type: "object" } }],
  credentials: { apiKey: { label: "Key", required: true } },
  baseUrls: [{ id: "tasks", url: "https://tasks.example.test" }],
};

test("production context config validates limits and warmups default off", () => {
  const run = (overrides: Record<string, string> = {}) => {
    const environment = { ...process.env };
    for (const key of [
      "CONTEXT_TOKEN_LIMIT", "WARMUP_ENABLED", "WARMUP_MAX_CONCURRENT",
      "WARMUP_TIMEOUT_MS", "BUDGET_MODEL_CALL_LIMIT", "BUDGET_MODEL_CALL_WINDOW_MS",
    ]) delete environment[key];
    return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      const { env } = await import('./src/env.ts');
      process.stdout.write(JSON.stringify({
        limit: env.CONTEXT_TOKEN_LIMIT, warmups: env.WARMUP_ENABLED,
        calls: env.BUDGET_MODEL_CALL_LIMIT, window: env.BUDGET_MODEL_CALL_WINDOW_MS,
        concurrency: env.WARMUP_MAX_CONCURRENT, timeout: env.WARMUP_TIMEOUT_MS,
      }));
    `], {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      env: {
        ...environment,
        DOTENV_CONFIG_PATH: "/dev/null",
        NODE_ENV: "test",
        BETTER_AUTH_SECRET: "test-secret-at-least-thirty-two-characters",
        BETTER_AUTH_URL: "http://localhost:17600",
        PORT: "17600",
        CHECKPOINT_DB_KEY: "test-checkpoint-key",
        PLUGINS_TRUSTED_HOSTS: "",
        ...overrides,
      },
    });
  };
  const defaults = run();
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout), {
    limit: 32_768, warmups: false, calls: 60, window: 60_000, concurrency: 2, timeout: 10_000,
  });
  const configured = run({
    CONTEXT_TOKEN_LIMIT: "8192", WARMUP_ENABLED: "true",
    BUDGET_MODEL_CALL_LIMIT: "4", BUDGET_MODEL_CALL_WINDOW_MS: "120000",
    WARMUP_MAX_CONCURRENT: "1", WARMUP_TIMEOUT_MS: "500",
  });
  assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(JSON.parse(configured.stdout), {
    limit: 8192, warmups: true, calls: 4, window: 120_000, concurrency: 1, timeout: 500,
  });
  for (const key of [
    "CONTEXT_TOKEN_LIMIT", "BUDGET_MODEL_CALL_LIMIT", "BUDGET_MODEL_CALL_WINDOW_MS",
    "WARMUP_MAX_CONCURRENT", "WARMUP_TIMEOUT_MS",
  ]) {
    for (const value of ["0", "-1", "1.5", "9007199254740992", "invalid"]) {
      const invalid = run({ [key]: value });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, new RegExp(key));
    }
  }
  for (const value of ["1", "yes", "", "FALSE"]) {
    const invalid = run({ WARMUP_ENABLED: value });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /WARMUP_ENABLED/);
  }
  for (const key of ["WARMUP_MAX_CONCURRENT", "WARMUP_TIMEOUT_MS"]) {
    const invalid = run({ [key]: "2147483648" });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, new RegExp(key));
  }
});

test("production boot shares phase 4 services and uses scoped model credentials", async (t) => {
  let chat!: ChatRoutesOptions;
  let runner!: JobRunnerDeps;
  let modelInput!: BuildModelInput;
  let fetchApp!: Hono["fetch"];
  let executorOptions: Record<string, unknown> = {};
  const calls: unknown[][] = [];
  const cleanup: string[] = [];
  const registry = {
    watch() {},
    disposeWatch() { cleanup.push("watch"); },
    requirePlugin() { return plugin; },
    listInstalledPlugins() { return [plugin]; },
  };
  const store = { async load() {}, getPinnedIps() { return []; } };
  const environment = {
    PORT: 17600,
    BUDGET_MAX_CONCURRENT: 2,
    BUDGET_QUEUE_MAX: 3,
    BUDGET_MODEL_CALL_LIMIT: 2,
    BUDGET_MODEL_CALL_WINDOW_MS: 120_000,
    CONTEXT_TOKEN_LIMIT: 16,
    INFERENCE_RATE_LIMIT: 60,
    INFERENCE_RATE_BURST: 20,
    WARMUP_ENABLED: true,
    WARMUP_MAX_CONCURRENT: 1,
    WARMUP_TIMEOUT_MS: 1000,
    PLUGINS_TRUSTED_HOSTS: ["tasks.example.test"],
    CHECKPOINT_DB_KEY: "test-checkpoint-key",
    NOTIFY_BASE_URL: "",
  };
  const modules: Record<string, Record<string, unknown>> = {
    "@hono/node-server": {
      serve: (options: { fetch: Hono["fetch"] }) => {
        fetchApp = options.fetch;
        return { close: () => { cleanup.push("server"); } };
      },
    },
    "./auth.ts": { auth: { handler: () => new Response() } },
    "./env.ts": { env: environment },
    "./inference.ts": { inferenceRoutes: new Hono(), requireApiKey: async () => "test-user" },
    "./ledger.routes.ts": { ledger: {}, ledgerRoutes: new Hono() },
    "./plugins/index.ts": { createPluginWiring: () => ({ registry, store }) },
    "./plugins/routes.ts": { createPluginRoutes: () => new Hono() },
    "./transport/models.ts": { createModelsRoutes: () => new Hono() },
    "./transport/skills.ts": { createSkillsRoutes: () => new Hono() },
    "./transport/mcps.ts": { createMcpRoutes: () => new Hono() },
    "./checkpoints/routes.ts": { createCheckpointRoutes: () => new Hono() },
    "./checkpoints/store.ts": {
      createCheckpointStore: async () => ({ checkpointer: {}, touchThread() {} }),
    },
    "./transport/chat.ts": {
      createChatRoutes: (options: ChatRoutesOptions) => { chat = options; return new Hono(); },
    },
    "./transport/model.ts": {
      buildModel: (input: BuildModelInput) => { modelInput = input; return {}; },
    },
    "./jobs/runner.ts": {
      createJobRunner: (deps: JobRunnerDeps) => {
        runner = deps;
        assert.ok(deps.budget);
        assert.ok(deps.contextManager);
        return { async resumeStuckJobs() {}, dispose() { cleanup.push("runner"); } };
      },
      JobError: class extends Error {
        constructor(readonly code: string, message: string) { super(message); }
      },
      ToolExecutor: class {
        constructor(options: Record<string, unknown>) { executorOptions = options; }
        async execute(...args: unknown[]) { calls.push(args); return "[]"; }
      },
    },
  };
  const globals = globalThis as typeof globalThis & { __productionModules?: typeof modules };
  globals.__productionModules = modules;
  const originalTerm = process.listeners("SIGTERM");
  const originalInt = process.listeners("SIGINT");
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.includes("/src/index.ts") && modules[specifier]) {
        const source = Object.keys(modules[specifier]!).map((key) =>
          `export const ${key} = globalThis.__productionModules[${JSON.stringify(specifier)}][${JSON.stringify(key)}];`,
        ).join("\n");
        return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => {
    hooks.deregister();
    delete globals.__productionModules;
    chat.warmups?.dispose();
    chat.toolCache?.dispose();
    for (const listener of process.listeners("SIGTERM")) {
      if (!originalTerm.includes(listener)) process.removeListener("SIGTERM", listener);
    }
    for (const listener of process.listeners("SIGINT")) {
      if (!originalInt.includes(listener)) process.removeListener("SIGINT", listener);
    }
  });
  await import("../src/index.ts");
  assert.equal(runner.budget, chat.budget);
  assert.equal(runner.contextManager, chat.contextManager);
  assert.equal(runner.threadLocks, chat.threadLocks);
  assert.equal(runner.toolCache, chat.toolCache);
  assert.equal(runner.pins, chat.pins);
  assert.equal(executorOptions.registry, registry);
  assert.equal(executorOptions.trustedHosts, environment.PLUGINS_TRUSTED_HOSTS);
  assert.deepEqual((executorOptions.getPinnedIps as () => unknown)(), []);

  const budget = chat.budget!;
  budget.beforeModelCall("alice", "sync");
  runner.budget!.beforeModelCall("alice", "async");
  const denied = budget.reserveModelCall("alice", "vision");
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.ok(denied.retryAfterSeconds > 60);
  assert.equal(budget.reserveModelCall("bob").ok, true);
  assert.deepEqual(chat.contextManager!.truncateSeed([
    new HumanMessage("x".repeat(200)),
    new HumanMessage("latest"),
  ]).map((message) => message.content), ["latest"]);
  assert.throws(() => chat.contextManager!.prepareMessages([
    new SystemMessage("x".repeat(100)), new HumanMessage("latest"),
  ], {}), { code: "context_length_exceeded" });

  const credentials = Object.freeze({ apiKey: "admission-scoped-test-key" });
  let checked = 0;
  const context = { credentials, signal: new AbortController().signal, assertActive: () => { checked++; } };
  chat.pins!.get = () => { throw new Error("latest pin must never be read"); };
  await runner.buildModel!("model", { owner: "alice", requestModel: "override", requestParameters: { temperature: 0 } }, context);
  assert.equal(checked, 1);
  assert.equal(modelInput.credentials, credentials);
  assert.equal(modelInput.requestModel, "override");
  assert.deepEqual(modelInput.requestParameters, { temperature: 0 });
  assert.equal(modelInput.trustedHosts, environment.PLUGINS_TRUSTED_HOSTS);
  assert.throws(() => runner.buildModel!("model", undefined, { ...context, credentials: undefined }), { code: "credentials_expired" });
  assert.throws(() => runner.buildModel!("model", undefined, { ...context, signal: AbortSignal.abort() }));

  const call = { owner: "warm-owner", pluginId: plugin.id, tool: "list_tasks", args: {}, credentials: { apiKey: "tool-test-key" } };
  const admission = chat.warmups!.schedule(call);
  assert.equal(admission.ok, true);
  if (!admission.ok) return;
  assert.equal(budget.activeCount(call.owner), 1);
  assert.deepEqual(await admission.done, { status: "warmed" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.slice(0, 4), [plugin.id, call.tool, {}, call.credentials]);
  assert.ok(calls[0]![4] instanceof AbortSignal);
  assert.equal(budget.activeCount(call.owner), 0);
  assert.equal(budget.modelCallCount(call.owner), 0);
  const cached = chat.warmups!.schedule(call);
  assert.equal(cached.ok, true);
  if (cached.ok) assert.deepEqual(await cached.done, { status: "cached" });
  assert.equal(calls.length, 1);

  assert.equal((await fetchApp(new Request("http://localhost/"))).status, 200);
  const disposeCache = chat.toolCache!.dispose.bind(chat.toolCache);
  chat.toolCache!.dispose = () => { cleanup.push("cache"); disposeCache(); };
  registry.disposeWatch = () => { cleanup.push("watch"); throw new Error("test cleanup failure"); };
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  const shutdown = process.listeners("SIGTERM").find((listener) => !originalTerm.includes(listener))!;
  shutdown("SIGTERM");
  shutdown("SIGTERM");
  assert.deepEqual(cleanup, ["runner", "watch", "cache", "server"]);
  assert.deepEqual(errors, [["gateway: plugin watcher cleanup failed"]]);
  assert.deepEqual(chat.warmups!.schedule(call), { ok: false, reason: "disposed" });
  const rejected = await fetchApp(new Request("http://localhost/"));
  assert.equal(rejected.status, 503);
  assert.deepEqual(await rejected.json(), { error: "shutting_down" });
});
