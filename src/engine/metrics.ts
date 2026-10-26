import type { DenyReason, TenantMetrics } from "../types.js";

interface Counters {
  totalEvaluations: number;
  allowedCount: number;
  blockedCount: number;
  noisyNeighborsIsolated: number;
}

export class MetricsRegistry {
  private readonly tenants = new Map<string, Counters>();

  record(tenantId: string, allowed: boolean, reason?: DenyReason): void {
    const counters = this.forTenant(tenantId);
    counters.totalEvaluations += 1;
    if (allowed) {
      counters.allowedCount += 1;
    } else {
      counters.blockedCount += 1;
      if (reason === "NOISY_NEIGHBOR_THROTTLED" || reason === "CLIENT_KEY_EXCEEDED") {
        counters.noisyNeighborsIsolated += 1;
      }
    }
  }

  snapshot(
    tenantId: string,
    activeTrackedKeys: number,
    currentMemoryEstimatedBytes: number,
  ): TenantMetrics {
    const counters = this.forTenant(tenantId);
    return {
      tenantId,
      activeTrackedKeys,
      totalEvaluations: counters.totalEvaluations,
      allowedCount: counters.allowedCount,
      blockedCount: counters.blockedCount,
      noisyNeighborsIsolated: counters.noisyNeighborsIsolated,
      currentMemoryEstimatedBytes,
    };
  }

  allSnapshots(
    activeKeys: (tenantId: string) => number,
    memory: (tenantId: string) => number,
  ): TenantMetrics[] {
    return [...this.tenants.keys()].map((tenantId) =>
      this.snapshot(tenantId, activeKeys(tenantId), memory(tenantId)),
    );
  }

  private forTenant(tenantId: string): Counters {
    let counters = this.tenants.get(tenantId);
    if (!counters) {
      counters = {
        totalEvaluations: 0,
        allowedCount: 0,
        blockedCount: 0,
        noisyNeighborsIsolated: 0,
      };
      this.tenants.set(tenantId, counters);
    }
    return counters;
  }
}

export function renderPrometheus(snapshots: TenantMetrics[]): string {
  const lines: string[] = [
    "# HELP rate_limit_evaluations_total Total check calls",
    "# TYPE rate_limit_evaluations_total counter",
    "# HELP rate_limit_allowed_total Allowed evaluations",
    "# TYPE rate_limit_allowed_total counter",
    "# HELP rate_limit_blocked_total Blocked evaluations",
    "# TYPE rate_limit_blocked_total counter",
    "# HELP rate_limit_noisy_neighbors_isolated_total Isolated noisy-neighbor denials",
    "# TYPE rate_limit_noisy_neighbors_isolated_total counter",
    "# HELP rate_limit_active_keys Currently tracked buckets",
    "# TYPE rate_limit_active_keys gauge",
    "# HELP rate_limit_memory_estimated_bytes Estimated in-process bucket memory",
    "# TYPE rate_limit_memory_estimated_bytes gauge",
  ];

  for (const snap of snapshots) {
    const t = `tenant="${escapeLabel(snap.tenantId)}"`;
    lines.push(`rate_limit_evaluations_total{${t}} ${snap.totalEvaluations}`);
    lines.push(`rate_limit_allowed_total{${t}} ${snap.allowedCount}`);
    lines.push(`rate_limit_blocked_total{${t}} ${snap.blockedCount}`);
    lines.push(
      `rate_limit_noisy_neighbors_isolated_total{${t}} ${snap.noisyNeighborsIsolated}`,
    );
    lines.push(`rate_limit_active_keys{${t}} ${snap.activeTrackedKeys}`);
    lines.push(`rate_limit_memory_estimated_bytes{${t}} ${snap.currentMemoryEstimatedBytes}`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
