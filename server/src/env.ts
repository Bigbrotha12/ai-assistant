import { config } from "dotenv";
import { z } from "zod";
import { parseTrustedHostEntries } from "./plugins/ssrf.ts";

config({ quiet: true });

/**
 * Development-only encryption key for the checkpoint store. Conversations must
 * survive gateway restarts in dev too, so this default is a STABLE literal
 * (never randomly re-derived — a fresh random key per boot would make every
 * previously-written checkpoint DB unreadable). It is a loud anti-pattern
 * named as such; production is fail-fast instead (see the superRefine below).
 */
const CHECKPOINT_DEV_DEFAULT_KEY = "dev-only-checkpoint-encryption-key-not-for-production";

export const envSchema = z.object({
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET is required and must be at least 32 characters"),
  BETTER_AUTH_URL: z
    .string()
    .url("BETTER_AUTH_URL must be an absolute URL, e.g. http://localhost:17600"),
  PORT: z.coerce.number().int().positive().default(17600),
  DB_PATH: z.string().default("./data/gateway.db"),
  CONFIG_DIR: z.string().default("/config"),
  // Sustained / burst ceiling for `POST /v1/chat/completions`, applied
  // PER-OWNER (the authenticated user id, not the API key) since Phase 4
  // Wave A — a user with many keys cannot rotate keys to bypass the limit.
  INFERENCE_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  INFERENCE_RATE_BURST: z.coerce.number().int().positive().default(20),
  // Per-user concurrency budget (Phase 4, Wave A): max in-flight chat
  // operations (sync streams + background jobs) and how many background
  // admissions may queue per owner before rejection.
  BUDGET_MAX_CONCURRENT: z.coerce.number().int().positive().default(2),
  BUDGET_QUEUE_MAX: z.coerce.number().int().positive().default(3),
  BUDGET_MODEL_CALL_LIMIT: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(60),
  BUDGET_MODEL_CALL_WINDOW_MS: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(60_000),
  CONTEXT_TOKEN_LIMIT: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(32_768),
  // Skill injection budget for composeAgentPrompt (chars/4 token heuristic).
  AGENT_SKILL_BUDGET_TOKENS: z.coerce.number().int().positive().max(1_000_000).default(6000),
  // Custom-agent spec guard rails (size caps in the request body schema).
  AGENT_SPEC_MAX_SYSTEM_PROMPT: z.coerce.number().int().positive().default(8000),
  AGENT_SPEC_MAX_SKILLS: z.coerce.number().int().positive().default(50),
  AGENT_SPEC_MAX_MCPS: z.coerce.number().int().positive().default(20),
  AGENT_SPEC_MAX_TOOLS: z.coerce.number().int().positive().default(100),
  WARMUP_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  WARMUP_MAX_CONCURRENT: z.coerce.number().int().positive().max(2_147_483_647).default(2),
  WARMUP_TIMEOUT_MS: z.coerce.number().int().positive().max(2_147_483_647).default(10_000),
  // Outbound model-call timeout (ms). ChatOpenAI otherwise uses the SDK's
  // default (~10 min); a hung upstream would block a stream that long.
  MODEL_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Per-call timeout (ms) for MCP server JSON-RPC (initialize/tools/list/
  // tools/call). A hung MCP server must not block the request forever.
  MCP_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  LEDGER_DB_PATH: z.string().default("./data/ledger.db"),
  LEDGER_STUCK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  LEDGER_LEASE_EXPIRY_MS: z.coerce.number().int().positive().default(60_000),
  CHECKPOINT_DB_PATH: z.string().default("./data/checkpoints.db"),
  // Encrypted-at-rest key for the checkpoint store. Required in production
  // (fail-fast below); development falls back to a stable DEV-ONLY default and
  // warns loudly. The transform guarantees a non-undefined value by export.
  CHECKPOINT_DB_KEY: z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      if (process.env.NODE_ENV === "production" && !value) {
        ctx.addIssue({
          code: "custom",
          message:
            "CHECKPOINT_DB_KEY is required when NODE_ENV=production; " +
            "the checkpoint DB is encrypted at rest and refuses a plaintext default",
        });
      }
    })
    .transform((value) => {
      if (value) return value;
      console.warn(
        "Gateway: CHECKPOINT_DB_KEY is unset; using a DEVELOPMENT-ONLY default " +
          "key for the checkpoint store. Set CHECKPOINT_DB_KEY to a real secret " +
          "(e.g. `openssl rand -hex 32`) before production.",
      );
      return CHECKPOINT_DEV_DEFAULT_KEY;
    }),
  // SMTP settings for the password-reset email (better-auth
  // `sendResetPassword`). Empty SMTP_HOST (the default) disables sending and
  // logs the reset link instead — a development fallback so the forgot-password
  // flow stays testable without a mail server.
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default(""),
  // ntfy push-notification server base URL (e.g. `https://ntfy.example.com`).
  // Empty (the default) = push notifications disabled; the /api/notify
  // provisioning endpoints remain available regardless.
  NOTIFY_BASE_URL: z
    .string()
    .default("")
    .superRefine((value, ctx) => {
      if (value === "") return;
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error(`unsupported protocol '${url.protocol}'`);
        }
      } catch {
        ctx.addIssue({
          code: "custom",
          message:
            "NOTIFY_BASE_URL must be an absolute http(s) URL or empty to disable notifications",
        });
      }
    }),
  PLUGINS_STORE_PATH: z.string().default("./data/plugins.json"),
  PLUGINS_TRUSTED_HOSTS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((host) => host.trim())
        .filter((host) => host.length > 0),
    ),
  // Admin-vouched MCP server hosts (hostnames/IPs/wildcards, comma-separated).
  // Two privileges over the default SSRF posture, scoped to the MCP path ONLY:
  //  1. Range checks are bypassed (like PLUGINS_TRUSTED_HOSTS) so in-cluster
  //     ClusterIP MCP servers resolve without DISALLOWED_HOST/DNS_REBINDING.
  //  2. Unlike plugins — which stay https-only in production — an MCP host on
  //     this list MAY use http: in production, because MCP SSE/streamable
  //     servers inside a homelab are plain http services. Scheme enforcement
  //     for everything else (plugins, LLM endpoints) is untouched, and all
  //     other SSRF defenses (DNS-rebinding pinning, redirect refusal) still
  //     apply to MCP calls.
  MCP_TRUSTED_HOSTS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((host) => host.trim())
        .filter((host) => host.length > 0),
    ),
  // Default model plugin provider override — provider-agnostic. The builtin
  // model plugin's endpoint + default model come from these (OpenRouter
  // defaults), so a self-hosted operator can point at any OpenAI-compatible
  // provider without editing code.
  DEFAULT_MODEL_PROVIDER_BASE_URL: z
    .string()
    .url("DEFAULT_MODEL_PROVIDER_BASE_URL must be an absolute URL")
    .default("https://openrouter.ai/api/v1"),
  DEFAULT_MODEL_PROVIDER_MODEL: z.string().trim().min(1).default("openrouter/auto"),
  // Console log level. error < warn < info < debug.
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Gateway: invalid environment configuration");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

// PLUGINS_TRUSTED_HOSTS entries are used verbatim as SSRF trusted-host
// patterns; a malformed entry (a scheme, port, path, whitespace, bare `*` or
// mid-string wildcard) silently never matches and would leave an admin
// thinking an internal host is allowed when it is not. Fail fast at load,
// matching the other env checks below.
try {
  parseTrustedHostEntries(env.PLUGINS_TRUSTED_HOSTS);
} catch (err) {
  console.error(`Gateway: ${(err as Error).message}`);
  process.exit(1);
}

// Same fail-fast for MCP_TRUSTED_HOSTS; a malformed entry would silently never
// match and leave an admin thinking an internal MCP host is reachable.
try {
  parseTrustedHostEntries(env.MCP_TRUSTED_HOSTS);
} catch (err) {
  console.error(`Gateway: ${(err as Error).message}`);
  process.exit(1);
}

// The ledger threshold ordering is fixed: stuck-timeout must be strictly
// shorter than lease-expiry so the watchdog never marks a task `stuck` and
// then deadlocks waiting for the lease to lapse. Fail fast at load rather
// than at Ledger construction (which would hard-crash at import time).
if (env.LEDGER_STUCK_TIMEOUT_MS >= env.LEDGER_LEASE_EXPIRY_MS) {
  console.error(
    `Gateway: LEDGER_STUCK_TIMEOUT_MS (${env.LEDGER_STUCK_TIMEOUT_MS}) ` +
      `must be < LEDGER_LEASE_EXPIRY_MS (${env.LEDGER_LEASE_EXPIRY_MS}) ` +
      `so the stuck watchdog fires before the lease would deadlock a relaunch.`,
  );
  process.exit(1);
}

export type Env = typeof env;