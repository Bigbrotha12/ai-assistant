import { createTokenBucketLimiter } from "../rate_limit.ts";

/**
 * Per-OWNER rate limiting (Phase 4, Wave A middleware).
 *
 * The gateway's existing `createTokenBucketLimiter` (`src/rate_limit.ts`) is
 * an in-memory, continuously-refilled token bucket keyed by API key. That
 * algorithm — the single source of truth for admission — is wrapped, NOT
 * re-implemented: this factory keeps the exact bucket the rest of the gateway
 * uses and adds the richer `{ allowed, retryAfterSeconds }` shape the chat
 * transport needs for the `Retry-After` header.
 *
 * `retryAfterSeconds` is derived from the bucket's refill rate: a denied key
 * needs (at most) one token to be admitted again, and the bucket refills at
 * `ratePerMinute / 60` tokens/second, so the refill bound for one token is
 * `ceil(60 / ratePerMinute)` — floored at 1 second. This is a conservative
 * upper bound (a bucket that is near-full recovers sooner), which is the safe
 * direction for a `Retry-After` header.
 *
 * In-memory per-owner state, no persistence. Fine for the single-instance
 * gateway (same constraint as the token bucket and credential pins it composes).
 * `rateLimiter.check(owner)` is keyed by the authenticated user id — a user
 * with many API keys cannot rotate keys to bypass the limit, because the owner
 * (not the key) is the bucket key.
 */
export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export type PerOwnerRateLimiter = {
  check(owner: string): RateLimitResult;
};

export type PerOwnerRateLimiterOptions = {
  /** Sustained refill rate (requests/minute). Default 60 (INFERENCE default). */
  ratePerMinute?: number;
  /** Bucket ceiling (consecutive requests allowed at once). Default 20. */
  burst?: number;
};

const DEFAULT_RATE_PER_MINUTE = 60;
const DEFAULT_BURST = 20;

export function createPerOwnerRateLimiter(
  opts: PerOwnerRateLimiterOptions = {},
): PerOwnerRateLimiter {
  const ratePerMinute = opts.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE;
  const burst = opts.burst ?? DEFAULT_BURST;
  const limiter = createTokenBucketLimiter(ratePerMinute, burst);
  const retryAfterSeconds = Math.max(1, Math.ceil(60 / ratePerMinute));

  return {
    check(owner: string): RateLimitResult {
      return { allowed: limiter(owner), retryAfterSeconds };
    },
  };
}