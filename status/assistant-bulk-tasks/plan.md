# Plan: assistant-bulk-tasks
created: 2026-09-29
state: PLAN

## X (problem)
User report: "can you remove all tasks?" (52 tasks) → the assistant proposes one `archive_task` per task → `ASSISTANT_TOOL_BUDGET_EXCEEDED — Assistant exceeded its tool budget (24 rounds)`. The tools only accept a single `ref` (`server/assistant/write-tools.ts:476-495` archive/restore factory; `:682` delete_task), so a bulk operation explodes the round budget.
User directive: do NOT change the tool budget/round caps — expand the tools themselves to handle archive/delete in bulk.

## Scope
- In: extend `archive_task`, `restore_task` (shared factory) and `delete_task` to accept `refs: string[]` as an alternative to `ref` (1..100 per call; legacy `{ref}` shape still supported end-to-end, including pending rows already persisted); all-or-nothing at proposal time (unknown refs → `proposed:false` naming them); executor applies per item, aggregates applied/failed (partial success allowed, zero-applied → error); existing diff types reused with a compact summary target (`"52 tasks"`); resume-note `targetOf` summarizes bulk; tool descriptions nudge bulk usage (one call for many tasks); docs (`docs/LAYERS.md` write-tool entries + `docs/API.md` if args are enumerated) updated; tests for propose/execute/partial/invalid/cap + legacy shape + resume note; lane tests + gate.
- Out (explicit non-scope): MAX_CHAT_TOOL_ROUNDS / MAX_TOOL_ROUNDS changes; new tool names; new diff types or UI components (chip structure unchanged — summary text only); wireframe edits; approval-flow changes; commits.

## Graph A
```ts
extend schemas + propose → extend executor (bulk, partial, legacy) → resume-note summary → docs → tests → gate → report
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| propose | partial-resolve semantics unclear | all-or-nothing at proposal; report the exact unknown refs |
| executor | delete partial failure semantics differ from archive | keep per-item semantics; aggregate honestly |
| UI | summary text needs a new diff kind | stop and report; reuse existing diff with summary strings |
| budget | tempted to raise the cap | forbidden by user directive; tool-level item cap only |

## R
- evidence: live error `ASSISTANT_TOOL_BUDGET_EXCEEDED`; `write-tools.ts:476-495,:682`; `write-execution.ts:114,:170`; `tools.ts:25-26`; `resume-results.ts`
- memory: recall at open · store on DONE (summary + plan/report paths)
- tests: `bun run test:be`, `bun run test:fe`; gate via steward

## Memory
- `icm_memory_store` on DONE: summary + paths to `status/assistant-bulk-tasks/plan.md` and `report.md`
