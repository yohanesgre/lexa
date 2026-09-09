# Lane dispatch (complex + parallelizable)

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
2. Isolate: `git worktree add -b <branch> .worktrees/<plan>-<lane> origin/main`
   (`<plan>` = work-plans folder name; fails → FAST EXIT naming cause,
   never proceed unisolated). Then per-lane setup inside it
   (`bun install`; copy `.env` only if a smoke needs it — never commit it).
   2b. Clean check INSIDE the worktree: `git status --porcelain` — clean
   expected; dirty from an unknown source → WAIT + report.
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
6. Brief must hold: absolute worktree path, branch, files+lines, acceptance, gate,
   no-commit, forbidden list (`goal/SKILL.md` Phase 4). Replies caveman-compressed.
