# AI Runtimes — AI execution runtime

AI Runtimes is Lexa's AI execution umbrella. Two co-existing active tiers (see
`docs/ARCHITECTURE.md` §Runtimes — two active AI tiers for the decision record,
formerly ADR-0001, now merged; amendments 2026-08-23/24 merged into
ARCHITECTURE.md — two-agent catalog, engine switching, personal-overlay toggle,
skills junction, vision chain, and the full Forge→Hearth→Runtimes identifier
rename):

| | Herald | Blacksmith |
|---|---|---|
| Role | Writing + PM assistant | Coding agent |
| Engine | Server-side `chat()` (`server/herald/provider.ts`) | listener/daemon/warm `opencode serve` |
| Queue | HTTP stream handler, in-process | daemons via `claimNextTask` |
| Auth | Browser cookie/Bearer | x-runtime-token surfaces |
| Thread state | `herald_threads` (ModelMessage[] JSON, rolling summary) | `runtime_sessions` |
| Agents/skills render | prompt injection via systemPrompts | `.agents/` file writes |

Shared: `runtime_tasks` queue with `kind` discriminator (`herald`|`blacksmith`
— `claimNextTask` carries `AND kind='blacksmith'`; Herald streams claim via a
kind-scoped conditional UPDATE; field names `agentMarkdown`/`skillMarkdown`
frozen for daemon wire compat), **Lexa Agents/Skills** catalog
(`lexa_agents`/`lexa_skills`/`lexa_agent_skills` — renamed from `forge_*` in the
squashed `0001_init.sql` baseline; routes `/api/agents`, `/api/skills`; exactly
two builtins `herald`/`blacksmith` after the `0005_runtime_rename.sql` id rebind, generic
`lexa` retired; per-agent skill availability = `lexa_agent_skills` junction
only), popover, logs/activity machinery. Per-project engine switching
(`herald_settings.engine` ∈ `herald|blacksmith` with `engine_switcher_enabled`
gate; personal-overlay member toggle is client-side session preference, admin
writes the default; freeform chat always herald → 409
`ENGINE_NOT_SUPPORTED_FOR_CHAT` under blacksmith). Vision chain:
`primarySupportsImages` checkbox → inline vs 409 `VISION_NOT_CONFIGURED`
(`vision_model` delegation removed in the squashed baseline). History:
the full Forge→Hearth identifier rename (2026-08-24) is baked into
the `0001_init.sql` baseline; the Hearth→Runtimes rename (2026-09-24, migration
`0005_runtime_rename.sql`) carried tables
`runtime_tasks`/`runtime_task_logs`/`runtime_sessions`, routes `/api/runtimes/*`,
header `x-runtime-token`, env `RUNTIME_*`/`LXK_RUNTIME_DAEMON_TOKEN`, activity
`runtime_*`, and CLI state — breaking reinstall. The popover picks per-run.

## Daemon + listener

- The AI button in the task/wiki editors needs at least one online daemon
  child, managed by `lx machine listen` (env: `LEXA_URL`,
  `LEXA_API_KEY` or `LXK_RUNTIME_DAEMON_TOKEN`,
  `RUNTIME_AGENT=opencode|hermes|command-code`). The listener owns per-runtime
  daemon children; there are no per-runtime systemd units. Without a daemon,
  Generate returns `NO_RUNTIME_ONLINE`.
- **Daemons NEVER inherit the listener's shell env.** Secret vars are scrubbed
  at spawn (`cli/src/machine.ts` `scrubDaemonEnv` — closed allowlist:
  `PATH/HOME/LANG/LC_*/TERM/TZ/PWD/SHELL/USER/LOGNAME/XDG_*/BUN_*/LEXA_DIR/LEXA_FLAVOR`).
  Runtime credentials come only from the runtime env file + `config.json`.
- The listener passes its group dir as `LEXA_DIR` and the host's flavor as
  `LEXA_FLAVOR`, so the daemon resolves state inside the right server group
  (`~/.lexa/<host>/`). Without it, staging/dev daemons would build their
  sandboxes inside the prod root.
- Starting the listener from a shell with `.env` exported prints a boot
  warning; a daemon whose env-file key is dead exits 3 ("API key revoked —
  re-run Setup runtime").

## Run claim flow

Every run picks an **agent** (rule bundle, default "Lexa") + a dependent
**skill** (operation bundle) in the popover. The claim carries their
instructions (`agentMarkdown` / `skillMarkdown`) — files-only, no host store.
All host state lives under `~/.lexa/` (`LEXA_DIR`), grouped per server host
(`~/.lexa/<host>/`).

`POST /api/runtimes/events` delivers only machine + agent CLI + a fresh
key; the listener persists its machine id at `~/.lexa/<host>/machine-id` and
the per-machine secret at `~/.lexa/<host>/machine-secret` (both chmod 600),
heartbeats every 3s, claims only its own events (sending `x-machine-secret`),
and owns one daemon child per runtime under
`~/.lexa/<host>/runtimes/<runtime-id>/env` (chmod 600). `machine install` is
a thin listener alias; `--no-systemd` writes no daemon files and runs the
listener under your own supervisor.

## Warm opencode runtimes (opencode only)

The daemon owns one `opencode serve` per runtime and drives every task over
pure HTTP — no `run` client is ever spawned (the attach client is unreliable
on 1.18.11: it exits without mirroring text parts — spike-verified).

The claim payload carries the continue-vs-mint verdict: `runtimeSessionId`
(continue the mapped conversation) or `null` (mint
`POST /session?directory=<workspace>` on serve, assert the bound directory,
then persist the mapping in `runtime_sessions` BEFORE the run).

- Runs are blocking `POST /session/:id/message` (model as
  `{providerID, modelID}` — a `"provider/model"` string is rejected).
- Live logs tee via 3s polling of `GET /session/:id/message`.
- The result is the joined text parts; `session.error` fails the task.
- Cancel/timeout = `POST /session/:id/abort` (best effort — unblocks the
  message POST) + **drop the mapping row unconditionally**
  (`DELETE /api/runtimes/sessions`; an aborted session is poisoned and must
  never be continued).
- The popover's "New session" uses the user-facing
  `POST /api/runtimes/sessions/reset` (409 while the document has an active
  task on that runtime).
- Agent/skill change → the server returns `null` → the daemon mints a fresh
  session and rewrites the row (reset semantics, no history rows).
- Auto-compaction is server-side (`compaction.auto` in the serve session
  loop) — long-lived sessions compact themselves, no Lexa work.

## Serve lifecycle

Serve binds `127.0.0.1` on a flavor-separated port — prod 4096–4127,
staging 4196–4227, dev 4296–4327 (`flavorBaseFor(LEXA_FLAVOR)` +
`fnv1a(runtimeId) % 32`, +1..+4 fallback candidates, `RUNTIME_SERVE_PORT`
override in the runtime env file first), readiness probed via
`GET /session` (200 = fully up).

Flavor is a derived label only (loopback → `dev`, else `prod`;
`LEXA_FLAVOR`/`--flavor` override) used for exactly this serve-port base —
never for state paths.

The daemon sweeps a stale `serve.pid` at boot (SIGKILL/power-loss orphans),
respawns crashed serve with a 5s→30s backoff (never gives up, sessions
survive — the session DB lives in the persistent sandbox), kills serve on
its SIGTERM (listener stop) and on the exit-3 auth-failure path. If serve
cannot boot, claimed tasks fail with "Runtime unavailable — opencode
serve did not start" — no legacy cold-`run` fallback.

## Persistent sandbox + workspace (opencode only)

Every project gets a persistent workspace dir at
`~/.lexa/<host>/projects/<projectId>/` (seeded write-once with `README.md` +
a static orchestrator `AGENTS.md`); per run the daemon (over)writes
`.agents/agents/<agentId>/AGENTS.md` (the selected lexa-agent's rules) and
`.agents/skills/<skillId>/SKILL.md`.

The legacy sealed per-run HOME is replaced by a persistent per-runtime
sandbox at the group's `<LEXA_DIR>/runtimes/<runtimeId>/runtime-home/`
(seeded once, never wiped — removed only with the runtime; contains the
deny-rule `opencode.json`: bash fully denied, `external_directory: deny`,
`*auth.json*` denied, `skill`/`webfetch` denied + a copy of
`~/.local/share/opencode/auth.json` chmod 600, refreshed at serve boot AND
at every claim).

`external_directory: deny` is evaluated on the resolved path, so the serve
root ≠ workspace is safe: reads inside the session's bound workspace work,
everything outside is blocked. Sessions bind to their workspace at mint and
keep it on continuation; a re-provisioned workspace (listener sync / manual
wipe) leaves a stale file context — reset the session after wiping a
workspace. Global opencode config — permissions, plugins — never loads into
AI runs.

`lx machine workspace list|sync` inspects/re-syncs local workspaces.
hermes/command-code keep the legacy ephemeral `~/.lexa/<host>/runs/` layout.
