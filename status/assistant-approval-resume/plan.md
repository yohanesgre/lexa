# Plan: assistant-approval-resume
created: 2026-09-29
state: PLAN

## X (problem)
Bug (user report 2026-09-29): after the assistant asks approval for a `create_task` call and the user approves, the run stops with no follow-up. Trace: `handleDecide` (`app/components/chat/assistant-chat-session.ts:96-109`) patches the chip and discards the server's returned `{batchId, remaining}`; the only resume trigger is the settle pass (`assistant-chat-session.ts:71-79`), which needs the frozen turn to carry `batch.chips` — `suspendTurnFrame` (`app/components/chat/assistant-chat-logic.ts:177-192`) stores chips only when `pendingChipsOf(stream.pending, batchId)` is non-empty, else a marker-only `suspendedBatchId` that `resumableBatchId` (`:212-220`) never returns. Server resume is a separate call (`server/services/assistant-chat.service.ts:326-368`); the decide endpoint only flips row status (`:315-325`). No test covers decide→resume.

## Scope
- In: confirm the fault with a failing test (live suspension: does the frozen turn carry chips; does `updateChip` actually mutate `turns`) — CONFIRMED 2026-09-29: client resume fires; the server dies executing `create_task`; fix the server-side crash (`server/assistant/write-execution.ts:63-65` uses `.get()` on the async DbDriver — switch to `.first()` per the driver API) with regression tests for both resume paths (chat `assistant-chat.service.ts` + task/wiki `assistant-task.service.ts`); keep the settle-pass resume as fallback; regression tests for live + reload paths and no double POST; lane tests + gate. Client-side decide-driven resume is now out (mechanism disproven — would be redundant).
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
