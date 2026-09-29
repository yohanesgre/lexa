# Plan: assistant-approval-loop-rejectall
created: 2026-09-29
state: PLAN

## X (problem)
Two issues in the task-write approval flow (user report 2026-09-29):
1. Themodel re-proposes the same `create_task` batch after each resume — a loop. Jev: yes 0.83 that the missing executed-write record in the resumed context is the primary cause (the assistant's tool calls are display-only `toolLog`, sanitized away before the provider; `approvalResults` are SSE frames only, never history).
2. There is no batch-level "Reject all" — wireframes and code only have "Approve all" (`wireframes/src/herald-write-approvals.html:103,:640`; `AssistantApprovals.tsx:61-65`).
3. Approval chips do not survive navigation (user report 2026-09-29): leaving the chat and returning re-renders the cached transcript, whose marker still shows pending chips even though decisions are recorded; approving then 409s `APPROVAL_ALREADY_DECIDED`. The transcript query is `staleTime: Infinity` with no refetch on mount, so the GET reconciliation never runs when the page remounts.
4. Approval chips render as a vertical list — long batches consume vertical space (user request 2026-09-29). Replace with a horizontal carousel (wireframe-first, then React).

## Scope
- In:
  - loop lane (server): tell the resumed model what was executed — build a compact summary of executed write results and pass it into the resumed provider call WITHOUT persisting a user-visible turn; tests assert the provider messages carry the summary and the persisted transcript is unchanged.
  - design lane: add "Reject all" to the batch header in `wireframes/src/herald-write-approvals.html` (both batch states) + update the BATCH GROUPING annotation (:590), run `bash wireframes/build.sh`.
  - reject-all UI (wave 2, after design): `useApprovalDecisions.handleRejectAll` mirroring approve-all with `reject`, button in `AssistantApprovals.tsx`, tests.
  - persist lane (client): make the transcript refetch on mount (`refetchOnMount: "always"` or equivalent) so GET reconciliation backfills decided approvals and a stale cached marker cannot render pending chips; regression test (cached pending marker + reconciled server response → chips terminal, no 409 path).
  - carousel lane: wireframe the approval batch as a horizontal carousel (design first + `bash wireframes/build.sh`), then implement in React (AssistantApprovals and related components; port any new wireframe classes into `app/styles/phosphor.css`); tests.
  - lane tests + gate.
- Out (explicit non-scope): wire-shaped tool-call/result protocol (jev second at 0.29 — deferred), server duplicate-write dedupe guard (0.19 — deferred), attachments, the architecture viz, wireframe or submodule commits (no ask), unrelated refactors.

## Graph A
```ts
wave 1: design (wireframe) ∥ loop (server) → wave 2: reject-all UI (needs design) → tsc + lane tests → gate → report
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| design | wireframe needs a state not drawn (e.g. mixed batch) | designer stops, reports; no invention |
| loop | fix requires persisting a visible synthetic turn | stop and report; ephemeral-for-resume only |
| wave 2 | wireframe not built/passed | do not implement; wait for design lane |
| gate | red | lane owner fixes; re-run |

## R
- evidence: jev_ask 2026-09-29 (loop_cause 0.83; best_fix synthetic-summary 0.51); `assistant-chat.service.ts:326-368`; `build-stream.ts:247,280`; wireframe `herald-write-approvals.html:103,590,640`
- memory: recall at open · store on DONE (summary + plan/report paths)
- tests: `bun run test:be` (loop) / `bun run test:fe` (UI); gate via steward

## Lanes
- design: `wireframes/src/herald-write-approvals.html` (+ `wireframes/dist` via build) — Reject all batch action
- loop: `server/assistant/build-stream.ts`, `server/services/assistant-chat.service.ts` (+ tests), `shared/assistant.ts` if needed — executed-writes summary for the resumed model call
- persist: `app/components/chat/AssistantChatPage.tsx` (+ test) — transcript refetch on mount so navigation cannot resurrect pending chips
- carousel: `wireframes/src/herald-write-approvals.html` (design) then `app/components/chat/AssistantApprovals.tsx`, `AssistantApprovalChipRow.tsx`, related chat components + `app/styles/phosphor.css` (implementation) — horizontal approval carousel

## Memory
- `icm_memory_store` on DONE: summary + paths to `status/assistant-approval-loop-rejectall/plan.md` and `report.md`
