# Report: assistant-bulk-tasks

state: DONE
ts: 1790674500

## Scope
Extend `archive_task`, `restore_task`, `delete_task` to accept bulk `refs`
(1..100) alongside the legacy single `ref`, so a large operation is one
proposal/one approval instead of one per task. No budget/round-cap changes.
No new tool names, no new diff types.

## Files
- `server/assistant/write-tools.ts` — `MAX_BULK_TASK_REFS=100`; shared
  `taskRefsSchema` (`ref` or `refs`, at least one — refine message is the
  validation error); `bulkRefSummary`/`bulkTitleSummary` helpers; in-factory
  `resolveTaskRefs` (all-or-nothing, names unknown refs); archive/restore
  factory + `delete_task` rewritten to accept both shapes. Single-task
  (`ref`, or a one-element `refs`) keeps the legacy diff/detail byte-identical.
  Bulk diff reuses the existing type with `taskRef: "<n> tasks"`,
  `taskTitle: first up-to-3 keys (+ "…" only when truncated)`; detail
  `Archive 52 tasks` / `Restore 52 tasks` / `Delete 52 tasks`. Descriptions
  nudge `refs`.
- `server/assistant/write-execution.ts` — `taskRefsFromArgs` (accepts persisted
  legacy `{ref}` and bulk `{refs}`); `runBulkTaskOp` runs the per-item op,
  catches per item (delete keeps the subtask guard), aggregates
  `{ applied, failed }`, allows partial success, fails the whole write when
  zero applied. archive/restore/delete dispatch: `refs.length <= 1` keeps the
  original single-item path.
- `server/assistant/resume-results.ts` — `targetOf` returns `"<n> tasks"` for
  a non-empty `refs` list before the legacy identifier scan.
- `docs/LAYERS.md` — write-tools paragraph now documents `refs`
  (1..`MAX_BULK_TASK_REFS=100`), all-or-nothing propose, per-item executor
  aggregation, and the summary-string diff reuse. `docs/API.md` does not
  enumerate these tools' args (only `writeToolsCount`), so unchanged.

## Tests
- `server/assistant/write-tools.test.ts` — bulk propose (archive/delete/restore
  summary diff + detail + recorded args), unknown ref named
  (`task 'NIM-404' not found`; multi → `tasks not found: 'X-1', 'Y-2'`),
  `>100`/empty/missing ref rejected at the schema, single `ref` and
  one-element `refs` byte-identical; executor: bulk archive all applied,
  bulk delete partial failure aggregated honestly, zero applied → error,
  legacy `{ref}` row still executes.
- `server/assistant/resume-results.test.ts` (new) — `targetOf` bulk summary,
  legacy ref, invalid args; executed-writes note renders
  `- archive_task "52 tasks": applied`.

## Gate
- `./node_modules/.bin/tsc --noEmit` → no output (pass).
- `bun run test:be` → Test Files 144 passed, Tests 1747 passed.
- `bun run test:fe` → Test Files 98 passed, Tests 680 passed.

## Deviations / design note
- Chip target copy is summary text inside the existing diff type — no UI or
  wireframe change. `targetFor(diff)` returns `diff.taskRef`, which for bulk is
  `"52 tasks"`; `taskTitle` is the first up-to-3 keys. `task_restore` bulk sets
  `toColumn` to the first task's column (the current UI does not render it).
- `bulkTitleSummary` appends `…` only when more than 3 tasks — an exactly-2/3
  list is shown whole so the ellipsis never implies missing rows.
- Partial failures are carried in the executor's `{ applied, failed }` result;
  the resumed approval result/note is per-approval (`applied`) since partial
  success is a success of the approval. No schema change to resume results.
- No commits. `MAX_CHAT_TOOL_ROUNDS`/`MAX_TOOL_ROUNDS` untouched.

## Wave 2 — reviewer findings

Supersedes the last two Deviations bullets above (partial-result handling).

- **Partial bulk failure surfaced (MED).** `runBulkTaskOp`
  (`write-execution.ts`) tags a batch with `partial: true` when ≥1 item failed
  (shape stays `{ applied, failed }`, so the all-applied equality assertions
  still hold). `collectResumeResults` derives `partial: { applied, failed,
  errors? }` (deduped error strings) via `partialOfResult` and carries it onto
  the `ResumeResult` and the note line. `buildResumeResultsNote` now renders
  `- delete_task "10 tasks": applied (9 of 10 failed: TASK_HAS_CHILDREN: …)`
  (first 3 distinct errors, then `…`); a fully-applied bulk line stays bare.
  `approval_result` frame payload carries the optional `partial` field.
  Types additive: `ApprovalPartial` added to `shared/assistant.ts`.
- **Duplicate refs deduped (MED).** `taskRefListOf` (`write-tools.ts`) and
  `taskRefsFromArgs` (`write-execution.ts`) now trim + dedupe in first-seen
  order; `targetOf` counts unique refs. A repeated ref no longer inflates the
  summary or runs twice (spurious `TASK_NOT_FOUND` on double delete).
- **`ref` + `refs` exactly-one (NIT).** `taskRefsSchema` refine changed to XOR
  with message `provide exactly one of 'ref' or 'refs'`; both-present fails
  validation, no proposal. Provider-visible union shape not adopted
  (`anyOf` tool-param risk); the XOR refine is the clear error.
- **Stale comment (NIT).** `write-tools.ts` header comment reworded: a bulk
  call occupies one proposal slot (`MAX_WRITES_PER_TURN`), it avoids only the
  per-task proposal cost.

Tests added: `write-tools.test.ts` (XOR reject; dedupe → one summary/proposal;
executor dedupe → each task once; executor `partial: true`),
`resume-results.test.ts` (partial note line `applied (9 of 10 failed: …)`,
bare line when fully applied), `build-stream.test.ts` (frame carries
`partial`).

Gate (wave 2):
- `./node_modules/.bin/tsc --noEmit` → no output (pass).
- `bun run test:be` → Test Files 144 passed, Tests 1753 passed.
- `bun run test:fe` → Test Files 98 passed, Tests 680 passed.

No commits.

