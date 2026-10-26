import type { KeyDimension, RateLimitPolicy, RequestContext } from "../types.js";
import { canonicalizeClientIp } from "./ip.js";
import { headerValue } from "./proxy.js";

export function matchesPolicy(policy: RateLimitPolicy, ctx: RequestContext): boolean {
  const match = policy.match;
  if (!match) {
    return true;
  }
  if (match.methods && match.methods.length > 0) {
    const allowed = match.methods.map((m) => m.toUpperCase());
    if (!allowed.includes(ctx.method.toUpperCase())) {
      return false;
    }
  }
  if (match.routePrefix && !ctx.route.startsWith(match.routePrefix)) {
    return false;
  }
  return true;
}

export function isTenantPolicy(policy: RateLimitPolicy): boolean {
  if (policy.scope === "tenant") {
    return true;
  }
  if (policy.scope === "client") {
    return false;
  }
  return policy.keyStrategy.dimensions.length === 0;
}

export function buildCompositeKey(policy: RateLimitPolicy, ctx: RequestContext): string {
  const parts = [`t=${ctx.tenantId}`, `p=${policy.id}`];
  const dimensions = isTenantPolicy(policy)
    ? ([] as KeyDimension[])
    : policy.keyStrategy.dimensions;

  for (const dimension of dimensions) {
    parts.push(`${dimension}=${dimensionValue(dimension, policy, ctx)}`);
  }
  return parts.join("|");
}

function dimensionValue(
  dimension: KeyDimension,
  policy: RateLimitPolicy,
  ctx: RequestContext,
): string {
  switch (dimension) {
    case "ip":
      return canonicalizeClientIp(ctx.clientIp, policy.keyStrategy.ipv6SubnetMask ?? 64);
    case "userId":
      return ctx.userId ?? "anonymous";
    case "route":
      return `${ctx.method.toUpperCase()}:${ctx.route}`;
    case "header": {
      const name = policy.keyStrategy.headerName;
      if (!name) {
        return "missing-header-name";
      }
      return headerValue(ctx.headers, name) ?? "missing";
    }
    default: {
      const _exhaustive: never = dimension;
      return _exhaustive;
    }
  }
}
