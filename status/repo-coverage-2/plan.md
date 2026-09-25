# Plan: repo-coverage-2
created: 2026-09-25
state: PLAN
gate: 2026-09-25 user "proceed" (merge #103 + continue coverage waves 2–3)
iter: W1i1

## X (problem)
Complete the deferred DB coverage backlog: waves 2–3 for the eight remaining untested repos. Test-only; no source changes. Acceptance: every `server/repos/*.ts` has a sibling `.test.ts`, six new suites pass, and the full gate stays green.

## Scope
- In:
  - Lane A: `server/repos/{api-key,device-login,user-project-role}.repo.test.ts`
  - Lane B: `server/repos/{attachment,source,project-repos}.repo.test.ts`
  - Lane C: `server/repos/{assistant-call-logs,assistant-model-prices}.repo.test.ts`
- Out: source/schema changes (defects found are reported, not fixed); open decisions (`runtimes.team_id`, `PREFIX-n`, `cf-connecting-ip`); `docs/design-system.html` (unrelated concurrent work).

## Graph A (happy path)
```ts
plan → 3 test lanes (A/B/C) → reviewer → verify no untested repo files → full gate → commit → push → PR → DONE
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| lane | test exposes a real defect | report `path:line` + evidence; do not fix source |
| lane | missing fixtures | seed via direct repo/db inserts, follow existing harness |
| gate | red | fix in lane; no commit |

## R
- branch `chore/repo-coverage-2` @ d283867
- commands: `bun x vitest run <new specs>` · `bun x tsc --noEmit` · `bash scripts/verify-gate.sh`
- acceptance check: the repo/test sibling loop returns no untested `server/repos/*.ts`

## Lanes
- A: `server/repos/{api-key,device-login,user-project-role}.repo.test.ts`
- B: `server/repos/{attachment,source,project-repos}.repo.test.ts`
- C: `server/repos/{assistant-call-logs,assistant-model-prices}.repo.test.ts`

## Memory
- `icm_memory_store` on DONE: summary + plan.md/report.md paths
