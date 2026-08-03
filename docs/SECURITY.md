# Security Hardening — Lexa

> Oracle review: 3 critical, 5 important, 9 nice-to-have. Prioritized by attacker impact.
> Updated: Workers removed — Bun standalone deployment. All code-level items closed 2026-08-03 (v0.1.0 hardening — see RELEASE.md).

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

**Status: ✅ FIXED** (v0.1.0 — `WikiService.search` maps `DbError` → 422 `SEARCH_ERROR` with a generic message; `server/services/wiki.service.ts`)

### 8. API key management — resolved

**Status: ✅ FIXED** (all `/api/*` routes guarded by `verifyApiKey`; **v0.1.0 hardening:** admin-only enforcement added on `/api/settings/api-keys`, `/api/admin/*`, project/column/swimlane/field-config mutations, and Forge agents/skills CRUD — caller identity resolved from the key (keys without a user = admin), non-admins get 403 `FORBIDDEN`. Matches the MCP surface (`server/mcp/auth.ts`).)

### 9. Webhooks not yet implemented

**Status: 🔲 PENDING (Phase 6 — deferred out of v0.1.0)**

**Impact:** When built — signature timing oracle, replay attacks, unbounded body.

**Fix (when building):**
- Constant-time HMAC compare via `crypto.subtle.verify`, never `sig === computed`
- `X-GitHub-Delivery` dedup before enqueue, reject duplicates with 200
- Cap body size before HMAC verification

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
**Status: ✅ FIXED** (v0.1.0 — `X-Content-Type-Options: nosniff` + `Cache-Control: no-store` on all `/api/*` and `/mcp` responses; `server/entry.ts`)

### 18. `parseInt` unchecked NaN on revisions limit
**Status: ✅ FIXED** (v0.1.0 — wiki `listRevisions` uses `clampLimit` like the tasks path)

## Passed Review

| Area | Finding |
|------|---------|
| SQL injection | All interpolated fragments are hardcoded column literals, values always bound |
| Cursor decode | Bound after decode, safe |
| API key hash timing | SHA-256 of 256-bit key makes timing oracle useless |
| MCP auth ordering | Auth validated before parse — correct |

## Fix Priority (remaining)

1. **#5 — Rate limiting** (CF dashboard, zero code)
2. **#2 — Access JWT verify** (defense in depth, low urgency)
3. **#9 — Webhook hardening** (during Phase 6 build)
