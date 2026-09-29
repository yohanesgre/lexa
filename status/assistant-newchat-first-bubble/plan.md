# Plan: assistant-newchat-first-bubble
created: 2026-09-29
state: PLAN

## X (problem)
Bug (user report 2026-09-29): creating a new chat from an open thread, then sending the first message — the prompt never appears in a user chat bubble (assistant streams, user turn missing until reload). Code-backed mechanism:
1. `useSettledTurns` 404 branch (`app/components/chat/assistant-chat-session.ts:255-258`) returns `[]` whenever the transcript query errors — dropping the optimistic ephemeral user turn, because a fresh UUID 404s until the first write.
2. `useTerminalRefetch` (`:282-293`) treats `ASSISTANT_THREAD_NOT_FOUND` at terminal as a dead thread and removes the query instead of refetching — after a first successful send the thread EXISTS, so the persisted user turn is never fetched.
Net: the bubble only reappears on reload.

## Scope
- In: reproduce with a failing test (page-level New chat → send → bubble visible during streaming and after terminal; or hook-level); fix (a) settle keeps ephemeral turns while `stream.hasIngress` even when the transcript 404s; (b) terminal refetch refetches/invalidates the transcript when the not-found error predates ingress and `stream.hasIngress` is true, keeping remove/drop behavior for genuinely dead threads (no ingress), loop-safe (one-shot guard); regression tests; lane tests + gate.
- Out (explicit non-scope): server changes (if the mechanism disproves and needs one → stop and report); wireframe edits; the architecture viz; unrelated refactors; commits (not asked).

## Graph A
```ts
failing test (repro) → settle/refetch fix → tests green → gate → report
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| repro | mechanism differs (e.g. server drops the user turn) | stop, report mechanism with evidence |
| fix | needs a server change | stop, report; no contract change without user |
| tests | session hook hard to mount | extract the pure decision helper; test that + a page harness with the real stream store |

## R
- evidence: session reads 2026-09-29 (`assistant-chat-session.ts:242-293`, `AssistantChatPage.tsx:125-166,250-266`, `assistant-chat-logic.ts:87,265-313`)
- memory: `icm_memory_recall` at open · `icm_memory_store` on DONE (summary + plan/report paths)
- tests: `bun run test:fe`; gate via steward

## Memory
- `icm_memory_store` on DONE: summary + paths to `status/assistant-newchat-first-bubble/plan.md` and `report.md`
