# Plan: assistant-chat-fixes
created: 2026-09-29
state: PLAN

## X (problem)
Adversarial review of the assistant chat frontend (chat page + support layer; popover panel) found broken flows and unmergeable defects: thread selection/deep-links never resolve, reload mid-approval deadlocks a thread, image attachments are a silent no-op, the panel loses its run on close and has no focus management. Jev scored the surfaces 2.48–3.27/4; reviewer verdicts REQUEST CHANGES / needs-fixes. Review sessions: `ses_f14c1f801ffe6sVWTdf6p46It6` (chat+support), `ses_f14c1f800ffeScnq0VF6gkLJCg` (panel).

## Scope
- In: all severities from both reviews —
  - a-core: chatId resolution effect (`?thread` > `lexa-chat-last` > list head), `selectThread` immediate switch, approval batch reconnect after reload (render persisted chips; remove marker-only composer deadlock), attachments end-to-end via an EXISTING documented upload path, retry `fromIndex: -1` guard, per-thread turn/freeze reset (`syncKey` + chatId), IME `isComposing` guard (composer + mention), composer `aria-label` + busy-409 placeholder copy, dead imports.
  - b-ui: live regions on streaming/transcript, jump-button focusability, delete-dialog focus trap/Escape/restore + missing copy sentence, chip approve/reject `aria-label`s, duplicate meta line, usage line (live done-frame only, if stream data already local), `phosphor.css` `.bubble-actions` hover/focus-within rule.
  - c-panel: run reattach after close (per-document persisted taskId; no re-POST for terminal sessions), dialog role + focus management (trap/restore), trigger outside-dismiss fix, live regions, SkillPicker semantics/keyboard, draft+skill persistence across close, selection/docImages computed at click, object-URL revoke, settings error state, applied/rejected labels, empty Tools heading, nits, panel behavioral tests.
- Out (explicit non-scope): no wireframe edits (code aligns to existing wireframes; a missing state stops the item and reports); no new endpoints/tables/error codes without reporting; no cross-lane file edits (a-core owns `app/lib/use-assistant-stream.ts`; c-panel reports instead); no commits/pushes (not asked); no gate/CI config changes; no unrelated refactors; `.tmp/` bundles untouched; `status/TIMELINE.md` user edits preserved (append only).

## Graph A (happy path)
```ts
a-core + b-ui + c-panel (parallel, disjoint files) → lane tests + tsc green → steward final gate (bash scripts/verify-gate.sh) → reviewer re-review of changed files → report.md → DONE
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| a-core | no documented upload path for attachments | implement rest; mark the item BLOCKED in lane report; no invented endpoint |
| b-ui | needs a prop/state only a-core owns | report instead of editing the other lane's file |
| c-panel | needs `app/lib/use-assistant-stream.ts` change | report instead; a-core resolves after the wave |
| any lane | UI state absent from wireframes | stop that item, report; do not invent |
| verify | gate red | lane owner fixes; re-run; no DONE |

## R
- memory: `icm_wake_up` + `icm_memory_recall` at open · `icm_memory_store` on DONE (summary + plan.md/report.md paths)
- tests: lane-scoped `bun run test:fe` / `test:be`; final `bash scripts/verify-gate.sh` via steward
- reviewer re-review of changed files after fixes; evidence before assertions

## Lanes
- a-core: `app/routes/$slug/chat.tsx`, `app/components/chat/{AssistantChatPage,assistant-chat-logic,assistant-chat-session,assistant-chat-utils,assistant-chat-turns-state,AssistantChatComposer}.ts(x)`, `app/lib/use-assistant-stream.ts`, `app/lib/useMentionTokens.ts`, `server/assistant/**` + `shared/assistant.ts` only as needed (no new endpoints) — chat correctness
- b-ui: `app/components/chat/{AssistantChatTurns,AssistantChatShell,AssistantActivity,AssistantBubble,AssistantApprovalChipRow,ThreadsSidebar}.tsx`, `app/styles/phosphor.css` — chat UI a11y/copy/nits
- c-panel: `app/components/assistant/panel/**`, `app/lib/use-assistant-panel.ts`, `app/components/TextEditor.tsx` — panel fixes

## Memory
- `icm_memory_store` on DONE: summary + paths to `status/assistant-chat-fixes/plan.md` and `report.md`
