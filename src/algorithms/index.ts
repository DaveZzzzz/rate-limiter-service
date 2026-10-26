import type { RateLimitPolicy } from "../types.js";
import { SlidingWindowCounterAlgorithm } from "./sliding-window-counter.js";
import { TokenBucketAlgorithm } from "./token-bucket.js";
import type { Algorithm } from "./types.js";

const tokenBucket = new TokenBucketAlgorithm();
const slidingWindow = new SlidingWindowCounterAlgorithm();

export function getAlgorithm(policy: RateLimitPolicy): Algorithm {
  switch (policy.algorithm) {
    case "token-bucket":
      return tokenBucket;
    case "sliding-window":
      return slidingWindow;
    default:
      throw new Error(`Unsupported algorithm: ${policy.algorithm}`);
  }
}

export { TokenBucketAlgorithm } from "./token-bucket.js";
export { SlidingWindowCounterAlgorithm } from "./sliding-window-counter.js";
export type { Algorithm } from "./types.js";
export { FakeClock, MonotonicClock } from "./clock.js";
export type { Clock } from "./clock.js";
