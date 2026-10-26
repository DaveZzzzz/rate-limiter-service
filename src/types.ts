export type RateLimitAlgorithmName =
  | "token-bucket"
  | "sliding-window"
  | "leaky-bucket";

export type KeyDimension = "ip" | "userId" | "route" | "header";

export type RequestPriority = "critical" | "standard" | "background";

export type DenyReason =
  | "TENANT_QUOTA_EXCEEDED"
  | "CLIENT_KEY_EXCEEDED"
  | "NOISY_NEIGHBOR_THROTTLED";

export interface RateLimitPolicy {
  id: string;
  tenantId: string;
  name: string;
  algorithm: RateLimitAlgorithmName;
  capacity: number;
  refillRatePerSecond?: number;
  windowSizeSeconds?: number;
  keyStrategy: {
    dimensions: KeyDimension[];
    headerName?: string;
    ipv6SubnetMask?: number;
  };
  priorityWeights?: Record<string, number>;
  /** Optional request matcher. Tenant-wide policies typically omit this. */
  match?: {
    methods?: string[];
    routePrefix?: string;
  };
  /** When true, this policy is the tenant-wide fairness cap. */
  scope?: "tenant" | "client";
}

export interface RequestContext {
  tenantId: string;
  clientIp: string;
  userId?: string;
  route: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | string;
  headers: Record<string, string | string[] | undefined>;
  priority?: RequestPriority;
  cost?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds?: number;
  reason?: DenyReason;
}

export interface TenantMetrics {
  tenantId: string;
  activeTrackedKeys: number;
  totalEvaluations: number;
  allowedCount: number;
  blockedCount: number;
  noisyNeighborsIsolated: number;
  currentMemoryEstimatedBytes: number;
}

export interface ConsumeResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds?: number;
  utilization: number;
}
