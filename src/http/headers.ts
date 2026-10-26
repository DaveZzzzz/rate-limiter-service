import type { RateLimitResult } from "../types.js";

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "x-ratelimit-limit": String(result.limit),
    "x-ratelimit-remaining": String(result.remaining),
    "x-ratelimit-reset": String(result.resetAt),
  };
  if (!result.allowed && result.retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(result.retryAfterSeconds);
  }
  return headers;
}

export function applyRateLimitHeaders(
  setHeader: (name: string, value: string) => void,
  result: RateLimitResult,
): void {
  for (const [name, value] of Object.entries(rateLimitHeaders(result))) {
    setHeader(name, value);
  }
}
