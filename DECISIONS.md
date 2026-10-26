# Design Decisions

## 1. Algorithm Selection & Trade-offs

**Algorithms implemented:** Token Bucket and Sliding Window Counter.

**Why chosen:** Token Bucket is the right default for APIs that should absorb short bursts without letting a client run unbounded. Sliding Window Counter (two integers + a window timestamp) removes the classic fixed-window spike at window edges while staying O(1) memory per key. A sliding-window *log* would be more precise but stores one timestamp per event, which fights the memory budget this service is being judged on. Leaky Bucket was skipped as a third algorithm: it is a special case of token bucket with no burst, and the priority shedder already covers “smooth the cheap traffic first.”

Both algorithms share a `peek` / `commit` interface so hierarchical evaluation can fail closed without mutating sibling buckets.

## 2. Noisy Neighbor & Multi-Tenant Fairness Strategy

**Hierarchy model:** Every request is matched against the tenant’s policies. Policies with `scope: "tenant"` (or empty key dimensions) share one bucket for the whole tenant. Client policies are keyed by the configured dimensions (`userId`, `ip`, `route`, `header`).

Evaluation order is:

1. Peek every matching **client** policy.
2. If any client policy denies, return `CLIENT_KEY_EXCEEDED` and **do not** commit the tenant bucket (or any client bucket).
3. Peek tenant utilization. If it is above the shed threshold, drop `background` (90%) or `standard` (95%) with `NOISY_NEIGHBOR_THROTTLED`. Critical traffic is not shed here.
4. Peek the tenant cap. If it denies, return `TENANT_QUOTA_EXCEEDED` without committing.
5. Commit client + tenant together.

**Fairness guarantee:** An abusive user burns only their own sub-quota. Innocent users in the same tenant keep drawing from the remaining tenant pool. Starvation of critical work under load is reduced by the priority shedder, not by weighted queues (those would need a wait-list and extra latency).

## 3. Networking & Key Extraction Realities

**IPv6 handling:** Individual IPv6 addresses are cheap for an attacker (SLAAC / privacy extensions). The extractor parses the address into a 128-bit integer and masks to `ipv6SubnetMask` (default `/64`), so every host in that subnet shares one bucket. IPv4-mapped IPv6 (`::ffff:x.x.x.x`) is treated as IPv4.

**Proxy & NAT strategy:** `X-Forwarded-For` is untrusted by default. It is only walked when the immediate peer is in `TRUSTED_PROXIES`. The walk starts at the right (closest to this process) and skips trusted hops, returning the first untrusted address. Blindly taking `XFF[0]` would let any client spoof identity. CGNAT / a whole office behind one IPv4 still collapses to one IP key — that is why default seed policies also limit `userId`. IP-only limits cannot fairly separate 10,000 employees from one attacker on the same public address; identity (API key / user) has to be a second dimension.

## 4. In-Memory Storage & Memory Management

**Data structures used:** `Map<string, Bucket>` plus an intrusive doubly-linked LRU list. Each bucket holds algorithm state (token count or two window counters). Composite keys are strings of the form `t=tenant|p=policyId|dimension=value`.

**Pruning / Eviction:** Three guards against OOM:

- Lazy LRU promotion on access.
- Periodic sweep (default 5s) that drops entries idle longer than `ttlMs` (default 60s), walking from the LRU tail.
- Hard cap (`maxKeys`, default 100k). Inserts evict the least-recently used key first.

Byte estimate is `activeKeys * 256`, which is conservative for a key string plus a small state object and list pointers. It is an operational gauge, not RSS.

## 5. Concurrency & Node.js Event Loop

**Atomicity approach:** `evaluate()` is fully synchronous. There is no `await` between peek and commit, so the single-threaded event loop cannot interleave another request in the middle of a decrement. That is sufficient for one process; it is *not* sufficient across Node cluster workers or multiple containers.

**Time:** Production uses `MonotonicClock` (`Date.now()` origin + `performance.now()`), so NTP steps cannot rewind refill math. Tests inject `FakeClock`. Header `resetAt` values are Unix seconds derived from that clock. Retry-After is always an integer ≥ 1 second.

## 6. What I Would Do Differently With More Time

- Redis / Valkey with a Lua `peek+commit` script (or a GCRA implementation) so many Node processes share one counter plane.
- Per-tenant memory quotas and circuit breaking when estimated bytes exceed a budget.
- Weighted fair queueing with a tiny in-process wait buffer for `background` instead of immediate 429.
- Config API / etcd watch for policy hot reload, plus authn on `/v1/rate-limit/reset`.
- Native CIDR matching for trusted proxies (`10.0.0.0/8`) instead of exact IP equality.
- A proper sliding-window log path for forensic “exactly N in T” SLAs where counter approximation is too coarse.
