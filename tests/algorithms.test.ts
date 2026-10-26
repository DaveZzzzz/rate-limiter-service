import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/algorithms/clock.js";
import { SlidingWindowCounterAlgorithm } from "../src/algorithms/sliding-window-counter.js";
import { TokenBucketAlgorithm } from "../src/algorithms/token-bucket.js";
import type { RateLimitPolicy } from "../src/types.js";

const tenant = "t1";

function tokenPolicy(capacity: number, refill: number): RateLimitPolicy {
  return {
    id: "tb",
    tenantId: tenant,
    name: "tb",
    algorithm: "token-bucket",
    capacity,
    refillRatePerSecond: refill,
    keyStrategy: { dimensions: ["userId"] },
  };
}

function windowPolicy(capacity: number, windowSizeSeconds: number): RateLimitPolicy {
  return {
    id: "sw",
    tenantId: tenant,
    name: "sw",
    algorithm: "sliding-window",
    capacity,
    windowSizeSeconds,
    keyStrategy: { dimensions: ["userId"] },
  };
}

describe("TokenBucketAlgorithm", () => {
  it("allows until capacity then denies, and refills over time", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const algo = new TokenBucketAlgorithm();
    const policy = tokenPolicy(2, 1);
    const state = algo.createState(policy, clock.nowMs());

    expect(algo.commit(state, policy, 1, clock.nowMs()).allowed).toBe(true);
    expect(algo.commit(state, policy, 1, clock.nowMs()).allowed).toBe(true);
    const denied = algo.commit(state, policy, 1, clock.nowMs());
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    clock.advance(1000);
    const refilled = algo.commit(state, policy, 1, clock.nowMs());
    expect(refilled.allowed).toBe(true);
    expect(refilled.remaining).toBe(0);
  });

  it("peek does not mutate state", () => {
    const algo = new TokenBucketAlgorithm();
    const policy = tokenPolicy(1, 1);
    const now = 1000;
    const state = algo.createState(policy, now);
    algo.peek(state, policy, 1, now);
    algo.peek(state, policy, 1, now);
    expect(algo.commit(state, policy, 1, now).allowed).toBe(true);
    expect(algo.commit(state, policy, 1, now).allowed).toBe(false);
  });
});

describe("SlidingWindowCounterAlgorithm", () => {
  it("smooths across window boundaries", () => {
    const clock = new FakeClock(0);
    const algo = new SlidingWindowCounterAlgorithm();
    const policy = windowPolicy(10, 10);
    const state = algo.createState(policy, clock.nowMs());

    for (let i = 0; i < 10; i += 1) {
      expect(algo.commit(state, policy, 1, clock.nowMs()).allowed).toBe(true);
    }
    expect(algo.commit(state, policy, 1, clock.nowMs()).allowed).toBe(false);

    // At the exact window boundary the previous window still fully counts.
    // After 1s into the next window, previous weight is 0.9 so 1 more request fits.
    clock.advance(11_000);
    expect(algo.commit(state, policy, 1, clock.nowMs()).allowed).toBe(true);
  });
});
