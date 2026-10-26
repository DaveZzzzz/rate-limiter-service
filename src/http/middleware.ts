import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RateLimiter } from "../engine/index.js";
import { resolveClientIp } from "../extractors/index.js";
import type { RequestContext, RequestPriority } from "../types.js";
import { applyRateLimitHeaders } from "./headers.js";

export interface RateLimitPluginOptions {
  limiter: RateLimiter;
  tenantHeader?: string;
  trustedProxies?: string[];
  skip?: (request: FastifyRequest) => boolean;
}

export async function rateLimitPlugin(
  fastify: FastifyInstance,
  options: RateLimitPluginOptions,
): Promise<void> {
  const tenantHeader = options.tenantHeader ?? "x-tenant-id";
  const trusted = new Set(options.trustedProxies ?? []);

  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.skip?.(request)) {
      return;
    }

    const ctx = contextFromRequest(request, tenantHeader, trusted);
    const result = options.limiter.evaluate(ctx);
    applyRateLimitHeaders((name, value) => {
      void reply.header(name, value);
    }, result);

    if (!result.allowed) {
      return reply.code(429).send(result);
    }
  });
}

export function contextFromRequest(
  request: FastifyRequest,
  tenantHeader: string,
  trustedProxies: ReadonlySet<string>,
): RequestContext {
  const headers = request.headers as Record<string, string | string[] | undefined>;
  const tenantId =
    header(headers, tenantHeader) ??
    header(headers, "x-tenant-id") ??
    "org-acme-prod";
  const userId =
    bearerUser(header(headers, "authorization")) ?? header(headers, "x-user-id");
  const priority = parsePriority(header(headers, "x-priority"));

  return {
    tenantId,
    clientIp: resolveClientIp({
      remoteAddress: request.ip,
      headers,
      trustedProxies,
    }),
    userId,
    route: request.url.split("?")[0] ?? "/",
    method: request.method,
    headers,
    priority,
  };
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

function bearerUser(authorization?: string): string | undefined {
  if (!authorization) {
    return undefined;
  }
  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() === "bearer" && token) {
    return token;
  }
  return undefined;
}

function parsePriority(value?: string): RequestPriority | undefined {
  if (value === "critical" || value === "standard" || value === "background") {
    return value;
  }
  return undefined;
}
