# Report: assistant-carousel-autoslide — impl lane

state: DONE
ts: 1790677078

## Scope
Client-only auto-advance for the Assistant write-approval carousel. Design source of truth: `wireframes/src/herald-write-approvals.html` State 3b ("Auto-advance — a decided card hands off to the next pending card", lines 757–922) + updated State 1 annotations (lines 239–240). No commits.

## Behavior pinned
- **Trigger** — a per-card Reject / Approve on the ACTIVE card arms a single advance keyed by that card's `approvalId`. The arm is consumed when that chip leaves `pending` (success → approved/rejected, or a terminal error mapping → expired/approved/rejected): `EXPIRED`/`NOT_FOUND` → expired, `ALREADY_DECIDED` → approved/rejected/expired.
- **Non-terminal error** (toast path, chip stays pending) → no advance. The decision promise resolving without a state change marks the arm resolved, and the next chips change disarms it — a later unrelated flip cannot fire the stale arm.
- **Batch actions excluded** — `Approve all` / `Reject all` clear the arm and never arm it; they call the same `handleDecide`, so the exclusion is enforced at the batch buttons, not by chip-state alone.
- **Target** — computed from chip IDENTITY (never the pre-decision index): scan seq-ordered chips forward from the decided chip for the first `pending`; if none after it, wrap to the earliest pending; zero pending chips → no movement (stay on the card just decided).
- **Focus & motion** — advance reuses `goTo`: focus lands on the new active card's first enabled Approve button (else the card wrapper), `preventScroll`, and `prefers-reduced-motion` makes it an instant jump. Existing scroll-settle/clamp/keyboard behavior untouched.

## Files
- `app/components/chat/AssistantApprovals.tsx` — `armRef` (`{id, resolved}`) + `orderedRef`; settle `useEffect([chips])`; `handleCardDecide` wrapper (arms only when the pressed chip is the active card, tracks the onDecide promise); `ApprovalChipRow onDecide={handleCardDecide}`; batch button onClick clears the arm. No changes to the chip row were needed.
- `app/components/chat/assistant-chat-carousel.test.tsx` — `renderBatch` now mocks `onApproveAll`/`onRejectAll` and exposes `rerenderChips`; 7 new tests: approve advances, reject advances, no-pending stays put, wrap to earliest pending, batch actions do not move (with a per-card arm pending), terminal error mapping (self-heal → expired) advances, non-terminal error does not advance and does not leave a stale arm.

## Tests
```
./node_modules/.bin/tsc --noEmit   → clean (no output)
bun run test:fe                    → Test Files 98 passed (98) · Tests 687 passed (687)
./node_modules/.bin/vitest run app/components/chat/assistant-chat-carousel.test.tsx → 1 passed (1) · 21 passed (21) (14 prior + 7 new)
```

## Deviations
None.

## Wave 2 — reviewer findings (2026-09-29)

state: DONE · ts: 1790677803

- **MED stale `.then`:** the arm is tokenised by object identity (`const marker = { id, resolved: false }; armRef.current = marker`) and its `.then` only flips `resolved` when `armRef.current === marker`, so a superseded attempt's late settle can no longer resolve a retry's arm. Chip buttons stay enabled during flight; correctness no longer depends on disabling them.
- **NIT non-active click:** `handleCardDecide` arms only when the pressed chip is the active card; a click on any other card's button calls `onDecide` and leaves an existing arm untouched (batch buttons still clear explicitly).
- **NIT contract typing:** `onDecide` / `onApproveAll` / `onRejectAll` typed `void | Promise<void>` in `AssistantApprovals.tsx` and `AssistantApprovalChipRow.tsx`; the settle contract (a returned thenable drives the arm's `resolved` flag) is documented at the prop declarations.
- **NIT render-phase write:** `orderedRef.current = ordered` moved into a `useLayoutEffect` declared before the settle effect, so the scan input is refreshed ahead of it and no ref is written during render.
- **Tests:** batch-exclusion now rerenders the armed chip terminal with at least one OTHER chip still pending (asserts `1 / 3`); the disarm test drives `onDecide` through a controllable promise resolved in `act` (exercises the resolved-disarm branch, then flips the armed chip terminal and asserts no advance); added a `prefers-reduced-motion: reduce` case asserting the advance still moves the counter; added two regression tests — a superseded attempt's late settle cannot resolve the retry's arm, and a click on a non-active card's button leaves an in-flight arm intact.

## Tests (wave 2)
```
./node_modules/.bin/tsc --noEmit   → clean (no output)
bun run test:fe                    → Test Files 98 passed (98) · Tests 690 passed (690)
```

