# Plan: assistant-carousel-autoslide
created: 2026-09-29
state: PLAN

## X (problem)
User request (2026-09-29): in the approval carousel, after approving/rejecting ONE item, the carousel should slide to the next item — fewer clicks, natural through-the-batch flow. Current behavior (shipped PR #134/#135): the active card stays put after a decision; the user must press Next.

## Scope
- In:
  - design lane: pin the auto-advance behavior in `wireframes/src/herald-write-approvals.html` (visible annotations + a state/illustration): after a per-card Approve/Reject resolves, advance to the next still-pending card; if none remain, stay on the last card (all decided, no actions); batch Approve all / Reject all do NOT auto-advance; focus behavior on advance; reduced-motion (instant); a decision that ends terminal via error mapping (e.g. 409 self-heal) counts as decided and advances. Run `bash wireframes/build.sh`.
  - implementation lane (after design): `AssistantApprovals` advances to the next pending card once the active card's decision resolves terminal (success or terminal error mapping); clamp at ends; no advance for batch actions; keep the existing scroll-settle/focus mechanics; tests (advance on approve, advance on reject, last-pending stays, batch actions don't advance, error-terminal advances).
  - lane tests + gate.
- Out (explicit non-scope): budget/round caps; bulk tools; other approval UX; new diff types; commits.

## Graph A
```ts
design (wireframe annotation/state + build) → implementation (auto-advance) → tests → gate → report
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| design | wireframe already pins the opposite behavior | update the wireframe (this task is the change); note the old annotation changed |
| impl | deciding the active card reorders `ordered` and indices shift | derive the next index from the chip identity, not the old index; test it |
| impl | auto-advance fights focus/settle | only advance after the decision resolves; keep focus/settle rules from the wireframe |

## R
- evidence: `app/components/chat/AssistantApprovals.tsx` (goTo/active/settle), `assistant-chat-session.ts` `handleDecide`, `wireframes/src/herald-write-approvals.html`
- memory: recall at open · store on DONE (summary + plan/report paths)
- tests: `bun run test:fe`; gate via steward

## Lanes
- design: `wireframes/src/herald-write-approvals.html` (+ dist via build) — auto-advance semantics
- impl: `app/components/chat/AssistantApprovals.tsx` (+ tests) — advance after per-card decision

## Memory
- `icm_memory_store` on DONE: summary + paths to `status/assistant-carousel-autoslide/plan.md` and `report.md`
