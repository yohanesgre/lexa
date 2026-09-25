# Report: open-decisions
created: 2026-09-25
sessions: ses_f2ba20257ffe5CIAQa1wy3Mk2v (main), ses_f28b66ffdffdKaRSd70CPrzYdb (architect), ses_f28abfecfffexb7qfEXJkGg561 (lane), ses_f2899142cffebVWvuL6QbMsv63 (review), ses_f28846dbaffeTLvxH35875kssg + ses_f2881f383ffe2bSa18AmGXNSkC (gate)
result: branch `omos/open-decisions` (worktree `.worktrees/open-decisions`) @ b46576c — PREFIX-n alias and cf-connecting-ip trust decisions implemented; `runtimes.team_id` design persisted, implementation pending the maintainer pick.

## What changed

- **PREFIX-n aliases** now resolve for payload/query task ids: `addTaskLink.toTaskId`, `createTask.parentId`, `searchTasks.exclude` (unresolvable → no exclusions, never 404), `moveTask.beforeTaskId`/`afterTaskId` (bad key → 404, not 500), source endpoints `:id` when `type=task`, and runtime-session `documentId` when `documentType=task`. UUID behavior unchanged; wiki page ids untouched. `docs/API.md` alias statement extended.
- **Client-IP trust hardened:** new `resolveClientIp` in `server/api/rate-limit.ts` trusts `cf-connecting-ip` only when the peer is loopback (127/8, `::1`, v4-mapped) or matches `LXK_TRUSTED_PROXY_CIDRS`; wired into the Bun middleware, the Workers middleware (which now deletes the client-supplied `x-lexa-remote-ip` stamp first), and the auth surface. Dead `isPrivateIp` removed. IPv6 embedded-IPv4 parsing fixed.
- **Config/plumbing:** `LXK_TRUSTED_PROXY_CIDRS` added to `server/env.ts`, `.env.example`, `docs/DEPLOYMENT.md`, `docs/LAYERS.md`, `docs/ARCHITECTURE.md`; forwarded through `scripts/install-lib.sh` compose renders + `docker-compose.yml`, asserted in `scripts/test-install.sh`.
- **Design record:** `status/open-decisions/design-runtimes-team-id.md` — options A–D, recommendation (A: `RESTRICT` + explicit reassign; first step D), migration sketch, six open questions.

## Tests

- Full suite `bun run test` → **201 files / 1793 tests passed** (first gate run had 20 load-timeouts; clean rerun, environmental).
- `bash scripts/test-install.sh` → 35/35.
- `bun x tsc --noEmit` → exit 0; `check:invariants` green; secrets clean.
- Reviewer PASS after one REQUEST CHANGES round (compose forwarding, Workers spoof, move anchors, document ids, IPv6 parse, dead code, docs, `.env.example` — all fixed and re-verified).

## Deviations

- Loopback trust implemented as `127.0.0.0/8` + `::1` + v4-mapped (superset of `127.0.0.1`, standard loopback).
- No `.addError` added for move anchors: the API maps errors globally; a bad key anchor yields 404 via `RowNotFound` (tested).
- Workers has no peer address → `cf-connecting-ip` remains the only source there (documented); the inbound spoofable stamp is now stripped.

## Concerns

- `runtimes.team_id` (and the sibling `runtime_events.team_id` question) still needs the maintainer pick before implementation.
- Pre-existing vacuous `staging` assertion in `scripts/test-install.sh` left untouched (out of scope).
- PR merge pending user.
