---
name: goal
description: Goal-driven execution loop — breakdown a user goal, deepen with design graphs, protocol the work, track in work-plans, execute via isolated herdr lanes, loop until done. Use ONLY when the user invokes `/goal`. This skill is `/goal`-scoped and does not govern ordinary sessions, other commands, or other agents.
---

# Goal

Turn a goal prompt into DONE through a loop. Each loop iteration is:
verify state → met? close : adjust → execute next wave. The loop ends only
when acceptance criteria hold and gates are green — never on effort spent.

Scope: this skill runs ONLY under an explicit `/goal` invocation. Its
guard and policies do NOT apply to ordinary sessions, other commands, or
other agents. Outside `/goal`, the normal global/repo AGENTS.md rules
govern.

Autonomy: `/goal` is full-auto AFTER the execution gate. Human gates
exist only before Phase 4 (goal clarity, design direction, protocol +
model/effort approval). Once execution starts, the loop never waits
for a human. Safety after the gate comes from automated rails below.
The user reads wave reports async; the loop never blocks on them.
Approving the execution gate pre-authorizes lanes end-to-end
(branch → commit → push → PR → auto-merge on green CI).
Invoking `/goal` IS the explicit ask for that close-out lifecycle:
every green+met DONE ends in commit → push → PR, no separate
envelope needed. The gate still approves scope and waves.

Runtime: opencode2 (v2) only. Assumed surfaces: herdr CLI (`pane
split/run`, `agent start/prompt/wait/read`), opencode2 flags (`--auto`,
`--prompt`, `--session`), V2 command frontmatter
(`description/agent/model/subtask`), project skill dir `.agents/skills/`,
project commands dir `.opencode/commands/`. If this session is not
opencode2, STOP and flag before doing anything.

## Main-session guard (orchestrator never codes — `/goal` only)

Applies only inside a `/goal` loop. The main session is the orchestrator,
not an implementer. It NEVER edits `app/`, `server/`, `shared/`, `cli/`,
`wireframes/`, `docs/*.md`, or any skill/config file, and never calls a
mutating tool against those paths. Every code or design-doc mutation is
delegated to an isolated herdr lane.

The orchestrator writes only the tracking plane directly:
`status/<plan>/` (`plan.md`, `status.md`, `lanes/<lane>.md`,
`report.md`), `status/TIMELINE.md`, and `mem_save`. It also drives
isolate, gates, review, PR, CI, and merge — it does not produce the diff.

Delegation:
- **`subagent` tool** — READ-ONLY only (research, exploration, review
  reading). A single foreground (inline, blocking) call. It never mutates
  files. Background or parallel `subagent` fan-out is banned.
- **herdr lane(s)** — the ONLY mutation vehicle. Simple = exactly one
  lane. Complex = one lane per track (1..N).

A mutation the orchestrator makes itself is a violation: stop, revert it
before proceeding, and re-dispatch the work to a lane.

## Simple vs complex (lane-count + review boundary — risk + scope)

Classify before designing. When unsure, it is complex. This does NOT pick
the vehicle (all mutations are herdr lanes) — it picks how many lanes and
how deep the review runs.

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

Route: **simple** → exactly one herdr lane in the single plan worktree.
**complex** → one herdr lane per track (1..N; single track = one lane).
File count is a hint, never a gate — classify on contract surface.

## Skill roster (load by ID; fall back, never stall)

| Phase | Skill ID | If missing |
|---|---|---|
| 1 UI | `design-graph` | design from wireframes + tokens directly, note gap |
| 1 backend/graph | `design-thinking` | Effect/codebase conventions from repo docs, note gap |
| 2 | graph-protocol in `design-thinking` references | order waves by dependency manually |
| 3 | `work-plans` | mirror its layout (`plan.md`/`status.md`/lanes/`report.md`/TIMELINE) manually |
| 4 lane | `herdr` | STOP + report — herdr is the only mutation vehicle |
| 4 FE | `frontend-tanstack` | repo `app/` conventions + wireframes, note gap |
| 4 BE | `backend` / `backend-effect-bun` | repo `server/` Effect patterns, note gap |
| 5 | `verification-before-completion` if present | evidence-before-assertion manually: paste gate outputs |

IDs change between sessions — a failed load is a signal, not an
error: record it in the lane/plan and continue with the fallback.
A skill that fails to load twice across different plans is stale:
propose a roster patch in the next plan report.
Never invent a skill ID.

## Phase 0 — Capture + breakdown + triage

1. Take the goal from the invocation (`/goal <text>`) or ask for it.
   (`/goal` with no goal is the ONE case that waits for user input.)
2. Break the goal into work items (what must be true when done, not how).
3. Ambiguous scope, missing acceptance, or architecture fork → ask the
   user with the question tool (this is the human-gated planning zone).
   Never guess on architecture; state what you would otherwise do.
4. Triage the route BEFORE designing, using § Simple vs complex.
   Isolation is NOT triaged: every route executes in a fresh worktree
   (Phase 4 isolate, after work-plans + gate) — never in the invoking
   checkout, which other agents share. The orchestrator never edits code
   in any route (§ Main-session guard).
   - **Simple** (all simple conditions hold): exactly one herdr lane in
     the single plan worktree. No second lane.
   - **Complex** (any complex condition holds): one herdr lane per track
     — one worktree + pane + agent each; a single-track complex task is
     still one lane. Full dispatch in Phase 4.
   State the chosen route + lane count + why in one line before proceeding.

## Phase 1 — Deepen (design before protocol)

- UI/surface work → design-graph: draw Surface<C,V,N> first. C = happy-path
  content flow, V = void states (empty/loading/partial/error/denied),
  N = needs (data/permission/prior-step/viewport).
- Backend/graph work → design-thinking: A = happy-path call graph,
  E = break points, R = dependencies. Applies to Effect-TS services and to
  subagent task graphs (delegated subgraph vs implemented graph — compare
  both before any gate; extra/missing node = off-script).
- Conflicting docs or requirements → STOP, report, wait. No scope creep:
  report missing pieces, don't build them.

## Phase 2 — Protocol (graph-protocol)

Order waves by dependency, not enthusiasm. Independent tracks may run in
parallel; dependent tracks WAIT (e.g. wireframe lane DONE — `src` edit +
build green — before any React lane starts). Name lanes, assign file
ownership per lane so parallel tracks never write the same files.

## Phase 3 — Track (work-plans)

One folder `status/<plan>/` (name `[a-z0-9-]`): `plan.md` (X/scope/graph/
lanes), `status.md` 3-line heartbeat (state/ts/msg, plan mirrors slowest
lane), `lanes/<lane>.md` per parallel track, `report.md` on DONE, one line
per event in `status/TIMELINE.md`. No loose files in `status/` root besides
`TIMELINE.md`. `mem_save` on DONE (summary + artifact paths).

Freeze acceptance in `plan.md` BEFORE any lane executes: one verifiable
criterion per work item, each paired with its verify command
(`tsc --noEmit`, which `test:*` lane, which manual smoke). Waves verify
against this frozen list — never invent new acceptance mid-execution.
Record the dispatched agent + its resolved model+variant per lane in
`plan.md` (R). Resolve the model from the role agent's markdown `model:`
field — `~/.config/opencode/agents/<role>.md` (source:
`~/projects/dotfiles/config/opencode/agents/<role>.md`). The agent md is
the single source of truth for model+effort.
Record the execution-gate ack in `plan.md` as `gate: <ISO8601> <who> <branch>`.
Prefix lane status msgs with `W<n>i<m>` so loop position survives scrollback.
Validate tracking with `bash .agents/skills/work-plans/scripts/plan-check.sh <plan>` at open and before DONE.

## Execution gate (LAST human gate — nothing human after this)

Present for one-shot approval: frozen acceptance, waves + lanes + file
ownership, chosen route + why, agent + resolved model+variant per lane
(from the agent md; question tool, no defaults), worktree path(s) + branch name(s),
autonomy envelope (worktree → branch → commit →
push → PR → auto-merge on green CI). Close-out runs on every
green+met DONE by the invocation itself, not by envelope enumeration.
User approves → Phase 4 isolates first (fresh worktree, § Phase 4),
then runs with zero further questions. User rejects/changes → adjust Phases
0–3, re-present. No approval = no execution. Approval lapses after
72h or if the goal text changed → re-present only the diff, not the
whole gate. Worktrees/branches always derive from latest `main` at dispatch;
post-approval main movement is handled by rebase-before-PR, not by
re-gating.
Fast path: triage = simple (all § Simple vs complex conditions hold) →
gate collapses to goal restatement + one scope line. Ack = any reply
without rejection or change request ("gas", "oke", "lanjut", 👍 all
count; "tunggu", "jangan", "ubah X" do not). Proceed on ack.

## Phase 4 — Execute (route by complexity, zero questions from here)

Isolate FIRST (mandatory, every route — immediately after gate approval,
before any code read/edit/gate/commit):
1. `git fetch origin main`; confirm `.worktrees/` is gitignored and no
   branch/path collision (`git worktree list`,
   `git branch -a | grep <name>`). Control-checkout dirt is EXPECTED
   (other agents share it) — never require a clean control checkout,
   never branch from its working tree.
2. Create the worktree(s) with the `lane-dispatch` guards: simple → one
   plan worktree `git worktree add -b <branch> .worktrees/<plan>
   origin/main`; complex → one per lane `.worktrees/<plan>-<lane>`
   (`<plan>` = work-plans folder name; suffix on collision, never reuse).
   Set up inside each (`bun install`; copy `.env` only if a smoke needs
   it — never commit it); baseline `tsc --noEmit` to confirm clean.
   `status/<plan>/` stays in the control checkout (tracking plane) — code
   work never touches control-checkout files after this point.
3. `git worktree add` failing (branch/path collision) → FAST EXIT naming
   the cause — never proceed unisolated in the control checkout.

Run the approved route. Every mutation is a herdr lane — the orchestrator
only dispatches, waits, reads, and verifies; it never edits files itself
(§ Main-session guard). Follow `references/lane-dispatch.md` for the exact
dispatch order (binary checks → worktree → pane → agent start → prompt →
read).

- **Simple** → exactly one lane in `.worktrees/<plan>`.
- **Complex** → one lane per track: worktree `.worktrees/<plan>-<lane>`
  (`.worktrees/` in `.gitignore`), one herdr pane per lane (`pane split
  --cwd <worktree> --no-focus`), one opencode2 agent IN each pane
  (`pane run` / `agent start --kind opencode`, drive via `agent prompt
  --wait`, read via `agent read`).

Every lane brief is self-contained (absolute worktree path, branch,
files+lines, acceptance, gate, no-commit, forbidden list); replies
caveman-compressed.
Forbidden in every lane brief (opencode2 `--auto` approves what is
not denied): act outside the assigned worktree, exfiltrate data beyond
declared fetches, `--force` or history rewrites on shared branches,
commit secrets. Violation kills the lane.
Pick lane agents by DISCOVERY, never hardcode IDs (available agents
change between sessions). For herdr, run `herdr agent` to list kinds and
match roles — implementer (bounded build/fix), reviewer
(correctness/scope/edge cases), researcher (docs/codebase lookup),
design/plan (multi-step breakdown). herdr kinds name backends, not roles —
the role travels in the brief: implementer → `swe`; researcher →
`researcher`; planner → `architect`; reviewer →
`reviewer`. The orchestrator's own `subagent` calls are read-only
(research/review) and pick their agent the same way — they never mutate.
herdr has no opencode2 kind: drive opencode2 with `opencode2 run --auto
--model` (a model with stored creds — see `opencode2 auth list`; the
default model errors `No cookie auth cred`); warm a fresh
agent with one trivial prompt before the brief. Wait for lane output
with `bun .agents/skills/goal/scripts/lane-wait.ts` (reactive
sentinel wait — never fixed `sleep`); the runner-file vehicle is
prescribed in `references/lane-dispatch.md` step 4.
Dispatch EVERY lane with an explicit `--model provider/model#variant` plus
`--agent <role>`. Resolve the ref by reading the role agent's markdown
`model:` field — `~/.config/opencode/agents/<role>.md` (source:
`~/projects/dotfiles/config/opencode/agents/<role>.md`) — and pass that
exact base+variant. The agent md is the single source of truth for
model+effort: never hardcode, guess, or invent one. If the role agent md
has no `model:`, use the gate-approved ref recorded in `plan.md` (R); if
neither exists → FAST EXIT naming the gap. The default model errors
(auth), and an agent's `model:` field does NOT auto-apply to a primary
`opencode2 run --agent` session (child/subagent sessions only) — which is
why it must be read and passed explicitly.
If no fitting agent exists, keep the lane WAIT and report the gap — the
orchestrator never does the lane's step itself. Never invent an agent
name — an unknown name fails the dispatch and burns a loop iteration.
Lane rules: a lane that hits a contract mismatch or needs out-of-scope
files flips to WAIT and reports — never guesses. Lanes may run their own
inline subagents while files/scopes don't collide. The orchestrator's
`subagent` calls are read-only and MUST NOT touch anything already
delegated; the orchestrator never edits files itself.
Lane lifecycle: keep worktree + branch until its PR merges (never delete
early); removal needs explicit user approval. Resume a dead lane agent
with opencode2 `--session` (state lives in the worktree, re-brief from
the lane file). Each lane runs `git status` FIRST inside its own worktree —
clean expected there; dirty from an unknown source → WAIT + report, never
build on top of it (control-checkout dirt is irrelevant — lanes never touch
it). If `HERDR_ENV` is not `1` → FAST EXIT with reason
(required: herdr session) — never fall back silently to another route,
never drive another client's panes. Binary check first: `herdr` and
`opencode2` must both resolve in the lane pane (`command -v`); either
missing → FAST EXIT naming the binary. `git worktree add` failing
(branch/path collision) → FAST EXIT naming the cause —
never proceed unisolated. Approved model erroring at dispatch →
FAST EXIT naming the model — never silently substitute another model
(cost/behavior was approved as-is).

## Phase 5 — Verify + loop (guarded)

Gate per route (lane runs its own row; orchestrator re-runs it at
integration — trust lane output, but verify before commit):
- wire: `bash wireframes/build.sh` exit 0 + grep built `dist/` for the
  changed copy. No `tsc` needed (static HTML).
- be: `tsc --noEmit` + `test:be` (or touched suites if full is slow) +
  `check:invariants` when `server/`/`shared/` touched.
- fe: `tsc --noEmit` + `test:fe`.
- docs-only: reviewer read (names/numbers match source files verbatim).
Evidence rule: paste gate output tails into the lane report — a bare
"tests pass" without output does not count as green. Attach the full
gate log path (`$GATE_LOG_DIR/gate-*.log` from `verify-gate.sh`)
alongside the tails.
Pre-existing failures: lane suite red → rerun the SAME suite on a
pristine `main` checkout → identical failure = pre-existing: declare
it in the PR body and proceed; new failure = lane fixes it first.
Scoped reruns and the pristine-main recipe live in
`git-workflow/references/checks.md`.
Missing tool: `command -v` first, then the closest equivalent, and
declare the deviation. Known pairs: `bunx` → `bun x`;
`tsc` → `bun run typecheck`.

End of every wave: gates + FROZEN acceptance. Green + met → reviewer
pass → report + DONE + `mem_save`. Red or unmet → adjust the plan,
record the deviation, next loop iteration.
Loop guard (no human to catch infinite loops, so the loop bounds
itself): max 3 iterations on the same wave without progress — progress
means ≥1 newly-green acceptance item or newly-green gate since the
last iteration, nothing else counts. No progress → park
that lane as WAIT, continue the others, and note the blocker in the
report. Hard cap 5 wave iterations per plan → close as PARTIAL with
blockers listed, never spin forever. Same point failing twice →
change strategy first. Blocked lane pieces are reported, not waited on.
The only halt-everything is secrets/credentials exposure: kill that
lane immediately and report.
Merge gate: PR auto-merges when CI is green. CI red → fix loop (counts
toward the loop guard); unfixable within budget → leave open + report.
Merge BLOCKED BY POLICY (e.g. required-human-review rule, not red CI)
→ leave open + report immediately, never burn loop iterations polling
it. PR body carries report excerpts (result + gate tails +
deviations) — `status/` is gitignored, so reports travel via the PR
body, not the repo. Worktree/branch removal after merge needs no approval inside `/goal`
(the invocation pre-authorized the full lifecycle); keep them until
merged, then clean up.

Reviewer + reply contract: every lane gets a reviewer pass (correctness,
scope, edge cases) before its PR; findings return to the lane, not
around it. No reviewer agent discoverable → orchestrator self-reviews
against a checklist (diff matches lane scope, acceptance re-checked,
edge cases probed, staged names secret-free) and records it in the
report. Lane findings live in the lane file (+ TIMELINE line);
`report.md` is owned by the orchestrator and aggregates lanes.
Review is reading, not coding — the orchestrator may run read-only
reviewer subagents without violating the guard.
Report progress per wave as: state, commit sha, one-line
test summary, concerns (if any) — nothing else.

Auto close-out: a wave that is green + met with its reviewer pass
recorded always commits on its branch (conventional message, body =
WHY), pushes (`git push -u origin <branch>`), and opens a PR (base
`main`, body = result + gate tails + deviations). Invoking `/goal`
is the explicit ask for this lifecycle (`git-workflow` §1 item 10 —
the invocation enumerates branch → commit → push → PR), so no
separate envelope is needed. Then the merge gate takes over.

## Edge cases (checklist, bukan opsional)

- Dirty worktree: the clean check runs INSIDE the fresh worktree (`git status`
  FIRST after creation) — clean expected there. Dirty from an unknown
  source → WAIT + report, never build on top of it. Control-checkout dirt
  is expected (shared with other agents) and never blocks isolate, because
  worktrees branch from `origin/main`, not the working tree.
- Shared-file collision: migrations numbering, CHANGELOGs, submodule
  gitlinks, and lockfiles are shared even when features look disjoint.
  Assign ownership explicitly at protocol time; on collision risk,
  serialize those files through one lane.
- Rebase before PR: main moves under lanes. Rebase each lane on latest
  `main` + re-run its gate before opening the PR. CI red caused by the
  rebase → fix loop (counts toward the loop guard).
- Files are truth: terminal scrollback is ephemeral. Lane progress
  lives in lane files + `report.md`. After context compaction, re-read
  `plan.md` + lane files AND run `mem_context` before continuing —
  never assume file or memory state. If `mem_context` returns
  unreadable, proceed on files alone and note it.
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
  session — every mutation goes to a herdr lane (simple = one lane,
  complex = one per track). The orchestrator's `subagent` calls are
  read-only. A self-made edit is a violation: revert it + re-dispatch.
- Repo bindings, in order, before touching code: design-system primitives
  → `docs/SCHEMA.md` (names + invariants verbatim) → `docs/LAYERS.md` →
  `docs/API.md` → wireframes → `docs/ARCHITECTURE.md` (rationale only).
  Docs conflict → STOP + report, never resolve alone.
- Destructive or irreversible steps (migrations, deletes, deploys,
  force-push, history rewrites) are auto-approved INSIDE lane
  branches/worktrees only — blast radius ends at the PR. Hard
  forbidden, no exceptions: mutating `main` outside PR flow,
  force-pushing shared branches, touching prod data, committing
  secrets (staged-name check runs before every commit; a hit kills
  the lane and is reported).
- Git guardrails before any git mutation (single trunk `main` — Section 4).
  Branch → PR → merge, never commit on `main`, never push/merge without
  explicit ask — invoking `/goal` counts as that ask for its close-out
  worktree/branch/commits/pushes/PRs. After isolate, every code mutation
  (edit, gate, commit) runs inside the assigned worktree — never in the
  control checkout. Stage files explicitly, check staged names for secrets.
- Wireframe-first for UI: `wireframes/src/` + build before React.
- Conventional commits (`feat|fix(scope): subject`, body = WHY).
- Submodule rule: commit+push inside the submodule first, then bump
  the pointer in the parent.
