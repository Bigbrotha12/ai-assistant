type Bucket = {
  tokens: number;
  lastRefill: number;
};

export type TokenBucketLimiterOptions = {
  maxEntries?: number;
  staleAfterMs?: number;
  now?: () => number;
};

/** A token-bucket limiter with a one-token [refund] escape hatch. */
export type TokenBucketLimiter = ((key: string) => boolean) & {
  /**
   * Returns one previously consumed token to [key] (capped at the burst
   * ceiling). Used when an action gated by [key] fails after consuming its
   * token, so a transient downstream failure does not lock the caller out for
   * the whole refill window.
   */
  refund: (key: string) => void;
};

/**
 * In-memory per-key token-bucket rate limiter.
 *
 * The bucket refills continuously at `ratePerMinute / 60` tokens per second up
 * to the `burst` ceiling; each call consumes one token. A key with no prior
 * state gets a full bucket (minus the token the call consumes).
 */
export function createTokenBucketLimiter(
  ratePerMinute: number,
  burst: number,
  options: TokenBucketLimiterOptions = {},
): TokenBucketLimiter {
  const refillPerSecond = ratePerMinute / 60;
  const buckets = new Map<string, Bucket>();
  const clock = options.now ?? (() => Date.now());
  const staleAfterMs = options.staleAfterMs;
  const maxEntries =
    options.maxEntries === undefined ? undefined : Math.max(1, Math.floor(options.maxEntries));

  const pruneExpired = (now: number): void => {
    if (staleAfterMs === undefined) return;
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastRefill >= staleAfterMs) buckets.delete(key);
    }
  };

  const limiter = ((key: string): boolean => {
    const now = clock();
    let bucket = buckets.get(key);
    if (bucket && staleAfterMs !== undefined && now - bucket.lastRefill >= staleAfterMs) {
      buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      pruneExpired(now);
      if (maxEntries !== undefined) {
        while (buckets.size >= maxEntries) {
          const oldest = buckets.keys().next().value;
          if (oldest === undefined) break;
          buckets.delete(oldest);
        }
      }
      buckets.set(key, { tokens: burst - 1, lastRefill: now });
      return true;
    }
    const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000);
    bucket.tokens = Math.min(
      burst,
      bucket.tokens + elapsedSeconds * refillPerSecond,
    );
    bucket.lastRefill = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }) as TokenBucketLimiter;
  limiter.refund = (key) => {
    const bucket = buckets.get(key);
    if (!bucket) return;
    bucket.tokens = Math.min(burst, bucket.tokens + 1);
    bucket.lastRefill = clock();
  };
  return limiter;
}

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
 * Per-ADDRESS resend limiter for verification emails (C2): at least 60
 * seconds between sends to the same address (keyed lowercased). better-auth's
 * global rate limit (`rateLimit.window`/`max`) is shared across callers and
 * is NOT per-address, so the resend endpoint
 * (`POST /api/auth/send-verification-email`) gets this custom gate instead.
 *
 * Built from the standard token bucket with rate=1/min and burst=1: the
 * first send consumes the only token, so a second send to the same key is
 * denied until the bucket has refilled a full 60 seconds later
 * (`retryAfterSeconds` = ceil(60 / rate) = 60).
 *
 * In-memory state — SINGLE-REPLICA assumption (same constraint as every
 * other limiter in this file: a multi-replica deployment would need shared
 * storage for the buckets).
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
