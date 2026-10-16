import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { envSchema } from "../src/config/env.ts";

const REQUIRED = {
  BETTER_AUTH_SECRET: "test-secret-at-least-thirty-two-characters",
  BETTER_AUTH_URL: "http://localhost:17600",
};

function parse(input: Record<string, string> = {}) {
  return envSchema.parse({ ...REQUIRED, ...input });
}

describe("immutable-image env overrides (env schema)", () => {
  test("DEFAULT_MODEL_PROVIDER_BASE_URL / MODEL default to the OpenRouter URL + model", () => {
    const env = parse();
    assert.equal(env.DEFAULT_MODEL_PROVIDER_BASE_URL, "https://openrouter.ai/api/v1");
    assert.equal(env.DEFAULT_MODEL_PROVIDER_MODEL, "openrouter/auto");
  });

  test("provider overrides parse to the configured values", () => {
    const env = parse({
      DEFAULT_MODEL_PROVIDER_BASE_URL: "https://llm.example.test/v1",
      DEFAULT_MODEL_PROVIDER_MODEL: "my-selfhosted-model",
    });
    assert.equal(env.DEFAULT_MODEL_PROVIDER_BASE_URL, "https://llm.example.test/v1");
    assert.equal(env.DEFAULT_MODEL_PROVIDER_MODEL, "my-selfhosted-model");
  });

  test("DEFAULT_MODEL_PROVIDER_BASE_URL rejects non-URL values", () => {
    assert.throws(() => parse({ DEFAULT_MODEL_PROVIDER_BASE_URL: "not-a-url" }));
  });

  test("CONFIG_DIR defaults to /config and is overridable", () => {
    assert.equal(parse().CONFIG_DIR, "/config");
    assert.equal(parse({ CONFIG_DIR: "/custom-config" }).CONFIG_DIR, "/custom-config");
  });

  test("AGENT_SPEC_MAX_SKILLS defaults to 50", () => {
    assert.equal(parse().AGENT_SPEC_MAX_SKILLS, 50);
  });

  test("MCP_TRUSTED_HOSTS defaults to an empty list", () => {
    assert.deepEqual(parse().MCP_TRUSTED_HOSTS, []);
  });

  test("MAX_ESTABLISH_BODY_BYTES defaults to 25 MiB and is overridable", () => {
    assert.equal(parse().MAX_ESTABLISH_BODY_BYTES, 25_000_000);
    assert.equal(parse({ MAX_ESTABLISH_BODY_BYTES: "10000000" }).MAX_ESTABLISH_BODY_BYTES, 10_000_000);
    assert.ok(parse().MAX_ESTABLISH_BODY_BYTES > parse().MAX_REQUEST_BODY_BYTES);
  });

  test("MCP_TRUSTED_HOSTS parses a comma-separated list", () => {
    const env = parse({
      MCP_TRUSTED_HOSTS: "*.productivity.svc.cluster.local, ln.health.svc.cluster.local ",
    });
    assert.deepEqual(env.MCP_TRUSTED_HOSTS, [
      "*.productivity.svc.cluster.local",
      "ln.health.svc.cluster.local",
    ]);
  });

  test("SUPERUSER_API_KEY defaults to an empty list (gate disabled)", () => {
    assert.deepEqual(parse().SUPERUSER_API_KEY, []);
  });

  test("SUPERUSER_API_KEY parses a trimmed comma-separated rotation list", () => {
    const env = parse({
      SUPERUSER_API_KEY: " old-secret , new-secret ,, ",
    });
    assert.deepEqual(env.SUPERUSER_API_KEY, ["old-secret", "new-secret"]);
  });

  test("agent spec caps + skill budget are env-configurable", () => {
    const env = parse({
      AGENT_SKILL_BUDGET_TOKENS: "9000",
      AGENT_SPEC_MAX_SYSTEM_PROMPT: "16000",
      AGENT_SPEC_MAX_SKILLS: "75",
      AGENT_SPEC_MAX_MCPS: "30",
      AGENT_SPEC_MAX_TOOLS: "150",
    });
    assert.equal(env.AGENT_SKILL_BUDGET_TOKENS, 9000);
    assert.equal(env.AGENT_SPEC_MAX_SYSTEM_PROMPT, 16000);
    assert.equal(env.AGENT_SPEC_MAX_SKILLS, 75);
    assert.equal(env.AGENT_SPEC_MAX_MCPS, 30);
    assert.equal(env.AGENT_SPEC_MAX_TOOLS, 150);
  });

  test("Sentinel policy defaults to advisory and supports the blocking flip", () => {
    assert.equal(parse().SENTINEL_POLICY_MODE, "advisory");
    assert.equal(parse({ SENTINEL_POLICY_MODE: "blocking" }).SENTINEL_POLICY_MODE, "blocking");
    assert.equal(parse().SENTINEL_MAX_BODY_BYTES, 65_536);
    assert.equal(parse({ SENTINEL_MAX_BODY_BYTES: "1024" }).SENTINEL_MAX_BODY_BYTES, 1_024);
  });

  test("Sentinel semantic knobs default (disabled, kev-4b, 0.5, 2000ms, context-aware)", () => {
    const env = parse();
    assert.equal(env.SENTINEL_SEMANTIC_ENABLED, false);
    assert.equal(env.SENTINEL_SEMANTIC_PLUGIN_ID, "kev-4b");
    assert.equal(env.SENTINEL_SEMANTIC_THRESHOLD, 0.5);
    assert.equal(env.SENTINEL_SEMANTIC_TIMEOUT_MS, 2_000);
    assert.equal(env.SENTINEL_SEMANTIC_CONTEXT_AWARE, true);
  });

  test("Sentinel semantic booleans use a strict string enum, not z.coerce.boolean", () => {
    // "false" must not be coerced to true (the z.coerce.boolean trap).
    assert.equal(parse({ SENTINEL_SEMANTIC_ENABLED: "true" }).SENTINEL_SEMANTIC_ENABLED, true);
    assert.equal(parse({ SENTINEL_SEMANTIC_ENABLED: "false" }).SENTINEL_SEMANTIC_ENABLED, false);
    assert.equal(parse({ SENTINEL_SEMANTIC_CONTEXT_AWARE: "false" }).SENTINEL_SEMANTIC_CONTEXT_AWARE, false);
    assert.throws(() => parse({ SENTINEL_SEMANTIC_ENABLED: "1" }));
    assert.throws(() => parse({ SENTINEL_SEMANTIC_ENABLED: "yes" }));
  });

  test("Sentinel semantic threshold is bounded 0..1", () => {
    assert.equal(parse({ SENTINEL_SEMANTIC_THRESHOLD: "0.25" }).SENTINEL_SEMANTIC_THRESHOLD, 0.25);
    assert.throws(() => parse({ SENTINEL_SEMANTIC_THRESHOLD: "1.5" }));
    assert.throws(() => parse({ SENTINEL_SEMANTIC_THRESHOLD: "-0.1" }));
  });

  test("Sentinel semantic plugin id + timeout are overridable", () => {
    const env = parse({
      SENTINEL_SEMANTIC_PLUGIN_ID: "kev-8b",
      SENTINEL_SEMANTIC_TIMEOUT_MS: "5000",
    });
    assert.equal(env.SENTINEL_SEMANTIC_PLUGIN_ID, "kev-8b");
    assert.equal(env.SENTINEL_SEMANTIC_TIMEOUT_MS, 5_000);
  });

  test("LEDGER_RETENTION_MS / LEDGER_SWEEP_INTERVAL_MS default to 24h / 1h and are overridable", () => {
    assert.equal(parse().LEDGER_RETENTION_MS, 86_400_000);
    assert.equal(parse().LEDGER_SWEEP_INTERVAL_MS, 3_600_000);
    const env = parse({
      LEDGER_RETENTION_MS: "3600000",
      LEDGER_SWEEP_INTERVAL_MS: "600000",
    });
    assert.equal(env.LEDGER_RETENTION_MS, 3_600_000);
    assert.equal(env.LEDGER_SWEEP_INTERVAL_MS, 600_000);
  });
});

describe("builtin openrouter plugin env overrides (fresh process)", () => {
  const run = (overrides: Record<string, string> = {}) => {
    const environment = { ...process.env };
    for (const key of [
      "DEFAULT_MODEL_PROVIDER_BASE_URL",
      "DEFAULT_MODEL_PROVIDER_MODEL",
    ]) delete environment[key];
    return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      const { openRouterPlugin } = await import('./src/plugins/builtin/openrouter.ts');
      process.stdout.write(JSON.stringify({
        endpoint: openRouterPlugin.inference.endpoint,
        defaultModel: openRouterPlugin.inference.defaultModel,
        baseUrl: openRouterPlugin.baseUrls[0].url,
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
        PLUGINS_TRUSTED_HOSTS: "",
        ...overrides,
      },
    });
  };

  test("defaults to the OpenRouter endpoint + model when unset", () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      endpoint: "https://openrouter.ai/api/v1",
      defaultModel: "openrouter/auto",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  test("overrides endpoint, baseUrl, and defaultModel", () => {
    const result = run({
      DEFAULT_MODEL_PROVIDER_BASE_URL: "https://llm.example.test/v1",
      DEFAULT_MODEL_PROVIDER_MODEL: "my-selfhosted-model",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      endpoint: "https://llm.example.test/v1",
      defaultModel: "my-selfhosted-model",
      baseUrl: "https://llm.example.test/v1",
    });
  });
});

describe("MCP_TRUSTED_HOSTS fail-fast (fresh process)", () => {
  const run = (mcpTrustedHosts: string) => {
    const environment = { ...process.env };
    for (const key of ["MCP_TRUSTED_HOSTS", "PLUGINS_TRUSTED_HOSTS"]) delete environment[key];
    return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      await import('./src/config/env.ts');
      process.stdout.write('ok');
    `], {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      env: {
        ...environment,
        DOTENV_CONFIG_PATH: "/dev/null",
        NODE_ENV: "test",
        BETTER_AUTH_SECRET: "test-secret-at-least-thirty-two-characters",
        BETTER_AUTH_URL: "http://localhost:17600",
        MCP_TRUSTED_HOSTS: mcpTrustedHosts,
      },
    });
  };

  test("a well-formed allowlist starts the gateway", () => {
    const result = run("*.productivity.svc.cluster.local");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "ok");
  });

  test("a malformed entry (scheme) fails fast at load", () => {
    const result = run("http://example.com");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid MCP_TRUSTED_HOSTS/);
  });
});
