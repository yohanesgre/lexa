---
name: goal
description: Goal-driven execution loop — breakdown a user goal, deepen with design graphs, protocol the work, track in work-plans, execute via isolated herdr lanes, loop until done. Use ONLY when the user invokes `/goal`. This skill is `/goal`-scoped and does not govern ordinary sessions, other commands, or other agents.
---

# Goal

Turn a goal prompt into DONE through a loop. Each iteration: verify state
→ met? close : adjust → execute next wave. The loop ends only when
acceptance criteria hold and gates are green — never on effort spent.

Scope: this skill runs ONLY under an explicit `/goal` invocation. Its
guard and policies do NOT apply to ordinary sessions, other commands, or
other agents. Outside `/goal`, the global/repo AGENTS.md rules govern.

Autonomy: `/goal` is full-auto AFTER the execution gate. Human gates
exist only before Phase 4 (goal clarity, design direction, protocol +
model/effort approval). Once execution starts, the loop never waits for a
human. Safety after the gate comes from the automated rails below. The
user reads wave reports async; the loop never blocks on them. Approving
the execution gate pre-authorizes exactly the lifecycle it enumerates
(branch → commit → push → PR → auto-merge on green CI) for exactly the
named lanes/branches. The gate approves scope and waves.

Runtime: opencode2 (v2) only. Assumed surfaces: herdr CLI (`pane
split/run`, `agent start/prompt/wait/read`), opencode2 flags (`--auto`,
`--prompt`, `--session`, `--agent`, `--model`), V2 command frontmatter
(`description/agent/model/subagent`), project skill dir `.agents/skills/`,
project commands dir `.opencode/commands/`. If this session is not
opencode2, STOP and flag before doing anything.

## The graph (this skill IS the pipeline for it)

```
A — happy path (execution graph)
goal → intake → classify → design → protocol → track → GATE
     → isolate → wave{lanes} → verify → review → close(PR) → merge
     → loop: next wave | DONE

E — break points (coordinator failures, not worker failures)
wrong context · missing input (invisible edge) · misinterpretation
herdr/env/binary/model/agent gap · secrets · no progress

R — every worker prompt carries
subgraph (nodes+edges) · WHY · governing docs · acceptance · gate · forbidden

Boundary: prompt = delegated subgraph IN → return = implemented graph OUT.
Verify: compare implemented graph vs delegated subgraph; extra/missing node = deviation.
```

Nodes are tasks; edges are data dependencies. Independent nodes run
parallel (one lane each); an edge gates the dependent wave. One node, one
owner. Read this graph before Phase 0; if the work doesn't match it, fix
the work or fix the graph — never leave them disagreeing.

## Main-session guard (orchestrator never codes — `/goal` only)

Applies only inside a `/goal` loop. The main session is the orchestrator,
not an implementer. It NEVER edits `app/`, `server/`, `shared/`, `cli/`,
`wireframes/`, `docs/*.md`, or any skill/config file, and never calls a
mutating tool against those paths.

The orchestrator writes only the tracking plane directly:
`status/<plan>/` (`plan.md`, `status.md`, `lanes/<lane>.md`,
`report.md`), `status/TIMELINE.md`, and `mem_save`. It also drives
isolate, gates, review, PR, CI, and merge — it does not produce the diff.

Delegation by node type (matches the graph):
- **Mutation nodes → herdr lane(s) only.** Lane roles: `swe`
  (implementation), `designer` (design artifacts). Simple = exactly one
  lane. Complex = one lane per track (1..N).
- **Read-only nodes → `subagent` tool only.** Single foreground (inline,
  blocking) call; background/parallel fan-out banned. Roles: `architect`
  (design/plan), `researcher` (codebase/web lookup), `reviewer` (review).
  They never mutate; their agent md `model:` pin applies to child sessions
  automatically — no `--model` needed.

A mutation the orchestrator makes itself is a violation: stop, revert it
before proceeding, and re-dispatch the work to a lane. Design artifacts
that must land as files: wireframes/design-system → `designer` lane; ADR
content → merged into the relevant `docs/*.md` (`ARCHITECTURE.md` for
decisions) — no separate ADR tree; implementation-plan content → folded
into `status/<plan>/plan.md`, never a separate plans tree. A mutation lane
(`swe`) persists the architect artifact verbatim — the read-only
`architect` never writes.

## Routing: simple vs complex (lane count — risk + scope)

Classify before designing. When unsure, it is complex. This picks how many
mutation lanes and how deep the review runs.

**Simple** — ALL must hold:
- one concern, one track
- touches no named contract surface: no `docs/SCHEMA.md`,
  `docs/LAYERS.md`, or `docs/API.md` invariant/schema/error-catalog
  change; no migration
- no wireframe change (`wireframes/src/**`) or design-system primitive
- no shared-file collision (migrations, CHANGELOG, submodule gitlinks,
  lockfiles)
- no second parallelizable track

**Complex** — ANY one makes it complex:
- touches schema/API/ARCHITECTURE invariant, a service/repo/error
  contract, or a migration
- touches `wireframes/` or design-system primitives
- multi-concern or broad refactor (one concern per lane)
- ≥2 independent tracks (even small ones)
- shared-file collision, or risk too broad for one brief

Route: **simple** → exactly one mutation lane in the single plan worktree.
**complex** → one mutation lane per track (1..N; single track = one lane).
File count is a hint, never a gate — classify on contract surface.

## Phase 0 — Intake + triage

1. Take the goal from the invocation (`/goal <text>`) or ask for it.
   (`/goal` with no goal is the ONE case that waits for user input.)
2. Break the goal into work items (what must be true when done, not how).
3. Ambiguous scope, missing acceptance, or architecture fork → ask the
   user with the question tool (this is the human-gated planning zone).
   Never guess on architecture; state what you would otherwise do.
4. Triage the route BEFORE designing, using § Routing. Isolation is NOT
   triaged: every route executes in a fresh worktree (Phase 4 isolate,
   after work-plans + gate) — never in the invoking checkout, which other
   agents share. The orchestrator never edits code in any route.
   - **Simple**: exactly one mutation lane in the single plan worktree.
   - **Complex**: one mutation lane per track — one worktree + pane +
     agent each; a single-track complex task is still one lane.
   State the chosen route + lane count + why in one line before proceeding.

## Phase 1 — Deepen (design before protocol)

- UI/surface work → `design-graph`: draw Surface<C,V,N> first. C =
  happy-path content flow, V = void states
  (empty/loading/partial/error/denied), N = needs
  (data/permission/prior-step/viewport).
- Backend/state work → `design-thinking`: A = happy-path call graph,
  E = break points, R = dependencies.
- Orchestration work → the graph above +
  `design-thinking/references/graph-protocol.md`: nodes, edges, waves,
  E, R. Compare the delegated subgraph vs the implemented graph before
  any gate; extra/missing node = off-script.
- Read-only reasoning nodes run here as `subagent` calls: `architect`
  (brainstorm/design/ADR/plan), `researcher` (lookup). Their output feeds
  `plan.md`; nothing they produce bypasses the gate. A `writing-plans`
  artifact is input, not a second plan of record: `status/<plan>/plan.md`
  stays the `/goal` single source — fold its files/tasks/tests into
  `R`/`Graph A`, and persist the docs plan only if acceptance requires it
  (mutation lane, linked from `plan.md`). The artifact's own execution
  handoff (subagent-driven / inline) is overridden — execution is always
  the goal lane model.
- Skill missing → fall back to the behavior described inline, record the
  gap in the lane/plan.
- Conflicting docs or requirements → STOP, report, wait. No scope creep:
  report missing pieces, don't build them.

## Phase 2 — Protocol (wave graph)

Order waves by dependency, not enthusiasm. Independent tracks may run in
parallel; an edge gates the dependent wave (e.g. wireframe lane DONE —
`src` edit + build green — before any React lane starts). Name lanes,
assign one owner per node, and assign file ownership per lane so parallel
tracks never write the same files. Write the wave graph into `plan.md`.

## Phase 3 — Track (work-plans)

One folder `status/<plan>/` (name `[a-z0-9-]`). Open it per the
`work-plans` skill: copy `assets/plan-template.md` → `plan.md`, fill
X / Scope / Graph A / E / R / Lanes, write `status.md`
(`state: PLAN`, `ts`, `msg`), append the PLAN line to `status/TIMELINE.md`.
`ls status/` shows active plans only; no loose files in `status/` root
besides `TIMELINE.md`.

Fill the template's graph sections — this skill's graph IS the plan:
- **Graph A**: the wave graph (waves + lanes, one owner per node).
- **E**: execution break points (see § Break points).
- **R**: the delegated subgraph per lane — role agent + resolved
  model+variant, nodes (files/units), edges (inputs consumed, outputs
  produced), acceptance, gate. Resolve the model from the role agent's
  markdown `model:` field — `~/.config/opencode/agents/<role>.md` (source:
  `~/projects/dotfiles/config/opencode/agents/<role>.md`); the agent md is
  the single source of truth for model+effort.
- **Lanes**: only when parallel. The simple route is one track → delete the
  section and skip `lanes/` (never invent a lane to fill the shape).
- Header `gate:` = execution-gate ack (`<ISO8601> <who> <branch>`);
  `iter:` = current `W<n>i<m>`.

Freeze acceptance in `plan.md` BEFORE any lane executes: one verifiable
criterion per work item, each paired with its verify command
(`tsc --noEmit`, which `test:*` lane, which manual smoke). Waves verify
against this frozen list — never invent new acceptance mid-execution.

Keep `status.md` at 3 lines and mirroring the slowest lane; lane files stay
3-line too. **Reopen rule**: any new request on a DONE plan → flip
`status.md` to WORKING first + TIMELINE line, then act. `mem_save` on DONE
(summary + `plan.md`/`report.md` paths); `report.md` follows the work-plans
report template. Tracking artifacts have their own break points (3-line
overflow, orphan lane, DONE-without-report, pointerless `mem_save`) — fix
the artifact per `work-plans`, don't duplicate them here. Finished plans
stay in `status/` until archived; archiving is outside `/goal`.

Prefix lane status msgs with `W<n>i<m>` so loop position survives scrollback.
Validate tracking with
`bash .agents/skills/work-plans/scripts/plan-check.sh <plan>` at open and
before DONE.

## Execution gate (LAST human gate — nothing human after this)

Present for one-shot approval: frozen acceptance, the wave graph
(waves + lanes + one owner per node), chosen route + why, mutation lanes
+ role agents + resolved model+variant (from the agent md; question tool,
no defaults), read-only roles used, worktree path(s) + branch name(s),
autonomy envelope (worktree → branch → commit → push → PR → auto-merge on
green CI). User approves → Phase 4 isolates first, then runs with zero
further questions. User rejects/changes → adjust Phases 0–3, re-present.
No approval = no execution. Approval lapses after 72h or if the goal text
changed → re-present only the diff, not the whole gate.
Worktrees/branches always derive from latest `main` at dispatch;
post-approval main movement is handled by rebase-before-PR, not by
re-gating.

Fast path: triage = simple (all § Routing conditions hold) → gate
collapses to goal restatement + one scope line. Ack = any reply without
rejection or change request ("gas", "oke", "lanjut", 👍 all count;
"tunggu", "jangan", "ubah X" do not). Proceed on ack.

## Phase 4 — Execute (zero questions from here)

### 4.1 Isolate FIRST (mandatory, every route)

1. `git fetch origin main`; confirm `.worktrees/` is gitignored and no
   branch/path collision (`git worktree list`,
   `git branch -a | grep <name>`). Control-checkout dirt is EXPECTED
   (other agents share it) — never require a clean control checkout,
   never branch from its working tree.
2. Create the worktree(s) with the `references/lane-dispatch.md` guards:
   simple → one plan worktree `git worktree add -b <branch>
   .worktrees/<plan> origin/main`; complex → one per lane
   `.worktrees/<plan>-<lane>` (`<plan>` = work-plans folder name; suffix
   on collision, never reuse). Set up inside each (`bun install`; copy
   `.env` only if a smoke needs it — never commit it); baseline
   `tsc --noEmit` to confirm clean.
   `status/<plan>/` stays in the control checkout (tracking plane) — code
   work never touches control-checkout files after this point.
3. `git worktree add` failing (branch/path collision) → FAST EXIT naming
   the cause — never proceed unisolated in the control checkout.
4. Clean check INSIDE the fresh worktree: `git status --porcelain` —
   clean expected there; dirty from an unknown source → WAIT + report,
   never build on top of it.

### 4.2 Dispatch — the prompt IS the delegated subgraph

Follow `references/lane-dispatch.md` for the exact order (guards →
worktree → pane → agent → prompt → read). Lane roles by DISCOVERY, never
hardcoded IDs: `swe` (implement/fix), `designer` (wireframes/design
artifacts). herdr kinds name backends, not roles — the role travels in
the brief. If no fitting agent exists, keep the lane WAIT and report the
gap; never invent an agent name.

Brief (subgraph IN — every lane, self-contained):
```
WHY:            <reason this node exists>
Nodes:          <exact files/units, one owner, path:line>
Edges:          <inputs consumed from prior waves; outputs for dependents>
Governing docs: <repo bindings / design docs that win>
Acceptance:     <frozen criteria from plan.md>
Gate:           <verification command(s)>
Forbidden:      act outside the worktree; exfiltrate beyond declared
                fetches; --force or history rewrite on shared branches;
                commit secrets
Boundary:       cwd <absolute worktree>; branch <branch>; no commit, no push
```

Model: dispatch with an explicit `--model provider/model#variant` plus
`--agent <role>`. Resolve the ref by reading the role agent's markdown
`model:` field (`~/.config/opencode/agents/<role>.md`) and pass that exact
base+variant. Never hardcode, guess, or invent one. If the role agent md
has no `model:`, use the gate-approved ref in `plan.md` (R); if neither
exists → FAST EXIT naming the gap. The default model errors (auth), and
an agent's `model:` field does NOT auto-apply to a primary
`opencode2 run --agent` session (child/subagent sessions only) — which is
why it must be read and passed explicitly.

Forbidden in every lane brief (opencode2 `--auto` approves what is not
denied): act outside the assigned worktree, exfiltrate data beyond
declared fetches, `--force` or history rewrites on shared branches,
commit secrets. Violation kills the lane.

herdr has no opencode2 kind: drive opencode2 with `opencode2 run --auto
--model ... --agent <role>`; warm a fresh agent with one trivial prompt
before the brief. Wait for lane output with
`bun .agents/skills/goal/scripts/lane-wait.ts` (reactive sentinel wait —
never fixed `sleep`); the runner-file vehicle is prescribed in
`references/lane-dispatch.md` step 4.

### 4.3 Return — the reply IS the implemented graph

Lane reply style: caveman-compressed EXCEPT `reviewer`, which runs full
prose (compression drops review nuance). Every lane return carries:
```
Implemented: <files changed + what changed>
Evidence:    <gate output tails + full log path>
Deviations:  <extra/missing/renamed nodes vs the delegated subgraph>
Open:        <blockers, if any>
```

Lane rules: a lane that hits a contract mismatch or needs out-of-scope
files flips to WAIT and reports — never guesses. Lanes may run their own
inline subagents while files/scopes don't collide. The orchestrator's
`subagent` calls are read-only and MUST NOT touch anything already
delegated; the orchestrator never edits files itself.

Lane lifecycle: keep worktree + branch until its PR merges (never delete
early); removal needs explicit user approval. Resume a dead lane agent
with opencode2 `--session` (state lives in the worktree, re-brief from the
lane file). Each lane runs `git status` FIRST inside its own worktree —
clean expected there; dirty from an unknown source → WAIT + report, never
build on top of it (control-checkout dirt is irrelevant — lanes never
touch it).

## Phase 5 — Verify + loop (guarded)

Gate per route (lane runs its own row; orchestrator re-runs it at
integration — trust lane output, but verify before commit):
- wire: `bash wireframes/build.sh` exit 0 + grep built `dist/` for the
  changed copy. No `tsc` needed (static HTML).
- be: `tsc --noEmit` + `test:be` (or touched suites if full is slow) +
  `check:invariants` when `server/`/`shared/` touched.
- fe: `tsc --noEmit` + `test:fe`.
- docs-only: reviewer read (names/numbers match source files verbatim).

Compare (the payoff of the subgraph boundary): implemented graph vs
delegated subgraph for every lane. Extra node = off-script (revert or
justify); missing node = skipped work (lane fixes or report). A
mismatch is a deviation, never silently accepted.

Evidence rule: paste gate output tails into the lane report — a bare
"tests pass" without output does not count as green. Attach the full
gate log path (`$GATE_LOG_DIR/gate-*.log` from `verify-gate.sh`)
alongside the tails.
Pre-existing failures: lane suite red → rerun the SAME suite on a
pristine `main` checkout → identical failure = pre-existing: declare it
in the PR body and proceed; new failure = lane fixes it first. Scoped
reruns and the pristine-main recipe live in
`git-workflow/references/checks.md`.
Missing tool: `command -v` first, then the closest equivalent, and
declare the deviation. Known pairs: `bunx` → `bun x`;
`tsc` → `bun run typecheck`.

End of every wave: gates + FROZEN acceptance + graph compare. Green +
met → reviewer pass → report + DONE + `mem_save`. Red or unmet → adjust
the plan, record the deviation, next loop iteration.

Reviewer pass: every lane gets a reviewer pass (correctness, scope, edge
cases) before its PR; findings return to the lane, not around it. Run the
`reviewer` as a read-only `subagent` (full prose). No reviewer
discoverable → orchestrator self-reviews against a checklist (diff
matches lane scope, acceptance re-checked, edge cases probed, staged
names secret-free) and records it in the report. Lane findings live in
the lane file (+ TIMELINE line); `report.md` is owned by the orchestrator
and aggregates lanes.

Auto close-out: a wave that is green + met with its reviewer pass
recorded always commits on its branch (conventional message, body = WHY),
pushes (`git push -u origin <branch>`), and opens a PR (base `main`, body
= result + gate tails + deviations). Invoking `/goal` plus the approved
gate is the explicit ask for exactly the enumerated lifecycle. Then the
merge gate takes over: PR auto-merges when CI is green. CI red → fix loop
(counts toward the loop guard); unfixable within budget → leave open +
report. Merge BLOCKED BY POLICY (e.g. required-human-review rule, not red
CI) → leave open + report immediately, never burn loop iterations polling
it. Worktree/branch removal after merge needs no approval inside
`/goal`; keep them until merged, then clean up. `status/` is gitignored —
reports travel via the PR body, not the repo.

Report progress per wave as: state, commit sha, one-line test summary,
concerns (if any) — nothing else.

## Break points (E — coordinator failures, handled outside the happy path)

- **FAST EXIT** (that lane only; name the cause, never fall back
  silently): `HERDR_ENV` ≠ `1`; `herdr` or `opencode2` missing in the
  pane; `git worktree add` branch/path collision; approved model erroring
  at dispatch (never substitute another model — cost/behavior was
  approved as-is); no `--model` resolvable for a lane.
- **WAIT** (park the lane, continue others, report the blocker): contract
  mismatch; needs out-of-scope files; no fitting agent; clean-check
  failure inside the worktree from an unknown source.
- **Loop guard**: max 3 iterations on the same wave without progress —
  progress means ≥1 newly-green acceptance item or gate since the last
  iteration. No progress → park that lane WAIT, continue others, note the
  blocker. Hard cap 5 wave iterations per plan → close as FAILED with
  blockers listed (`report.md` records what shipped), never spin forever.
  Same point failing twice → change strategy first.
- **Secrets/credentials exposure**: the only halt-everything — kill that
  lane immediately and report.
- **Merge-blocked-by-policy**: leave open + report, never poll.

## Edge cases (checklist, bukan opsional)

- Dirty worktree: clean check runs INSIDE the fresh worktree; dirty from
  an unknown source → WAIT + report. Control-checkout dirt is expected
  (shared with other agents) and never blocks isolate, because worktrees
  branch from `origin/main`, not the working tree.
- Shared-file collision: migrations numbering, CHANGELOGs, submodule
  gitlinks, and lockfiles are shared even when features look disjoint.
  Assign one owner at protocol time; on collision risk, serialize those
  files through one lane.
- Rebase before PR: main moves under lanes. Rebase each lane on latest
  `main` + re-run its gate before opening the PR. CI red caused by the
  rebase → fix loop (counts toward the loop guard).
- Files are truth: terminal scrollback is ephemeral. Lane progress lives
  in lane files + `report.md`. After context compaction, re-read
  `plan.md` + lane files AND run `mem_context` before continuing — never
  assume file or memory state. If `mem_context` returns unreadable,
  proceed on files alone and note it.
- Plan-env hygiene: if `status/<plan>/` already exists, suffix the plan
  name (date/slug) — never reuse. `status/` stays in the control checkout;
  the worktree never owns tracking files. Every lane brief pins the binary
  PATH and sets cwd to the assigned worktree (missing tools = declare
  deviation, use closest equivalent).

## Standing guardrails (every loop)

- Main-session guard (`/goal` only): the orchestrator edits ONLY the
  `status/` tracking plane (`status/<plan>/**`, `status/TIMELINE.md`) +
  memory. Code and design docs (`app/`, `server/`, `shared/`, `cli/`,
  `wireframes/`, `docs/*.md`, skill/config) are never edited by the main
  session — mutation goes to a herdr lane (`swe`/`designer`), read-only
  work to a `subagent` (`architect`/`researcher`/`reviewer`). A self-made
  edit is a violation: revert it + re-dispatch.
- Repo bindings, in order, before touching code: design-system primitives
  → `docs/SCHEMA.md` (names + invariants verbatim) → `docs/LAYERS.md` →
  `docs/API.md` → wireframes → `docs/ARCHITECTURE.md` (rationale only).
  Docs conflict → STOP + report, never resolve alone.
- Destructive or irreversible steps (migrations, deletes, deploys,
  force-push, history rewrites) are auto-approved INSIDE lane
  branches/worktrees only — blast radius ends at the PR. Hard forbidden,
  no exceptions: mutating `main` outside PR flow, force-pushing shared
  branches, touching prod data, committing secrets (staged-name check runs
  before every commit; a hit kills the lane and is reported).
- Git guardrails before any git mutation (single trunk `main` — git-workflow
  skill). Branch → PR → merge, never commit on `main`. Invoking `/goal`
  covers close-out only for the lifecycle enumerated at the execution gate
  and approved there. After isolate, every code mutation (edit, gate,
  commit) runs inside the assigned worktree — never in the control
  checkout. Stage files explicitly, check staged names for secrets.
- Wireframe-first for UI: `wireframes/src/` + build before React.
- Conventional commits (`feat|fix(scope): subject`, body = WHY).
- Submodule rule: commit+push inside the submodule first, then bump
  the pointer in the parent.
