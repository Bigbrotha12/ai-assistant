import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { bearer } from "better-auth/plugins";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sendEmailVerificationMail, sendPasswordResetMail } from "./email.ts";
import { env } from "./env.ts";
import {
  createSendVerificationEmailCallback,
  getSendVerificationRateLimitGate,
} from "./verify_email.ts";
import {
  clearDeleting,
  completeDeletion,
  handleAccountDeletionAPIError,
  markDeleting,
  withOwnerBarrier,
} from "./account_deletion.ts";

mkdirSync(dirname(env.DB_PATH), { recursive: true });

const isProduction = env.NODE_ENV === "production";

// Shared handle on the better-auth SQLite database. Exported (C2) so the
// later tri-state `requireApiKey` can look up the owning user: an API key's
// `referenceId` is the user id, and the gate needs that user's
// `emailVerified` flag. The gate itself lives in a later step.
export const authDb = new Database(env.DB_PATH);

export interface AuthUserRow {
  id: string;
  name: string;
  email: string;
  /** Normalized to a real boolean (SQLite stores this column as INTEGER 0/1). */
  emailVerified: boolean;
  image: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

/**
 * Fetch a user row by id (e.g. the api key's `referenceId`) including
 * `emailVerified`. Returns `null` when no such user exists.
 */
export function getUserById(id: string): AuthUserRow | null {
  const row = authDb
    .prepare(
      "SELECT id, name, email, emailVerified, image, createdAt, updatedAt FROM user WHERE id = ?",
    )
    .get(id) as
    | (Omit<AuthUserRow, "emailVerified"> & { emailVerified: number | boolean })
    | undefined;
  if (!row) return null;
  return { ...row, emailVerified: Boolean(row.emailVerified) };
}

/**
 * M12: default API-key lifetime at CREATE time — 90 days, in SECONDS.
 *
 * CRITICAL UNIT: better-auth's api-key plugin treats
 * `keyExpiration.defaultExpiresIn` as SECONDS — the create path computes
 * `expiresAt = getDate(span, "sec") = Date.now() + span * 1000`. The previous
 * literal `60 * 60 * 24 * 365 * 1000` was therefore evaluated as ~31.5
 * BILLION seconds (~1000 years), not the 1 year its `*1000` suggested (that
 * multiplier belongs to milliseconds, which this option does not use).
 * Applies only at create: keys minted before this change keep their original
 * `expiresAt` until rotated (client-side M12 rotation sweep).
 */
export const API_KEY_DEFAULT_EXPIRES_IN_SECONDS = 90 * 24 * 60 * 60;

/**
 * The exact apiKey-plugin configuration the gateway is built with, exported so
 * tests exercise key minting through the production config surface (same
 * object, no copied literals that could drift).
 */
export const API_KEY_PLUGIN_OPTIONS = {
  defaultPrefix: "sk",
  defaultKeyLength: 32,
  keyExpiration: {
    defaultExpiresIn: API_KEY_DEFAULT_EXPIRES_IN_SECONDS,
  },
  // The plugin defaults to a per-key cap of 10 verifications/24h, which
  // would throttle legitimate inference traffic and surface as false 401s
  // (our `requireApiKey` maps verify failures to unauthorized). The
  // gateway applies its own per-key token-bucket limiter on
  // /v1/chat/completions (INFERENCE_RATE_LIMIT / INFERENCE_RATE_BURST), so
  // the plugin-level cap is disabled here.
  rateLimit: { enabled: false },
};

/** Minimal user shape the deletion hooks need (better-auth passes its `User`). */
export type DeletionHookUser = { id: string };

export type AccountDeletionRuntime = {
  abortOwner?: (owner: string) => unknown | Promise<unknown>;
  deleteSessionsForOwner?: (owner: string) => unknown | Promise<unknown>;
  invalidateForUser?: (owner: string) => unknown | Promise<unknown>;
  releaseOwner?: (owner: string) => unknown | Promise<unknown>;
};

let accountDeletionRuntime: AccountDeletionRuntime | undefined;
let accountDeletionNotifyStore:
  | { delete(owner: string): Promise<boolean> }
  | undefined;

export function configureAccountDeletionRuntime(
  runtime: AccountDeletionRuntime | undefined,
): void {
  accountDeletionRuntime = runtime;
}

export function configureAccountDeletionNotifyStore(
  store: { delete(owner: string): Promise<boolean> } | undefined,
): void {
  accountDeletionNotifyStore = store;
}

export type AccountDeletionDeps = {
  /** better-auth SQLite handle — the `apikey` table keys rows by `referenceId`. */
  db: DatabaseType;
  /**
   * Owner-scoped ledger purge (`Ledger.purgeOwnerData`): cancels the owner's
   * non-terminal jobs, drops/recreates the append-only triggers and deletes
   * the rows in one transaction. Omitted when the caller has no ledger.
   */
  purgeLedgerOwner?: (owner: string) => unknown | Promise<unknown>;
  /**
   * Resolves the notify credential store used for `NotifyStore.delete(owner)`.
   * Omitted when the caller has no notify store.
   */
  getNotifyStore?: () =>
    | { delete(owner: string): Promise<boolean> }
    | undefined;
  getRuntime?: () => AccountDeletionRuntime | undefined;
};

export type AccountDeletionHooks = {
  beforeDelete: (user: DeletionHookUser) => Promise<void>;
  afterDelete: (user: DeletionHookUser) => Promise<void>;
};

/**
 * Cascade cleanup for better-auth's built-in, session-guarded
 * `POST /api/auth/delete-user` (M12). The built-in delete removes the `user`
 * and `session` rows but MISSES apikey rows, the encrypted notify blob and
 * ledger tasks — these hooks sweep them, each strictly self-scoped to
 * `user.id` (never another owner's rows).
 *
 * All cleanup runs in `beforeDelete`, while the user row still exists. A
 * failure aborts the delete and leaves the account retryable; every purge is
 * idempotent so a retry can safely repeat the already-completed work.
 */
export function createAccountDeletionHooks(
  deps: AccountDeletionDeps,
): AccountDeletionHooks {
  return {
    async beforeDelete(user) {
      markDeleting(user.id);
      try {
        await withOwnerBarrier(user.id, async () => {
          const runtime = deps.getRuntime?.() ?? {};
          await runtime.abortOwner?.(user.id);
          await runtime.deleteSessionsForOwner?.(user.id);
          await runtime.invalidateForUser?.(user.id);
          await runtime.releaseOwner?.(user.id);
          deps.db
            .prepare("DELETE FROM apikey WHERE referenceId = ?")
            .run(user.id);
          if (deps.purgeLedgerOwner) await deps.purgeLedgerOwner(user.id);
          const store = deps.getNotifyStore?.();
          if (store) await store.delete(user.id);
        });
      } catch (error) {
        clearDeleting(user.id);
        throw error;
      }
    },
    async afterDelete(user) {
      completeDeletion(user.id);
    },
  };
}

export const auth = betterAuth({
  appName: "AI Assistant",
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  database: authDb,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // C2: a fresh signup gets `token: null` and NO session row, and sign-in
    // of an unverified account is rejected with better-auth's built-in
    // 403 EMAIL_NOT_VERIFIED until the emailed token flips `emailVerified`.
    // (`autoSignIn` and `requireEmailVerification` live here — better-auth
    // reads both from `emailAndPassword`, not from `emailVerification`.)
    autoSignIn: false,
    requireEmailVerification: true,
    // Route the email to our own reset page (`GET /reset-password?token=…`,
    // served by the Hono app) instead of better-auth's `/api/auth` callback
    // redirect — the app has no deep-link handling, so the emailed link must
    // land on a page the token can be entered into.
    sendResetPassword: async ({ user, token }) => {
      await sendPasswordResetMail({
        to: user.email,
        url: `${env.BETTER_AUTH_URL}/reset-password?token=${token}`,
      });
    },
  },
  // C2: top-level better-auth option (NOT a plugin). `sendOnSignIn` makes the
  // sign-in 403 path also re-send the mail; `autoSignInAfterVerification`
  // signs the user in when they hit the verify page. Token lifetime stays
  // better-auth's default 1h (`expiresIn` deliberately unset).
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    // Point the emailed link at OUR Hono page (`GET /verify-email?token=…`),
    // not better-auth's `/api/auth/verify-email` JSON response — the page
    // fetches the wire route and renders a human-readable outcome.
    // `sendOnSignUp`, `sendOnSignIn`, and explicit resend all use this callback,
    // intentionally sharing one verification mail per address per 60 seconds.
    sendVerificationEmail: createSendVerificationEmailCallback(
      async ({ user, token }) => {
        await sendEmailVerificationMail({
          to: user.email,
          url: `${env.BETTER_AUTH_URL}/verify-email?token=${token}`,
        });
      },
      { gate: getSendVerificationRateLimitGate() },
    ),
  },
  // M12 — full account deletion via better-auth's built-in, session-guarded
  // `POST /api/auth/delete-user` (password-confirmed body; sensitiveSession-
  // Middleware requires a session, the password OR a fresh session gates the
  // destructive step). No custom endpoint. Without
  // `sendDeleteAccountVerification` better-auth deletes immediately after the
  // password/freshness check, sandwiching its own user/session row removal
  // between the cascade hooks.
  user: {
    deleteUser: {
      enabled: true,
      ...createAccountDeletionHooks({
        db: authDb,
        getRuntime: () => accountDeletionRuntime,
        purgeLedgerOwner: async (owner) => {
          // Lazy dynamic import: a static `import { ledger } from
          // "./ledger.routes.ts"` would open LEDGER_DB_PATH and start the
          // retention sweep for EVERY importer of auth.ts (api_key.ts,
          // tests) and form the cycle auth -> ledger.routes -> api_key ->
          // auth. index.ts loads ledger.routes at boot in production; tests
          // inject their own purge through createAccountDeletionHooks.
          const { ledger } = await import("./ledger.routes.ts");
          return ledger.purgeOwnerData(owner);
        },
        getNotifyStore: () => accountDeletionNotifyStore,
      }),
    },
  },
  // H2 server half: sliding 30-day session. better-auth session time values
  // are in SECONDS — 30d = 30*24*60*60. The sliding refresh (once per day,
  // better-auth's default cadence) extends `expiresAt` in the DB WITHOUT
  // rotating the token, so a persisted session token stays valid while the
  // user is active.
  session: {
    expiresIn: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  advanced: {
    cookiePrefix: "ai-assistant",
    useSecureCookies: isProduction,
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
  },
  onAPIError: {
    onError: handleAccountDeletionAPIError,
  },
  plugins: [
    // M12: 90-day default expiry (SECONDS — see
    // API_KEY_DEFAULT_EXPIRES_IN_SECONDS); shared options object exported for
    // tests so key-minting assertions run through the production config.
    apiKey(API_KEY_PLUGIN_OPTIONS),
    bearer(),
  ],
});

export type Auth = typeof auth;
