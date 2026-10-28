# Testing

Durable source of truth for Lexa's test suite: the lane commands, what each retained guard protects, and
the rules for adding tests. This file is tracked — the working trim artifacts (`plan.md`, per-slice audit
manifests, `report.md`) live under `status/test-suite-trim/`, which is **gitignored and never pushed**, so
nothing another device needs may live only there.

## Suite at a glance (2026-10-11)

| metric | value |
|---|---|
| test files | 95 |
| cases | 822 (`it`/`test` declarations; vitest counts each `it.each` row separately) |
| test LOC | ~25.7k |
| full-suite wall | ~38s standalone, ~43s through `verify-gate.sh` (6-core dev box) |
| checkers | `check:invariants` (14 architectural invariants, static), `check:test-hygiene` (this file's rules) |

Before the 2026-10-11 trim the suite was 321 files / 3,820 cases / 66.7k LOC / ~90s. The cut removed
tier duplication and copy/implementation-detail pins, not protection: the invariant→test map below is the
contract that every architectural invariant keeps a dynamic guard where one is possible.

## Lanes & iteration contract

| Lane | Command | Scope |
|---|---|---|
| shared/pure | `bun run test:shared` | `shared/` |
| backend | `bun run test:be` | `shared/` + `server/` |
| frontend | `bun run test:fe` | `shared/` + `app/` |
| app-only | `bun run test:app` | `app/` |
| cli | `bun run test:cli` | `cli/src/` |
| full | `bun run test` / `test:full` | everything (pre-merge / release CI) |

During iteration run only the touched file(s) (`bun run test -- <path>`, ~1s); run the lane at lane close;
run the full suite at pre-merge. `bash scripts/verify-gate.sh` scopes the test step to the changed areas
(`--print-plan` previews it, `--full` forces the whole suite) and always adds typecheck, the test-hygiene
guard rail, `check:invariants` when `server/`/`shared/` changed, and the secrets check. `bash
scripts/ci-local.sh` mirrors release CI. Installer surface: `bash scripts/test-install.sh`; mobile smoke:
`bun run check:mobile`.

## Guard rail — minimal and important tests only

`bun run check:test-hygiene` runs on every gate and fails it. Rules:

1. **Name the criterion before writing the test.** One of: an architectural invariant (the 14 in
   `scripts/check-invariants.ts`), a documented contract (`docs/API.md`, `docs/SCHEMA.md`,
   `docs/LAYERS.md`), a security/auth boundary, a race/atomicity property, a migration/upgrade path, a
   destructive operation, or a core-flow smoke. No criterion → do not write the test.
2. **One test per effect, at the tier where the effect lives.** Route-level for the documented HTTP
   contract, service-level for domain rules, db-level for schema/migration, the static scanner for
   structural invariants, one smoke per UI surface. Never restate the same effect at a second tier.
3. **Banned outright:** snapshot assertions (`toMatchSnapshot`, `toMatchInlineSnapshot`).
4. **Ratchet (per-file caps in `scripts/test-hygiene-allow.json`, measured at trim close):**
   `toHaveClass`/`toHaveStyle`, `toBeTruthy`/`toBeDefined`, `toHaveBeenCalledWith` (mock-argument
   echoes), `readFileSync` (source/artifact reads). Measured above the cap fails the gate; measured below
   is reported so the cap can be lowered. Raising a cap needs a stated criterion in the change body.
5. **Budget:** 100 files / 900 cases / 27k LOC. Exceeding a ceiling is a warning owned by the report, not
   a license to duplicate — prefer extending an existing case's assertions over adding a near-identical
   case, and never re-pin existing wording or implementation behavior (delete it instead).

Also banned by judgment (no mechanical check): copy/label/px/class pins, internal-wiring assertions,
source-text scans, implementation-detail pins, and tests whose subject has no production caller.

## Invariant → test map

Titles come from `scripts/check-invariants.ts`; evidence is grep-verified against the retained tree.

| # | invariant | guard | evidence |
|---|---|---|---|
| 1 | No service-to-service cycles | static scanner only | `scripts/check-invariants.ts` — no dynamic test is possible; the scanner is the guard |
| 2 | Echo suppression | dynamic | `server/services/github.service.test.ts` "records an echo delivery and does not re-process it" · `server/workers-entry.test.ts` (HMAC + delivery-after-success) |
| 3 | Webhook atomic (bypassGuards + one tx) | dynamic | `server/repos/task-batch.test.ts` "buildWebhookMoveAndEmitBatch: move + synced-state + github_synced activity in one batch" |
| 4 | Positions deterministic + retry-once | dynamic | `shared/positions.test.ts` "positions documented invariant" · `server/services/task.service.test.ts` "TaskService WIP + positions" |
| 5 | WIP limit atomic conditional UPDATE | dynamic | `server/repos/task-batch.test.ts` "buildWipMoveStmt keeps the WIP limit as one conditional UPDATE statement" · `server/services/task.service.test.ts` |
| 6 | Mutation cache consistency (setQueryData, never invalidateQueries on the mutation path) | dynamic | `app/lib/queries-mutations.test.tsx` (one case per mutation family, "no refetch"/"never invalidate") · `app/lib/assistant-chat-queries.test.tsx` |
| 7 | Markdown at the boundary | static scanner + dynamic | `scripts/check-invariants.ts` · `shared/markdown.test.ts` · `app/lib/markdownToReact.test.tsx` |
| 8 | Webhook auth = HMAC signature | dynamic | `server/github/client.test.ts` (valid / tampered / blank-secret no-fail-open) · `server/workers-entry.test.ts` (invalid HMAC → 401, no processing) |
| 9 | Column→GitHub state via `columns.github_state` | dynamic | `server/services/column.service.test.ts` "ColumnService github_state" (incl. CHECK rejection) · `server/services/github.service.test.ts` |
| 10 | required_fields on create/move/update (TipTap-aware) | dynamic | `server/services/task.service.test.ts` "TaskService required fields" · `app/components/useTaskDetailActions.test.tsx` (client gate) |
| 11 | One-way link integrity `UNIQUE(issue_id)` | dynamic | `server/db/db.test.ts` "rejects a second task_github_issues row with the same issue_id" |
| 12 | Emission invariant (activity in the same tx) | dynamic | `server/repos/task-batch.test.ts` (write+activity pairs, delete cascade, archive pair) · `server/services/emission.service.test.ts` |
| 13 | Ticket keys immutable | dynamic | `server/services/task.service.test.ts` "TaskService ticket keys" (sequential per-project, concurrent uniqueness) |
| 14 | Milestone/sprint rules + one Backlog | dynamic | `server/services/milestone.service.test.ts` (cascade archive/restore, batch rollback) · `server/services/swimlane.service.test.ts` (backlog guard, deadline bounds) · `server/db/migrate.test.ts` (partial unique index) |

### Other non-droppable surfaces
- **Error catalog** — `server/api/error-catalog.test.ts` covers all 86 codes in `docs/API.md` §Error
  Envelope (doc-drift check + tag→status/code + the never-raised list + no-leak cases).
- **Route middleware property matrix** — `server/api/auth-key.test.ts` enumerates the live route table
  from `LexaApi.groups` (with the documented auth-exempt list) and asserts 401-without-credential for
  every mounted route plus 403 for the admin-scoped GET surface, so a new route that forgets the
  middleware fails a test instead of silently falling out of the per-file set.
- **Security boundaries** — `server/assistant/{secrets,secrets-workers,mcp,ssrf}.test.ts`,
  `server/mcp/mcp.test.ts` (inbound `/mcp`: personal-key/cookie/unbound rejection,
  per-request revocation + access freshness, Origin/body/rate caps, path-segment
  traversal, user isolation, persisted mutation results),
  `server/ssrf.test.ts`, `server/api/{auth-key,rate-limit}.test.ts`,
  `server/services/{wiki,workspace-invites}.test.ts`, `app/routes/share.$token.test.tsx`,
  `shared/safe-href.test.ts`, `server/auth-recovery.test.ts` (atomic rolling
  recovery admission across the 1/address/60s, 5/address/hour, 10/IP/10min
  windows; uniform acknowledgement before lookup; unknown/banned produce no
  issuance; malformed/disallowed-origin/unconfigured rejection),
  `server/auth.factory.test.ts` (native 30-minute self-service token uses the
  configured sender and skips a deactivated account; issuing-instance adapter
  isolation across two auth instances), `server/services/email.service.test.ts`
  (accepted vs known rejection vs unrecognized transport/internal outcome),
  and the retained
  `server/services/workspace-invites.test.ts` reset case (single use,
  requester session-cookie expiry, and deactivated-target INVALID_TOKEN before
  credential mutation).
- **Migrations & upgrades** — `server/db/{migrate,backfills}.test.ts`,
  `server/assistant/legacy-convert.test.ts`, `cli/src/{worker-upgrade,upgrade-process}.test.ts`,
  `server/workers-entry.test.ts` (maintenance purge removes expired
  `recovery_requests` rows while keeping live ones).
- **Destructive CLI** — `cli/src/{worker-upgrade,upgrade-process,release,index.admin-settings}.test.ts`
  (`--yes` guard, secret display discipline, backup/restore, tag + checksum integrity).
- **Data-loss / contract guards** — `server/repos/assistant-thread.repo.test.ts` (transcript truncate CAS
  against a concurrent writer, interleaved append keeps both messages, malformed transcript replaced) and
  `server/assistant/build-stream.test.ts` (`onDispose` exactly once on done/fail/cancel, a legacy display
  `toolCalls` log never reaching the provider, parts-shaped transcript normalization).

## Trim history (why the suite looks like this)

Cut criterion catalog — **keep**: invariant, documented contract, security boundary, race/atomicity,
data-loss/upgrade path, core-flow smoke, destructive op. **Drop**: copy/label/class/px pins,
implementation-detail and mock-echo assertions, tier duplicates, render-only suites, incidental defaults,
pins on unreachable code.

### Protection knowingly given up (owner-approved 2026-10-11, below-floor depth)

This list is the durable record — do not re-derive it from anything outside this repo:

- Chat UI race/idempotency suites that did **not** guard duplicate execution or data loss
  (`assistant-chat-session`, `assistant-chat-turns-state`, `assistant-chat-carousel`,
  `assistant-chat-queue`, `assistant-chat-attachments`). Guarded-but-kept counterparts: the approval
  suspension guard, the resume idempotency path, the transcript races (see above).
- Per-endpoint API error variants beyond the catalog matrix; per-resource repository CRUD echoes
  (service/API tests already run the same real DB).
- CLI non-destructive command coverage (help listings, per-flag payload echoes).
- Per-component render/composition suites, focus-trap/ARIA polish, copy/label/class/px pins,
  internal-wiring and mock-argument echoes, source-text scans.
- Per-node markdown mapping cases (round-trip, echo stability and the XSS set are retained).
- Assistant detail beyond the resume/approval guards (streaming lifecycle, vision wire formats, citation
  and image-hydration paths, per-message `$skills` rendering); env-file loader permutations; cron
  per-schedule-type variants; DB driver-parity internals beyond batch atomicity; storage S3/R2 config
  permutations.
- **Granularity, not coverage, inside collapsed cases** — several `it`s covering one rule became one case
  with multiple assertions, so a failure now stops at the first failing assertion instead of naming the
  variant.

Step-by-step numbers for each cut (per-slice audit manifests, per-lane reports) were machine-local
orchestration state under `status/`, which is gitignored and never pushed — treat this file as the
authoritative summary.
