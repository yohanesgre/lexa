# Lane dispatch (all mutation routes)

Every `/goal` mutation runs through a herdr lane. Simple route = exactly
one lane in `.worktrees/<plan>`; complex route = one lane per track
(`.worktrees/<plan>-<lane>`). The `subagent` tool is read-only only
(research/review) and never mutates; background or parallel `subagent`
fan-out is banned.

Order matters — run top to bottom, one lane at a time. Any FAST EXIT
stops that lane only; others continue.

1. Guards (control checkout, before worktree creation):
   ```bash
   test "${HERDR_ENV:-}" = 1          # else FAST EXIT, required: herdr session
   command -v herdr && command -v opencode2   # else FAST EXIT naming binary
   git fetch origin main
   git worktree list                  # no path collision
   git branch -a | grep <branch>      # no branch collision
   ```
   Control-checkout dirt is EXPECTED (other agents share it) — never gate
   on it. The clean check runs INSIDE the fresh worktree (step 2b).
2. Isolate: `git worktree add -b <branch> <worktree> origin/main` where
   `<worktree>` = `.worktrees/<plan>` for the simple route (one lane) or
   `.worktrees/<plan>-<lane>` for complex. `<plan>` = work-plans folder
   name; fails → FAST EXIT naming cause,
   never proceed unisolated. Then per-lane setup inside it
   (`bun install`; copy `.env` only if a smoke needs it — never commit it).
   2b. Clean check INSIDE the worktree: `git status --porcelain` — clean
   expected; dirty from an unknown source → WAIT + report.
3. Pane: `herdr pane split --current --direction right --cwd <worktree> --no-focus`
   (read the new pane ID from `.result.pane.pane_id`).
4. Agent: `herdr agent start <name> --kind <backend> --pane <pane-id>`
   (role travels in the brief, not the kind; mutation roles: `swe`,
   `designer` — read-only roles run as `subagent`, not lanes).
   No opencode2 kind exists — drive opencode2 without it: write the lane
   brief to a runner file `<worktree>/../<slug>-runner.sh` (or
   `/tmp/opencode/<slug>-runner.sh`), run `herdr pane run <pane>
   "bash <runner>"`, then wait with
   `bun .agents/skills/goal/scripts/lane-wait.ts <pane> <sentinel>
   [timeout-ms]`. The runner file keeps the sentinel out of the pane's
   command echo, so `wait-output --match` can only fire on real
   completion — never match on text that also appears in the dispatched
   command. `--model provider/model#variant` is required on every lane —
   read it from the role agent's md `model:` field
   (`~/.config/opencode/agents/<role>.md`) and pass it verbatim. The
   default model needs cookie auth (`No cookie auth cred`), and an agent's
   md `model:` pin does NOT auto-apply to a primary `opencode2 run --agent`
   session (child/subagent sessions only). Check `opencode2 auth list`
   first. Warm up with one trivial prompt first;
   a fresh `opencode` boot can fail with a postinstall error — record
   it and switch paths instead of retrying blindly.
   Approved model errors here → FAST EXIT naming the model, never substitute.
5. Drive: `herdr agent prompt <name> "<brief>" --wait --timeout 120000`;
   read via `herdr agent read <name> --source recent-unwrapped --lines 120`.
   Dead agent resumes with opencode2 `--session` (state lives in the worktree).
6. Brief = the delegated subgraph (`goal/SKILL.md` §4.2): WHY, Nodes (files
   + lines, one owner), Edges (inputs consumed / outputs produced),
   Governing docs, Acceptance (frozen), Gate (verify commands), Forbidden,
   Boundary (absolute worktree path, branch, no-commit). Include the lane's
   `--agent` + `--model` (model read from the role agent's md `model:` field).
7. Return = the implemented graph (`goal/SKILL.md` §4.3): Implemented
   (files + what changed), Evidence (gate tails + log path), Deviations
   (extra/missing nodes vs the delegated subgraph), Open. Replies
   caveman-compressed, except `reviewer` (full prose).
