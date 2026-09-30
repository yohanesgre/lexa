# Plan: release-prep
created: 2026-09-30
state: WORKING
gate: 2026-09-30 user-approved envelope — branch `chore/release-v2026.4.0`, plain branch (no worktree), wireframes ff-merge+push, commits, push branch, open PR. Auto-merge, tagging, and the release cut are a LATER step.

## X (problem)
Six release-prep gaps judged against `docs/RELEASING.md` would have made the
2026.4.0/2026.5.0 release cut wrong or unreproducible: the pre-tag checklist
describes artifacts that no longer exist, it contradicts itself on how a web
app upgrade happens, it has no push or post-tag verification step, the pinned
wireframes pointer is not on the wireframes trunk, versions/changelogs still
sit at the previous release, and `status/TIMELINE.md` carries an uncommitted
325-line mass deletion.

Evidence: `.tmp/release-prep-facts.md` (untracked).

## Scope
- In:
  1. docs stale steps — replace the packed/embed checklist item (3).
  2. deploy contradiction — fix the "upgrades go through `deploy`" sentence.
  3. missing push + verify checklist items.
  4. wireframes pointer — fast-forward wireframes `main` to `e18a4ab` and push.
  5. version/changelog bump — app `2026.4.0`, CLI `2026.5.0`, both changelogs dated.
  6. timeline — restore `status/TIMELINE.md` from HEAD, keep only genuinely new lines.
- Out (explicit non-scope):
  - Tagging (`v2026.4.0`, `cli-v2026.5.0`) and the actual release cut.
  - Merging this PR to `main` (auto-merge is a later step).
  - Any application behavior change.
  - Deleting wireframes branches (report-only, including the stale `fix/design-system-wiki-primitives`).

## Graph A (happy path)
```ts
wireframes ff main → e18a4ab + push
  → branch chore/release-v2026.4.0
  → timeline restore + append new lines
  → RELEASING.md (3 doc fixes)
  → version bumps + dated changelogs
  → plan/status/report artifacts
  → verify-gate green
  → 3 commits → push branch → PR (no tags)
```

## E (break points)
| Node | Break | Treatment |
|---|---|---|
| wireframes | submodule tree dirty | STOP, report — do not merge |
| wireframes | `merge-base --is-ancestor` fails (non-ff) | STOP, report — do not force |
| gate | `verify-gate.sh` red | STOP, report tail, no commit |
| push | rejected | STOP, report, no force |
| changelog | commit is `chore`/internal, not user-facing | leave out, note as concern |
| timeline | line ambiguous as new-vs-restored | drop it, report |

## R
- Files: `docs/RELEASING.md`, `package.json`, `cli/package.json`, `CHANGELOG.md`, `cli/CHANGELOG.md`, `status/TIMELINE.md`, `status/release-prep/*`
- Submodule: `wireframes/` (merge + push, envelope-approved)
- Gate: `bash scripts/verify-gate.sh`
- PR: `gh pr create --base main` (no merge, no tag)
- memory: `icm_memory_store` on DONE (summary + plan.md/report.md paths)

## Memory
- `icm_memory_store` on DONE: summary + paths to plan.md and report.md
