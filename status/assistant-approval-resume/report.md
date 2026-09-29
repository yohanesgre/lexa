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

## Follow-up (2026-09-29): non-wire `toolCalls` crashed the provider run

### Root cause
`@tanstack/ai` 0.61.0 `getPendingToolCallsFromMessages` treats **every**
assistant `message.toolCalls` array as real wire tool calls, then
`checkForPendingToolCalls` → `resolveExecutableTools` dereferences
`tc.function.name`. Lexa persisted the UI display log under that exact key
(`build-stream.ts:242`/`:497`, entries `{ name, detail? }`), so resume (and any
fresh send over a legacy thread) crashed with
`TypeError: undefined is not an object (evaluating 'tc.function.name')`.

### Docs decision
`docs/API.md` GET-transcript and `docs/LAYERS.md` approval-protocol document the
persisted assistant meta (`ts`, `citations`, `error`, `stopped`, `pendingBatch`)
but **never** `toolCalls`, and no reader in `app/`, `server/`, `shared/`, or
`cli/` consumes it. Renaming an undocumented, unread internal display field is
docs-safe, so both paths were taken:
1. **Rename** the persisted display log `toolCalls` → `toolLog` at both write
   sites (`build-stream.ts:242` suspend, `:497` fail path); the wire key can no
   longer be written by Lexa.
2. **Boundary sanitizer** (mandatory) for legacy threads and any malformed
   entry: `sanitizeProviderMessages` strips assistant `toolCalls` entries
   lacking `function.name` and drops the field when the whole array was the
   display log; wire-shaped entries and non-assistant messages pass through
   untouched (input never mutated).

Applied once at the single provider funnel, right after hydration and before
`gatewayStream`/`streamChat` (`build-stream.ts`: `hydrated` → `prepared`), so all
four services (chat send + resume, task/wiki send + resume) are covered.
`provider.ts` remains the only importer of `chat()`, so no other path reaches
the library. `node_modules` untouched.

### Tests
- `server/assistant/build-stream.test.ts` — 5 unit tests for
  `sanitizeProviderMessages` (legacy display log stripped; wire-shaped kept by
  identity; mixed array keeps only wire entries; non-assistant roles untouched;
  no-op returns input identity) + a provider-boundary test asserting a legacy
  `toolCalls` history entry is gone from the messages handed to `gatewayStream`
  + the suspend test now asserts the persisted display log is `toolLog` and the
  entry has no `toolCalls`.
- `server/services/assistant-chat.service.test.ts` — the approved `create_task`
  resume test seeds the realistic legacy shape
  (`toolCalls:[{name:"create_task",detail:"New task"}]` + `pendingBatch`),
  asserts no `ASSISTANT_GENERATION_FAILED` frame and that the assistant message
  handed to the provider has no `toolCalls`.
- `server/services/assistant-task.service.test.ts` — same seed/assertions on the
  task/wiki resume path.
- `server/services/assistant-resume.test.ts` — fixture display-log key aligned
  to `toolLog`.
- **Mock seam (explicit):** both service suites `vi.mock("../assistant/provider")`,
  so the real `chat()` never runs there; the hermetic guard is the sanitizer
  unit test plus the assertion on the exact `messages` handed to the stubbed
  `streamChat` (captured in `providerMock.calls`). Proven to catch the
  regression: with the sanitizer call removed, the chat resume test fails on
  `expect(assistantHanded.toolCalls).toBeUndefined()`.
- Point 4 (no re-execution): resume still executes only the resolved batch's
  approved rows via `executeAssistantWrite`; the sanitized history carries no
  `toolCallId`-bearing wire `toolCalls`, so the library finds zero pending calls
  and never re-runs the batch. Asserted by the existing "task row actually
  created" checks + the new no-error-frame checks.
- A real-`chat()` provider-boundary test was not added (optional) — the mock +
  unit-test seam above is the guard.

### Design gap (REPORT ONLY)
The resumed model run is **not** told the executed tool results. `approvalResults`
are SSE frames only (`build-stream.ts:247`); they are never injected as
`role:"tool"` messages, and `applyResumeResults` just drops the `pendingBatch`
marker. After sanitization the model resumes from a transcript whose suspended
assistant turn has no tool-call/tool-result pair, so it has no context that the
approved writes executed — it may acknowledge without knowing, or re-propose.
The library's own `role:"tool"` + `toolCallId` result-message path exists and
would be the place to carry them, but that is a separate design decision; no
change proposed here.

### Verification (exact)
- `./node_modules/.bin/tsc --noEmit` → exit 0, no output.
- `bun run test:be` → 142 files passed / 1710 tests passed (+6 new).
- `bun run test:fe` → 94 files passed / 637 tests passed.

### Deviations
- Renamed the persisted display key (step 3 authorized this as docs-safe); the
  sanitizer still covers legacy `toolCalls` threads, so both fixes coexist.
- No client change: `runChatStream` receives only the raw message string, so the
  persisted field rename is server-internal and invisible to clients.
- No commits; `check:invariants`/`verify-gate.sh` not run (not required without a
  commit ask).

## Deviations / notes
- Scope: fix landed in `server/assistant/write-execution.ts`, not the client
  resume trigger (client works as designed; plan Scope In amended for this).
- The plan's step-2 explicit client resume was not implemented: mechanism (a)/(b)
  disproven and the settle pass already resumes exactly once (dedupe via
  `resumedBatchesRef`), so a second trigger would be redundant.
- No commits; `check:invariants`/full `verify-gate.sh` not run (not required
  without a commit ask) — `tsc` + `test:be` + `test:fe` cover the change.
- Untouched pre-existing dirty state: `status/TIMELINE.md`, `wireframes` submodule pointer.

## Follow-up 2 (2026-09-29): decided chips re-armed → 409 `APPROVAL_ALREADY_DECIDED` bursts

### Symptom
After approving a chip batch the client re-armed the decided chips as `pending`
and re-sent identical decisions; live log showed bursts of
`409 APPROVAL_ALREADY_DECIDED` (06:17:34 → 06:17:38 → 06:18:00).

### Root causes (verified by background trace, session `ses_f142e49d4ffewgu0PhmAzwA4q3`)
1. **FE — transcript rebuild drops in-session decisions.**
   `settleTurns` (`app/components/chat/assistant-chat-turns-state.ts`) kept the
   optimistic `prev` only while some chip was `pending` or a `suspendedBatchId`
   existed. The moment the last chip turned terminal, the next settle pass
   returned `renderTranscript(messages)`; a persisted approval whose `status` was
   never reconciled maps back to `pending` (`chipFromPendingApproval`), so the
   decided chips became actionable again and clicks re-POSTed → 409.
2. **Server — reconciliation covered only the newest marker.**
   `reconcileChatApprovals` (`server/services/assistant-chat.service.ts`) called
   `findPendingBatch(messages)`, which returns only the newest marker, so older
   batch markers on refetch rebuilt as `pending`.

Chip gating, `handleDecide`/`handleApproveAll`, and the server 409 path were
correct and unchanged.

### Fixes
**A (FE, primary).** New pure helper `carryKnownDecisions(prev, turns)` overlays
KNOWN terminal chip decisions from `prev` onto a rebuilt transcript by
`approvalId` — only terminal states propagate; approvals still pending in `prev`
or absent from it keep the rebuilt state; chips not present in `prev` are
untouched. Input never mutated; identity returned when nothing carries.
`settleTurns` now computes
`const serverTurns = carryKnownDecisions(prev, renderTranscript(messages))`,
so a stale marker can never re-arm a chip decided in this session. The
`liveApproval` retention was not weakened.

**B (server, reinforcing).** New pure helper `findPendingBatches(messages)`
(all markers, oldest first, deduped). `reconcileChatApprovals` now iterates
`findPendingBatches`, loads `pendingWritesRepo.listByBatch` per batch, flattens
the decision rows, and applies them with the existing
`reconcilePendingBatchStatuses` — every marker gets its statuses, not just the
newest. Response shape/contract unchanged.

### Tests
- `app/components/chat/assistant-chat-turns-state.test.ts` (new, 4):
  `carryKnownDecisions` preserves terminal decisions and leaves unknown/new-batch
  approvals pending; returns input identity when `prev` has no terminal decision;
  `settleTurns` keeps an all-terminal batch terminal across a transcript rebuild
  (no re-arm).
- `server/services/assistant-chat.service.test.ts` (+1): two markers — older
  decided (`approved`), newer `pending` — `reconcileChatApprovals` applies both
  statuses.
- Existing suites unchanged and green.

### Verification (exact)
- `./node_modules/.bin/tsc --noEmit` → exit 0, no output.
- `bun run test:fe` → 95 files passed / 641 tests passed.
- `bun run test:be` → 142 files passed / 1711 tests passed.

### C (REPORT ONLY, backlog item 4)
The resumed model re-proposes writes because tool results are never injected
into the resumed transcript. No tool-result injection built here.
