# Plan: assistant-approval-resume
created: 2026-09-29
state: PLAN

## X (problem)
Bug (user report 2026-09-29): after the assistant asks approval for a `create_task` call and the user approves, the run stops with no follow-up. Trace: `handleDecide` (`app/components/chat/assistant-chat-session.ts:96-109`) patches the chip and discards the server's returned `{batchId, remaining}`; the only resume trigger is the settle pass (`assistant-chat-session.ts:71-79`), which needs the frozen turn to carry `batch.chips` — `suspendTurnFrame` (`app/components/chat/assistant-chat-logic.ts:177-192`) stores chips only when `pendingChipsOf(stream.pending, batchId)` is non-empty, else a marker-only `suspendedBatchId` that `resumableBatchId` (`:212-220`) never returns. Server resume is a separate call (`server/services/assistant-chat.service.ts:326-368`); the decide endpoint only flips row status (`:315-325`). No test covers decide→resume.

Follow-up (2026-09-29, same flow after the write-execution fix): writes now execute, but the resumed model run crashes inside `@tanstack/ai` 0.61.0 — `TypeError: undefined is not an object (evaluating 'tc.function.name')` at `activities/chat/index.js:841` (`checkForPendingToolCalls`), because the persisted assistant turn stores the UI display log under the library's wire key `toolCalls` (`server/assistant/build-stream.ts:242`, `:497`) and resume replays it as real tool calls (`getPendingToolCallsFromMessages`). Fresh sends over the same history can crash the same way.

## Scope
- In: confirm the fault with a failing test (live suspension: does the frozen turn carry chips; does `updateChip` actually mutate `turns`) — CONFIRMED 2026-09-29: client resume fires; the server dies executing `create_task`; fix the server-side crash (`server/assistant/write-execution.ts:63-65` uses `.get()` on the async DbDriver — switch to `.first()` per the driver API) with regression tests for both resume paths (chat `assistant-chat.service.ts` + task/wiki `assistant-task.service.ts`); keep the settle-pass resume as fallback; regression tests for live + reload paths and no double POST; lane tests + gate. Client-side decide-driven resume is now out (mechanism disproven — would be redundant). FOLLOW-UP 2 (2026-09-29): duplicate decide / 409 re-arm — (A) carry known terminal chip decisions when `settleTurns` rebuilds turns from the transcript (`app/components/chat/assistant-chat-turns-state.ts:19-22` drops the decided batch the moment its last chip turns terminal; rebuilt chips map back to `pending` via `chipFromPendingApproval`), so a decided chip can never become actionable again from a stale marker; (B) reconcile ALL `pendingBatch` markers on GET, not just the newest (`server/services/assistant-chat.service.ts:199-201` → `findPendingBatch` returns only the latest); regression tests for both. FOLLOW-UP (2026-09-29): sanitize non-wire `toolCalls` before the provider call on ALL paths (resume + normal send, legacy threads included) so the UI display log can never reach `@tanstack/ai` as real tool calls; align the persisted/display field with docs authority (`docs/API.md` thread-message shape) — rename only if docs permit, otherwise keep the API shape and always sanitize at the boundary; regression tests seeding the realistic suspend shape (`toolCalls: [{name, detail}]` + `pendingBatch`) plus a legacy-history normal-send case.
- Out (explicit non-scope): new endpoints/error codes/DB changes; server-side auto-resume on decide (client-driven resume remains the contract); wireframe edits; attachments; unrelated refactors; commits (not asked).

## Graph A
```ts
confirm fault (failing test) → fix chip capture if needed → explicit decide-driven resume (dedupe) → FE tests (live + reload + single POST) → tsc + test:fe + test:be green → report
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| confirm | mechanism differs (resume fires but server drops/errors it) | stop, report mechanism with evidence, re-brief before fixing |
| fix | needs a server contract change beyond existing resume | stop and report; no endpoint/contract change without user |
| tests | double-resume risk (decide trigger + settle pass) | assert exactly one POST per batch |

## R
- evidence: researcher session `ses_f14542092ffe0y58FfAZS8ZdYg`; prior context `status/assistant-chat-fixes/report.md`
- memory: `icm_memory_recall` at open · `icm_memory_store` on DONE (summary + plan/report paths)
- tests: lane-scoped `bun run test:fe` / `test:be`; gate via steward before any commit ask

## Memory
- `icm_memory_store` on DONE: summary + paths to `status/assistant-approval-resume/plan.md` and `report.md`
