import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../src/algorithms/clock.js";
import { RateLimiter } from "../src/engine/rate-limiter.js";
import { buildApp } from "../src/http/app.js";

const tenantId = "org-acme-prod";

async function appWith(limiter: RateLimiter) {
  return buildApp({ limiter, enableDemoMiddleware: true });
}

describe("HTTP API", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns 200 then 429 with RFC rate-limit headers", async () => {
    const limiter = new RateLimiter({
      clock: new FakeClock(1_700_000_000_000),
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
    app = await appWith(limiter);

    const payload = {
      tenantId,
      clientIp: "203.0.113.10",
      userId: "usr_99812",
      route: "/api/v1/payments",
      method: "POST",
      priority: "critical",
    };

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/rate-limit/check",
      payload,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["x-ratelimit-limit"]).toBe("1");
    expect(allowed.headers["x-ratelimit-remaining"]).toBe("0");
    expect(allowed.headers["x-ratelimit-reset"]).toBeTruthy();
    expect(JSON.parse(allowed.body).allowed).toBe(true);

    const blocked = await app.inject({
      method: "POST",
      url: "/v1/rate-limit/check",
      payload,
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeTruthy();
    expect(JSON.parse(blocked.body).reason).toBe("CLIENT_KEY_EXCEEDED");
  });

  it("exposes tenant metrics and prometheus text", async () => {
    const limiter = new RateLimiter({
      policies: [
        {
          id: "user",
          tenantId,
          name: "user",
          algorithm: "token-bucket",
          capacity: 10,
          refillRatePerSecond: 10,
          keyStrategy: { dimensions: ["userId"] },
        },
      ],
    });
    app = await appWith(limiter);
    await app.inject({
      method: "POST",
      url: "/v1/rate-limit/check",
      payload: {
        tenantId,
        clientIp: "203.0.113.10",
        userId: "usr_1",
        route: "/",
        method: "GET",
      },
    });

    const metrics = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/metrics`,
    });
    expect(metrics.statusCode).toBe(200);
    expect(JSON.parse(metrics.body).totalEvaluations).toBe(1);

    const promo = await app.inject({ method: "GET", url: "/metrics" });
    expect(promo.statusCode).toBe(200);
    expect(promo.body).toContain("rate_limit_evaluations_total");
  });

  it("rejects non-positive cost with 400", async () => {
    const limiter = new RateLimiter({
      policies: [
        {
          id: "user",
          tenantId,
          name: "user",
          algorithm: "token-bucket",
          capacity: 10,
          refillRatePerSecond: 10,
          keyStrategy: { dimensions: ["userId"] },
        },
      ],
    });
    app = await appWith(limiter);

    const blocked = await app.inject({
      method: "POST",
      url: "/v1/rate-limit/check",
      payload: {
        tenantId,
        clientIp: "203.0.113.10",
        userId: "usr_1",
        route: "/",
        method: "GET",
        cost: -5,
      },
    });
    expect(blocked.statusCode).toBe(400);
    expect(JSON.parse(blocked.body).error).toMatch(/cost/);
  });

  it("resets quotas", async () => {
    const limiter = new RateLimiter({
      policies: [
        {
          id: "user",
          tenantId,
          name: "user",
          algorithm: "token-bucket",
          capacity: 1,
          refillRatePerSecond: 0.01,
          keyStrategy: { dimensions: ["userId"] },
        },
      ],
    });
    app = await appWith(limiter);
    const payload = {
      tenantId,
      clientIp: "203.0.113.10",
      userId: "usr_1",
      route: "/",
      method: "GET",
    };
    await app.inject({ method: "POST", url: "/v1/rate-limit/check", payload });
    expect(
      (await app.inject({ method: "POST", url: "/v1/rate-limit/check", payload })).statusCode,
    ).toBe(429);

    const reset = await app.inject({
      method: "POST",
      url: "/v1/rate-limit/reset",
      payload: { tenantId },
    });
    expect(JSON.parse(reset.body).removed).toBeGreaterThan(0);
    expect(
      (await app.inject({ method: "POST", url: "/v1/rate-limit/check", payload })).statusCode,
    ).toBe(200);
  });
});
