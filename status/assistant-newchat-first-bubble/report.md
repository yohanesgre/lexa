# Report: assistant-newchat-first-bubble

state: DONE
ts: 1790664901

## Problem
New chat from an open thread → first message: the prompt never renders as a user
bubble (assistant reply streams, user turn missing until reload).

## Mechanism — CONFIRMED (test-first, reproduced)
Client-only. Two compounding bugs:

1. `useSettledTurns` (`app/components/chat/assistant-chat-session.ts:254-260`):
   the `transcriptError` branch returned `[]` for ANY transcript error, dropping
   the optimistic ephemeral user turn appended by `send`
   (`AssistantChatPage.tsx:262`). A fresh UUID 404s (`ASSISTANT_THREAD_NOT_FOUND`)
   until the first write, so the turn was cleared on the next derived render.
   Reproduction detail beyond the dispatch note: the drop happens AT `connecting`
   (before any ingress) — `startStream` calls `stream.send`, which flips status to
   `connecting` synchronously, and `hasIngress` is still false. A pure `hasIngress`
   guard would not have fixed it.

2. `useTerminalRefetch` (`assistant-chat-session.ts:282-293`): at terminal status
   it treated `ASSISTANT_THREAD_NOT_FOUND` as a dead thread and
   `cancelQueries` + `removeQueries` the transcript. After the first successful
   send the thread EXISTS, so the persisted user turn was never fetched (the
   stale 404 query was dropped, not refetched). The prompt only reappeared on
   reload.

No server bug found — the server was never asked for the transcript once the
query was removed.

## Fix (client-only)
- `useSettledTurns` error branch: keep `prev` when `stream.hasIngress || streaming`
  (connecting/streaming or any ingress), with the `chatChanged ? null : prev`
  guard so a thread switch cannot leak the previous thread's turns. `[]` only for
  a genuinely dead thread (404, no stream activity, no ingress). Preserves the old
  `status === "error" && hasIngress` keep-prev behavior.
- Extracted pure helper `terminalTranscriptAction(code, hasIngress)`
  (`assistant-chat-logic.ts:269-279`): `"drop"` for not-found + no ingress;
  `"refetch"` otherwise.
- `useTerminalRefetch`: `drop` → cancel+remove (dead thread, unchanged);
  not-found + ingress → `invalidateQueries` once per chat (one-shot `refetchedRef`
  guard against an invalidate/error/invalidate loop); every other terminal path →
  `invalidateQueries` as before. Added `stream.hasIngress` to deps.
- `send`'s optimistic append unchanged.

## Tests
`app/components/chat/assistant-chat-session.test.tsx` (+4 tests, all red before the
fix):
- `useSettledTurns — fresh thread 404 keeps the optimistic user turn`: survives
  connecting, streaming and terminal while the transcript 404s; clears for a
  genuinely dead thread (404, no ingress).
- `useTerminalRefetch — fresh-thread 404 recovery`: 404 + ingress refetches and
  loads the persisted transcript; 404 + no ingress removes the query.
- `fresh thread — first send stays visible end to end`: composed
  `useQuery` + `useSettledTurns` + `useTerminalRefetch` harness — user bubble
  visible through connecting/streaming/terminal, no duplicate after the
  terminal refetch replaces the stale 404.
- `terminalTranscriptAction`: drop vs refetch decision table.

Verified red before the fix (2 hook assertions failed), green after.

## Verification
```
./node_modules/.bin/tsc --noEmit      → exit 0, 0 errors
bun run test:fe                       → Test Files 95 passed (95); Tests 649 passed (649)
```

## Deviations / concerns
- The fix uses `hasIngress || streaming` (not `hasIngress` alone) because the
  drop occurs at `connecting`. Documented above.
- `drop` at terminal for a pre-ingress failed send still drops the optimistic user
  turn (existing behavior, out of scope: no ingress means the thread never
  existed; also no assistant error bubble is frozen pre-ingress).
- No commits (not asked). `status/TIMELINE.md` and the `wireframes` submodule
  pointer were already dirty before this task — untouched by me.
