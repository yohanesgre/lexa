# Rate Limiting — Lexa

Defense-in-depth for `/api/*` and `/mcp`. All code-level security items are closed
(docs/SECURITY.md); rate limiting is now closed too — an in-process limiter in the
Bun server, no Cloudflare WAF dependency (the WAF rule path is paid on some plans).

## Threat model

- **Leaked API key** — a machine key (`lxk_*`) pasted into a log or a repo. Bearer
  auth still works; rate limiting bounds how fast the key can be abused before you
  rotate it.
- **Buggy agent loop** — a Forge run or MCP client stuck retrying an endpoint can
  fan out hundreds of requests per minute (`resolveTaskProject` already fans out
  HTTP calls per project on some paths — amplification is built in).
- Browser users are NOT the target: 2–5 people behind Cloudflare Access. The limit
  is generous enough to never trip on real use, aggressive enough to stop a loop.

## How it works

- Fixed window, per client IP: **600 requests per 10 minutes** (defaults —
  `max` / `windowMs` constants in `server/api/rate-limit.ts`).
- Enforced **before auth** — `/api/*` in the API middleware (rate limit →
  body pre-check → auth, so a blocked IP stays blocked regardless of key),
  `/mcp` at the entry edge. One shared bucket (`apiRateLimiter`) across both
  surfaces. Also throttles unauthenticated key-guessing floods.
- Client IP: entry resolves it — `server.requestIP()` socket address,
  `CF-Connecting-IP` trusted only when the socket peer is private (tunnel
  sidecar) — and stamps it as `x-lexa-remote-ip` on the reconstructed request
  (any inbound value deleted first, spoof-guard). The middleware applies the
  same `isPrivateIp`-gated trust to `cf-connecting-ip`.
- `/api/setup*` and `/api/health` are exempt (first-run wizard, health probes —
  cheap unauthenticated GETs must not 429).
- Denied requests get **429** `{ "error": { "code": "RATE_LIMITED", "message": "Rate limit exceeded" } }`
  with a `Retry-After` header (seconds until the window resets). Same raw
  early-gate pattern as the 413 `BODY_TOO_LARGE` response.

## Coverage

| Surface | Auth | Limited |
|---|---|---|
| `/api/*` (REST, humans + machines) | Bearer `lxk_*` (or Access) | Yes (middleware) |
| `/mcp` (AI agents) | Bearer `lxk_*` | Yes (entry; shared bucket) |
| `/api/webhooks/github` (GitHub → Lexa) | HMAC-SHA-256 | **No — exempt** |
| `/api/setup/*` (first-run wizard) | None (setup-locked after first run) | No — exempt |
| `/api/health` | None | No — exempt |

### Webhook exemption (do not remove)

GitHub delivers webhooks in bursts — a sync burst can arrive within seconds.
Throttling them risks dropping legitimate deliveries (delivery is recorded only
after successful processing, so a throttled delivery would just be retried by
GitHub later — but it adds delay and noise). The channel is HMAC-authenticated,
not attackable by third parties, so the exemption costs nothing.

## Tuning

Edit the constants in `server/api/rate-limit.ts`:

| Constant | Default | Notes |
|---|---|---|
| `max` | 600 | Requests per window |
| `windowMs` | 600_000 | 10 minutes |
| `sweepThreshold` | 10_000 | Buckets before expired entries are swept (memory bound) |

Per-IP caveat: behind NAT, everyone on one office IP shares a bucket; agent
provider egress pools may share IPs too. If real use trips the limit, raise `max`
rather than tightening.

## Verify

Burst against a running server (dev: `bun run dev:server` or `bun run dev:full` —
all local requests share one IP, so the burst hits the limit):

```bash
for i in $(seq 1 700); do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/projects
done | sort | uniq -c
```

Expect `200` for the first ~600 and `429` for the rest, then a `Retry-After`
header on the 429s. Requests pass again after the window resets. (Unauthenticated
bursts work too — rate limiting runs before auth, so 401s consume the bucket;
`/api/health` is exempt and will NOT 429.)

Smoke-check the exemption: trigger a GitHub webhook delivery (move a task between
columns with issue sync on) and confirm the card still moves.
