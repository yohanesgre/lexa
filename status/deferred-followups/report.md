# Report: deferred-followups
created: 2026-09-25
sessions: ses_f2ba20257ffe5CIAQa1wy3Mk2v (main), ses_f28fd349affetCLrZBdrGAgx2A (rownotfound), ses_f28fd3499ffeljgb32EQwlPhIo (coverage-a), ses_f28fd3491ffe7yokrgnww9LyJP (coverage-b), ses_f28f782c2ffeNh8ss0N8eNvjM8 (review), ses_f28f46e91ffex35c6zzIrdJeta (fixups), ses_f28ec5f3bffegplQnvPV3bVywu (gate)
result: branch `chore/deferred-followups` @ a0dfc01 — deferred wave 1 shipped (contract + coverage + doc notes); coverage waves 2-3 remain parked.

## What changed

- **RowNotFound audit correction:** `project`/`task`/`column`/`swimlane` repo `update` were already strict — they re-read via `queryFirst` after the UPDATE, so an absent row already raised `RowNotFound`. No code change; the original review premise was wrong.
- **Three GitHub-link setters made strict:** `setGithubIssueTitle`, `setGithubSyncedState`, `setPushedContent` now fail `RowNotFound` on `changes === 0`; sync callers map to `DbError`, webhook title refresh logs-and-continues. Documented best-effort HTTP-200 behavior (`docs/API.md`) unchanged; `changes === 0` is a true absent-row signal on SQLite.
- **`docs/LAYERS.md` repo write contract** (delete idempotent, update/set strict, exceptions listed precisely: `CommentRepo.softDelete`, `FieldConfigRepo.updateOption`, bulk sweeps, conditional transitions) + client-facing error-copy policy.
- **Other notes:** `docs/ARCHITECTURE.md` admin-role assumption; `server/db/database.ts` `@deprecated` test-harness note.
- **Six new repo test suites:** `column.repo` (ordering, CHECK, FK, counts), `project.repo` (key/slug, uniqueness, atomic counter statement), `webhook-event.repo` (idempotent delivery, prune), `assistant-providers.repo` (CRUD + masking proves no raw key leaks), `runtime-machine.repo` (register conflict matrix, heartbeat, offline, strict delete), `wiki.repo` (tree, per-project slug, revision cascade, newest-N prune, FTS). No defects found.
- **Error-trail fix:** content-push failure now logs the original error; a missing link row on the success path no longer re-enters the failure branch.

## Tests

- `bash scripts/verify-gate.sh` → exit 0: `tsc` passed; vitest **192 files / 1725 tests passed**; `check:invariants` green; secrets/dist clean.
- Reviewer PASS after one round (contract precision, two weak assertions, error trail, deprecation wording — all fixed and re-verified).

## Deviations

- No service-level test for the three strict setters: no dedicated service method, and `GitHubService.Default` bakes in `GitHubClient.Default` so layer override fails; repo-level `RowNotFound` tests added instead.
- `.tmp/dup_scan.py` scratch file removed.

## Concerns

- Deferred waves 2-3 (`api-key`, `device-login`, `user-project-role`, `attachment`, `source`, `project-repos`; `assistant-call-logs`, `assistant-model-prices`) remain parked in `status/deferred-backlog/`.
- `assistant-providers.repo` raw row surfaces carry `api_key`; masking is asserted on `maskedView`/`maskedList` (the surfaces routes consume) — service-side masking remains the contract.
- Unrelated concurrent work: `docs/design-system.html` is modified in the worktree and intentionally excluded from this branch.
- PR merge pending user.
