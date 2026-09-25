# Plan: deferred-followups
created: 2026-09-25
state: PLAN
gate: 2026-09-25 user "proceed" — execute deferred backlog wave 1 (branch → commit → push → PR per established pattern)
iter: W1i1

## X (problem)
Execute deferred-backlog wave 1: (a) the RowNotFound split contract plus three small doc notes, (b) DB coverage wave 1 for the six invariant/security-critical untested repos. Later coverage waves and the open decisions stay parked.

## Scope
- In:
  - L1 RowNotFound split contract: audit void UPDATE/setter methods; add strict `RowNotFound` only where callers already guarantee existence or the domain mapping is safe; `delete*` stay idempotent and are documented in `docs/LAYERS.md`; tests per changed method; audit table in the lane report.
  - L1 doc notes: admin-route ownership assumption in `docs/ARCHITECTURE.md`; `@deprecated` note on `server/db/database.ts`; client-facing error-copy policy in `docs/LAYERS.md`.
  - L2a coverage: new `column.repo.test.ts`, `project.repo.test.ts`, `webhook-event.repo.test.ts`.
  - L2b coverage: new `assistant-providers.repo.test.ts` (key masking), `runtime-machine.repo.test.ts`, `wiki.repo.test.ts`.
- Out: coverage waves 2–3 (`api-key`, `device-login`, `user-project-role`, `attachment`, `source`, `project-repos`; `assistant-call-logs`, `assistant-model-prices`); open decisions (`runtimes.team_id`, `PREFIX-n`, `cf-connecting-ip`); no schema changes.

## Graph A (happy path)
```ts
write plan → 3 parallel lanes (L1 / L2a / L2b) → reviewer → full gate → commit → push → PR → DONE
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| L1 | strict update would change a documented API status | stop for that method, keep void, record caller pre-check in the audit table |
| L2* | new test exposes a real defect | do not fix source; report file:line in the lane report |
| lanes | file collision | L1 owns repo/service source + docs; L2* own only new `*.repo.test.ts` |
| gate | red | fix in lane; no commit |

## R
- branch `chore/deferred-followups` @ a0dfc01
- commands: `bun x vitest run <specs>` · `bun x tsc --noEmit` · `bash scripts/verify-gate.sh`

## Lanes
- L1 rownotfound: void setters in `server/repos/**`, service mapping in `server/services/**`, `docs/LAYERS.md`, `docs/ARCHITECTURE.md`, `server/db/database.ts` (+ tests)
- L2a coverage: `server/repos/{column,project,webhook-event}.repo.test.ts` (new files only)
- L2b coverage: `server/repos/{assistant-providers,runtime-machine,wiki}.repo.test.ts` (new files only)

## Memory
- `icm_memory_store` on DONE: summary + plan.md/report.md paths
