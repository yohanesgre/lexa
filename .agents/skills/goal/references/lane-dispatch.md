# Lane dispatch (complex + parallelizable)

Order matters — run top to bottom, one lane at a time. Any FAST EXIT
stops that lane only; others continue.

1. Guards (in the lane pane, before anything else):
   ```bash
   test "${HERDR_ENV:-}" = 1          # else FAST EXIT, required: herdr session
   command -v herdr && command -v opencode2   # else FAST EXIT naming binary
   git status --porcelain            # clean expected; dirty from unknown source → WAIT
   git worktree list                  # no path collision
   ```
2. Isolate: `git worktree add -b <branch> .worktrees/<slug> main`
   (fails → FAST EXIT naming cause, never proceed unisolated).
3. Pane: `herdr pane split --current --direction right --cwd <worktree> --no-focus`
   (read the new pane ID from `.result.pane.pane_id`).
4. Agent: `herdr agent start <name> --kind <backend> --pane <pane-id>`
   (role travels in the brief, not the kind; map in `goal/SKILL.md` Phase 4).
   No opencode2 kind exists — drive opencode2 without it: write the lane
   brief to a runner file `<worktree>/../<slug>-runner.sh` (or
   `/tmp/opencode/<slug>-runner.sh`), run `herdr pane run <pane>
   "bash <runner>"`, then wait with
   `bun .agents/skills/goal/scripts/lane-wait.ts <pane> <sentinel>
   [timeout-ms]`. The runner file keeps the sentinel out of the pane's
   command echo, so `wait-output --match` can only fire on real
   completion — never match on text that also appears in the dispatched
   command. `--model` is required: the
   default model needs cookie auth (`No cookie auth cred`); check
   `opencode2 auth list` first. Warm up with one trivial prompt first;
   a fresh `opencode` boot can fail with a postinstall error — record
   it and switch paths instead of retrying blindly.
   Approved model errors here → FAST EXIT naming the model, never substitute.
5. Drive: `herdr agent prompt <name> "<brief>" --wait --timeout 120000`;
   read via `herdr agent read <name> --source recent-unwrapped --lines 120`.
   Dead agent resumes with opencode2 `--session` (state lives in the worktree).
6. Brief must hold: worktree, branch, files+lines, acceptance, gate,
   no-commit, forbidden list (`goal/SKILL.md` Phase 4). Replies caveman-compressed.
