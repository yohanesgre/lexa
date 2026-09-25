# Plan: deferred-backlog
created: 2026-09-25
state: PLAN
note: not scheduled — durable record per user decision 2026-09-25 ("take note to do deferred later"). jev judged nothing here merge-blocking; searchByTitle was the only next-cycle yes and is handled in `status/backlog-cleanup/`.

## X (problem)
Record the deferred DB/backend review follow-ups so they are not lost, with enough detail to schedule each as its own plan.

## Scope
- In (do later, scheduled on user go):
  1. RowNotFound split contract — own plan: deletes stay idempotent + documented in `docs/LAYERS.md`; audit void setters (e.g. `setGithubLink`, `setPushedContent`, `user.update`) and make update paths strict `RowNotFound`; tests. Medium API-visible risk.
  2. DB repo test coverage — own plan, invariant-first waves for the 14 untested repos. Wave 1: `column`, `project`, `webhook-event`, `assistant-providers` (key masking), `runtime-machine`, `wiki`. Wave 2: `api-key`, `device-login`, `user-project-role`, `attachment`, `source`, `project-repos`. Wave 3: `assistant-call-logs`, `assistant-model-prices`. Acceptance: every `server/repos/*.ts` has a sibling `.test.ts`.
  3. `server/db/database.ts` deprecation note — freeze new imports; do not delete (≈30 test files depend on it; `initSqlite` pragma coverage is unique).
  4. Admin-route ownership doc line — note in `docs/ARCHITECTURE.md` auth section that project-scoped admin roles don't exist; column/swimlane/milestone bare-id routes assume global admin.
  5. Client-facing error-copy policy — decide whether locally-generated failures (e.g. watchdog stall) may bypass the provider sanitizer; document in `docs/LAYERS.md`.
- Out: items already actioned on `fix/backlog-cleanup` (searchByTitle GROUP BY, dead `activity` param, `shared/diff` guard, SCHEMA WIP snippet, invariant #7 reword).

## Open decisions (not scheduled)
| item | jev lean | note |
|---|---|---|
| `runtimes.team_id` FK action | needs_design (0.67) | decide orphaned-runtime behavior; NULL team = global runtime |
| `PREFIX-n` payload alias | extend_code (0.63) | vs narrow invariant (0.30) |
| `cf-connecting-ip` trust | loopback_only (0.82) | proposal: loopback default + configurable trusted proxies |

## Graph A
```ts
user says go → open one plan per item → implement → gate → PR
```

## Memory
- linked from `decisions-lexa` (icm) entry of 2026-09-25
