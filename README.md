# Multi-Tenant Rate Limiting Service

In-memory rate limiter for Node.js 20+ / TypeScript 5. It evaluates request metadata against hierarchical tenant and client policies, isolates noisy neighbors, and returns RFC-style `X-RateLimit-*` / `Retry-After` headers.

## Features

- **Token Bucket** — burst up to `capacity`, refill at `refillRatePerSecond`
- **Sliding Window Counter** — O(1) memory per key, no fixed-window boundary spike
- **Generic keys** — `tenantId` plus `ip` / `userId` / `route` / `header`
- **IPv6 /64 grouping** — SLAAC cycling cannot bypass an IP limit
- **Trusted-proxy X-Forwarded-For** — spoofed headers from untrusted sockets are ignored
- **Noisy-neighbor isolation** — client caps are checked (and consumed) before the tenant pool
- **Priority shedder** — background traffic is dropped when a tenant is ≥90% utilized
- **Fail-open / fail-closed** — `FAIL_OPEN=true|false`
- **Prometheus** — `GET /metrics`
- **Fastify middleware** — plug-and-play wrapper under `/protected`

## Setup

```bash
npm install
npm test
npm run dev
```

Production build:

```bash
npm run build
npm start
```

Benchmark (in-process evaluations, target >20k/sec):

```bash
npm run bench
```

## Docker

```bash
docker compose up --build
```

The API listens on `http://localhost:3000`.

## HTTP API

### Check / consume quota

`POST /v1/rate-limit/check`

```bash
curl -i -X POST http://localhost:3000/v1/rate-limit/check \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantId": "org-acme-prod",
    "clientIp": "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    "userId": "usr_99812",
    "route": "/api/v1/payments",
    "method": "POST",
    "priority": "critical"
  }'
```

Allowed responses are `200` with `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. Throttled responses are `429` plus `Retry-After`.

### Reset quotas

```bash
curl -X POST http://localhost:3000/v1/rate-limit/reset \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"org-acme-prod"}'
```

Optional `key` substring clears a subset of buckets for that tenant.

### Metrics

```bash
curl http://localhost:3000/v1/tenants/org-acme-prod/metrics
curl http://localhost:3000/metrics
```

### Middleware demo

```bash
curl -i http://localhost:3000/protected/demo \
  -H 'x-tenant-id: org-acme-prod' \
  -H 'x-user-id: usr_99812'
```

## Default seed policies (`org-acme-prod`)

| Policy | Algorithm | Cap | Key |
| --- | --- | --- | --- |
| Tenant global | Token bucket | 500 rps | tenant |
| Per user | Sliding window | 50 / 1s | userId |
| Per IP | Sliding window | 80 / 1s | IPv6 /64 or IPv4 |
| Login route | Token bucket | 5, refill 0.2/s | IP + `POST /auth/login` |

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `FAIL_OPEN` | `false` | Allow on engine errors / unknown tenants |
| `TRUSTED_PROXIES` | empty | Comma-separated proxy IPs allowed to set `X-Forwarded-For` |

Design notes live in [DECISIONS.md](./DECISIONS.md). AI usage is recorded in [AI_USAGE.md](./AI_USAGE.md).
