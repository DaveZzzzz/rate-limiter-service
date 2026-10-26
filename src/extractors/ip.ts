import { isIP } from "node:net";

/**
 * Canonicalize a client IP for rate-limit keys.
 * IPv6 addresses are masked to `prefixLength` (default /64) so SLAAC
 * address cycling cannot evade a per-address limit.
 */
export function canonicalizeClientIp(ip: string, ipv6PrefixLength = 64): string {
  const trimmed = stripZoneId(ip.trim());
  if (!trimmed) {
    return "unknown";
  }

  const mapped = extractIpv4Mapped(trimmed);
  if (mapped) {
    return mapped;
  }

  const version = isIP(trimmed);
  if (version === 4) {
    return trimmed;
  }
  if (version === 6) {
    return maskIpv6(trimmed, ipv6PrefixLength);
  }
  return trimmed.toLowerCase();
}

export function stripZoneId(ip: string): string {
  const zone = ip.indexOf("%");
  return zone === -1 ? ip : ip.slice(0, zone);
}

function extractIpv4Mapped(ip: string): string | undefined {
  const lowered = ip.toLowerCase();
  const prefix = "::ffff:";
  if (lowered.startsWith(prefix)) {
    const rest = ip.slice(prefix.length);
    if (isIP(rest) === 4) {
      return rest;
    }
  }
  return undefined;
}

export function ipv6ToBigInt(ip: string): bigint {
  const groups = expandIpv6Groups(ip);
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return value;
}

export function maskIpv6(ip: string, prefixLength: number): string {
  const prefix = Math.min(128, Math.max(0, prefixLength));
  const value = ipv6ToBigInt(ip);
  const shift = BigInt(128 - prefix);
  const masked = prefix === 0 ? 0n : (value >> shift) << shift;
  return bigIntToIpv6(masked);
}

function expandIpv6Groups(ip: string): string[] {
  const halves = ip.split("::");
  if (halves.length > 2) {
    throw new Error(`Invalid IPv6 address: ${ip}`);
  }

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - (head.length + tail.length);
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    throw new Error(`Invalid IPv6 address: ${ip}`);
  }
  const zeros = halves.length === 2 ? Array.from({ length: missing }, () => "0") : [];
  return [...head, ...zeros, ...tail].map((g) => g || "0");
}

function bigIntToIpv6(value: bigint): string {
  const groups: string[] = [];
  let remaining = value;
  for (let i = 0; i < 8; i += 1) {
    const group = remaining & 0xffffn;
    groups.unshift(group.toString(16));
    remaining >>= 16n;
  }
  return compressIpv6(groups);
}

function compressIpv6(groups: string[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let start = -1;
  for (let i = 0; i <= groups.length; i += 1) {
    if (i < groups.length && groups[i] === "0") {
      if (start === -1) start = i;
    } else if (start !== -1) {
      const len = i - start;
      if (len > bestLen) {
        bestStart = start;
        bestLen = len;
      }
      start = -1;
    }
  }
  if (bestLen < 2) {
    return groups.join(":");
  }
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}
