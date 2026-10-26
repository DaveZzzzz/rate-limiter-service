import Fastify, { type FastifyInstance } from "fastify";
import { RateLimiter } from "../engine/index.js";
import { defaultPolicies } from "../engine/seed-policies.js";
import { rateLimitPlugin } from "./middleware.js";
import { registerRoutes } from "./routes.js";

export interface AppOptions {
  limiter?: RateLimiter;
  failOpen?: boolean;
  trustedProxies?: string[];
  enableDemoMiddleware?: boolean;
}

export function parseTrustedProxies(raw = process.env.TRUSTED_PROXIES): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createLimiter(options: AppOptions = {}): RateLimiter {
  return (
    options.limiter ??
    new RateLimiter({
      policies: defaultPolicies(),
      failOpen: options.failOpen ?? process.env.FAIL_OPEN === "true",
    })
  );
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const limiter = createLimiter(options);
  const trustedProxies = options.trustedProxies ?? parseTrustedProxies();
  const app = Fastify({ logger: false });

  app.addHook("onClose", async () => {
    limiter.close();
  });

  await registerRoutes(app, limiter);

  if (options.enableDemoMiddleware ?? true) {
    await app.register(
      async (scoped) => {
        await scoped.register(rateLimitPlugin, {
          limiter,
          trustedProxies,
        });
        scoped.get("/demo", async () => ({ ok: true, via: "middleware" }));
      },
      { prefix: "/protected" },
    );
  }

  app.decorate("rateLimiter", limiter);
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    rateLimiter: RateLimiter;
  }
}
