# Report: assistant-approval-resume

state: DONE (mechanism (c) confirmed; server fix applied; regression tests green)

## Summary
The user's bug — approving a `create_task` chip stopped the run with no follow-up —
was NOT a client resume-trigger fault. The client resume fires correctly; the
server resume stream died executing the approved `create_task` write because
`executeAssistantWrite` called the raw bun:sqlite synchronous `.get()` on the
async `DbDriver` (which exposes `.first()`). The `TypeError` became an Effect
`Die`, which `Effect.either` does not catch, so `resumeChatStream` /
`resumeThreadStream` aborted before streaming the follow-up. Fixed by using the
driver's async `first()`.

## Confirmed mechanism (c): resume fires, server dies
Client side is working as designed (verified with temp harnesses using the real
`useAssistantStream` + full `AssistantChatPage` wiring, since deleted):
- live suspension freezes a turn WITH chips (`pendingChipsOf(stream.pending, batchId)`
  non-empty; `tool_pending` frames precede `suspended`, which does not clear
  `pending`) → plan hypothesis (a) disproven;
- `updateChip` mutates `turns` and the settle pass POSTs `/resume` exactly once
  after the last chip is approved → (b) disproven.

Server side (reproduced): seed thread + approved `create_task` batch, then
`resumeChatStream` →

```
DECIDED: {"approvalId":"ap1","batchId":"b1","status":"approved","remaining":0}
(FiberFailure) TypeError: ctx.db.prepare(...).get is not a function
  at server/assistant/write-execution.ts:65:13
  _tag: 'Die'
```

Positive control (`update_task`) resumed fine (`['start','approval_result','delta','done']`),
bounding the blast radius to `create_task` — it was the only `.get(` misuse in
`server/assistant/**` (verified by grep; `move_swimlane` uses `.prepare().run()`
on the async driver and is correct).

## Fix (minimal, `server/assistant/write-execution.ts:63`)
```ts
const first = yield* Effect.promise(() =>
  ctx.db.prepare(`SELECT id FROM columns WHERE project_id = ? ORDER BY position ASC LIMIT 1`).first<{ id: string }>(row.project_id)
);
if (!first) return yield* new InvalidArgs({ reason: "project has no columns" });
```
Query and types are unchanged; only the driver access changed from the
synchronous `.get()` to the async `DbStmt.first()` (matches the existing
`Effect.promise(() => ctx.db.prepare(...).run(...))` pattern at line 167).
No contract/endpoint/schema change; client resume triggering untouched.

## Tests
- `server/services/assistant-chat.service.test.ts` → new "applies an approved
  create_task and streams the follow-up (no Die)": seeds thread + approved/pending
  `create_task` row, `decideApproval` (remaining 0), `resumeChatStream`; asserts
  `approval_result` status `applied`, a follow-up `done` frame, and the task row
  actually created.
- `server/services/assistant-task.service.test.ts` → same coverage on the
  task/wiki path via `resumeThreadStream("task","t1")`.
- Both tests were proven to catch the regression: with the old `.get()` code
  re-applied they fail with `(FiberFailure) TypeError: ctx.db.prepare(...).get is not a function`.
- Existing resume tests used `no_such_write_tool`, which is why the bug slipped.

## Verification (exact)
- `./node_modules/.bin/tsc --noEmit` → exit 0, no output.
- `bun run test:be` → 142 files passed / 1704 tests passed (+2 new).
- `bun run test:fe` → 94 files passed / 637 tests passed.

## Deviations / notes
- Scope: fix landed in `server/assistant/write-execution.ts`, not the client
  resume trigger (client works as designed; plan Scope In amended for this).
- The plan's step-2 explicit client resume was not implemented: mechanism (a)/(b)
  disproven and the settle pass already resumes exactly once (dedupe via
  `resumedBatchesRef`), so a second trigger would be redundant.
- No commits; `check:invariants`/full `verify-gate.sh` not run (not required
  without a commit ask) — `tsc` + `test:be` + `test:fe` cover the change.
- Untouched pre-existing dirty state: `status/TIMELINE.md`, `wireframes` submodule pointer.
