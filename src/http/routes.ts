import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RateLimiter } from "../engine/index.js";
import type { RequestContext } from "../types.js";
import { applyRateLimitHeaders } from "./headers.js";

interface CheckBody {
  tenantId: string;
  clientIp: string;
  userId?: string;
  route: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  priority?: "critical" | "standard" | "background";
  cost?: number;
}

interface ResetBody {
  tenantId: string;
  key?: string;
}

export async function registerRoutes(app: FastifyInstance, limiter: RateLimiter): Promise<void> {
  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: CheckBody }>("/v1/rate-limit/check", async (request, reply) => {
    const body = request.body;
    if (body.cost !== undefined && !(Number.isFinite(body.cost) && body.cost > 0)) {
      return reply.code(400).send({ error: "cost must be a positive finite number" });
    }
    const ctx: RequestContext = {
      tenantId: body.tenantId,
      clientIp: body.clientIp,
      userId: body.userId,
      route: body.route,
      method: body.method ?? "GET",
      headers: body.headers ?? {},
      priority: parsePriority(body.priority),
      cost: body.cost,
    };
    const result = limiter.evaluate(ctx);
    applyRateLimitHeaders((name, value) => {
      void reply.header(name, value);
    }, result);
    return reply.code(result.allowed ? 200 : 429).send(result);
  });

  app.post<{ Body: ResetBody }>("/v1/rate-limit/reset", async (request, reply) => {
    if (await rejectIfUnauthorized(request, reply)) {
      return;
    }
    const removed = limiter.reset(request.body.tenantId, request.body.key);
    return { removed };
  });

  app.get<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/metrics", async (request, reply) => {
    if (await rejectIfUnauthorized(request, reply)) {
      return;
    }
    return limiter.tenantMetrics(request.params.tenantId);
  });

  app.get("/metrics", async (request, reply) => {
    if (await rejectIfUnauthorized(request, reply)) {
      return;
    }
    return reply.type("text/plain; version=0.0.4").send(limiter.prometheus());
  });
}

function parsePriority(
  value: CheckBody["priority"] | string | undefined,
): RequestContext["priority"] {
  if (value === "critical" || value === "standard" || value === "background") {
    return value;
  }
  return undefined;
}

async function rejectIfUnauthorized(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || readAdminToken(request) !== expected) {
    await reply.code(401).send({ error: "unauthorized" });
    return true;
  }
  return false;
}

function readAdminToken(request: FastifyRequest): string | undefined {
  const header = request.headers["x-admin-token"];
  if (typeof header === "string" && header) {
    return header;
  }
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return undefined;
  }
  const [scheme, token] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() === "bearer" && token) {
    return token;
  }
  return undefined;
}
