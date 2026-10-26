import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../src/algorithms/clock.js";
import { RateLimiter } from "../src/engine/rate-limiter.js";
import type { RateLimitPolicy, RequestContext } from "../src/types.js";

const tenantId = "org-acme-prod";
let limiter: RateLimiter | undefined;

afterEach(() => {
  limiter?.close();
  limiter = undefined;
});

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId,
    clientIp: "203.0.113.10",
    userId: "usr_a",
    route: "/api/v1/payments",
    method: "POST",
    headers: {},
    ...overrides,
  };
}

function policies(list: RateLimitPolicy[]): RateLimiter {
  limiter = new RateLimiter({
    policies: list,
    clock: new FakeClock(1_700_000_000_000),
    sweepIntervalMs: 60_000,
  });
  return limiter;
}

describe("core enforcement", () => {
  it("allows until the limit then returns 429 semantics", () => {
    const engine = policies([
      {
        id: "user",
        tenantId,
        name: "user",
        algorithm: "token-bucket",
        capacity: 3,
        refillRatePerSecond: 3,
        scope: "client",
        keyStrategy: { dimensions: ["userId"] },
      },
    ]);

    expect(engine.evaluate(ctx()).allowed).toBe(true);
    expect(engine.evaluate(ctx()).allowed).toBe(true);
    const lastAllow = engine.evaluate(ctx());
    expect(lastAllow.allowed).toBe(true);
    expect(lastAllow.remaining).toBe(0);

    const blocked = engine.evaluate(ctx());
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("CLIENT_KEY_EXCEEDED");
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("refills token buckets over elapsed time", () => {
    const clock = new FakeClock(0);
    limiter = new RateLimiter({
      clock,
      sweepIntervalMs: 60_000,
      policies: [
        {
          id: "user",
          tenantId,
          name: "user",
          algorithm: "token-bucket",
          capacity: 1,
          refillRatePerSecond: 1,
          keyStrategy: { dimensions: ["userId"] },
        },
      ],
    });

    expect(limiter.evaluate(ctx()).allowed).toBe(true);
    expect(limiter.evaluate(ctx()).allowed).toBe(false);
    clock.advance(1000);
    expect(limiter.evaluate(ctx()).allowed).toBe(true);
  });
});

describe("noisy neighbor isolation", () => {
  it("lets user B continue after user A exhausts a per-user cap without draining the tenant pool", () => {
    const engine = policies([
      {
        id: "tenant",
        tenantId,
        name: "tenant",
        algorithm: "token-bucket",
        capacity: 5,
        refillRatePerSecond: 5,
        scope: "tenant",
        keyStrategy: { dimensions: [] },
      },
      {
        id: "user",
        tenantId,
        name: "user",
        algorithm: "sliding-window",
        capacity: 2,
        windowSizeSeconds: 60,
        scope: "client",
        keyStrategy: { dimensions: ["userId"] },
      },
    ]);

    expect(engine.evaluate(ctx({ userId: "A" })).allowed).toBe(true);
    expect(engine.evaluate(ctx({ userId: "A" })).allowed).toBe(true);
    for (let i = 0; i < 10; i += 1) {
      const denied = engine.evaluate(ctx({ userId: "A" }));
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toBe("CLIENT_KEY_EXCEEDED");
    }

    expect(engine.evaluate(ctx({ userId: "B" })).allowed).toBe(true);
    expect(engine.evaluate(ctx({ userId: "B" })).allowed).toBe(true);

    const leftover = engine.evaluate(ctx({ userId: "C", priority: "critical" }));
    expect(leftover.allowed).toBe(true);
    const tenantExhausted = engine.evaluate(ctx({ userId: "D", priority: "critical" }));
    expect(tenantExhausted.allowed).toBe(false);
    expect(tenantExhausted.reason).toBe("TENANT_QUOTA_EXCEEDED");
  });
});

describe("IPv6 subnet masking", () => {
  it("shares a pool for two addresses in the same /64", () => {
    const engine = policies([
      {
        id: "ip",
        tenantId,
        name: "ip",
        algorithm: "token-bucket",
        capacity: 1,
        refillRatePerSecond: 1,
        keyStrategy: { dimensions: ["ip"], ipv6SubnetMask: 64 },
      },
    ]);

    const first = engine.evaluate(
      ctx({ clientIp: "2001:db8:85a3::1", userId: undefined }),
    );
    const second = engine.evaluate(
      ctx({ clientIp: "2001:db8:85a3::ffff", userId: undefined }),
    );
    const other = engine.evaluate(
      ctx({ clientIp: "2001:db8:85a3:1::1", userId: undefined }),
    );

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(other.allowed).toBe(true);
  });
});

describe("multi-dimension keys", () => {
  it("tracks user and IP limits independently", () => {
    const engine = policies([
      {
        id: "user",
        tenantId,
        name: "user",
        algorithm: "token-bucket",
        capacity: 1,
        refillRatePerSecond: 1,
        keyStrategy: { dimensions: ["userId"] },
      },
      {
        id: "ip",
        tenantId,
        name: "ip",
        algorithm: "token-bucket",
        capacity: 5,
        refillRatePerSecond: 5,
        keyStrategy: { dimensions: ["ip"] },
      },
    ]);

    expect(engine.evaluate(ctx({ userId: "u1", clientIp: "203.0.113.1" })).allowed).toBe(true);
    expect(engine.evaluate(ctx({ userId: "u1", clientIp: "203.0.113.1" })).allowed).toBe(false);
    expect(engine.evaluate(ctx({ userId: "u2", clientIp: "203.0.113.1" })).allowed).toBe(true);
  });
});

describe("request cost", () => {
  it("rejects zero, negative, and non-finite cost even when fail-open", () => {
    limiter = new RateLimiter({
      failOpen: true,
      clock: new FakeClock(1_700_000_000_000),
      sweepIntervalMs: 60_000,
      policies: [
        {
          id: "user",
          tenantId,
          name: "user",
          algorithm: "token-bucket",
          capacity: 3,
          refillRatePerSecond: 3,
          keyStrategy: { dimensions: ["userId"] },
        },
      ],
    });

    expect(limiter.evaluate(ctx({ cost: -1 })).allowed).toBe(false);
    expect(limiter.evaluate(ctx({ cost: 0 })).allowed).toBe(false);
    expect(limiter.evaluate(ctx({ cost: Number.NaN })).allowed).toBe(false);
    expect(limiter.evaluate(ctx({ cost: Number.POSITIVE_INFINITY })).allowed).toBe(false);
    const allowed = limiter.evaluate(ctx());
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(2);
  });
});

describe("peek persistence", () => {
  it("does not persist buckets for keys that never commit", () => {
    limiter = new RateLimiter({
      maxKeys: 8,
      clock: new FakeClock(1_700_000_000_000),
      sweepIntervalMs: 60_000,
      policies: [
        {
          id: "tenant",
          tenantId,
          name: "tenant",
          algorithm: "token-bucket",
          capacity: 1,
          refillRatePerSecond: 1,
          scope: "tenant",
          keyStrategy: { dimensions: [] },
        },
        {
          id: "user",
          tenantId,
          name: "user",
          algorithm: "token-bucket",
          capacity: 10,
          refillRatePerSecond: 10,
          scope: "client",
          keyStrategy: { dimensions: ["userId"] },
        },
      ],
    });

    expect(limiter.evaluate(ctx({ userId: "seed", priority: "critical" })).allowed).toBe(true);
    for (let i = 0; i < 50; i += 1) {
      const denied = limiter.evaluate(ctx({ userId: `probe-${i}`, priority: "critical" }));
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toBe("TENANT_QUOTA_EXCEEDED");
    }

    expect(limiter.tenantMetrics(tenantId).activeTrackedKeys).toBeLessThanOrEqual(2);
  });
});

describe("store configuration", () => {
  it("rejects a non-positive maxKeys cap", () => {
    expect(
      () =>
        new RateLimiter({
          maxKeys: 0,
          policies: [],
        }),
    ).toThrow(/maxKeys/);
  });
});

describe("memory eviction", () => {
  it("bounds tracked keys under churn", () => {
    limiter = new RateLimiter({
      maxKeys: 25,
      ttlMs: 1,
      sweepIntervalMs: 60_000,
      clock: new FakeClock(1000),
      policies: [
        {
          id: "ip",
          tenantId,
          name: "ip",
          algorithm: "token-bucket",
          capacity: 10,
          refillRatePerSecond: 10,
          keyStrategy: { dimensions: ["ip"] },
        },
      ],
    });

    for (let i = 0; i < 200; i += 1) {
      limiter.evaluate(ctx({ clientIp: `203.0.113.${i % 200}`, userId: `u${i}` }));
    }

    const metrics = limiter.tenantMetrics(tenantId);
    expect(metrics.activeTrackedKeys).toBeLessThanOrEqual(25);
    expect(metrics.currentMemoryEstimatedBytes).toBeGreaterThan(0);
  });
});

describe("priority shedder", () => {
  it("sheds background traffic when the tenant is near capacity", () => {
    const engine = policies([
      {
        id: "tenant",
        tenantId,
        name: "tenant",
        algorithm: "token-bucket",
        capacity: 10,
        refillRatePerSecond: 10,
        scope: "tenant",
        keyStrategy: { dimensions: [] },
      },
    ]);

    for (let i = 0; i < 9; i += 1) {
      expect(engine.evaluate(ctx({ userId: `u${i}`, priority: "critical" })).allowed).toBe(true);
    }

    const background = engine.evaluate(ctx({ userId: "bg", priority: "background" }));
    expect(background.allowed).toBe(false);
    expect(background.reason).toBe("NOISY_NEIGHBOR_THROTTLED");

    const critical = engine.evaluate(ctx({ userId: "crit", priority: "critical" }));
    expect(critical.allowed).toBe(true);
  });
});

describe("fail-open vs fail-closed", () => {
  it("fails closed when a policy cannot be evaluated", () => {
    limiter = new RateLimiter({
      failOpen: false,
      policies: [
        {
          id: "bad",
          tenantId,
          name: "bad",
          algorithm: "leaky-bucket",
          capacity: 1,
          keyStrategy: { dimensions: [] },
        },
      ],
    });
    const result = limiter.evaluate(ctx());
    expect(result.allowed).toBe(false);
  });

  it("fails open when configured", () => {
    limiter = new RateLimiter({
      failOpen: true,
      policies: [
        {
          id: "bad",
          tenantId,
          name: "bad",
          algorithm: "leaky-bucket",
          capacity: 1,
          keyStrategy: { dimensions: [] },
        },
      ],
    });
    expect(limiter.evaluate(ctx()).allowed).toBe(true);
  });
});
