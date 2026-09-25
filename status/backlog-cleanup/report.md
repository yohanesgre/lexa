# Report: backlog-cleanup
created: 2026-09-25
sessions: ses_f2ba20257ffe5CIAQa1wy3Mk2v (main), ses_f29205cf8ffeSprTkjZmu4UGbs + ses_f291b5c13ffeDfhldbs0xfWj4x (code), ses_f29205cf7ffeNTAEfwwV0AvREh + ses_f291b5c09ffe7mLnOvLc6XyJMm (docs), ses_f291e70a9ffe6RP2CeQP4ZQoSA (review), ses_f2917d0abffeVxIJ30GZ0eAC6W (gate)
result: branch `fix/backlog-cleanup` (from origin/main eb4ce70) — approved cleanup + doc fixes; gate green; PR pending in this commit flow.

## What changed

- **`searchByTitle` duplicate/collapsed results (real bug):** `TASK_FROM` fans out on `LEFT JOIN task_assignees`, and the missing `GROUP BY t.id` made the query a single-group aggregate — it returned ONE row for all matches with assignee names merged across tasks. Added `GROUP BY t.id`; regression test seeds two matching tasks and fails without the clause (proven by temporarily removing it).
- **`buildTaskDeleteBatch`:** removed the inert `activity` input and its caller construction; comment now states the DELETE-only batch + `task_activity` cascade + transaction atomicity.
- **`shared/diff`:** O(n) common prefix/suffix trim before the `CELL_BUDGET` check; exact LCS on the trimmed middle with offset-adjusted hunk starts; coarse fallback only for genuinely pathological middles. Large doc + one-line edit now reports `+1/−1`, not whole-doc.
- **Docs:** `docs/SCHEMA.md` WIP snippet gains `AND archived_at IS NULL` + normative note; `AGENTS.md` invariant #7 scoped (task/wiki payloads TipTap JSON; runtime/assistant output may carry Markdown; shared pure converter importable) and invariant #12 gains the task-delete carve-out (cascade).
- **Backlog record:** `status/deferred-backlog/` holds the deferred follow-ups and open decisions; not actioned here by design.

## Tests

- `bash scripts/verify-gate.sh` → exit 0: `tsc --noEmit` passed; vitest **186 files / 1687 tests passed**; `check:invariants` green; secrets/dist clean.
- Targeted cleanup run: 4 files / 64 tests passed.
- Review: PASS after one review round (round 1 found the non-discriminating test, coarse-diff misreport, stale comment, over-broad invariant, and one missing branch — all fixed and re-verified).

## Deviations

- None.

## Concerns

- Diff trim relies on the equal-affix property of optimal LCS (covered by existing + new tests).
- PR merge is not authorized in this envelope — merge pending user.
