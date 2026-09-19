import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPerOwnerRateLimiter } from "../../src/middleware/rate_limit.ts";

describe("createPerOwnerRateLimiter", () => {
  it("allows up to the burst, then denies, with a retry-after derived from the refill rate", () => {
    const limiter = createPerOwnerRateLimiter({ ratePerMinute: 3, burst: 3 });
    const owner = "user-1";

    for (let i = 0; i < 3; i++) {
      assert.deepEqual(limiter.check(owner), {
        allowed: true,
        retryAfterSeconds: 20,
      });
    }
    // Burst exhausted: one token needs 60/3 = 20s of refill.
    assert.deepEqual(limiter.check(owner), {
      allowed: false,
      retryAfterSeconds: 20,
    });
    assert.deepEqual(limiter.check(owner), {
      allowed: false,
      retryAfterSeconds: 20,
    });
  });

  it("treats each owner independently", () => {
    const limiter = createPerOwnerRateLimiter({ ratePerMinute: 1, burst: 1 });
    const ownerA = "user-a";
    const ownerB = "user-b";

    assert.equal(limiter.check(ownerA).allowed, true);
    assert.equal(limiter.check(ownerA).allowed, false);
    // Different owner: unaffected by ownerA's exhaustion.
    assert.equal(limiter.check(ownerB).allowed, true);
  });

  it("defaults to 60/min with a burst of 20", () => {
    const limiter = createPerOwnerRateLimiter();
    const owner = "user-1";

    for (let i = 0; i < 20; i++) {
      assert.equal(limiter.check(owner).allowed, true);
    }
    assert.equal(limiter.check(owner).allowed, false);
    assert.equal(limiter.check(owner).retryAfterSeconds, 1);
  });

  it("floors retry-after at 1 second for high refill rates", () => {
    // 600/min => refill 10/s, so ceil(60/600) = 1. Never 0 or blank.
    const limiter = createPerOwnerRateLimiter({ ratePerMinute: 600, burst: 1 });
    const owner = "user-1";
    limiter.check(owner);
    const denied = limiter.check(owner);
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterSeconds, 1);
  });
});