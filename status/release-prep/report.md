# Report: release-prep
created: 2026-09-30
sessions: steward (release-prep landing, approved envelope)
result: 6 release-prep gaps fixed on `chore/release-v2026.4.0` — RELEASING.md stale steps corrected + push/verify items added, wireframes `main` fast-forwarded to `e18a4ab` and pushed, versions bumped to app `2026.4.0` / CLI `2026.5.0` with both changelogs dated `2026-09-30`, `status/TIMELINE.md` restored from HEAD with only genuinely new lines kept. NO tags cut, NO merge — both are a later step.

## Files

| File | Change |
|---|---|
| `docs/RELEASING.md` | checklist item 3 replaced (packed/embed step was dead), new items 7 (push) + 8 (verify), L89-90 upgrade sentence fixed |
| `package.json:3` | `2026.3.0` → `2026.4.0` |
| `cli/package.json:3` | `2026.4.0` → `2026.5.0` |
| `CHANGELOG.md` | `## [Unreleased]` → `## [2026.4.0] - 2026-09-30`; fresh empty `## [Unreleased]` above; 6 Added + 5 Fixed bullets added (11 total) |
| `cli/CHANGELOG.md` | `## [Unreleased]` → `## [2026.5.0] - 2026-09-30`; fresh empty `## [Unreleased]` above; 3 Fixed bullets added |
| `status/TIMELINE.md` | restored from HEAD; 112 new 2026-09-29/30 lines appended; 1 release-prep PLAN line; **0 deletions** |
| `status/release-prep/plan.md`, `status.md`, `report.md` | this plan |

Submodule `wireframes/` was already pinned at `e18a4ab` in the parent, so
**no parent pointer commit was needed** — the fix was making that commit
reachable from the wireframes trunk.

## Wireframes (step 1)

```
git -C wireframes fetch origin            # clean tree
git -C wireframes checkout main
git -C wireframes merge --ff-only origin/main   # 109f0d2 -> 2a36235
git -C wireframes merge-base --is-ancestor main fix/mention-initial-suggestions  # ANCESTOR-OK
git -C wireframes merge --ff-only fix/mention-initial-suggestions  # 2a36235 -> e18a4ab
git -C wireframes push origin main        # 2a36235..e18a4ab  main -> main
git -C wireframes branch -r --contains HEAD
  origin/HEAD -> origin/main
  origin/fix/mention-initial-suggestions
  origin/main
```

Fast-forward only; no merge commit, no force, no branch deleted. Submodule
left checked out on `main` at `e18a4ab`.

## Commits

- `88b9000` `docs(releasing): fix stale checklist steps`
- `bd77225` `chore(release): v2026.4.0, cli-v2026.5.0`
- `996fe0f` `chore(status): restore timeline, add plan`
- `chore(status): finalize release-prep report` (this artifact, final commit)

The branch is pushed to `origin/chore/release-v2026.4.0` and the PR to
`main` is opened immediately after the push. **No tag is cut and the PR is
not merged here** — the release cut (`v2026.4.0` / `cli-v2026.5.0`) and the
merge to `main` are a later, separately approved step.

## Tests

```
$ bash scripts/verify-gate.sh
▶ Gate: tsc --noEmit
  ✓ typecheck passed
▶ Gate: vitest run
  Test Files  247 passed (247)
       Tests  2514 passed (2514)
  ✓ tests passed
▶ Gate: secrets / staged check
  ✓ no secrets staged
  ✓ no dist staged
Gate GREEN — safe to commit.
Full log: /tmp/opencode/gate-20260930-112813.log

$ bun run check:invariants
  All invariants green (or warn).   # 14/14 OK
```

`verify-gate.sh` skips `check:invariants` unless `server/`, `shared/` or
`docs/SCHEMA` is touched (script L26); this change set touches none of
those, so it was run explicitly to satisfy the AGENTS.md gate.

## Deviations

- **Checklist numbering.** The two new steps landed as items 7 (push) and
  8 (verify) after the existing 6, rather than being merged into items 5/6,
  so the numbered list stays sequential and item 3 keeps its position.
- **App changelog coverage is condensed.** 76 commits span
  `v2026.3.0..HEAD`. The added bullets are user-facing roll-ups (one bullet
  per shipped area), not a per-commit list.

## Concerns

- **Changelog coverage is a judgment call.** 76 app commits (67 non-merge)
  were reduced to 11 added bullets; internal-only work (repo-coverage tests,
  wireframe-only bumps, `chore(status)` closings, `docs` syncs) was
  intentionally left out. Anything a user would notice in that remainder is
  not in the entry. Corrected from "12" after a post-merge recount.
  Follow-up coverage pass: 2 more bullets added (server-rendered share
  pages, bare `@` suggestions); the chat-landing spacing tweaks were judged
  below the changelog threshold and deliberately omitted.
- **App next version collides with the CLI's current version.** `v2026.4.0`
  and the CLI's released `cli-v2026.4.0` share the number. Independent
  pipelines and distinct tag prefixes keep it unambiguous, but the release
  commit names both sides on purpose.
- **Stale wireframes branch left in place (report-only).**
  `fix/design-system-wiki-primitives` has one commit not in wireframes
  `main`: `48a5f3b fix(wireframes): port wiki title/preview primitives to
  source`. Not deleted, not merged — needs a separate decision.
- **TIMELINE is append-only but the 2026-09-29/30 block is not perfectly
  ordered** relative to the restored HEAD tail (both are 2026-09-29). The
  alternative — committing the 325-line deletion — was rejected.
- The release cut itself (tags `v2026.4.0` / `cli-v2026.5.0`, merge to
  `main`) is **not** done here.
