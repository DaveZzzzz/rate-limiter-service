import type { ConsumeResult, RateLimitPolicy } from "../types.js";

export interface Algorithm {
  readonly name: RateLimitPolicy["algorithm"];
  createState(policy: RateLimitPolicy, nowMs: number): unknown;
  peek(state: unknown, policy: RateLimitPolicy, cost: number, nowMs: number): ConsumeResult;
  commit(state: unknown, policy: RateLimitPolicy, cost: number, nowMs: number): ConsumeResult;
}

export function clampRemaining(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}
