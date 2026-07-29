# Security Hardening — Lexa

> Oracle review: 3 critical, 5 important, 9 nice-to-have. Prioritized by attacker impact.
> Updated: Workers removed — Bun standalone deployment.

## 🔴 Critical

### 1. REST API has zero auth enforcement

**Status: ✅ FIXED** (`verifyApiKey` in `server/api/auth-key.ts`, called from `server/entry.ts:35-38`)

All `/api/*` routes (except `/api/health`) require `Authorization: Bearer lxk_*` header. SHA-256 hashed against `api_keys` table. Frontend sends key via `VITE_LXK_API_KEY` at build time.

### 2. CF Access header trusted without JWT verification

**Status: 🔴 ACCEPTABLE RISK**

**Impact:** Tunnel guarantees header authenticity in production. If tunnel bypassed (direct container access, misconfigured ingress), attacker sets `Cf-Access-Authenticated-User-Email` header and spoofs any user.

**Where:** `server/api/auth.ts:6` — reads header without verifying Access JWT.

**Fix (defense-in-depth, low priority):**
1. Verify Access JWT against team certs (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`)
2. Reject requests with CF headers but no tunnel origin IP

### 3. Default credential — resolved

**Status: ✅ FIXED** (`scripts/mcp/mcp-server.ts:30-34`)

Server exits with `process.exit(1)` if `LXK_API_KEY` env var is missing. Never ships fallback secrets.

## 🟡 Important

### 4. DB error internals leaked to clients

**Status: ✅ FIXED**

`respond()` in `server/api/http.ts:391-400` uses `catchAllCause` — defects get generic 500, typed errors mapped via error catalog. `errorResponse` returns codes only, never raw messages.

### 5. No rate limiting

**Status: ⬜ CONFIGURATION REQUIRED (CF Dashboard)**

**Impact:** Buggy agent or leaked key burns D1-equivalent reads/writes. `resolveTaskProject` fans out HTTP calls per project — amplification built in.

**Where:** All `/api/*` endpoints (Bun server).

**Fix:**
- CF Rate Limiting rule on `/api/*` (Zero Trust Dashboard, zero code)
- Document limits in `API.md`

### 6. Unbounded request bodies

**Status: ✅ FIXED** (was already marked fixed in original review)

### 7. FTS5 MATCH crashes leak errors

**Status: 🔴 NOT FIXED**

**Impact:** FTS operator syntax (`"`, `NEAR/`, unbalanced parens) in search query crashes SQLite → error to client.

**Where:** `server/repos/wiki.repo.ts:81` — user query bound raw into `MATCH ?`

**Fix:**
- Catch `DbError` in wiki search service
- Map to `422 SEARCH_ERROR` with generic message
- Optionally sanitize query (strip `"` and special operators) before MATCH

### 8. API key management — resolved

**Status: ✅ FIXED** (all `/api/*` routes guarded by `verifyApiKey`)

API key management endpoints (`/api/settings/api-keys`) are behind the same auth check as all other endpoints.

### 9. Webhooks not yet implemented

**Status: 🔲 PENDING (Phase 6)**

**Impact:** When built — signature timing oracle, replay attacks, unbounded body.

**Fix (when building):**
- Constant-time HMAC compare via `crypto.subtle.verify`, never `sig === computed`
- `X-GitHub-Delivery` dedup before enqueue, reject duplicates with 200
- Cap body size before HMAC verification

## 🟢 Nice-to-have

### 10. MCP skips `jsonrpc: "2.0"` validation
**Where:** `server/mcp/server.ts:118` — dispatches on any parsed object.<br>
**Fix:** Validate `jsonrpc` field, reject batch arrays explicitly.

### 11. Key format pre-check too loose
**Where:** `server/mcp/server.ts:107` — `key.length < 5` check<br>
**Fix:** Enforce `/^lxk_[0-9A-Za-z]{43}$/` before hashing.

### 12. Local server CORS `*` with Authorization
**Where:** `scripts/mcp/mcp-server.ts:953-955`<br>
**Fix:** Delete CORS headers entirely — MCP clients aren't browsers.

### 13. Local `/mcp` prefix match too broad
**Where:** `scripts/mcp/mcp-server.ts:971` — `startsWith("/mcp")` passes `/mcpfoo`<br>
**Fix:** Exact match `req.url === "/mcp"`

### 14. Key compare not constant-time
**Status: ✅ FIXED** (`scripts/mcp/mcp-server.ts:978` — uses `timingSafeEqual`)

### 15. Startup logs key prefix
**Where:** `scripts/mcp/mcp-server.ts:1014` — prints first 8 chars of key<br>
**Fix:** Drop the log line.

### 16. `/health` discloses WORKER_URL
**Status: ⬜ STALE** (no longer applicable — `WORKER_URL` field removed or harmless in Bun standalone)

### 17. No security headers on REST responses
**Where:** All API responses<br>
**Fix:** Add `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.

### 18. `parseInt` unchecked NaN on revisions limit
**Where:** `server/api/http.ts:670`<br>
**Fix:** Clamp via `clampLimit` like tasks path does.

## Passed Review

| Area | Finding |
|------|---------|
| SQL injection | All interpolated fragments are hardcoded column literals, values always bound |
| Cursor decode | Bound after decode, safe |
| API key hash timing | SHA-256 of 256-bit key makes timing oracle useless |
| MCP auth ordering | Auth validated before parse — correct |

## Fix Priority (remaining)

1. **#7 — FTS5 error handling** (data leak via search)
2. **#5 — Rate limiting** (CF dashboard, zero code)
3. **#2 — Access JWT verify** (defense in depth, low urgency)
4. **#9 — Webhook hardening** (during Phase 6 build)
5. **#10-18 — Nice-to-haves** (choose per effort)
