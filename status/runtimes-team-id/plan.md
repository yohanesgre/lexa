# Plan: runtimes-team-id
created: 2026-09-25
state: PLAN
gate: 2026-09-25 user "merge and proceed with option A" (branch → commit → push → PR)
iter: W1i1

## X (problem)
Implement Option A for the `runtimes.team_id` org-delete conflict (design: `status/open-decisions/design-runtimes-team-id.md`). Today `ON DELETE SET NULL` plus a service pre-clear silently convert team-scoped runtimes into GLOBAL runtimes (which may claim any team's tasks and receive cross-team task data). Option A: `ON DELETE RESTRICT` backstop + service refuses org deletion while runtimes are bound (409) + an explicit superadmin reassign/detach path.

## Scope
- In:
  - Migration `0007_runtimes_team_restrict.sql`: rebuild `runtimes` FK to `ON DELETE RESTRICT` (mirror the proven 0005 technique; D1-safe), recreate `idx_runtimes_machine` + `idx_runtimes_team`, `PRAGMA foreign_key_check`.
  - `server/services/teams.service.ts`: drop the implicit `team_id` pre-clear; attempt the org delete; on FK constraint, count bound runtimes and fail `TeamHasRuntimes` (race-free FK backstop).
  - New error `TeamHasRuntimes` → 409 `TEAM_HAS_RUNTIMES` with `{ teamId, count }` (`server/api/errors.ts` + `docs/LAYERS.md` catalog + `docs/API.md` team-delete section).
  - `PATCH /api/runtimes/:id` accepts `teamId: string | null` (superadmin): reassign to an existing team or detach (`null` = explicit global); repo/service with `RowNotFound`; `docs/API.md` PATCH section.
  - Docs: `docs/SCHEMA.md:632` → RESTRICT; `docs/ARCHITECTURE.md` runtime-scoping rationale.
  - Tests: team delete with bound runtime → 409 (row intact); after reassign/detach/delete → 200; raw `DELETE FROM organization` under FK ON → constraint error; migration chain produces the RESTRICT action; PATCH teamId happy/not-found/authz; claim regression (scoped runtime must not claim another team's task; explicit global still claims).
- Out:
  - `runtime_events.team_id` sibling FK (architect open question 5) — report-only;
  - changing register defaults (global stays possible via explicit registration/no team);
  - claim-time `status='offline'` gating (open question 4);
  - any UI/wireframe work (open question 6).

## Graph A (happy path)
```ts
plan → lane impl (migration + service + error + PATCH + docs + tests) → reviewer → full gate → commit → push → PR → DONE
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| migration | D1 cannot disable FKs | mirror 0005 technique; add/adjust D1 migration test; never edit 0001 |
| service | existing pre-clear removal breaks other delete paths | grep all org-delete paths; only teams.service owns it |
| PATCH | route already has a payload/auth contract | extend additively; keep existing fields/statuses |
| gate | red | fix in lane; no commit |

## R
- worktree `.worktrees/open-decisions` (reused), branch `omos/runtimes-team-id` @ b107f82
- commands: `bun x vitest run <specs>` · `bun x tsc --noEmit` · `bun run test:be` · `bash scripts/verify-gate.sh`

## Lanes
- impl: `migrations/0007_*.sql`, `server/services/teams.service.ts`, `server/services/runtime.service.ts`, `server/repos/runtime.repo.ts`, `server/api/errors.ts`, `server/api/http.ts`, docs (`SCHEMA.md`, `API.md`, `LAYERS.md`, `ARCHITECTURE.md`), + specs

## Memory
- `icm_memory_store` on DONE: summary + plan/report paths
