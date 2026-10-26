import type { ConsumeResult, RateLimitPolicy } from "../types.js";
import { unixSeconds } from "./clock.js";
import type { Algorithm } from "./types.js";
import { clampRemaining } from "./types.js";

export interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
}

function refillRate(policy: RateLimitPolicy): number {
  const rate = policy.refillRatePerSecond ?? policy.capacity;
  if (!(rate > 0)) {
    throw new Error(`token-bucket policy ${policy.id} needs a positive refillRatePerSecond`);
  }
  return rate;
}

function refilled(state: TokenBucketState, policy: RateLimitPolicy, nowMs: number): TokenBucketState {
  const elapsedSec = Math.max(0, (nowMs - state.lastRefillMs) / 1000);
  const tokens = Math.min(policy.capacity, state.tokens + elapsedSec * refillRate(policy));
  return { tokens, lastRefillMs: nowMs };
}

function resultFrom(
  tokensBefore: number,
  allowed: boolean,
  policy: RateLimitPolicy,
  nowMs: number,
  cost: number,
): ConsumeResult {
  const rate = refillRate(policy);
  const tokensAfter = allowed ? tokensBefore - cost : tokensBefore;
  const remaining = clampRemaining(tokensAfter);
  const secondsToFull = Math.max(0, (policy.capacity - tokensAfter) / rate);
  const resetAt = unixSeconds(nowMs) + Math.max(1, Math.ceil(secondsToFull || 1 / rate));
  const deficit = allowed ? 0 : Math.max(0, cost - tokensBefore);
  const retryAfterSeconds = allowed ? undefined : Math.max(1, Math.ceil(deficit / rate));
  return {
    allowed,
    limit: policy.capacity,
    remaining,
    resetAt,
    retryAfterSeconds,
    utilization: 1 - Math.min(policy.capacity, Math.max(0, tokensBefore)) / policy.capacity,
  };
}

export class TokenBucketAlgorithm implements Algorithm {
  readonly name = "token-bucket" as const;

  createState(policy: RateLimitPolicy, nowMs: number): TokenBucketState {
    return { tokens: policy.capacity, lastRefillMs: nowMs };
  }

  peek(state: unknown, policy: RateLimitPolicy, cost: number, nowMs: number): ConsumeResult {
    const next = refilled(state as TokenBucketState, policy, nowMs);
    const allowed = next.tokens >= cost;
    return resultFrom(next.tokens, allowed, policy, nowMs, cost);
  }

  commit(state: unknown, policy: RateLimitPolicy, cost: number, nowMs: number): ConsumeResult {
    const bucket = state as TokenBucketState;
    const next = refilled(bucket, policy, nowMs);
    const allowed = next.tokens >= cost;
    bucket.tokens = allowed ? next.tokens - cost : next.tokens;
    bucket.lastRefillMs = next.lastRefillMs;
    return resultFrom(next.tokens, allowed, policy, nowMs, cost);
  }
}
