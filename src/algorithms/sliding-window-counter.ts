import type { ConsumeResult, RateLimitPolicy } from "../types.js";
import { unixSeconds } from "./clock.js";
import type { Algorithm } from "./types.js";
import { clampRemaining } from "./types.js";

export interface SlidingWindowState {
  windowStartMs: number;
  currentCount: number;
  previousCount: number;
}

function windowMs(policy: RateLimitPolicy): number {
  const seconds = policy.windowSizeSeconds ?? 1;
  if (!(seconds > 0)) {
    throw new Error(`sliding-window policy ${policy.id} needs a positive windowSizeSeconds`);
  }
  return seconds * 1000;
}

function rolled(state: SlidingWindowState, windowSizeMs: number, nowMs: number): SlidingWindowState {
  let windowStartMs = state.windowStartMs;
  let currentCount = state.currentCount;
  let previousCount = state.previousCount;

  if (nowMs < windowStartMs) {
    return { windowStartMs, currentCount, previousCount };
  }

  const elapsedWindows = Math.floor((nowMs - windowStartMs) / windowSizeMs);
  if (elapsedWindows >= 2) {
    return { windowStartMs: windowStartMs + elapsedWindows * windowSizeMs, currentCount: 0, previousCount: 0 };
  }
  if (elapsedWindows === 1) {
    previousCount = currentCount;
    currentCount = 0;
    windowStartMs += windowSizeMs;
  }
  return { windowStartMs, currentCount, previousCount };
}

function estimate(state: SlidingWindowState, windowSizeMs: number, nowMs: number): number {
  const elapsed = Math.min(windowSizeMs, Math.max(0, nowMs - state.windowStartMs));
  const previousWeight = (windowSizeMs - elapsed) / windowSizeMs;
  return state.currentCount + state.previousCount * previousWeight;
}

function toResult(
  estimatedBefore: number,
  estimatedAfter: number,
  allowed: boolean,
  policy: RateLimitPolicy,
  windowSizeMs: number,
  windowStartMs: number,
  nowMs: number,
): ConsumeResult {
  const remaining = clampRemaining(policy.capacity - estimatedAfter);
  const windowEndMs = windowStartMs + windowSizeMs;
  const resetAt = unixSeconds(windowEndMs);
  const retryAfterSeconds = allowed
    ? undefined
    : Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000));
  return {
    allowed,
    limit: policy.capacity,
    remaining,
    resetAt,
    retryAfterSeconds,
    utilization: Math.min(1, Math.max(0, estimatedBefore) / policy.capacity),
  };
}

export class SlidingWindowCounterAlgorithm implements Algorithm {
  readonly name = "sliding-window" as const;

  createState(_policy: RateLimitPolicy, nowMs: number): SlidingWindowState {
    return { windowStartMs: nowMs, currentCount: 0, previousCount: 0 };
  }

  peek(state: unknown, policy: RateLimitPolicy, cost: number, nowMs: number): ConsumeResult {
    const size = windowMs(policy);
    const next = rolled(state as SlidingWindowState, size, nowMs);
    const estimated = estimate(next, size, nowMs);
    const allowed = estimated + cost <= policy.capacity;
    const estimatedAfter = allowed ? estimated + cost : estimated;
    return toResult(estimated, estimatedAfter, allowed, policy, size, next.windowStartMs, nowMs);
  }

  commit(state: unknown, policy: RateLimitPolicy, cost: number, nowMs: number): ConsumeResult {
    const bucket = state as SlidingWindowState;
    const size = windowMs(policy);
    const next = rolled(bucket, size, nowMs);
    const estimated = estimate(next, size, nowMs);
    const allowed = estimated + cost <= policy.capacity;
    bucket.windowStartMs = next.windowStartMs;
    bucket.previousCount = next.previousCount;
    bucket.currentCount = next.currentCount + (allowed ? cost : 0);
    const estimatedAfter = allowed ? estimated + cost : estimated;
    return toResult(estimated, estimatedAfter, allowed, policy, size, bucket.windowStartMs, nowMs);
  }
}
