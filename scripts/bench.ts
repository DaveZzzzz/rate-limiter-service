import { RateLimiter } from "../src/engine/rate-limiter.js";

const tenantId = "bench-tenant";
const limiter = new RateLimiter({
  maxKeys: 50_000,
  ttlMs: 60_000,
  sweepIntervalMs: 60_000,
  policies: [
    {
      id: "tenant",
      tenantId,
      name: "tenant",
      algorithm: "token-bucket",
      capacity: 10_000_000,
      refillRatePerSecond: 10_000_000,
      scope: "tenant",
      keyStrategy: { dimensions: [] },
    },
    {
      id: "user",
      tenantId,
      name: "user",
      algorithm: "sliding-window",
      capacity: 10_000_000,
      windowSizeSeconds: 60,
      scope: "client",
      keyStrategy: { dimensions: ["userId"] },
    },
  ],
});

const iterations = Number(process.env.BENCH_ITERS ?? 50_000);
const warmup = 2_000;

for (let i = 0; i < warmup; i += 1) {
  limiter.evaluate({
    tenantId,
    clientIp: "203.0.113.10",
    userId: `warm-${i % 16}`,
    route: "/api",
    method: "GET",
    headers: {},
  });
}

const start = performance.now();
for (let i = 0; i < iterations; i += 1) {
  limiter.evaluate({
    tenantId,
    clientIp: "203.0.113.10",
    userId: `user-${i % 256}`,
    route: "/api",
    method: "GET",
    headers: {},
  });
}
const elapsedMs = performance.now() - start;
const perSecond = Math.round(iterations / (elapsedMs / 1000));

console.log(`evaluations: ${iterations}`);
console.log(`elapsed_ms: ${elapsedMs.toFixed(2)}`);
console.log(`evals_per_sec: ${perSecond}`);

limiter.close();

if (perSecond < 20_000) {
  console.error("throughput below 20,000 evals/sec target");
  process.exitCode = 1;
}
