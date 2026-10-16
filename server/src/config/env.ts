import { config } from "dotenv";
import { z } from "zod";
import { parseTrustedHostEntries } from "../plugins/ssrf.ts";
import {
  GOAL_CONTEXT_TOKEN_LIMIT,
  GOAL_FAILED_ATTEMPT_TOKEN_ESTIMATE,
} from "../goals/constants.ts";

config({ quiet: true });

/**
 * Shared parser for the comma-separated trusted-host allowlists
 * (`PLUGINS_TRUSTED_HOSTS`/`MCP_TRUSTED_HOSTS`): split on commas, trim, drop
 * empties. Entry-SHAPE validation is deferred to the fail-fast pass below so
 * the error can name the specific env var (see `parseTrustedHostEntries`).
 */
const trustedHostsList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host.length > 0),
  );

/**
 * Shared parser for comma-separated secret lists (`SUPERUSER_API_KEY`): split
 * on commas, trim, drop empties, so a secret can be rotated by listing the old
 * and new values together. Entries are opaque secrets rather than host
 * patterns, so there is no shape-validation pass like `trustedHostsList` has.
 */
const secretList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((secret) => secret.trim())
      .filter((secret) => secret.length > 0),
  );

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
  // PER-OWNER (the authenticated user id, not the API key): a user with many
  // keys cannot rotate keys to bypass the limit.
  INFERENCE_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  INFERENCE_RATE_BURST: z.coerce.number().int().positive().default(20),
  // Per-user concurrency budget: max in-flight chat operations (sync streams +
  // background jobs) and how many background admissions may queue per owner
  // before rejection.
  BUDGET_MAX_CONCURRENT: z.coerce.number().int().positive().default(2),
  BUDGET_QUEUE_MAX: z.coerce.number().int().positive().default(3),
  BUDGET_MODEL_CALL_LIMIT: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(60),
  BUDGET_MODEL_CALL_WINDOW_MS: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(60_000),
  // CHAT request history cap (see `sessions/store.ts` for the byte projection).
  // This is NOT the goal-log pre-flight bound: goals use a separate,
  // deliberately independent `GOAL_CONTEXT_TOKEN_LIMIT` (60_000 default) and
  // the two must not be tied together.
  CONTEXT_TOKEN_LIMIT: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(32_768),
  // Skill injection budget for composeAgentPrompt (chars/4 token heuristic).
  AGENT_SKILL_BUDGET_TOKENS: z.coerce.number().int().positive().max(1_000_000).default(6000),
  // Phase 7.1 goal token knobs. The defaults live in `goals/constants.ts`
  // (documented there); both are read at step time so an operator can tune the
  // floor and the context gate without a code change.
  GOAL_FAILED_ATTEMPT_TOKEN_ESTIMATE: z
    .coerce.number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(GOAL_FAILED_ATTEMPT_TOKEN_ESTIMATE),
  GOAL_CONTEXT_TOKEN_LIMIT: z
    .coerce.number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(GOAL_CONTEXT_TOKEN_LIMIT),
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
  // Outbound plugin-tool-call timeout (ms). The model and MCP paths have
  // explicit timeouts; without one here a hung tool backend (undici's default
  // is ~5 min) would wedge the thread mutex / budget slot / job fence that
  // long.
  TOOL_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Per-call timeout (ms) for MCP server JSON-RPC (initialize/tools/list/
  // tools/call). A hung MCP server must not block the request forever.
  MCP_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Max accepted request body for `POST /v1/chat/completions` (bytes) on the
  // NON-establish paths (stateless, threaded, and session DELTA turns). Bounds
  // the body buffered before validation so an oversized POST cannot stall the
  // event loop or inflate memory for all users. Large enough for inline
  // base64 vision images.
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().positive().max(2_147_483_647).default(10_000_000),
  // Max accepted request body for a SESSION ESTABLISH: full history + base64
  // images ride the establish body, so it gets a higher ceiling than the
  // delta/stateless paths. The route-level `bodyLimit` is raised to this value;
  // non-establish requests are still bounded by MAX_REQUEST_BODY_BYTES,
  // enforced post-read with the same 413 `request_too_large` shape (the
  // establish/delta distinction is only visible from the parsed body).
  MAX_ESTABLISH_BODY_BYTES: z.coerce.number().int().positive().max(2_147_483_647).default(25_000_000),
  SENTINEL_POLICY_MODE: z.enum(["advisory", "blocking"]).default("advisory"),
  SENTINEL_MAX_BODY_BYTES: z.coerce.number().int().positive().max(2_147_483_647).default(65_536),
  SENTINEL_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  SENTINEL_RATE_BURST: z.coerce.number().int().positive().default(20),
  // Internal semantic (decision-model) path (Kev-4B). `SENTINEL_SEMANTIC_ENABLED`
  // is a strict "true"/"false" string enum, NOT `z.coerce.boolean()`: the latter
  // maps every non-empty string (including "false") to true, so an operator
  // writing "false" would silently enable a feature that calls a private model.
  SENTINEL_SEMANTIC_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Model plugin id backed by the internal decision server. Must resolve to a
  // `mode: "decisions"` plugin; the URL comes from that plugin's definition.
  SENTINEL_SEMANTIC_PLUGIN_ID: z.string().trim().min(1).default("kev-4b"),
  // Minimum confidence at which a semantic question is acted on (0..1).
  SENTINEL_SEMANTIC_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  // Per-question timeout for the semantic decision model call (ms).
  SENTINEL_SEMANTIC_TIMEOUT_MS: z.coerce.number().int().positive().max(2_147_483_647).default(2_000),
  // Whether a semantic question is phrased context-aware (does the text itself
  // express/request it) rather than merely topical. Parsed with the same strict
  // string-enum transform as ENABLED (never `z.coerce.boolean`).
  SENTINEL_SEMANTIC_CONTEXT_AWARE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  LEDGER_DB_PATH: z.string().default("./data/ledger.db"),
  LEDGER_STUCK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  LEDGER_LEASE_EXPIRY_MS: z.coerce.number().int().positive().default(60_000),
  // How long a terminal task (and its steps/chain) is retained before the
  // periodic sweep purges it, and how often that sweep runs.
  LEDGER_RETENTION_MS: z.coerce.number().int().positive().default(86_400_000),
  LEDGER_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  // SMTP settings for the password-reset and email-verification emails
  // (better-auth `sendResetPassword` / `sendVerificationEmail`). Empty
  // SMTP_HOST (the default) disables sending and logs the link instead — a
  // development fallback so those flows stay testable without a mail server.
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default(""),
  PLUGINS_STORE_PATH: z.string().default("./data/plugins.json"),
  PLUGINS_TRUSTED_HOSTS: trustedHostsList,
  // Process-wide ops secrets for the superuser surface (`requireSuperuser`):
  // POST /v1/plugins/reload, POST /v1/plugins/:id/install|uninstall, and the
  // full-detail GET /v1/plugins/:id. Comma-separated so a secret can be rotated
  // without downtime. This is NOT a better-auth API key and corresponds to no
  // user row: it names the synthetic owner "admin" and is deliberately NOT
  // revoked by account deletion. Empty (the default) leaves the superuser gate
  // DISABLED — gated endpoints answer 403. No default is ever generated,
  // logged, or echoed.
  SUPERUSER_API_KEY: secretList,
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
  MCP_TRUSTED_HOSTS: trustedHostsList,
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

// Trusted-host entries are used verbatim as SSRF trusted-host patterns; a
// malformed entry (a scheme, port, path, whitespace, bare `*` or mid-string
// wildcard) silently never matches and would leave an admin thinking an
// internal host is allowed when it is not. Fail fast at load, naming the
// specific knob. Order is PLUGINS → MCP, before the ledger threshold check
// below.
const trustedHostsEnvs: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["PLUGINS_TRUSTED_HOSTS", env.PLUGINS_TRUSTED_HOSTS],
  ["MCP_TRUSTED_HOSTS", env.MCP_TRUSTED_HOSTS],
];
for (const [envVarName, entries] of trustedHostsEnvs) {
  try {
    parseTrustedHostEntries(entries, envVarName);
  } catch (err) {
    console.error(`Gateway: ${(err as Error).message}`);
    process.exit(1);
  }
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