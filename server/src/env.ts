import { config } from "dotenv";
import { z } from "zod";
import { parseTrustedHostEntries } from "./plugins/ssrf.ts";

config({ quiet: true });

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
  INFERENCE_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  INFERENCE_RATE_BURST: z.coerce.number().int().positive().default(20),
  LEDGER_DB_PATH: z.string().default("./data/ledger.db"),
  LEDGER_STUCK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  LEDGER_LEASE_EXPIRY_MS: z.coerce.number().int().positive().default(60_000),
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