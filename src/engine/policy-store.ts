import type { RateLimitPolicy } from "../types.js";

export class PolicyStore {
  private readonly byTenant = new Map<string, RateLimitPolicy[]>();

  constructor(policies: RateLimitPolicy[] = []) {
    for (const policy of policies) {
      this.upsert(policy);
    }
  }

  upsert(policy: RateLimitPolicy): void {
    if (!Number.isFinite(policy.capacity) || policy.capacity <= 0) {
      throw new Error(`Policy ${policy.id} must have a positive capacity`);
    }
    const existing = this.byTenant.get(policy.tenantId) ?? [];
    const next = existing.filter((p) => p.id !== policy.id);
    next.push(policy);
    this.byTenant.set(policy.tenantId, next);
  }

  forTenant(tenantId: string): RateLimitPolicy[] {
    return this.byTenant.get(tenantId) ?? [];
  }
}
