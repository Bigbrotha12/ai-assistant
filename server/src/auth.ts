import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { bearer } from "better-auth/plugins";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sendPasswordResetMail } from "./email.ts";
import { env } from "./env.ts";

mkdirSync(dirname(env.DB_PATH), { recursive: true });

const isProduction = env.NODE_ENV === "production";

export const auth = betterAuth({
  appName: "AI Assistant",
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  database: new Database(env.DB_PATH),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
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
  advanced: {
    cookiePrefix: "ai-assistant",
    useSecureCookies: isProduction,
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
  },
  plugins: [
    apiKey({
      defaultPrefix: "sk",
      defaultKeyLength: 32,
      keyExpiration: {
        defaultExpiresIn: 60 * 60 * 24 * 365 * 1000,
      },
      // The plugin defaults to a per-key cap of 10 verifications/24h, which
      // would throttle legitimate inference traffic and surface as false 401s
      // (our `requireApiKey` maps verify failures to unauthorized). The
      // gateway applies its own per-key token-bucket limiter on
      // /v1/chat/completions (INFERENCE_RATE_LIMIT / INFERENCE_RATE_BURST), so
      // the plugin-level cap is disabled here.
      rateLimit: { enabled: false },
    }),
    bearer(),
  ],
});

export type Auth = typeof auth;