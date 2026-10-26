import { getAlgorithm, MonotonicClock, type Clock } from "../algorithms/index.js";
import { buildCompositeKey, isTenantPolicy, matchesPolicy } from "../extractors/index.js";
import type { ConsumeResult, RateLimitPolicy, RateLimitResult, RequestContext } from "../types.js";
import { BucketStore } from "./bucket-store.js";
import { MetricsRegistry, renderPrometheus } from "./metrics.js";
import { PolicyStore } from "./policy-store.js";

export interface RateLimiterOptions {
  policies?: RateLimitPolicy[];
  clock?: Clock;
  failOpen?: boolean;
  maxKeys?: number;
  ttlMs?: number;
  sweepIntervalMs?: number;
  shedThreshold?: number;
  standardShedThreshold?: number;
}

interface Applicable {
  policy: RateLimitPolicy;
  key: string;
}

export class RateLimiter {
  readonly policies: PolicyStore;
  readonly buckets: BucketStore;
  readonly metrics = new MetricsRegistry();
  readonly clock: Clock;
  readonly failOpen: boolean;
  readonly shedThreshold: number;
  readonly standardShedThreshold: number;

  constructor(options: RateLimiterOptions = {}) {
    this.policies = new PolicyStore(options.policies ?? []);
    this.clock = options.clock ?? new MonotonicClock();
    this.failOpen = options.failOpen ?? false;
    this.shedThreshold = options.shedThreshold ?? 0.9;
    this.standardShedThreshold = options.standardShedThreshold ?? 0.95;
    this.buckets = new BucketStore(
      options.maxKeys ?? 100_000,
      options.ttlMs ?? defaultTtlMs(options.policies ?? []),
    );
    this.buckets.startSweep(options.sweepIntervalMs ?? 5_000, () => this.clock.nowMs());
  }

  close(): void {
    this.buckets.stopSweep();
  }

  evaluate(ctx: RequestContext): RateLimitResult {
    const cost = ctx.cost ?? 1;
    if (!isPositiveCost(cost)) {
      return {
        allowed: false,
        limit: 0,
        remaining: 0,
        resetAt: Math.floor(this.clock.nowMs() / 1000),
        retryAfterSeconds: 1,
      };
    }
    try {
      return this.evaluateOrThrow(ctx, cost);
    } catch {
      if (this.failOpen) {
        return { allowed: true, limit: 0, remaining: 0, resetAt: Math.floor(this.clock.nowMs() / 1000) };
      }
      return {
        allowed: false,
        limit: 0,
        remaining: 0,
        resetAt: Math.floor(this.clock.nowMs() / 1000),
        retryAfterSeconds: 1,
        reason: "TENANT_QUOTA_EXCEEDED",
      };
    }
  }

  reset(tenantId: string, keySubstring?: string): number {
    return this.buckets.deleteByTenant(tenantId, keySubstring);
  }

  tenantMetrics(tenantId: string) {
    return this.metrics.snapshot(
      tenantId,
      this.buckets.activeKeys(tenantId),
      this.buckets.estimatedBytes(tenantId),
    );
  }

  prometheus(): string {
    return renderPrometheus(
      this.metrics.allSnapshots(
        (tenantId) => this.buckets.activeKeys(tenantId),
        (tenantId) => this.buckets.estimatedBytes(tenantId),
      ),
    );
  }

  private evaluateOrThrow(ctx: RequestContext, cost: number): RateLimitResult {
    const nowMs = this.clock.nowMs();
    if (this.policies.forTenant(ctx.tenantId).length === 0) {
      const result: RateLimitResult = this.failOpen
        ? { allowed: true, limit: 0, remaining: 0, resetAt: Math.floor(nowMs / 1000) }
        : {
            allowed: false,
            limit: 0,
            remaining: 0,
            resetAt: Math.floor(nowMs / 1000),
            retryAfterSeconds: 1,
            reason: "TENANT_QUOTA_EXCEEDED",
          };
      return result;
    }
    const applicable = this.applicablePolicies(ctx);
    const client = applicable.filter((item) => !isTenantPolicy(item.policy));
    const tenant = applicable.filter((item) => isTenantPolicy(item.policy));

    const clientPeek = this.peekAll(client, cost, nowMs);
    const deniedClient = clientPeek.find((item) => !item.result.allowed);
    if (deniedClient) {
      const result = toResult(deniedClient.result, "CLIENT_KEY_EXCEEDED");
      this.metrics.record(ctx.tenantId, false, result.reason);
      return result;
    }

    const tenantPeek = this.peekAll(tenant, cost, nowMs);
    const tightestTenant = tightest(tenantPeek.map((item) => item.result));
    const utilization = tightestTenant?.utilization ?? 0;
    const shed = this.shouldShed(normalizePriority(ctx.priority), utilization);
    if (shed) {
      const result: RateLimitResult = {
        allowed: false,
        limit: tightestTenant?.limit ?? 0,
        remaining: tightestTenant?.remaining ?? 0,
        resetAt: tightestTenant?.resetAt ?? Math.floor(nowMs / 1000),
        retryAfterSeconds: 1,
        reason: "NOISY_NEIGHBOR_THROTTLED",
      };
      this.metrics.record(ctx.tenantId, false, result.reason);
      return result;
    }

    const deniedTenant = tenantPeek.find((item) => !item.result.allowed);
    if (deniedTenant) {
      const result = toResult(deniedTenant.result, "TENANT_QUOTA_EXCEEDED");
      this.metrics.record(ctx.tenantId, false, result.reason);
      return result;
    }

    this.commitAll(client, cost, nowMs);
    const committedTenant = this.commitAll(tenant, cost, nowMs);
    const reported =
      tightest([
        ...clientPeek.map((item) => item.result),
        ...committedTenant,
      ]) ?? fallbackAllow(nowMs);
    this.metrics.record(ctx.tenantId, true);
    return {
      allowed: true,
      limit: reported.limit,
      remaining: reported.remaining,
      resetAt: reported.resetAt,
    };
  }

  private applicablePolicies(ctx: RequestContext): Applicable[] {
    return this.policies
      .forTenant(ctx.tenantId)
      .filter((policy) => matchesPolicy(policy, ctx))
      .map((policy) => ({ policy, key: buildCompositeKey(policy, ctx) }));
  }

  private peekAll(items: Applicable[], cost: number, nowMs: number) {
    return items.map((item) => {
      const algorithm = getAlgorithm(item.policy);
      const existing = this.buckets.touchExisting(item.key, nowMs);
      const state = existing?.state ?? algorithm.createState(item.policy, nowMs);
      return { item, result: algorithm.peek(state, item.policy, cost, nowMs) };
    });
  }

  private commitAll(items: Applicable[], cost: number, nowMs: number): ConsumeResult[] {
    return items.map((item) => {
      const algorithm = getAlgorithm(item.policy);
      const bucket = this.buckets.getOrCreate(item.key, item.policy, nowMs);
      return algorithm.commit(bucket.state, item.policy, cost, nowMs);
    });
  }

  private shouldShed(priority: RequestContext["priority"], utilization: number): boolean {
    if (priority === "background" && utilization >= this.shedThreshold) {
      return true;
    }
    if (priority === "standard" && utilization >= this.standardShedThreshold) {
      return true;
    }
    return false;
  }
}

function tightest(results: ConsumeResult[]): ConsumeResult | undefined {
  if (results.length === 0) {
    return undefined;
  }
  return results.reduce((best, current) =>
    current.remaining / Math.max(1, current.limit) < best.remaining / Math.max(1, best.limit)
      ? current
      : best,
  );
}

function toResult(consume: ConsumeResult, reason: RateLimitResult["reason"]): RateLimitResult {
  return {
    allowed: consume.allowed,
    limit: consume.limit,
    remaining: consume.remaining,
    resetAt: consume.resetAt,
    retryAfterSeconds: consume.retryAfterSeconds,
    reason,
  };
}

function isPositiveCost(cost: number): boolean {
  return Number.isFinite(cost) && cost > 0;
}

function normalizePriority(priority: RequestContext["priority"]): NonNullable<RequestContext["priority"]> {
  if (priority === "critical" || priority === "standard" || priority === "background") {
    return priority;
  }
  return "standard";
}

function defaultTtlMs(policies: RateLimitPolicy[]): number {
  let ttlMs = 60_000;
  for (const policy of policies) {
    if (policy.windowSizeSeconds && policy.windowSizeSeconds > 0) {
      const windows = policy.algorithm === "sliding-window" ? 2 : 1;
      ttlMs = Math.max(ttlMs, policy.windowSizeSeconds * 1000 * windows);
    }
    if (policy.refillRatePerSecond && policy.refillRatePerSecond > 0) {
      ttlMs = Math.max(ttlMs, (policy.capacity / policy.refillRatePerSecond) * 1000);
    }
  }
  return Math.ceil(ttlMs);
}

function fallbackAllow(nowMs: number): ConsumeResult {
  return {
    allowed: true,
    limit: Number.MAX_SAFE_INTEGER,
    remaining: Number.MAX_SAFE_INTEGER,
    resetAt: Math.floor(nowMs / 1000) + 1,
    utilization: 0,
  };
}
