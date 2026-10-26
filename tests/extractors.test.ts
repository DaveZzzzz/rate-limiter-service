import { describe, expect, it } from "vitest";
import { canonicalizeClientIp, maskIpv6 } from "../src/extractors/ip.js";
import { resolveClientIp } from "../src/extractors/proxy.js";
import { buildCompositeKey } from "../src/extractors/composite-key.js";
import type { RateLimitPolicy, RequestContext } from "../src/types.js";

describe("IPv6 masking", () => {
  it("groups addresses in the same /64", () => {
    const a = canonicalizeClientIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334", 64);
    const b = canonicalizeClientIp("2001:db8:85a3:0:ffff:ffff:ffff:ffff", 64);
    const c = canonicalizeClientIp("2001:db8:85a3:1::1", 64);
    expect(a).toBe(b);
    expect(a).toBe("2001:db8:85a3::");
    expect(c).not.toBe(a);
  });

  it("leaves IPv4 unchanged", () => {
    expect(canonicalizeClientIp("203.0.113.10", 64)).toBe("203.0.113.10");
  });

  it("maps IPv4-mapped IPv6 to IPv4", () => {
    expect(canonicalizeClientIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
  });

  it("masks arbitrary prefix lengths", () => {
    expect(maskIpv6("2001:db8:85a3::8a2e:370:7334", 48)).toBe("2001:db8:85a3::");
  });
});

describe("X-Forwarded-For", () => {
  it("ignores spoofed XFF from untrusted sockets", () => {
    const ip = resolveClientIp({
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": "1.2.3.4" },
      trustedProxies: new Set(["10.0.0.1"]),
    });
    expect(ip).toBe("203.0.113.9");
  });

  it("takes the rightmost untrusted hop behind a trusted proxy", () => {
    const ip = resolveClientIp({
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.20, 10.0.0.2" },
      trustedProxies: new Set(["10.0.0.1", "10.0.0.2"]),
    });
    expect(ip).toBe("198.51.100.20");
  });
});

describe("composite keys", () => {
  it("differentiates user vs ip dimensions", () => {
    const ctx: RequestContext = {
      tenantId: "org",
      clientIp: "203.0.113.5",
      userId: "usr_1",
      route: "/api",
      method: "GET",
      headers: {},
    };
    const userPolicy: RateLimitPolicy = {
      id: "user",
      tenantId: "org",
      name: "user",
      algorithm: "token-bucket",
      capacity: 1,
      refillRatePerSecond: 1,
      keyStrategy: { dimensions: ["userId"] },
    };
    const ipPolicy: RateLimitPolicy = {
      ...userPolicy,
      id: "ip",
      keyStrategy: { dimensions: ["ip"] },
    };
    expect(buildCompositeKey(userPolicy, ctx)).toContain("userId=usr_1");
    expect(buildCompositeKey(ipPolicy, ctx)).toContain("ip=203.0.113.5");
    expect(buildCompositeKey(userPolicy, ctx)).not.toBe(buildCompositeKey(ipPolicy, ctx));
  });
});
