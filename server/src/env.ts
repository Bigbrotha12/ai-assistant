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

const envSchema = z.object({
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET is required and must be at least 32 characters"),
  BETTER_AUTH_URL: z
    .string()
    .url("BETTER_AUTH_URL must be an absolute URL, e.g. http://localhost:17600"),
  INFERENCE_URL: z
    .string()
    .url("INFERENCE_URL must be an absolute URL of the OpenAI-compatible engine"),
  PORT: z.coerce.number().int().positive().default(17600),
  DB_PATH: z.string().default("./data/gateway.db"),
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
  WARMUP_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  WARMUP_MAX_CONCURRENT: z.coerce.number().int().positive().max(2_147_483_647).default(2),
  WARMUP_TIMEOUT_MS: z.coerce.number().int().positive().max(2_147_483_647).default(10_000),
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

const inferenceUrl = new URL(env.INFERENCE_URL);
const inferencePort = inferenceUrl.port
  ? Number(inferenceUrl.port)
  : inferenceUrl.protocol === "https:"
    ? 443
    : 80;
if (inferencePort === env.PORT) {
  console.error(
    `Gateway: INFERENCE_URL (${env.INFERENCE_URL}) must not point at this gateway's own port (PORT=${env.PORT}).`,
  );
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