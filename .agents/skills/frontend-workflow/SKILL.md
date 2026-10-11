---
name: frontend-workflow
description: 'Lexa frontend design + implementation operating procedure — wireframe-first design, PHOSPHOR fidelity, the design/implementation model split, the anti-slop filter, and browser verification. Load before any UI/UX design change, wireframe edit, or frontend implementation on Lexa.'
---

# Frontend Design Workflow — Lexa

Operating procedure for UI/UX work in this repo. It adapts an external, harness-agnostic
spec to what actually exists here — the wireframes submodule, PHOSPHOR, and the installed
skill/model set. Where this skill and `AGENTS.md` disagree, `AGENTS.md` wins.

## 0. Trigger

Load this skill when the task: changes a screen, state, layout, component, copy, or motion
in the app; edits `wireframes/src/**`; or reviews a frontend change for design drift,
responsiveness, or accessibility. Not for backend-only or pure-token work.

## 1. Mission

Deliver interfaces that are distinctive, usable, responsive, accessible, and
production-ready — with the fewest artifacts, model calls, and iterations that still get
there. Explicit decisions beat open-ended generation; evidence beats model confidence.

## 2. Authority (read in this order)

1. `AGENTS.md` — rules, agent boundaries, verification. Wins over everything here.
2. `docs/design-system.html` — PHOSPHOR primitives: tokens + canonical component markup.
   **Open it and copy primitive markup verbatim — never hand-write a primitive.**
3. `wireframes/src/*.html` — the surface/state source of truth (start at
   `flow-overview.html`, browse `index.html`).
4. `wireframes/DESIGN_SYSTEM.md` — identity, tokens, typography, color, motion.
5. `docs/SCHEMA.md`, `docs/LAYERS.md`, `docs/API.md` — when the UI is stateful or calls an
   endpoint. Endpoint shapes are exact.

Do not create parallel design docs (`DESIGN.md`, `PRODUCT.md`, a UI spec file). Direction
lives in `wireframes/DESIGN_SYSTEM.md`; primitives in `docs/design-system.html`; the router
is `AGENTS.md`. If two authority files conflict, **stop and report** — never resolve it
yourself.

## 3. Roles and models

| Role | Agent | Runtime |
|---|---|---|
| Design specialist — direction, IA/UX decisions, typography/color/spacing/motion principles, wireframe structure, visual review, resolving design-vs-usability conflicts | `@designer` | MiMo Pro tier (`opencode-go/mimo-v2.6-pro`, pinned in the harness config, not this repo) |
| Implementation specialist — inspect, transcribe wireframes into React, write components/styles/interactions, run browser checks, first-pass review against the wireframe | `@swe` | `opencode-go/deepseek-v4.1-flash#high` |
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

## 5. Design process

The craft specialists live in the `designer` skill's route table — load one or two at most:
`design-thinking` (screens, flows, void states), `frontend-design` (distinctive direction,
typography, motion), `design-system-patterns` (tokens, theming, component architecture).
Carry their decisions into the wireframe so the implementer never needs them.

Every significant decision must serve something: hierarchy/clarity, readability, density,
visual distinction, component consistency, interaction feedback, responsive behavior,
accessibility, or implementation cost. Warning signs, not absolute bans: generic dashboard
chrome, repeated card grids, arbitrary gradients, excessive rounded containers, metrics
without a source, decoration without a purpose. Minimalism is not quality; complexity is
not creativity.

## 6. Wireframe-first (non-negotiable)

**Any UI/UX change — new states, layout, components, copy, motion — is made in the
wireframes FIRST, then implemented in code.** Skipping the wireframe is never permitted;
what scales is its *scope and fidelity*, with the uncertainty of the change:

| Uncertainty | Wireframe work |
|---|---|
| Copy tweak, token change, obvious one-line fix | Edit the existing wireframe file's text/markup; rebuild. |
| New state on an existing surface | Draw the state in the existing wireframe, with an annotation. |
| New surface, navigation change, or competing structures | Full surface wireframe: happy path + void states (empty/loading/partial/error/denied) + the state matrix, before any React. |

Mechanics:

- `git submodule update --init wireframes` first — no frontend work before the submodule is
  present.
- Edit `wireframes/src/**` only (`dist/` is generated) → `bash wireframes/build.sh`.
- Annotation rule: document decisions with `<span class="annotation">` /
  `<span class="annotation-tag">` so they render — never in HTML comments.
- Every UI task brief carries: "Consult `docs/design-system.html` first; copy primitive
  markup verbatim."
- **Delegation sequencing:** the wireframe lane must *complete* (edited, rebuilt, gate
  green) before any React lane starts. Never run them in parallel.
- Submodule commits first, then bump the pointer in the parent (`git-workflow` §6).

## 7. Visual direction

A new or materially different direction is a `@designer` decision, recorded in
`wireframes/DESIGN_SYSTEM.md` (identity, signature, type roles, palette/semantic tokens,
spacing, component treatment, motion, accessibility constraints, responsive behavior) and
expressed in the wireframe. For a small feature that already follows PHOSPHOR, invent
nothing — reuse the tokens and primitives.

PHOSPHOR is already deliberate: warm amber-tinted rather than cold slate, density as the
game loop (30+ cards at 1080p with no vertical scroll), color as signal, three type voices,
motion as 150–250ms state transitions with full reduced-motion support. Extend it; do not
re-litigate it. Do not produce multiple polished previews "because there is a design stage".

## 8. Implementation rules

1. Transcribe the wireframe: layout, spacing, hierarchy, copy, and states exactly. No extra
   padding, borders, or invented treatments. If the wireframe shows 3 columns, build 3.
2. Port any new wireframe CSS class into `app/styles/phosphor.css` — wireframe classes do
   not exist in the app until ported.
3. PHOSPHOR tokens only (CSS variables); no raw hex outside `phosphor.css`.
4. Reuse existing components/tokens; never stand up a second component system.
5. Semantic markup, keyboard operability, visible focus, reduced motion, 44px tap targets.
6. Real behavior — no control that looks interactive but does nothing; every state in the
   matrix (empty/loading/error/disabled/partial/long content) is handled.
7. Server state via TanStack Query; update the cache with `setQueryData` from the mutation
   response — never `invalidateQueries` on the mutation path (invariant 6).
8. Do not change invariants 1–14, add endpoints, or add tables to make a screen work. If the
   UI needs one, report it.
9. Implement in the real app, not as a standalone HTML mock. Thrown-away prototypes are for
   design decisions only, live in `.tmp/` (gitignored), and are never added to `artifacts/` or
   `wireframes/`.
10. Add a screen, state, or component only if the wireframes contain it — otherwise get
    user approval first.

## 9. Anti-slop filter

The filter is not the source of creative direction; PHOSPHOR and the wireframe are.

- Load the core `antislop` skill plus the sub-skill matching the touch: `antislop-ui`
  (color/layout/components/motion), `antislop-human` (contrast, keyboard, focus, mobile
  exclusion), `antislop-layoutmobile` (reflow), `antislop-copywriting` (user-facing copy).
- Treat findings as findings, not verdicts: resolve real violations; a deliberate pattern
  that serves the product stays, with the reason written down. Never delete a purposeful
  choice because the pattern is common.
- Run the Delivery Gate after significant visual changes, before declaring done, and put its
  one-line-per-item PASS/FAIL report with evidence into `status/<plan>/report.md`. A FAIL is
  fixed and the gate re-run — never shipped, never silently dropped.
- The gate complements, never replaces, `scripts/verify-gate.sh` and the browser check.

## 10. Browser verification (agent-browser)

Compiling is not evidence. Run the real app and exercise the change:

1. Build the wireframes if `wireframes/src` changed; start the app (`bun run dev` → :5173;
   `dev:workers` for the Worker flavor, direct `/api`).
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
- One wireframe, one meaningful revision, by default — a guideline, not a licence to ship an
  unresolved structural defect.
- Never generate a preview nobody will inspect.
- Fix concrete failures instead of rewriting the interface; during visual refinement,
  address the three highest-impact remaining issues first.
- No open-ended critique loop after every CSS change; when fixes stop converging, escalate.
- Never claim an optimization reduced cost without usage numbers.

## 12. Delivery criteria

Do not call the work done until every applicable item is checked:

- [ ] Requested behavior implemented, in the real app.
- [ ] Wireframe reflects the change and was rebuilt (and committed/pushed in the submodule
      with the parent pointer bumped, when landing).
- [ ] UI conforms to the wireframe + `wireframes/DESIGN_SYSTEM.md`.
- [ ] Anti-slop Delivery Gate run; PASS/FAIL with evidence in the report.
- [ ] Browser check performed on the affected screen incl. void states and viewports.
- [ ] `bash scripts/verify-gate.sh` green; lane tests green.
- [ ] Failures fixed, or blockers explicitly documented.
- [ ] Report written (implemented / design decisions / verification actually performed /
      outstanding issues). Never claim a review, inspection, test, or gate that did not run.

## 13. Where this diverges from the external spec

Recorded so nobody re-introduces the conflicts:

| External spec said | Here, instead |
|---|---|
| Wireframing optional, low-fidelity, temp under `artifacts/` | Always wireframe-first, PHOSPHOR-fidelity, `.tmp/` for throwaways |
| `PRODUCT.md` / `DESIGN.md` / `UI-WORKFLOW.md` as authority | `AGENTS.md` + `wireframes/DESIGN_SYSTEM.md` + `docs/design-system.html`; no parallel docs |
| Impeccable as the primary runner | The installed `designer` route table + `frontend-design` / `design-system-patterns` |
| One generic quality stage | Anti-slop filter + wireframe conformance + browser check + repo gate, each with its own evidence |
