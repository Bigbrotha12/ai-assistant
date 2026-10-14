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
