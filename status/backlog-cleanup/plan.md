# Plan: backlog-cleanup
created: 2026-09-25
state: PLAN
gate: 2026-09-25 user fix/backlog-cleanup (proceed with all: merge #101 + cleanup branch + two doc fixes)
iter: W1i1

## X (problem)
Post-review cleanup of small, user-approved items: a real search bug (multi-assignee tasks duplicate in results), a dead builder param, a diff-memory guard, and two near-certain doc-conflict resolutions. Remaining deferred items live in `status/deferred-backlog/plan.md`.

## Scope
- In:
  - `server/repos/task.repo.ts`: `searchByTitle` gains `GROUP BY t.id` (+ multi-assignee regression test)
  - `server/repos/task-batch.ts` + `server/services/task.service.ts`: drop the unused `activity` input from `buildTaskDeleteBatch` and its caller
  - `shared/diff.ts`: cell-budget guard with coarse fallback + per-line token cap (+ tests)
  - `docs/SCHEMA.md`: canonical WIP SQL snippet gains `AND archived_at IS NULL`, marked normative
  - `AGENTS.md` invariant #7: reworded — shared pure converter allowed in app; REST boundary stays TipTap JSON
- Out (report-only / later): `status/deferred-backlog` items (RowNotFound audit, DB coverage plan, database.ts deprecation, admin-route doc line, error-copy policy); open decisions (runtimes.team_id, PREFIX-n, cf-connecting-ip)

## Graph A (happy path)
```ts
write plan → 2 parallel lanes (code / docs) → verify → reviewer → full gate → commit → push → PR → DONE
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| lanes | file collision | code lane owns server/ + shared/; docs lane owns AGENTS.md + docs/SCHEMA.md |
| searchByTitle | GROUP BY changes row shape | test asserts single row + concatenated assignees |
| diff guard | fallback changes rendering | LCS kept under budget; fallback only above; both paths tested |
| gate | red | fix in lane; no commit |

## R
- branch `fix/backlog-cleanup` @ eb4ce70 (from origin/main)
- commands: `bun x vitest run <specs>` · `bun x tsc --noEmit` · `bash scripts/verify-gate.sh`

## Lanes
- code: `server/repos/task.repo.ts` (+test), `server/repos/task-batch.ts`, `server/services/task.service.ts`, `shared/diff.ts` (+test)
- docs: `AGENTS.md`, `docs/SCHEMA.md`

## Memory
- `icm_memory_store` on DONE: summary + plan.md/report.md paths
