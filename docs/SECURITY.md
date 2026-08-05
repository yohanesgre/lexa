# Security Hardening — Lexa

> Oracle review: 3 critical, 5 important, 9 nice-to-have. Prioritized by attacker impact.
> Updated: Workers removed — Bun standalone deployment. All code-level items closed 2026-08-06 (v0.1.0 hardening + Access JWT verification — see RELEASE.md).

## 🔴 Critical

### 1. REST API has zero auth enforcement

**Status: ✅ FIXED** (auth middleware in `server/api/middleware.ts` — `resolveApiKeyIdentity` on the shared Sqlite connection, before route matching)

All `/api/*` routes (except `/api/health`) require `Authorization: Bearer lxk_*` header. SHA-256 hashed against `api_keys` table. The server injects its current key into served HTML (`<meta name="lxk-api-key">`); the client prefers it over any build-time `VITE_LXK_API_KEY`, so key rotation never breaks the browser.

### 2. CF Access header trusted without JWT verification

**Status: ✅ FIXED** (2026-08-06 audit hardening — opt-in via `LXK_ACCESS_AUD`)

`server/api/access-auth.ts` verifies the `Cf-Access-Jwt-Assertion` against the team JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, audience must match `LXK_ACCESS_AUD`); the JWKS fetch is SSRF-hardened. When `LXK_ACCESS_AUD` is unset, headers are still trusted for tunnel-authenticated identity, with a boot warning (`server/entry.ts:50`). Tunnel-bypass spoofing is now closed for deployments that set the env var.

### 3. Default credential — resolved

**Status: ✅ FIXED** (`seedAdminKey` in `server/entry.ts`)

No hardcoded fallback secret. `seedAdminKey` seeds the `api_keys` table from `LXK_API_KEY` when set, otherwise mints a random high-entropy key (logged once at boot).

## 🟡 Important

### 4. DB error internals leaked to clients

**Status: ✅ FIXED**

`respond()` in `server/api/http.ts:391-400` uses `catchAllCause` — defects get generic 500, typed errors mapped via error catalog. `errorResponse` returns codes only, never raw messages.

### 5. No rate limiting

**Status: ✅ FIXED** (2026-08-06 — in-process limiter, no CF dependency; see [`docs/RATE_LIMITING.md`](RATE_LIMITING.md))

Fixed-window per-IP limiter (600 req / 10 min, constants in `server/api/rate-limit.ts`), enforced **before auth** — `/api/*` in the API middleware, `/mcp` at the entry edge, one shared bucket. Covers `/api/*` + `/mcp`; `/api/webhooks/github`, `/api/setup*`, `/api/health` exempt (HMAC-authenticated / cheap unauthenticated GETs). IP resolved in entry (socket + `isPrivateIp`-gated `CF-Connecting-IP`), stamped spoof-safe on the reconstructed request. Denied → 429 `RATE_LIMITED` with `Retry-After`.

### 6. Unbounded request bodies

**Status: ✅ FIXED** (was already marked fixed in original review)

### 7. FTS5 MATCH crashes leak errors

**Status: ✅ FIXED** (v0.1.0 — `WikiService.search` maps `DbError` → 422 `SEARCH_ERROR` with a generic message; `server/services/wiki.service.ts`)

### 8. API key management — resolved

**Status: ✅ FIXED** (all `/api/*` routes guarded by `verifyApiKey`; **v0.1.0 hardening:** admin-only enforcement added on `/api/settings/api-keys`, `/api/admin/*`, project/column/swimlane/field-config mutations, and Forge agents/skills CRUD — caller identity resolved from the key (keys without a user = admin), non-admins get 403 `FORBIDDEN`. Matches the MCP surface (`server/mcp/auth.ts`).)

### 9. Webhooks not yet implemented

**Status: ✅ FIXED (Phase 6, 2026-08-04)**

`POST /api/webhooks/github` (server/api/http.ts `createWebhookHandler`):
- HMAC-SHA-256 over the RAW body (`server/github/crypto.ts`), constant-time hex compare — verified **before** any JSON parsing; failure → 401, no processing
- `X-GitHub-Delivery` dedup via `webhook_events` (INSERT only after successful processing — a mid-processing crash leaves the delivery unrecorded so GitHub's retry reprocesses)
- Acks 200 immediately, processing runs fire-and-forget in the background (Bun has no `waitUntil`)
- Body size: GitHub caps webhook payloads; no explicit cap implemented (acceptable for the trusted App channel — HMAC gates every request)

### 10. Setup wizard endpoints unauthenticated after first run

**Status: ✅ FIXED** (v0.1.0 — `POST /api/setup/admin`, `/api/setup/api-key`, `/api/setup/seed` lock with 403 `SETUP_LOCKED` once setup is complete (flag set by the new `/api/setup/complete` or when projects exist); see `server/api/http.ts`.)

## 🟢 Nice-to-have

### 10. MCP skips `jsonrpc: "2.0"` validation
**Status: ✅ FIXED** — `server/mcp/server.ts` rejects non-`"2.0"` requests.

### 11. Key format pre-check too loose
**Status: ✅ FIXED** — `server/mcp/server.ts` and `server/api/auth-key.ts` enforce `/^lxk_[0-9A-Za-z]{43}$/` before hashing.

### 12–15. Legacy `scripts/mcp/` local MCP server (CORS `*`, loose `/mcp` prefix, key log)
**Status: ✅ N/A** — deleted in v0.1.0; the MCP surface is `server/mcp/` (exact `/mcp` match on the main server, constant-time key compare, no CORS headers, no key logging).

### 16. `/health` discloses WORKER_URL
**Status: ⬜ STALE** (no longer applicable — `WORKER_URL` field removed or harmless in Bun standalone)

### 17. No security headers on REST responses
**Status: ✅ FIXED** (v0.1.0 — `X-Content-Type-Options: nosniff` + `Cache-Control: no-store` on all `/api/*` and `/mcp` responses; extended 2026-08 to the key-bearing SSR HTML page and the root fallback page — the admin key meta tag must never be cached)

### 18. `parseInt` unchecked NaN on revisions limit
**Status: ✅ FIXED** (v0.1.0 — wiki `listRevisions` uses `clampLimit` like the tasks path)

## Passed Review

| Area | Finding |
|------|---------|
| SQL injection | All interpolated fragments are hardcoded column literals, values always bound |
| Cursor decode | Bound after decode, safe |
| API key hash timing | SHA-256 of 256-bit key makes timing oracle useless |
| MCP auth ordering | Auth validated before parse — correct |
