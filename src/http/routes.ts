import type { FastifyInstance } from "fastify";
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
    const ctx: RequestContext = {
      tenantId: body.tenantId,
      clientIp: body.clientIp,
      userId: body.userId,
      route: body.route,
      method: body.method ?? "GET",
      headers: body.headers ?? {},
      priority: body.priority,
      cost: body.cost,
    };
    const result = limiter.evaluate(ctx);
    applyRateLimitHeaders((name, value) => {
      void reply.header(name, value);
    }, result);
    return reply.code(result.allowed ? 200 : 429).send(result);
  });

  app.post<{ Body: ResetBody }>("/v1/rate-limit/reset", async (request) => {
    const removed = limiter.reset(request.body.tenantId, request.body.key);
    return { removed };
  });

  app.get<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/metrics", async (request) => {
    return limiter.tenantMetrics(request.params.tenantId);
  });

  app.get("/metrics", async (_request, reply) => {
    return reply.type("text/plain; version=0.0.4").send(limiter.prometheus());
  });
}
