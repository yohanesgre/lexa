# Release — v0.1.0 (internal verification ledger)

> User-facing release notes: `docs/RELEASE_NOTES.md`.
> Status: SHIPPED — tag `v0.1.0` (2026-08-04). All A–G items green.

Scope: first tagged release of Lexa as a self-hosted project-management tool,
**including** the two-way GitHub issue sync (Phase 6 — see §F/G).

## A. Security hardening

 - [x] **A1 — REST admin gate.** `verifyApiKey` returns caller identity
      (`keyId`, `userId`, `role`; `user_id NULL` ⇒ admin — same rule as
      `server/mcp/server.ts`). Admin-only enforced on: `api-keys` group,
      `admin` group, project create/update/delete, column/swimlane
      create/update/delete, field-config PUT, settings group. Non-admin → 403
      `FORBIDDEN`. (REST previously accepted any valid key on these routes;
      the MCP surface already enforced admin.)
 - [x] **A2 — Setup first-run guard.** `POST /api/setup/admin` and
      `/api/setup/api-key` only while unconfigured (no `admin_emails` set);
      otherwise 403 `SETUP_LOCKED`. `/setup/seed` already guarded by project
      count. (These routes are API-key exempt by design — the wizard must be
      the only one able to use them.)
 - [x] **A3 — FTS5 crash → 422.** `WikiService.search` maps `DbError` from
      `MATCH ?` to `SearchError` (`SEARCH_ERROR`, 422) instead of leaking a
      500. (SECURITY.md #7.)
 - [x] **A4 — Security headers.** `X-Content-Type-Options: nosniff` and
      `Cache-Control: no-store` on all `/api/*` and `/mcp` responses.
      (SECURITY.md #17.)
 - [x] **A5 — Limit clamp.** Wiki `listRevisions` uses `clampLimit` instead of
      unchecked `parseInt`. (SECURITY.md #18.)

## B. GitHub sync — shipped (Phase 6, not deferred)

 - [x] Two-way issue sync shipped: GitHub App client (JWT/token cache/HMAC),
      `GitHubService`, raw webhook route (HMAC before parse, ack-200 +
      background processing, `webhook_events` dedup, per-issue echo
      suppression), `github-link` REST endpoints, MCP tools, TaskDetail UI.
      Full setup guide: `docs/GITHUB_SETUP.md`.
 - [x] `docs/API.md` / `docs/MCP.md` / `docs/LAYERS.md` / `docs/ARCHITECTURE.md`
      synced to the implemented multi-issue reality; `docs/SECURITY.md` #9 →
      FIXED.

## C. Legacy `scripts/mcp/` removed

 - [x] Delete `scripts/mcp/` (install.sh, uninstall.sh, configure-agent.sh,
      mcp-server.ts, lexa-mcp.env, lexa-mcp.service) — superseded by
      `server/mcp/` (streamable HTTP on the main server).
 - [x] `scripts/setup-cli.ts` MCP hint updated.
 - [x] SECURITY.md references scrubbed.

## D. Cleanup

 - [x] `.env.example` gains `LXK_FORGE_DAEMON_TOKEN=`.
 - [x] `package.json`: remove dangling `main`, add description.
 - [x] Remove stray empty untracked `src/` dir.
 - [x] Dockerfile: use `bun.lock`; delete `package-lock.json` (single lockfile).

## E. Verification gates (run in order, before tagging)

1. ✅ `tsc --noEmit` — pass (also fixed 17 pre-existing baseline errors: FiberId logging, findByUserId, dashboard/role error unions, catchTag narrowing, `CannotDeleteSelf()` arity, SSR import decl).
2. ✅ `vitest run` — 95/95 green (incl. GitHub crypto: JWT PKCS#1/PKCS#8, HMAC constant-time).
3. ✅ `bun run build` — production build succeeds.
4. ✅ Stack restarted with current `.env`; `/api/health` ok; `lxk-api-key` meta injected on :3000.
5. ✅ Backend curl suite: 401/200 auth, setup mutations locked, board/fieldConfig, task CRUD + archive/restore, 404/204 codes, FTS crash → 422 `SEARCH_ERROR`, forge endpoints, MCP handshake (401 without key / 200 with / jsonrpc validation). **Constraint mapping fixed:** bun:sqlite reports `UNIQUE constraint failed:` (no `SQLITE_CONSTRAINT` string) — `run()`/`batch()` now classify correctly: duplicate slug → 409 `SLUG_TAKEN`, non-empty column delete → 409 `HAS_CHILDREN`, position conflicts → retryable `ConstraintViolation` (was: all 500 `DATABASE_ERROR`).
6. ✅ Frontend pass (clean browser): dashboard, board, task detail, wiki tree + page + editor, settings (API Keys/Agents/Skills/Runtimes), Forge popover — all render, console errors = 0.
7. ✅ `docker compose build app` — image builds.
8. ✅ **MCP prod smoke** (lexa.yohanesgre.com/mcp, prod key): initialize, tools/list (35 tools), create_project → create_task → move_task → create_wiki_page → search_wiki → get_task — all green.
9. ✅ **GitHub round-trip on production** (fresh DB): link task → issue created+closed on move; close/reopen on GitHub → task follows (webhook); echo suppressed; deliveries recorded after success; bad-signature → 401.
10. ✅ **Migration squash:** `migrations/0001_init.sql` is a single clean unreleased schema (no rebuild/backfill steps; Forge builtin seeds kept). Fresh apply verified: inventory identical to the pre-squash DB, full API + MCP suite green on the new schema, existing dev/prod DBs boot without re-migration.
11. ✅ Prod redeployed on a clean volume (`lexa-prod_lexa-data` recreated); health ok, webhook/MCP bypass 401s verified.
12. ✅ Working tree committed; tag `v0.1.0` pushed.
