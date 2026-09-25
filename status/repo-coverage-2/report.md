# Report: repo-coverage-2
created: 2026-09-25
sessions: ses_f2ba20257ffe5CIAQa1wy3Mk2v (main), ses_f28c908b0ffePIEuy9PlCDEAe8 (A), ses_f28c908afffewjUNzCIKA6U53I (B), ses_f28c9089fffeyGN5LEFGds4L9S (C), ses_f28c5f2c1ffeHOyGLgaAAmuOLv (review), ses_f28c16979ffegV2P9Vy1ooa1wJ (fixups), ses_f28be3d59ffeJezHudYdlxu41R (gate)
result: branch `chore/repo-coverage-2` @ d283867 — coverage waves 2–3 complete; every `server/repos/*.ts` now has a sibling test file; one source fix found by the tests.

## What changed

- **Eight new repo test suites** (47 tests): `api-key` (hash-only storage, revocation, `touchIfStale` no-op contract), `device-login` (pending→approved/denied one-shot transitions, expiry, `api_key_id` SET NULL), `user-project-role` (delete+insert upsert, per-project/user listing, FKs), `attachment` (XOR CHECK both branches, per-project SHA uniqueness, task cascade, uploader SET NULL), `source` (document scoping, unique key, project cascade), `project-repos` (atomic full-replace rollback, uniqueness, cross-project reuse), `assistant-call-logs` (usage stats, percentiles, CSV, project cascade + provider SET NULL), `assistant-model-prices` (upsert, ordering).
- **Source fix (deviation from plan Out, evidence-based):** `SourceRepo.create` returned a fabricated `new Date().toISOString()` while reads return persisted `datetime('now')`; the fabricated value was observable in the `addSource` POST response. `create` now re-reads the inserted row (mirrors other repos), error channel widened to include `RowNotFound` (handled by `SourceService.add`).
- Follow-up test hardening from review: FK pragma enabled in call-logs suite, XOR both-set violation, `RowNotFound`-specific cascade assertion, device-login SET NULL, api-key no-op reframed, non-tautological price `updatedAt`.

## Tests

- `bash scripts/verify-gate.sh` → exit 0: `tsc` passed; vitest **200 files / 1772 tests passed**; `check:invariants` green; secrets clean.
- Targeted: 8 files / 47 tests.
- Acceptance loop: no untested `server/repos/*.ts` remains.
- Reviewer PASS after one round (one medium + six small findings, all fixed and re-verified).

## Deviations

- Plan Out said defects are report-only; the `source.create` timestamp divergence was fixed because it was observable in an API response — a bounded one-method fix with caller evidence.

## Concerns

- Coverage acceptance is name-based (sibling test exists) plus substantive for the eight repos; it is not a coverage-percentage target.
- Open decisions remain unpicked: `runtimes.team_id`, `PREFIX-n`, `cf-connecting-ip`.
- `docs/design-system.html` (unrelated concurrent work) excluded from this branch.
- PR merge pending user.
