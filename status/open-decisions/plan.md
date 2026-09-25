# Plan: open-decisions
created: 2026-09-25
state: PLAN
gate: 2026-09-25 user "proceed" (worktree lane, branch omos/open-decisions; commit → push → PR per established envelope)
iter: W1i1

## X (problem)
Action the three remaining open decisions. Two are implementable now with settled directions (PREFIX-n alias per invariant #13; cf-connecting-ip trust hardening). The third (`runtimes.team_id` org-delete semantics) is a doc/schema conflict needing a maintainer pick — the architect's decision-ready note is persisted here, implementation intentionally out of scope until the pick.

## Scope
- In:
  - **PREFIX-n alias:** resolve ticket-key aliases for payload/query task ids (createTask `parentId`, addTaskLink `toTaskId`, searchTasks `exclude`, plus any other payload/query task-id fields found), update `docs/API.md`, add tests.
  - **cf-connecting-ip:** trust the header only from loopback or configured trusted proxies; add `LXK_TRUSTED_PROXY_CIDRS` (comma-separated CIDRs/IPs, empty = loopback only); update `docs/DEPLOYMENT.md` (+ `docs/LAYERS.md` if middleware is documented there); tests for spoof-ignored/loopback/configured paths.
  - **Design record:** persist `design-runtimes-team-id.md` (architect note: options, recommendation, migration sketch, open questions).
- Out:
  - `runtimes.team_id` implementation (migration / service guard / PATCH `teamId` / new error code) — blocked on the maintainer pick (Option A vs first-step D);
  - `runtime_events.team_id` sibling issue (open question in the design note);
  - any UI/wireframe work; `docs/design-system.html` (concurrent work, other worktree).

## Graph A (happy path)
```ts
plan + design note → single decisions lane (PREFIX-n then cf-IP) → reviewer → full gate → commit → push → PR → DONE
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| PREFIX-n | payload field has no path slug | resolve by key then verify against project; else report |
| cf-IP | env conventions differ | follow `server/env.ts` patterns; declare any deviation |
| lane | both concerns touch `server/api/http.ts` | single combined lane edits the file once, in order: PREFIX-n first, then cf-IP |
| gate | red | fix in lane; no commit |

## R
- worktree `.worktrees/open-decisions`, branch `omos/open-decisions` @ b46576c (deps installed)
- commands: `bun x vitest run <specs>` · `bun x tsc --noEmit` · `bash scripts/verify-gate.sh`

## Lanes
- decisions: `server/api/http.ts` (PREFIX-n sites first, then the client-IP site), `server/api/middleware.ts`, `server/api/rate-limit.ts`, `server/entry.ts`, `server/env.ts`, `docs/API.md`, `docs/DEPLOYMENT.md`, `docs/LAYERS.md` (+ touched specs). Single lane because both concerns edit `server/api/http.ts`.

## Memory
- `icm_memory_store` on DONE: summary + plan.md/report.md + design note path
