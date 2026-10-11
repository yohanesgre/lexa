---
name: frontend-workflow
description: 'Lexa frontend operating procedure. Composes Impeccable (the design process: context, playbooks, craft-floor, detect) with the antislop quality filter over Lexa''s DESIGN.md design system, PHOSPHOR primitives, and the design/implementation model split. Load before any UI/UX design change or frontend implementation on Lexa.'
---

# Frontend Design Workflow — Lexa

Operating procedure for UI/UX work in this repo. It is Lexa's overlay **over** Impeccable: Impeccable is the design process, antislop is the quality filter, and `DESIGN.md` is the design authority. Where this skill and `AGENTS.md` disagree, `AGENTS.md` wins.

## 0. Trigger

Load this skill when the task: changes a screen, state, layout, component, copy, or motion
in the app; edits `DESIGN.md`, `PRODUCT.md`, or `.impeccable/**`; or reviews a frontend
change for design drift, responsiveness, or accessibility. Not for backend-only or
pure-token-consumer work.

## 1. Mission

Deliver interfaces that are distinctive, usable, responsive, accessible, and
production-ready — with the fewest artifacts, model calls, and iterations that still get
there. Explicit decisions beat open-ended generation; evidence beats model confidence.

## 2. Authority (read in this order)

1. `AGENTS.md` — rules, agent boundaries, verification. Wins over everything here.
2. `DESIGN.md` (root) — the design system. Token frontmatter is **normative**; the prose is
   how to apply the tokens. It is the single token source — no second token list anywhere.
3. `.impeccable/design.json` — the sidecar (tonal ramps, shadows, motion, breakpoints,
   component snippets, `themeOverrides` for the light theme). `PRODUCT.md` (root) is product
   truth.
4. `docs/design-system.html` — PHOSPHOR **primitive-markup reference**: canonical component
   markup. **Open it and copy primitive markup verbatim — never hand-write a primitive.**
5. `docs/SCHEMA.md`, `docs/LAYERS.md`, `docs/API.md` — when the UI is stateful or calls an
   endpoint. Endpoint shapes are exact.

PHOSPHOR tokens only — no raw hex outside `app/styles/phosphor.css`. `DESIGN.md` is the
single source of truth for tokens; never introduce a second token list. `wireframes/` is a
retired archive and is not a design source. If two authority files conflict, **stop and
report** — never resolve it yourself.

## 3. Roles and models

| Role | Agent | Runtime |
|---|---|---|
| Design specialist — direction, IA/UX decisions, typography/color/spacing/motion principles, visual review, resolving design-vs-usability conflicts | `@designer` | MiMo Pro tier (`opencode-go/mimo-v2.6-pro`, pinned in the harness config, not this repo) |
| Implementation specialist — inspect, implement components/styles/interactions from `DESIGN.md` + the primitives, run browser checks, first-pass review | `@swe` | `opencode-go/deepseek-v4.1-flash#high` |
| Image reading — any screenshot, mockup, or diagram | `@vision` | `opencode-go/mimo-v2.5` (text-only callers never receive images) |

Rules:

- `@designer` never edits `app/`, `server/`, `shared/`, `cli/`. `@swe` never invents visual
  direction — a missing decision goes back to `@designer`.
- Do **not** spend a design-model call on a routine CSS fix, a straightforward component
  change, or a failure with an obvious technical cause. Do escalate when the direction is
  weak/generic, hierarchy is still unclear, several valid treatments compete, the result
  contradicts the product personality, repeated fixes have not converged, or a consequential
  design decision cannot be settled from the specs.
- If the design model cannot be invoked in the current environment, do not pretend a review
  happened: produce the handoff artifact, proceed within available capability, and name the
  outstanding review in the report.

Escalation is a `task` handoff, not a vibe: send the screenshot path (or the built preview
URL), the intended direction, the acceptance criteria, and a numbered list of unresolved
problems; ask for **prioritized corrections, not a redesign**. Apply them and re-verify.

## 4. Initial assessment

Before designing or editing, answer:

1. What is the user's primary task and expected outcome on this surface?
2. Which screens, routes, components, styles, and existing conventions are touched?
3. Which states and viewports are affected (default, hover, focus-visible, active, disabled,
   loading, error, empty, long content; mobile and desktop)?
4. Does this need a new visual direction, or does the existing system already cover it?
5. What are the measurable acceptance criteria (including a browser check)?

Do not redesign unrelated screens, replace working components, or ask questions the repo
already answers. Record assumptions in one line and proceed; ask only when an unresolved
ambiguity would materially change the design or its behavior.

## 5. Impeccable flow

Impeccable is the design process; run it, do not run a parallel one. Engine launcher:
`.agents/skills/impeccable/scripts/impeccable`; playbooks: `.agents/skills/impeccable/reference/`.

1. Run `scripts/impeccable context` once per session; follow its directives. Do not rerun it.
2. Load the request's playbook from `.agents/skills/impeccable/reference/` — its Commands-table
   reference for an explicit/implied sub-command (`critique`, `audit`, `polish`, `harden`,
   `animate`, `adapt`, `clarify`, `layout`, `typeset`, `delight`, `distill`, `bolder`,
   `quieter`, `colorize`, `optimize`, `overdrive`, `component-review`, `generate`, `live`),
   or `new-work.md` for a new surface / replacement visual world. Inspect the target and the
   incumbent visual truth before editing.
3. Read `.agents/skills/impeccable/reference/craft-floor.md` immediately before any UI edit,
   including small refinements. It carries the quality floor and the absolute bans no detector
   catches. Not needed for planning-only work.
4. Implement in the real app.
5. After UI work, run `.agents/skills/impeccable/scripts/impeccable detect --json <changed targets>`
   once. No hooks are installed, so the detector runs manually.

A new or redesigned surface runs `init` (captures `PRODUCT.md`) → `new-work` → `DESIGN.md`:
replace the previous visual world rather than polishing a discarded look. A refinement keeps
the incumbent identity, behavior, copy, and everything outside scope.

Every significant decision must serve something: hierarchy/clarity, readability, density,
visual distinction, component consistency, interaction feedback, responsive behavior,
accessibility, or implementation cost. Warning signs, not absolute bans: generic dashboard
chrome, repeated card grids, arbitrary gradients, excessive rounded containers, metrics
without a source, decoration without a purpose. Minimalism is not quality; complexity is
not creativity.

## 6. Change spec (replaces the old wireframe structure pin)

Every UI change carries a short spec in its plan/PR, before or alongside the implementation:

- The **regions** it touches (page, section, component).
- The **states matrix**: empty / loading / error / partial / denied (plus hover, focus-visible,
  active, disabled, long content where relevant).
- The **real copy** (no lorem, no placeholder).
- Which **design-system components and tokens** it uses (`DESIGN.md` tokens + primitives from
  `docs/design-system.html`).

Never add a screen, state, or component the spec does not name without explicit user approval.

## 7. Visual direction

`DESIGN.md` + `.impeccable/design.json` are the direction. A new or materially different
direction is a `@designer` decision recorded there (identity, signature, type roles,
palette/semantic tokens, spacing, component treatment, motion, accessibility constraints,
responsive behavior) — not invented inline by the implementer. For a small feature that
already follows PHOSPHOR, invent nothing — reuse the tokens and primitives.

PHOSPHOR is already deliberate: warm amber-tinted rather than cold slate, density as the
game loop (30+ cards at 1080p with no vertical scroll), color as signal, three type voices,
motion as 150–250ms state transitions with full reduced-motion support. Extend it; do not
re-litigate it. Do not produce multiple polished previews "because there is a design stage".

## 8. Implementation rules

1. Implement from `DESIGN.md` + the primitives: layout, spacing, hierarchy, copy, and states.
   No extra padding, borders, or invented treatments.
2. PHOSPHOR tokens only (CSS variables); no raw hex outside `app/styles/phosphor.css`.
3. Reuse existing components/tokens; never stand up a second component system.
4. Semantic markup, keyboard operability, visible focus, reduced motion, 44px tap targets.
5. Real behavior — no control that looks interactive but does nothing; every state in the
   matrix (empty/loading/error/disabled/partial/long content) is handled.
6. Server state via TanStack Query; update the cache with `setQueryData` from the mutation
   response — never `invalidateQueries` on the mutation path (invariant 6).
7. Do not change invariants 1–14, add endpoints, or add tables to make a screen work. If the
   UI needs one, report it.
8. Implement in the real app, not as a standalone HTML mock. Thrown-away prototypes are for
   design decisions only, live in `.tmp/` (gitignored), and are never added to the repo.
9. Add a screen, state, or component only if the change spec names it — otherwise get user
   approval first.

## 9. Anti-slop filter

The filter is not the source of creative direction; `DESIGN.md` and the primitives are. It is
mandatory and it complements Impeccable — neither substitutes for the other.

- Load the core `~/.agents/skills/antislop/SKILL.md` plus the sub-skill matching the touch:
  `antislop-ui` (color/layout/components/motion), `antislop-human` (contrast, keyboard, focus,
  mobile exclusion), `antislop-layoutmobile` (reflow), `antislop-copywriting` (user-facing
  copy), and `antislop-code` when app code is touched.
- Treat findings as findings, not verdicts: resolve real violations; a deliberate pattern
  that serves the product stays, with the reason written down. Never delete a purposeful
  choice because the pattern is common.
- Overlap rule: after UI work, **both** antislop **and** Impeccable's `detect` are run; dedupe
  the findings, and neither substitutes for the other.
- Run the Delivery Gate after significant visual changes, before declaring done, and put its
  one-line-per-item PASS/FAIL report with evidence into `status/<plan>/report.md`. A FAIL is
  fixed and the gate re-run — never shipped, never silently dropped.
- The gate complements, never replaces, `scripts/verify-gate.sh` and the browser check.

## 10. Browser verification (agent-browser)

Compiling is not evidence. Run the real app and exercise the change:

1. Start the app (`bun run dev` → :5173; `dev:workers` for the Worker flavor, direct `/api`).
2. Navigate to the affected screen; inspect the rendered result.
3. Exercise the real controls and the critical flow — including the void states.
4. Snapshot-first (accessibility tree + semantic locators) when the active model has no
   vision; when an image must be read, hand the path to `@vision` — never send an image to a
   text-only model.
5. Check overflow, clipping, overlapping content, unreadable text, broken assets, spacing
   consistency, and at least mobile + desktop widths.
6. Read the console; fix defects and repeat only the affected steps.
7. Run the lane tests (`bun run test:app` / `test:fe`) and any applicable accessibility
   check; a browser click-through never replaces an assertion.

## 11. Token and iteration efficiency

- Load references only when relevant; never re-read a large file you already have.
- One meaningful revision, by default — a guideline, not a licence to ship an
  unresolved structural defect.
- Never generate a preview nobody will inspect.
- Fix concrete failures instead of rewriting the interface; during visual refinement,
  address the three highest-impact remaining issues first.
- No open-ended critique loop after every CSS change; when fixes stop converging, escalate.
- Never claim an optimization reduced cost without usage numbers.

## 12. Delivery criteria

Do not call the work done until every applicable item is checked:

- [ ] Requested behavior implemented, in the real app.
- [ ] Change spec written (regions + states matrix + copy + components/tokens used).
- [ ] UI conforms to `DESIGN.md` tokens and the `docs/design-system.html` primitives.
- [ ] Impeccable `detect` run on the changed targets; antislop Delivery Gate run; both
      PASS/FAIL-with-evidence blocks in the report, findings deduped.
- [ ] Browser check performed on the affected screen incl. void states and viewports.
- [ ] `bash scripts/verify-gate.sh` green; lane tests green.
- [ ] Failures fixed, or blockers explicitly documented.
- [ ] Report written (implemented / design decisions / verification actually performed /
      outstanding issues). Never claim a review, inspection, test, or gate that did not run.

## 13. How Impeccable and antislop compose

- Impeccable is the process (context → playbook → craft-floor → implement → detect) and holds
  the craft floor; antislop is the filter (core + touch sub-skill + Delivery Gate). Both run
  on every UI change.
- Where they overlap — contrast, spacing, type, motion, states — a finding from either is a
  finding; dedupe, and fix the real violation once. Neither tool's clean report excuses the
  other.
- A deliberate pattern stays when the reason is written down in the report. PHOSPHOR
  parameters and the committed `DESIGN.md` world override a generic anti-pattern warning.
- Neither tool replaces `scripts/verify-gate.sh`, the lane tests, or the browser check; each
  carries its own evidence.
