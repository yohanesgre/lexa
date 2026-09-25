# Report: runtimes-team-id
created: 2026-09-25
sessions: ses_f2ba20257ffe5CIAQa1wy3Mk2v (main), ses_f28b66ffdffdKaRSd70CPrzYdb (architect), ses_f2875db38ffeektG8p4nJ2lEza (impl), ses_f286de695ffeAZ7sbenP2FNjPp (review), ses_f2861531affeMhieAFwExwl9tC + ses_f285f1eb3ffefAfMmdze4LXv8X (gate)
result: branch `omos/runtimes-team-id` @ b107f82 — Option A implemented (RESTRICT FK, service 409 guard, explicit PATCH reassign/detach); docs + tests.

## What changed

- **Migration `0007_runtimes_team_restrict.sql`:** rebuilds `runtimes` with `team_id TEXT REFERENCES organization(id) ON DELETE RESTRICT` (was SET NULL). D1-safe statement order, explicit backup/restore of `runtime_tasks.runtime_id` (the DROP's FK-ON implicit delete would NULL them), indexes recreated; no edit to `0001_init.sql`; explicit `CREATE TABLE` + `INSERT … SELECT` instead of CTAS.
- **`server/services/teams.service.ts`:** implicit `team_id` pre-clear removed; org DELETE hits the FK backstop; `ConstraintViolation` → re-count → `TeamHasRuntimes` 409 `{ teamId, count }`; count 0 → `DbError` (truthful payload for unrelated blockers).
- **Error:** `TEAM_HAS_RUNTIMES` in `errors.ts`, `docs/LAYERS.md` catalog, `docs/API.md` endpoint + global 409 table.
- **`PATCH /api/runtimes/:id`** accepts `teamId: string | null` (superadmin only when the field is present): reassign to an existing org (404 unknown) or detach (`null` = explicit global); repo setter with `RowNotFound`; docs updated.
- **Docs:** `docs/SCHEMA.md:632` RESTRICT + note; `docs/ARCHITECTURE.md` runtime-scoping rationale.
- **Tests:** migration chain asserts RESTRICT + raw `DELETE FROM organization` fails under FK ON + child FK stays SET NULL after rebuild; team-delete 409/runtime-intact → detach/reassign → 200; PATCH reassign/detach/unknown-runtime/unknown-team/member-403; claim-scope pin; `PATCH {}` regression.

## Tests

- Full suite `bun run test` → **201 files / 1798 tests passed**, 0 failed (a gate run flaked with 3 timeouts under load; clean rerun).
- `bun run test:be` → 129 files / 1359 tests passed; `bun x tsc --noEmit` exit 0; `check:invariants` green; secrets clean.
- Reviewer PASS after one PASS WITH CONCERNS round (catalog row, honest constraint mapping, CTAS removal, child-FK test, doc wording — all fixed and re-verified; the reviewer also retracted its stale `PATCH {}` note with base-commit evidence).

## Deviations

- `runtimes` has no `updated_at` column → the setter omits it (names exact).
- Superadmin gate applies only when `teamId` is present; other PATCH fields keep prior access.
- `PRAGMA foreign_key_check` omitted (not D1-batch-safe); correctness pinned by the FK-ON migration test.
- `PATCH {}` was already guarded on main; only a regression test was added.

## Concerns

- **Out of scope, tracked in the design note:** `runtime_events.team_id` (same SET NULL widening class at re-register), register defaults (global remains possible via explicit registration), claim-time `status` gating, any UI for the reassign/detach state.
- D1 safety verified by FK-ON simulation, not real workerd; the migration file follows the proven 0005 pattern.
- Full-suite timeouts recur under parallel load (twice this session); solo/fresh reruns are clean — environmental.
- PR merge pending user.
