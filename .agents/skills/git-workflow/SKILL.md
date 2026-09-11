---
name: git-workflow
description: 'Lexa git rules and guardrails — single-trunk branching, commits, pushes, PR/merge discipline, wireframes submodule, and releases. Use whenever touching git on Lexa: creating branches/worktrees, committing, pushing, merging, tagging, handling the wireframes submodule, or answering "boleh commit/push?".'
---

# Git Workflow — Rules & Guardrails (Lexa)

Git discipline for this repo. Self-contained — no other skills required.

## 0. Trigger

Use this skill whenever you touch git:
- creating/switching branches or worktrees
- staging/committing, writing commit messages
- pushing, force-pushing, merging, rebasing, cherry-picking
- tagging `v*` / `cli-v*` releases
- touching the `wireframes/` submodule
- answering "boleh commit/push/merge?" or reviewing git history
- any `git` command that mutates remote or branch state

If you skip this skill, you will break a guardrail. Read it first.

## 1. Non-negotiable guardrails

These are never negotiable — report conflict, don't "fix" it yourself:

1. **Single trunk: `main` never receives direct commits.** Every task creates a new branch from `main`, work there, then PR → merge. Even docs/one-liners follow this.
2. **No commit unless the user explicitly asked.** "commit this", "commit with message X", or an approved execution gate. Never auto-commit after edits — and never on `main`.
3. **No push unless the user explicitly asked.** Never `git push`, `git push --force`, or `gh` publish without an exact instruction.
4. **No merge/rebase/cherry-pick unless the user explicitly asked.** Present the options, wait for the choice. Default when work completes = push + PR.
5. **No scope creep.** Only files/changes in the brief. If something is missing, report — don't add tables/columns/endpoints/error codes.
6. **Names exact.** Table/column/error code/route/config key must match `docs/*.md` verbatim.
7. **The wireframes submodule is commit-inside-first.** See §6.
8. **No secrets.** Never commit `.env`, `*.pem`, `*.private-key.pem`, `~/.lexa/**/config.json`, or any token. CI runs gitleaks — it will block.
9. **Gates green before commit/PR/tag.** See §3.2.
10. **Authorization is per-action, never transitive.** "commit dan push" covers exactly commit + push — never branch create, worktree add, PR open, merge, rebase, or force-push. Each mutating step needs its own explicit ask. Approval envelopes (e.g. `/goal` execution gates) must enumerate every lifecycle step they pre-authorize, including the branch name.

Violation = stop and ask the user. Never silent-fallback.

## 2. Branching — single trunk (`main`)

- `main` is single trunk — never commit directly. Every change (feat/fix/chore/docs/refactor, even 1-line) starts from `main` in a separate branch, then PR → merge to `main`. No exceptions — `chore(release)` and hotfixes also go via branch + PR.
- Branch naming:
  - Worktree lanes (preferred for parallel/risky work): `omos/<slug>` → path `.worktrees/<slug>`.
  - Simple fix/feature (single lane, low risk): `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>` — kebab-case, short.
  - Swarm lanes: branch per lane slug (orchestrator assigns).
  - Release branch: `chore/release-vX.Y.Z` (or `release/<version>`) → PR to `main`, tag after merge (see §7).
- Flow: `git checkout main && git pull && git checkout -b <branch>` (or `git worktree add -b <branch> .worktrees/<slug> main`). Keep the branch rebased on `main` if trunk moves: `git fetch && git rebase origin/main` (or merge `main` into the branch) — never rewrite `main`.
- Before `git worktree add` or `git checkout -b`:
  ```bash
  git status --porcelain          # decide: stash or commit dirty state?
  git branch -a | grep <name>     # no collision local/remote
  git worktree list               # no path collision
  grep ".worktrees" .gitignore    # must be ignored when using worktrees
  ```
- Ask user confirmation before `worktree add`, branch create/delete/rename, `prune`, or any destructive op (`reset --hard`, `clean`, `push --force`, removing a dirty worktree).

## 3. Commit rules

### 3.1 Conventional commits (enforced)

```
<type>(<scope>): <subject>
```
- `type`: `feat`, `fix`, `refactor`, `docs`, `chore`, `ci`, `test`, `perf`, `build` — lower case, no custom types.
- `scope` optional, kebab or one word: `auth`, `herald`, `board`, `sync`, `cli`, `schema`.
- `subject`: imperative, ≤50 chars, no period. Example: `feat(board): add WIP limit guard`
- Body (when needed): explains WHY, not WHAT. Wrap at ~72 chars.
- Breaking change: `feat!: drop Node 18` + `BREAKING CHANGE:` footer if migration needed.

Bad: `update fix`, `WIP`, `feat: stuff`. Good: `fix(sync): suppress echo via github_synced_state`.

### 3.2 Commit guardrail checklist (run before `git commit`)

Every commit must pass — if any fails, fix first, don't commit:

- [ ] `bun run typecheck` (`tsc --noEmit`) green
- [ ] `bun run test` green for touched modules; full suite if schema/service changed
- [ ] `bun run check:invariants` green if `server/`, `shared/`, or `scripts/check-invariants.ts` touched
- [ ] `bash wireframes/build.sh` green if `wireframes/src/` touched; `wireframes/dist/` never edited directly
- [ ] No `any` outside JSON boundaries, no stray `console.log`, no `.env`/`.pem` staged (`git diff --cached --name-only`)
- [ ] No file outside lane scope (agent boundaries in the repo `AGENTS.md`)
- [ ] Commit message follows §3.1 and `git diff --cached --stat` matches intent

One-shot gate (preferred):
```bash
bash scripts/verify-gate.sh
```
Manual equivalent:
```bash
bun run typecheck 2>&1 | tail -20
bun run test 2>&1 | tail -30
bun run check:invariants 2>&1 | tail -20
git diff --cached --name-only
```

### 3.3 Staging

- Stage explicitly: `git add <file> <file>` — never `git add -A` without reviewing `git status`.
- Verify staged: `git diff --cached` before committing.

## 4. Push rules

- No push without the user saying "push", "push branch X", or picking the push+PR option when work completes.
- Before push:
  ```bash
  git status
  git log --oneline origin/main..HEAD  # what you're about to publish
  git diff origin/main...HEAD --stat
  ```
- Never `push --force` on `main` or a shared branch. Force only on your own feature branch with explicit "force push" permission, and prefer `--force-with-lease`.
- Push naming: `git push -u origin <branch>` (or `HEAD:refs/heads/<branch>` for detached HEAD).

## 5. PR & merge rules — branch → PR → trunk

- Always `branch → push → PR → review → merge to main`. Never commit on `main`, and never merge locally without a PR unless the user explicitly says "merge locally".
- When work completes, present exactly two options and wait: **(1) merge locally** (only if the user wants local integration without GitHub review) or **(2) push and create a PR** (default). Do not act until the user picks.
- Branch must be green before PR:
  ```bash
  bash scripts/verify-gate.sh
  git log --oneline origin/main..HEAD
  git diff origin/main...HEAD --stat
  ```
- PR: base = `main` (confirm if the plan says otherwise), title = conventional commit style, description = what/why, docs conflicts (if any), gate outputs (`tsc`, `vitest`, `check:invariants`), testing notes. Use the repo template if present.
- After PR approved and CI green, merge via GitHub (squash or merge commit per repo setting — never force-push to `main`). After a local merge (only when the user picks option 1), re-run the gate on the merged result before pushing.
- Never delete a worktree/branch until its PR is merged or the user says `discard`. Keep the worktree for PR feedback.

## 6. Wireframes submodule

- Never edit `wireframes/dist/` (generated).
- Edit `wireframes/src/` → `bash wireframes/build.sh`.
- Commit **inside** the submodule first:
  ```bash
  cd wireframes && git add <src files> && git commit -m "feat(wireframes): <msg>" && git push
  cd .. && git add wireframes && git commit -m "chore: bump wireframes to <sha> (<desc>)"
  ```
- The parent commit must record the new pointer; the submodule must be pushed so clones resolve.
- Frontend implementation must port new wireframe CSS classes into `app/styles/phosphor.css` — they don't exist in the app until ported.

## 7. Release (web + CLI independent) — via branch + PR

See `docs/RELEASING.md` — never improvise:

1. Create branch `chore/release-vX.Y.Z` from `main`.
2. Both `CHANGELOG.md` + `cli/CHANGELOG.md` get dated `## [X.Y.Z] - YYYY-MM-DD` sections.
3. `bun run typecheck`, `bun run test`, `bash wireframes/build.sh` green on the branch.
4. Commit on the branch: `chore(release): vX.Y.Z, cli-vX.Y.Z` (one commit, both bumps).
5. Push branch → PR to `main` → merge after review. Then on `main` (after pull):
   ```bash
   git tag -a vX.Y.Z -m "<one-line summary>"
   git tag -a cli-vX.Y.Z -m "<one-line summary>"
   git push origin vX.Y.Z cli-vX.Y.Z   # only after user approval
   ```
Direct tag/commit on `main` without PR is blocked — releases also go through branch + PR.

## 8. Emergency & recovery

- Bad commit on a feature branch (not pushed): `git reset --soft HEAD~1` or `git commit --amend` with user approval.
- Bad push on a feature branch: `git revert <sha>` preferred over force. Force only with explicit approval.
- Bad merge to `main`: `git revert -m 1 <merge-sha>` — never `reset --hard` on `main`.
- Secrets leaked: rotate the secret immediately, `git rm --cached` + commit, don't rewrite history without user + infra approval.

## 9. Quick reference

| Action | Needs user ask? | Gate |
|---|---|---|
| `worktree add` / branch create | yes | §2 checks |
| `git commit` | yes | §3.2 checklist |
| `git push` | yes | §4 checks |
| `git merge/rebase` | yes | option menu + re-verify gate |
| `git tag v*` / `cli-v*` | yes | §7 checklist |
| `push --force` | explicit "force" | `--force-with-lease` only |

## 10. Scripts

- `scripts/verify-gate.sh` — one-shot phase gate (`tsc`, `vitest`, `check:invariants`, wireframes when needed, secret/staged check).
- `scripts/checks.md` — detailed gate commands and CI parity notes.

When in doubt: stop, state what you'd do, ask. Guessing on git history is expensive to undo.
