# Release — v0.1.0

> Status: HARDENING COMPLETE — all A–E items green (2026-08-03). Tag `v0.1.0`
> pending user go.

Scope: first tagged release of Lexa as a self-hosted project-management tool.
GitHub two-way sync is **deferred** (planned, not implemented — see §B).

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

## B. GitHub sync — deferred, docs made honest

 - [x] `docs/API.md`: `github-link` endpoints, `POST /api/webhooks/github`, and
      task `github` fields marked **planned — not implemented in v0.1.0**.
 - [x] `docs/MCP.md`: `link_github_issue`/`unlink_github_issue` already carry
      STUB wording — verify and keep.
 - [x] `docs/SECURITY.md`: statuses updated — #7/#17/#18 fixed after A3–A5,
      #9 stays pending (Phase 6), #12/#13/#15 N/A (legacy `scripts/mcp/`
      deleted).

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
2. ✅ `vitest run` — 88/88 green.
3. ✅ `bun run build` — production build succeeds.
4. ✅ Stack restarted with current `.env`; `/api/health` ok; `lxk-api-key` meta injected on :3000.
5. ✅ Backend curl suite 37/37: 401/200 auth, setup mutations → 403 `SETUP_LOCKED`, member key → 403 on admin endpoints (admin key → 200), board/fieldConfig, task CRUD + archive/restore, 404/204 codes, FTS crash → 422 `SEARCH_ERROR`, revisions limit clamp, forge endpoints, MCP handshake (401 without key / 200 with / jsonrpc validation).
6. ✅ Frontend pass (clean browser): dashboard, board, task detail, wiki tree + page + editor, settings (API Keys/Agents/Skills/Runtimes), Forge popover — all render, console errors = 0. (agent-browser showed a stale-HMR React error from the pre-restart dev server; absent on clean load.)
7. ✅ `docker compose build app` — image builds.
8. ⏳ Working tree reviewed; commit + `git tag v0.1.0` + push — **on user go**.
