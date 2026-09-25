# Design note: `runtimes.team_id` on organization delete

status: decision-ready, read-only analysis (architect, 2026-09-25). Implementation blocked on maintainer pick.

## Facts (verified)

| Fact | Evidence |
|---|---|
| SCHEMA declares no FK action (`NO ACTION`) | `docs/SCHEMA.md:632` |
| Baseline DB implements `ON DELETE SET NULL` | `migrations/0001_init.sql:154` |
| FK actions are live in prod | `PRAGMA foreign_keys = ON` (`server/db/database.ts:25`) |
| Bun migration runner disables FK enforcement for the run; D1 runner enforces | `server/db/migrate.ts:17-25` |
| Sanctioned path already nulls `team_id` before delete | `server/services/teams.service.ts:113-121` |
| Sibling FKs also `SET NULL`: `projects.team_id`, `runtime_events.team_id` | `0001_init.sql:128`; `0004_ui_gaps_w4.sql:8` |

**Claim flow (precise).** `POST /api/runtimes/daemon/claim` → `RuntimeService.claimNext` (`server/services/runtime.service.ts:348-356`) reads the runtime row (no `status` filter, `runtime.repo.ts:77-78`) then calls `claimNextTask(runtimeId, runtime.teamId)` → SQL predicate (`runtime.repo.ts:343-354`):

```
ft.status='queued' AND ft.kind='blacksmith'
AND (ft.runtime_id IS NULL OR ft.runtime_id = ?)
AND (? IS NULL OR (SELECT p.team_id FROM projects p WHERE p.id = ft.project_id) = ?)
```

With `teamId = NULL` the second clause short-circuits **true** → eligible for every queued blacksmith task in every project (any team, team-less, or dangling project). A scoped runtime only matches projects whose `team_id` equals its own. The claim response carries the task plus prompt/doc context/linked sources/repo content → **cross-team data disclosure**, not just eligibility.

**Status gating today:** none on claim. `status` is flipped online by `heartbeat`/`register`; offline only cosmetically by `markRuntimesOffline` (>2 min stale); an "offline" runtime that still polls claims fine. Enqueue-time `NoRuntimeOnline` is global, not team-aware.

**Register flow:** team = explicit payload > latest provider setup event (`runtime_events.team_id`) > existing row's team > **global default** (`server/services/runtime-register-team.test.ts:60-97`). `PATCH /api/runtimes/:id` has **no `teamId` field** (`server/api/http.ts:2548-2560`) — no admin reassign/detach path exists.

**Risk, stated exactly.** Any org delete — sanctioned service path *and* raw SQL (`scripts/seed-dev.sql:12`, ops scripts, future code) — silently converts team-scoped runtimes into global ones. The next daemon poll is enough; no restart. The doc-declared `NO ACTION` property is not enforced, so there is no backstop.

## Options

| | Option | Blocks silent widening | Migration |
|---|---|---|---|
| **A** | `ON DELETE RESTRICT` + service refuses org delete while runtimes bound; explicit reassign/detach via new `PATCH /api/runtimes/:id { teamId }` (superadmin) | Yes (service + raw SQL) | rebuild `runtimes` |
| **B** | Keep `SET NULL` + same-tx `status='offline'` marker + claim-time status gate + docs | Partly (visible, delayed; still widens after heartbeat unless reassigned) | none |
| **C** | `ON DELETE CASCADE` | No — re-register default is global; machine returns global after next heartbeat | rebuild `runtimes` (+ `runtime_events`) |
| **D** | Service-level guard only, FK stays `SET NULL` (phase 1 of A) | Sanctioned path yes; raw SQL no | none |

- **A — blast radius:** `teams.service.ts:105-122` (drop clear at `:113-118`, add guard), `runtime.repo.ts` (count/conditional delete), `http.ts` PATCH + authz, `errors.ts`. **Migration (SQLite, no `ALTER` for FK actions):** 12-step rebuild — create `runtimes_new` with `ON DELETE RESTRICT`, `INSERT…SELECT`, `DROP`, `RENAME`, recreate indexes (`SCHEMA.md:594-595`), `PRAGMA foreign_key_check`; table is tiny. Confirm no child FK references `runtimes` (`runtime_tasks.runtime_id`/`runtime_sessions`) first; Bun runner has FKs off, keep D1-safe ordering per `0005` header. **Error semantics:** new `TeamHasRuntimes` → 409 `TEAM_HAS_RUNTIMES`, payload `{ teamId, count }`; implement race-free by letting the single `DELETE` hit the FK (`SQLITE_CONSTRAINT_FOREIGNKEY`), re-count for the payload — same backstop pattern as invariant #13. Register at `errors.ts:200/277/482` + `LAYERS.md:1153` area. **Docs:** `SCHEMA.md:632` explicit `RESTRICT`; `API.md:1257-1262` (add 409), `API.md:1375-1379` (PATCH `teamId`); `LAYERS.md` catalog + scoping; `ARCHITECTURE.md` runtime-scoping rationale. **Tests:** delete team with bound runtime → 409; after reassign/detach/delete → 200; raw org `DELETE` under FK ON → constraint error; claim regression (scoped ≠ other team / team-less; global = all).
- **B — blast radius:** claim SQL must gain status gate *and* read `team_id` in the same statement (two-statement race); verify daemon heartbeat cadence vs the 2-min stale flip. No migration. Docs: SCHEMA → `SET NULL` + invariant. Tests: same-tx detach+offline; claim refused offline; concurrent claim-vs-delete never widens.
- **C — blast radius:** silently destroys runtime config; re-register makes it global unless register default flips fail-closed. Worst.
- **D — blast radius:** service guard + `TeamHasRuntimes` only; no PATCH yet, so admins detach by deleting the runtime. No migration. Residual: raw SQL still widens.

## Recommendation

**Option A.** It matches the declared schema, makes widening impossible on every path (FK backstop even for raw SQL), and the costs are a rare superadmin friction plus a trivial table rebuild. B leaves the hole open (visibility ≠ prevention); C recreates it via the register default.

**Smallest safe first step (if A is deferred):** ship **D** now — remove the implicit clear, add `TeamHasRuntimes` (409) via a conditional delete, wire `errors.ts` + `LAYERS.md`. Code-only, no schema change, closes the sanctioned path immediately. Then add `PATCH /api/runtimes/:id { teamId }`, then the `0007` rebuild to `RESTRICT`. Until `0007`, raw-SQL bypass remains as accepted residual risk.

## Open questions (maintainer only)

1. Baseline policy: append `0007` only, or also flip the squashed `0001_init.sql:154` so fresh installs are born fail-closed?
2. Is a manually registered runtime ever legitimately global, or must global be an explicit superadmin declaration (register default fail-closed)?
3. Sanctioned reassignment path: `PATCH /api/runtimes/:id { teamId }`, or re-install via a new setup event?
4. Should `status='offline'` block claims generally (couples to heartbeat cadence)?
5. Is `runtime_events.team_id SET NULL` in scope (same widening class at re-register)?
6. If team-delete UI gains a "reassign/detach runtimes" state, wireframe-first pass required.

---

# Addendum: `runtime_events.team_id` residual widening (architect, 2026-09-25)

Claim **CONFIRMED**. Post-Option-A residual: 0007 blocks deleting a team while runtimes are bound, but an event can reference org A while the existing runtime row is scoped to org B (reassigned via PATCH); delete A → its latest event becomes `team_id NULL` → re-register inherits NULL → global. Not dead code.

**Recommendation — (a), one condition:** `fromEvent.found && fromEvent.teamId !== null`. A NULL event means "no team information", not "explicit global", when an existing row can answer.

- `server/services/runtime.service.ts:507` — `let teamId = input.teamId ?? null` (inference only when payload team null/absent).
- `:512-514` — `if (fromEvent.found) teamId = fromEvent.teamId;` skips the existing-row fallback whenever any event exists, even `teamId: null`.
- `server/repos/runtime-event.repo.ts:95` — latest event returns `{ found: true, teamId: row.team_id ?? null }`; comment `:80-82` calls "found + null" an explicit global choice — to be corrected for inference.
- `migrations/0004_ui_gaps_w4.sql:8` + `docs/SCHEMA.md:684` — `SET NULL` is intentional and doc-matching; keep.

Why not CASCADE: deletes operational history to fix a semantics bug. Why not fail-closed register: breaks the declared `NULL = global` first-install default and legacy no-event machines.

```ts
if (teamId === null) {
  const fromEvent = yield* runtimeEventRepo.latestSetupEventTeam(input.machineId, input.provider);
  if (fromEvent.found && fromEvent.teamId !== null) {
    teamId = fromEvent.teamId;
  } else if (input.id) {
    const existing = yield* repo.findRuntimeById(input.id).pipe(
      Effect.catchTag("RowNotFound", () => Effect.succeed(null))
    );
    teamId = existing?.teamId ?? null;
  }
}
```

**Migration: none.** Code + comments only; orphaned events keep NULL.

**Tests:** NULL event + existing scoped row keeps team (fails pre-fix); global event + no row → global; no event + existing row keeps team; no event + no row → global; PATCH `teamId: null` detach regression; raw org delete under FK ON still RESTRICT.

**Docs:** `RUNTIMES.md` inference order + NULL-event semantics; `API.md` register + PATCH detach; `SCHEMA.md:684` wording (NULL = no binding / global on first install); `LAYERS.md` inference note.

**Residual maintainer questions:** (1) keep "explicit global event overrides a scoped row"? needs sentinel/column — not recommended; (2) orphaned-event cleanup / team-name snapshot for audit; (3) register payload `?? null` conflates omitted with explicit null (daemon does not send it).
