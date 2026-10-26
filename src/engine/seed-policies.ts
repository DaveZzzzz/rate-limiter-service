import type { RateLimitPolicy } from "../types.js";

export const DEFAULT_TENANT_ID = "org-acme-prod";

export function defaultPolicies(tenantId = DEFAULT_TENANT_ID): RateLimitPolicy[] {
  return [
    {
      id: `${tenantId}-tenant-global`,
      tenantId,
      name: "Tenant global cap",
      algorithm: "token-bucket",
      capacity: 500,
      refillRatePerSecond: 500,
      scope: "tenant",
      keyStrategy: { dimensions: [] },
    },
    {
      id: `${tenantId}-per-user`,
      tenantId,
      name: "Per-user sliding window",
      algorithm: "sliding-window",
      capacity: 50,
      windowSizeSeconds: 1,
      scope: "client",
      keyStrategy: { dimensions: ["userId"] },
    },
    {
      id: `${tenantId}-per-ip`,
      tenantId,
      name: "Per-IP (IPv6 /64) sliding window",
      algorithm: "sliding-window",
      capacity: 80,
      windowSizeSeconds: 1,
      scope: "client",
      keyStrategy: { dimensions: ["ip"], ipv6SubnetMask: 64 },
    },
    {
      id: `${tenantId}-login`,
      tenantId,
      name: "Strict login route",
      algorithm: "token-bucket",
      capacity: 5,
      refillRatePerSecond: 0.2,
      scope: "client",
      keyStrategy: { dimensions: ["ip", "route"], ipv6SubnetMask: 64 },
      match: { methods: ["POST"], routePrefix: "/auth/login" },
    },
  ];
}
