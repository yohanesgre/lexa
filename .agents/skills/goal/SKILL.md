---
name: goal
description: Goal-driven execution loop — breakdown a user goal, deepen with design graphs, protocol the work, track in work-plans, execute via lanes, loop until done. Use whenever the user invokes /goal or states an outcome to achieve (fix, feature, refactor) that needs breakdown → design → protocol → plan → execute → verify → repeat. Even if they don't say "goal", prefer this for multi-step work with a clear end state.
---

# Goal

Turn a goal prompt into DONE through a loop. Each loop iteration is:
verify state → met? close : adjust → execute next wave. The loop ends only
when acceptance criteria hold and gates are green — never on effort spent.

Autonomy: `/goal` is full-auto AFTER the execution gate. Human gates
exist only before Phase 4 (goal clarity, design direction, protocol +
model/effort approval). Once execution starts, the loop never waits
for a human. Safety after the gate comes from automated rails below.
The user reads wave reports async; the loop never blocks on them.
Approving the execution gate pre-authorizes lanes end-to-end
(branch → commit → push → PR → auto-merge on green CI).

Runtime: opencode2 (v2) only. Assumed surfaces: herdr CLI (`pane
split/run`, `agent start/prompt/wait/read`), opencode2 flags (`--auto`,
`--prompt`, `--session`), V2 command frontmatter
(`description/agent/model/subtask`), project skill dir `.agents/skills/`,
project commands dir `.opencode/commands/`. If this session is not
opencode2, STOP and flag before doing anything.

## Skill roster (load by ID; fall back, never stall)

| Phase | Skill ID | If missing |
|---|---|---|
| 1 UI | `design-graph` | design from wireframes + tokens directly, note gap |
| 1 backend/graph | `design-thinking` | Effect/codebase conventions from repo docs, note gap |
| 2 | graph-protocol in `design-thinking` references | order waves by dependency manually |
| 3 | `work-plans` | mirror its layout (`plan.md`/`status.md`/lanes/`report.md`/TIMELINE) manually |
| 4 lane | `herdr` | STOP herdr control, fall back one route step |
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
4. Triage the route BEFORE designing — lanes cost overhead, so earn them:
   - **Sequential/simple** (one track, few files, low risk): work inline.
     No worktree, no lanes, no herdr.
   - **Simple + parallelizable** (≥2 independent tracks, small each,
     disjoint files): background subagents, no worktrees.
   - **Complex + parallelizable** (multi-file/risky tracks with disjoint
     file ownership): full lanes — worktree + herdr pane + opencode2
     per lane.
   Parallelizable means: tracks share no files AND no output depends on
   another track's output. If either fails, serialize. State the chosen
   route + why in one line before proceeding.

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
Record the dispatched model + thinking effort per lane in `plan.md` (R).
Record the execution-gate ack in `plan.md` as `gate: <ISO8601> <who> <branch>`.
Prefix lane status msgs with `W<n>i<m>` so loop position survives scrollback.
Validate tracking with `bash .agents/skills/work-plans/scripts/plan-check.sh <plan>` at open and before DONE.

## Execution gate (LAST human gate — nothing human after this)

Present for one-shot approval: frozen acceptance, waves + lanes + file
ownership, chosen route + why, model + thinking effort per lane
(question tool, no defaults), autonomy envelope (branch → commit →
push → PR → auto-merge on green CI). User approves → Phase 4 runs
with zero further questions. User rejects/changes → adjust Phases
0–3, re-present. No approval = no execution. Approval lapses after
72h or if the goal text changed → re-present only the diff, not the
whole gate. Lanes always branch from latest `main` at dispatch;
post-approval main movement is handled by rebase-before-PR, not by
re-gating.
Fast path: triage = sequential/simple → gate collapses to goal
restatement + one scope line. Ack = any reply without rejection or
change request ("gas", "oke", "lanjut", 👍 all count; "tunggu",
"jangan", "ubah X" do not). Proceed on ack.

## Phase 4 — Execute (route by complexity, zero questions from here)

Run the approved route:

- **Complex + parallelizable** → one git worktree per lane
  (`.worktrees/<slug>`, never `.slim/`; `.worktrees/` in `.gitignore`),
  one herdr pane per lane (`pane split --cwd <worktree> --no-focus`),
  one opencode2 agent IN each pane (`pane run` / `agent start --kind
  opencode`, drive via `agent prompt --wait`, read via `agent read`).
  Lane briefs are self-contained (worktree, branch, files+lines,
  acceptance, gate, no-commit, forbidden list); replies
  caveman-compressed. Follow `references/lane-dispatch.md` for the
  exact dispatch order (binary checks → worktree → pane → agent
  start → prompt → read).
  Forbidden in every lane brief (opencode2 `--auto` approves what is
  not denied): act outside the lane worktree, exfiltrate data beyond
  declared fetches, `--force` or history rewrites on shared branches,
  commit secrets. Violation kills the lane.
  Pick lane agents by DISCOVERY, never hardcode IDs (available agents
  change between sessions). For the subagent tool, read the session's
  agent list and match by role: implementer (bounded build/fix),
  reviewer (correctness/scope/edge cases), researcher (docs/codebase
  lookup), planner (multi-step breakdown). For herdr, run `herdr agent`
  to list kinds and match the same roles. herdr kinds name backends,
  not roles — the role travels in the brief: implementer → subagent
  `swe`; researcher → `explorer-jr` / `librarian-jr`;
  planner → `planner`; reviewer → `reviewer`. herdr has no opencode2
  kind: drive opencode2 with `opencode2 run --auto --model` (a model
  with stored creds — see `opencode2 auth list`; the default model
  errors `No cookie auth cred`); warm a fresh
  agent with one trivial prompt before the brief. Wait for lane output
  with `bun .agents/skills/goal/scripts/lane-wait.ts` (reactive
  sentinel wait — never fixed `sleep`); the runner-file vehicle is
  prescribed in `references/lane-dispatch.md` step 4.
  Dispatch with `--model`/`--agent` matching the `plan.md` (R) record.
  If no fitting agent exists,
  do the step inline and record the gap. Never invent an agent name —
  an unknown name fails the dispatch and burns a loop iteration.
- **Simple + parallelizable** → background subagents via the subagent
  tool, no worktrees. Same self-contained briefs.
- **Sequential/simple** → work inline, no lanes.

Lane rules: a lane that hits a contract mismatch or needs out-of-scope
files flips to WAIT and reports — never guesses. Lanes may spawn
subagents while files/scopes don't collide. The orchestrator may also
use subagents but MUST NOT touch anything already delegated.
Lane lifecycle: keep worktree + branch until its PR merges (never delete
early); removal needs explicit user approval. Resume a dead lane agent
with opencode2 `--session` (state lives in the worktree, re-brief from
the lane file). If `HERDR_ENV` is not `1` → FAST EXIT with reason
(required: herdr session) — never fall back silently to another route,
never drive another client's panes. Binary check first: `herdr` and
`opencode2` must both resolve in the lane pane (`command -v`); either
missing → FAST EXIT naming the binary. `git worktree add` failing
(dirty tree, branch/path collision) → FAST EXIT naming the cause —
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
Report progress per wave as: state, commit sha, one-line
test summary, concerns (if any) — nothing else.

Auto close-out: a wave that is green + met with its reviewer pass
recorded commits on its branch (conventional message, body = WHY),
pushes (`git push -u origin <branch>`), and opens a PR (base `main`,
body = result + gate tails + deviations) — but ONLY when the
execution-gate envelope pre-authorized commit + push + PR with the
branch name enumerated (per-action rule, `git-workflow` §1 item 10).
Then the merge gate takes over. No envelope = report back and wait.

## Edge cases (checklist, bukan opsional)

- Dirty worktree: lane runs `git status` FIRST — clean expected. Dirty
  from an unknown source → WAIT + report, never build on top of it.
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
  name (date/slug) — never reuse. Lane briefs pin the binary PATH and
  set cwd to the lane worktree (missing tools = declare deviation,
  use closest equivalent).

## Standing guardrails (every loop)

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
  explicit ask. Stage files explicitly, check staged names for secrets.
- Wireframe-first for UI: `wireframes/src/` + build before React.
- Conventional commits (`feat|fix(scope): subject`, body = WHY).
- Submodule rule: commit+push inside the submodule first, then bump
  the pointer in the parent.
