# AI Tool Usage

## Tools Used

- Cursor (Grok 4.6) for scaffolding, implementation, tests, and docs.

## What Helped Most

- Turning the interview PDF into a modular layout (`algorithms/`, `extractors/`, `engine/`, `http/`) and a peek/commit algorithm interface so hierarchical evaluation did not consume tenant tokens on a client deny.
- Drafting IPv6 expand/mask helpers and the six required test scenarios so the first implementation pass already targeted the rubric.

## What I Had to Fix

- Clock math: an over-clever `SystemClock` mixing `Date.now()` and `performance.now()` was simplified to an origin + monotonic offset. Token-bucket `resetAt` also needed integer seconds, not fractional millisecond leftovers.
- IPv6 grouping must use bitwise masking of the 128-bit value, not string prefix truncation. Compressing the masked address (`2001:db8:85a3::`) is required so two writings of the same /64 hash to one Map key.
- Eviction cannot rely on `setInterval` alone under a fake clock; tests drive a hard LRU cap and call `evaluate` synchronously so churn stays bounded without waiting on timers.

## What AI Struggled With

- Noisy-neighbor semantics (“do not debit the tenant pool when the inner key fails”) are easy to get backwards if the engine consumes as it walks policies. The peek-then-commit pass is the part that needed a human design pass.
- Proxy header trust is often generated as “take the first XFF hop.” That is the spoofable choice; the correct walk is right-to-left through trusted proxies.
- Memory claims for a sliding-window *log* look fine in a README and explode under IP churn — hence the counter, not the log.
