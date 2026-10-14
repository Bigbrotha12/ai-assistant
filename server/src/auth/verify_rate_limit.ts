import { createTokenBucketLimiter } from "../managers/token_bucket.ts";

export type AddressLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export const SEND_VERIFICATION_MAX_BUCKETS = 10_000;
export const SEND_VERIFICATION_BUCKET_TTL_MS = 10 * 60 * 1000;

export type SendVerificationRateLimiterOptions = {
  maxEntries?: number;
  staleAfterMs?: number;
  now?: () => number;
};

/**
 * Per-ADDRESS resend limiter for verification emails: at least 60 seconds
 * between sends to the same address (keyed lowercased). better-auth's global
 * rate limit (`rateLimit.window`/`max`) is shared across callers and is NOT
 * per-address, so the resend endpoint (`POST /api/auth/send-verification-email`)
 * gets this custom gate instead.
 *
 * Built from the standard token bucket with rate=1/min and burst=1: the first
 * send consumes the only token, so a second send to the same key is denied
 * until the bucket has refilled a full 60 seconds later (`retryAfterSeconds`
 * = ceil(60 / rate) = 60).
 *
 * In-memory state — SINGLE-REPLICA assumption (same constraint as the token
 * bucket it builds: a multi-replica deployment would need shared storage).
 */
export type SendVerificationRateLimiter = ((
  email: string,
) => AddressLimitResult) & {
  /** Refunds the consumed token after a failed send (see [TokenBucketLimiter.refund]). */
  refund: (email: string) => void;
};

export function createSendVerificationRateLimiter(
  options: SendVerificationRateLimiterOptions = {},
): SendVerificationRateLimiter {
  const bucket = createTokenBucketLimiter(1, 1, {
    maxEntries: options.maxEntries ?? SEND_VERIFICATION_MAX_BUCKETS,
    staleAfterMs: options.staleAfterMs ?? SEND_VERIFICATION_BUCKET_TTL_MS,
    now: options.now,
  });
  const limiter = ((email: string): AddressLimitResult => ({
    allowed: bucket(email.trim().toLowerCase()),
    retryAfterSeconds: 60,
  })) as SendVerificationRateLimiter;
  limiter.refund = (email) => bucket.refund(email.trim().toLowerCase());
  return limiter;
}
