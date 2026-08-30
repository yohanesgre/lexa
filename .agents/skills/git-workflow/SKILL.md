---
name: git-workflow
description: Enforce Lexa git workflow rules and guardrails — branching, commits, pushes, PRs, releases, worktrees, and swarm lane discipline. Use whenever the user or agent touches git: creating branches/worktrees, committing, pushing, merging, tagging releases, handling wireframes submodule, or asks about git rules, commit conventions, or "boleh commit/push?".
---

# Git Workflow — Rules & Guardrails (Lexa)

Single source for git discipline on Lexa. All lanes (orchestrator, @fixer, @designer) follow this, even when docs say "just commit".

## 0. Trigger

Use this skill whenever:
- creating/switching branches or worktrees
- staging/committing, writing commit messages
- pushing, force-pushing, merging, rebasing, cherry-picking
- tagging `v*` / `cli-v*` releases
- touching `wireframes/` submodule
- answering "boleh commit/push/merge?" or reviewing git history
- any `git` command that mutates remote or branch state

If you skip this skill, you will break a guardrail. Read it first.

## 1. Non-negotiable guardrails

These are never negotiable — report conflict, don't "fix" it yourself:

1. **Single trunk: `main` never receives direct commits.** Every task creates a new branch from `main`, work there, then PR → merge. Even docs/one-liners follow this.
2. **No commit unless user explicitly asked.** "commit this", "commit with message X", or orchestrator approval. Never auto-commit after edits — and never on `main`.
3. **No push unless user explicitly asked.** Never `git push`, `git push --force`, or `gh` publish without exact instruction.
4. **No merge/rebase/cherry-pick unless user explicitly asked.** Present options, wait for choice (see `finishing-a-development-branch` skill for merge menu — default is push + PR).
5. **No scope creep.** Only files/changes in the brief. If something missing, report — don't add table/column/endpoint/error code.
6. **Names exact.** Table/column/error code/route/config key must match `docs/*.md` verbatim.
7. **Wireframes submodule is commit-inside-first.** See §6.
8. **No secrets.** Never commit `.env`, `*.pem`, `*.private-key.pem`, `~/.lexa/**/config.json`, or any token. CI runs gitleaks — it will block.
9. **Phase gates green before commit/PR/tag.** See §4.

Violation = stop and ask user. Never silent-fallback.

## 2. Branching — single trunk (`main`)

- `main` is single trunk — never commit directly. Every change (feat/fix/chore/docs/refactor, even 1-line) starts from `main` in a separate branch, then PR → merge to `main`. No exceptions — `chore(release)` and hotfixes also via branch + PR.
- Branch naming:
  - Worktree lanes (preferred for parallel/risky work): `omos/<slug>` → path `.slim/worktrees/<slug>` (see `worktrees` skill).
  - Simple fix/feature (single lane, low risk): `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>` — kebab-case, short.
  - Swarm lanes: branch per lane slug (orchestrator assigns).
  - Release branch: `chore/release-vX.Y.Z` (or `release/<version>`) → PR to `main`, tag after merge (see §7).
- Flow: `git checkout main && git pull && git checkout -b <branch>` (or `git worktree add -b <branch> .slim/worktrees/<slug> main`). Keep branch rebased on `main` if trunk moves: `git fetch && git rebase origin/main` (or merge `main` into branch) — never rewrite `main`.
- Before `git worktree add` or `git checkout -b`:
  ```bash
  git status --porcelain  # must decide: stash or commit dirty state?
  git branch -a | grep <name>  # no collision local/remote
  git worktree list  # no path collision
  cat .gitignore | grep ".slim/worktrees"  # must be ignored (worktrees skill adds block)
  ```
- Ask user confirmation before `worktree add`, branch create/delete/rename, `prune`, or any destructive op (`reset --hard`, `clean`, `push --force`, removing dirty worktree).

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

- [ ] `tsc --noEmit` green (all lanes)
- [ ] `vitest run` green for touched pure modules; full suite if schema/service changed
- [ ] `bun run check:invariants` green if touched `server/`, `shared/`, or `scripts/check-invariants.ts`
- [ ] `bash wireframes/build.sh` green if touched `wireframes/src/`; `wireframes/dist/` never edited directly
- [ ] No `any` outside JSON boundaries, no stray `console.log`, no `.env`/`.pem` staged (`git diff --cached --name-only`)
- [ ] No file outside lane scope (designer vs fixer boundaries in AGENTS.md)
- [ ] Commit message follows §3.1 and `git diff --cached --stat` matches intent

Quick gate:
```bash
bun run typecheck 2>&1 | tail -20   # or tsc --noEmit
bun run test 2>&1 | tail -30
bun run check:invariants 2>&1 | tail -20
git diff --cached --name-only
```

Use `scripts/verify-gate.sh` (this skill) for one-shot gate.

### 3.3 Staging

- Stage explicitly: `git add <file> <file>` — never `git add -A` without reviewing `git status`.
- Verify staged: `git diff --cached` before committing.

## 4. Push rules

- No push without user saying "push", "push branch X", or picking PR option in finishing menu.
- Before push:
  ```bash
  git status
  git log --oneline origin/main..HEAD  # what you're about to publish
  git diff origin/main...HEAD --stat
  ```
- Never `push --force` on `main` or shared branch. Force only on your own feature branch with explicit "force push" permission, and prefer `--force-with-lease`.
- Push naming: `git push -u origin <branch>` (or `HEAD:refs/heads/<branch>` for detached HEAD).

## 5. PR & merge rules — branch → PR → trunk

- Always `branch → push → PR → review → merge to main`. Never `commit on main` or `merge locally without PR` unless user explicitly says "merge locally" (then still via menu).
- Use `finishing-a-development-branch` skill menu verbatim when work complete. Default choice = **2. Push and create PR** (trunk workflow). Option 1 (merge locally) only if user explicitly wants local integration without GitHub review.
- Branch must be green before PR:
  ```bash
  bash .agents/skills/git-workflow/scripts/verify-gate.sh
  git log --oneline origin/main..HEAD
  git diff origin/main...HEAD --stat
  ```
- PR: base = `main` (confirm if plan says otherwise), title = conventional commit style, description = what/why, docs conflicts (if any), gate outputs (`tsc`, `vitest`, `check:invariants`), testing notes. Use template if repo has one.
- After PR approved and CI green, merge via GitHub (squash or merge commit per repo setting — don't force-push to `main`). After `git merge <feature>` locally (only when user picks local merge), re-run `vitest run` + `tsc --noEmit` on merged result before pushing.
- Never delete worktree/branch until PR merged or user typed `discard` (finishing skill rule). Keep worktree for PR feedback.

## 6. Wireframes submodule

- Never edit `wireframes/dist/` (generated).
- Edit `wireframes/src/` → `bash wireframes/build.sh`.
- Commit **inside** submodule first:
  ```bash
  cd wireframes && git add <src files> && git commit -m "feat(wireframes): <msg>" && git push
  cd .. && git add wireframes && git commit -m "chore: bump wireframes to <sha> (<desc>)"
  ```
- Parent commit must record new pointer; submodule must be pushed so clones resolve.
- Frontend lanes (@designer/@fixer) must copy new wireframe CSS classes into `app/styles/phosphor.css` — they don't exist in app until ported.

## 7. Release (web + CLI independent) — via branch + PR

See `docs/RELEASING.md` — never improvises, adapted to trunk workflow:

1. Create branch `chore/release-vX.Y.Z` from `main`.
2. Both `CHANGELOG.md` + `cli/CHANGELOG.md` have dated `## [X.Y.Z] - YYYY-MM-DD` sections.
3. `tsc --noEmit`, `vitest run`, `bash wireframes/build.sh` green on branch.
4. Commit on branch: `chore(release): vX.Y.Z, cli-vX.Y.Z` (one commit, both bumps).
5. Push branch → PR to `main` → merge after review. Then on `main` (after pull):
    ```bash
    git tag -a vX.Y.Z -m "<one-line summary>"
    git tag -a cli-vX.Y.Z -m "<one-line summary>"
    git push origin vX.Y.Z cli-vX.Y.Z   # only after user approval
    ```
Direct tag/commit on `main` without PR is blocked — release also goes through branch + PR.

## 8. Swarm / lane discipline

- Respect `status/briefs/<lane>.md` + `status/<lane>.md` contract (AGENTS.md § Status protocol).
- `DONE` requires: gate green + lane tests + `status/reports/<lane>.md` + status `DONE`. DONE ≠ reviewed.
- If blocked on BE contract: `state: WAIT`, stop, orchestrator pings BE.
- Never touch files outside lane scope. Need endpoint/type → report to orchestrator.
- Every task mutation invariants (§ ARCHITECTURE.md) still apply — don't bypass them to "make commit pass".

## 9. Emergency & recovery

- Bad commit on feature branch (not pushed): `git reset --soft HEAD~1` or `git commit --amend` with user approval.
- Bad push on feature branch: revert commit `git revert <sha>` preferred over force. Force only with explicit approval.
- Bad merge to `main`: `git revert -m 1 <merge-sha>` — never `reset --hard` on `main`.
- Secrets leaked: rotate key immediately, `git rm --cached` + commit, don't rewrite history without user + infra approval.

## 10. Quick reference

| Action | Needs user ask? | Gate |
|---|---|---|
| `worktree add` / branch create | yes | §2 checks |
| `git commit` | yes | §3.2 checklist |
| `git push` | yes | §4 checks |
| `git merge/rebase` | yes | menu + re-verify gate |
| `git tag v*` | yes | §7 checklist |
| `push --force` | explicit "force" | `--force-with-lease` only |

## 11. Scripts

- `scripts/verify-gate.sh` — one-shot phase gate (`tsc`, `vitest`, `check:invariants`, wireframes if needed, secret/staged check).
- `references/checks.md` — detailed gate commands and CI parity notes.

When in doubt: stop, state what you'd do, ask. Guessing on git history is expensive to undo.
