# Report: db-backend-review-fixes
created: 2026-09-25
sessions: ses_f2ba20257ffe5CIAQa1wy3Mk2v (main), ses_f2af8ae8affem8RFJkt4HbWV1Q (verify), ses_f2af56102ffehByNOhbHSAcldz + ses_f2aeb4a7effeUOqlCbkJIdSixs (api), ses_f2af56101ffencYazhfdUt10os + ses_f2aeb4a7dffewHv46Dd1Z044o2 (db), ses_f2af560f7ffet5zoLSaSGr48wX (svc), ses_f2ae30ed3fferUcPo53O5OYGCT (review), ses_f2ad5ecaeffekk6elytSFn602Q + ses_f2ad2d101ffe7BaWmtmdiEWntN (gate)
result: branch `fix/db-backend-review-fixes` (from origin/main 3b7c40a) — all reviewed code findings fixed; doc-conflict and deployment-sensitive items excluded by user decision; commit/push/PR under the approved gate envelope.

## What changed

- **Authorization (IDOR class, wider than first reviewed):** new `requireTaskInProject` gate applied to every task-scoped handler (task CRUD/move/archive/restore, activity, comments create/update/delete, GitHub link/link-existing/unlink, task-link list/add/remove) so a raw UUID can no longer bypass the project slug; `CommentService.edit/remove` and `TaskLinkService.remove` now scope to the resolved task; `addSource` validates the document against the project before insert/activity; `removeSource` is project-scoped; `deleteAttachment` verified uploader-or-project-admin.
- **Webhook/auth:** empty/blank webhook secret rejected before HMAC (crypto + client + both hosts); Workers `/api/auth/*` gets the Bun host's IP throttle, login limiter, and body cap via a shared `handleAuthSurface`; limiter Maps swept; setup exemption no longer matches `/api/setup*`.
- **Leak hardening:** provider error details allowlisted; SSE/persist/onFail go through `clientFacingErrorMessage` (raw/upstream never client-visible; server logs keep raw); `searchRepos` authenticated with installation token + fallback; `githubFetch` timeout + bounded idempotent retry; `app/lib/markdownToReact.tsx` uses shared `safeHref`.
- **DB:** ticket-key backfill now transactional, seeded from `MAX(number)`, idempotent, `next_task_number = max(existing, highest)`; phantom `updated_at` writes removed (`field-config.repo`, `milestone-batch`); `user.repo` writes `updated_at`; batch builders use `datetime('now')`; dead pre-DELETE activity insert removed; assistant-model delete batched; `github_issues_raw` emitted as JSON (`json_group_array(json_object(...))`) and parsed JSON-first; stale migration comment fixed (0007).
- **Services:** `clearDueAt` emits the due-date `field_changed` row in the same batch; webhook deliveries recorded after successful no-op processing (echo/no-target); assistant write-execution re-checks `project_id` at execution time; SSRF lookup fails closed and the URL is re-validated immediately before each fetch.

## Tests

- `bash scripts/verify-gate.sh` → exit 0; `tsc --noEmit` passed; vitest **186 files / 1680 tests passed**; `check:invariants` green; secrets/dist checks clean.
- Lane runs: api 8 files/142 tests; db 8/65; svc 4/54; reviewer independent re-runs 12/219 + 12/107 (326 tests) — all green.
- Regression tests added for every fixed defect, including partial backfill state, `||`-in-title issue round-trip, empty-secret HMAC, cross-project UUID 404s with DB-state assertions, throttle/body-cap paths, and SSE sanitizer.

## Deviations

- Backfill stores `max(existing, highest)` (column = last issued; `TaskService` pre-increments; `setup.test.ts` expects 5) — not `highest + 1` as first briefed.
- SSRF DNS-rebinding TOCTOU narrowed (fail-closed + pre-fetch re-validation) but not eliminated: Bun fetch exposes no custom lookup/dispatcher.
- Watchdog stall text is now server-log-only; clients receive the sanitized generic `ASSISTANT_GENERATION_FAILED` message.
- `server/db/database.ts` kept: used by ~30 test files with unique pragma coverage; not dead enough to remove safely.
- `app/lib/markdownToReact.tsx` + test are intentional (review finding) though flagged as out-of-scope residue by the reviewer.

## Excluded (need owner decision)

- Doc conflicts (rule: report, never resolve): `runtimes.team_id` FK action, `PREFIX-n` alias on payload ids vs API.md, SCHEMA.md canonical WIP SQL snippet, invariant #7 frontend-markdown usage.
- Deployment-sensitive: `cf-connecting-ip` trust scope for private socket IPs.
- Deferred: `RowNotFound` standardization on 0-row writes, `shared/diff` O(n*m) cap, DB test coverage for untested repos.

## Concerns

- `wireframes` submodule pointer was already dirty on checkout (PR #100 gitlink bump); never staged.
- `providerMessage` still crosses to clients (matches the allowlist contract); switch to generic-only if policy tightens.

## Review

Reviewer final verdict: **PASS** after one REQUEST CHANGES round (source-route bypasses + SSE leak found and fixed); 326 tests independently verified.
