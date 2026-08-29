type Bucket = {
  tokens: number;
  lastRefill: number;
};

/**
 * In-memory per-key token-bucket rate limiter.
 *
 * The bucket refills continuously at `ratePerMinute / 60` tokens per second up
 * to the `burst` ceiling; each call consumes one token. A key with no prior
 * state gets a full bucket (minus the token the call consumes). State is
 * bounded by the number of distinct keys seen — the gateway's only callers —
 * so unbounded growth is not a concern.
 */
export function createTokenBucketLimiter(
  ratePerMinute: number,
  burst: number,
): (key: string) => boolean {
  const refillPerSecond = ratePerMinute / 60;
  const buckets = new Map<string, Bucket>();

  return (key) => {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { tokens: burst - 1, lastRefill: now });
      return true;
    }
    const elapsedSeconds = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(
      burst,
      bucket.tokens + elapsedSeconds * refillPerSecond,
    );
    bucket.lastRefill = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
}