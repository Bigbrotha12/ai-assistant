import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { envSchema } from "../src/env.ts";

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

  test("MCP_TRUSTED_HOSTS parses a comma-separated list", () => {
    const env = parse({
      MCP_TRUSTED_HOSTS: "*.productivity.svc.cluster.local, ln.health.svc.cluster.local ",
    });
    assert.deepEqual(env.MCP_TRUSTED_HOSTS, [
      "*.productivity.svc.cluster.local",
      "ln.health.svc.cluster.local",
    ]);
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
      await import('./src/env.ts');
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
    assert.match(result.stderr, /invalid MCP_TRUSTED_HOSTS|must be an exact/);
  });
});