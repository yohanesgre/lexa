# Plan: db-backend-review-fixes
created: 2026-09-25
state: PLAN
gate: 2026-09-25T03:05+07:00 user fix/db-backend-review-fixes (authorized: branch→commit→push→PR)
iter: W1i1

## X (problem)
Adversarial review of DB+backend (3 read-only lanes) found 4 must-fix defects plus medium/low issues at commit 0f4caa4. Trunk is one merge ahead (origin/main 3b7c40a, PR #100 renamed herald→assistant), so every finding is re-verified at branch HEAD before the fix. All code findings get fixed; doc-conflict and deployment-sensitive items stay report-only.

## Scope
- In:
  - api/security: project gates on task mutations + updateComment (server/api/http.ts); webhook empty-secret guard (server/github/crypto.ts); Workers auth parity (server/workers-entry.ts) + limiter sweeps (server/auth.ts); provider error-details allowlist (server/api/errors.ts); searchRepos auth + retry/timeout (server/github/client.ts); shared safeHref in app/lib/markdownToReact.tsx
  - db: task-keys-backfill transaction + numbering (server/db/task-keys-backfill.ts); phantom updated_at writes (server/repos/field-config.repo.ts, server/repos/milestone-batch.ts); missing updated_at (server/repos/user.repo.ts); batch timestamps via datetime('now') + dead activity insert (server/repos/task-batch.ts, milestone-batch.ts); assistant-models delete tx; github_issues_raw JSON parsing (shared/db.ts); dead server/db/database.ts if safely removable; stale migration comment if runner ignores file content
  - services: clearDueAt activity emission (server/services/task.service.ts); recordDelivery on echo/no-target early returns (server/services/github.service.ts); assistant write-execution task re-scope (server/assistant/write-execution.ts); SSRF fail-closed lookup + all-address validation (server/assistant/ssrf.ts, tools.ts)
- Out (report-only, needs user decision):
  - doc conflicts: runtimes.team_id FK action; PREFIX-n alias on payload ids vs docs/API.md; SCHEMA.md canonical WIP SQL snippet; invariant #7 frontend-markdown usage
  - cf-connecting-ip trust scope (deployment-sensitive); RowNotFound standardization on 0-row writes; shared/diff memory cap; DB test-coverage expansion for untested repos

## Graph A (happy path)
```ts
verify findings @ HEAD → 3 parallel lanes (api/db/svc) → reviewer(diff) → full gate → commit → push → PR → DONE
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| verify | finding already fixed or renamed | lane reports, skips fix, keeps evidence |
| lanes | shared-file collision | lanes own disjoint files (api: http/errors/github/workers/auth; db: db/repos/shared-db; svc: services/assistant) |
| tests | beforeAll timeout under machine load | rerun spec alone; environmental only if solo pass |
| gate | red | fix in lane, rerun; no commit before green |

## R
- branch: fix/db-backend-review-fixes (from origin/main @3b7c40a); pre-existing `wireframes` submodule pointer drift — never stage it
- commands: `bun run typecheck` · `bun run test:be` · `bun x vitest run <file>` · `bash scripts/verify-gate.sh`
- memory: `icm_memory_store` on DONE with plan.md/report.md paths

## Lanes
- api: server/api/http.ts, server/api/errors.ts, server/github/crypto.ts, server/github/client.ts, server/workers-entry.ts, server/auth.ts, app/lib/markdownToReact.tsx (+ tests)
- db: server/db/task-keys-backfill.ts, server/repos/{field-config,milestone-batch,user,task-batch,*models}.ts, shared/db.ts, migrations/0001_init.sql (+ tests)
- svc: server/services/task.service.ts, server/services/github.service.ts, server/assistant/write-execution.ts, server/assistant/ssrf.ts, server/assistant/tools.ts (+ tests)

## Memory
- `icm_memory_store` on DONE: 3–5 lines + status/db-backend-review-fixes/{plan.md,report.md}
