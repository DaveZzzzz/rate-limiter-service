import { isIP } from "node:net";
import { stripZoneId } from "./ip.js";

export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw.join(",");
  }
  return raw;
}

/**
 * Resolve the client IP across reverse proxies.
 * X-Forwarded-For is only consulted when the immediate peer is trusted.
 * From the right (closest to us), skip trusted hops and take the first
 * untrusted address — the socket that connected to the edge proxy.
 */
export function resolveClientIp(options: {
  remoteAddress?: string;
  headers: Record<string, string | string[] | undefined>;
  trustedProxies: ReadonlySet<string>;
}): string {
  const remote = options.remoteAddress ? stripZoneId(options.remoteAddress) : undefined;
  if (!remote || !isTrusted(remote, options.trustedProxies)) {
    return remote && isIP(remote) ? remote : "unknown";
  }

  const forwarded = headerValue(options.headers, "x-forwarded-for");
  if (!forwarded) {
    return remote;
  }

  const hops = forwarded
    .split(",")
    .map((hop) => stripZoneId(hop.trim()))
    .filter(Boolean);

  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i];
    if (!hop || !isIP(hop)) {
      continue;
    }
    if (!isTrusted(hop, options.trustedProxies)) {
      return hop;
    }
  }

  return hops[0] && isIP(hops[0]) ? hops[0] : remote;
}

function isTrusted(ip: string, trusted: ReadonlySet<string>): boolean {
  if (trusted.has("*")) {
    return true;
  }
  return trusted.has(ip);
}
