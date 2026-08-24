# Hearth — AI execution runtime

Hearth is Lexa's AI execution umbrella. Two co-existing active tiers (see
`docs/ADR-0001-two-tier-ai-architecture.md` for the decision record and
`docs/ARCHITECTURE.md` §"Hearth — two active AI tiers" for context):

| | Herald | Blacksmith |
|---|---|---|
| Role | Writing + PM assistant | Coding agent |
| Engine | Server-side `chat()` (`server/herald/provider.ts`) | listener/daemon/warm `opencode serve` |
| Queue | HTTP stream handler, in-process | daemons via `claimNextTask` |
| Auth | Browser cookie/Bearer | x-hearth-token surfaces |
| Thread state | `herald_threads` (ModelMessage[] JSON, rolling summary) | `hearth_sessions` |
| Agents/skills render | prompt injection via systemPrompts | `.agents/` file writes |

Shared: `hearth_tasks` queue (`kind` discriminates), **Lexa Agents/Skills**
catalog (`lexa_agents` / `lexa_skills` / `lexa_agent_skills` — renamed from
`forge_*` in migration 0010; routes `/api/agents`, `/api/skills`), popover,
logs/activity machinery. Per-project engine switching
(`herald_settings.engine`) with personal-overlay member toggle. The popover
picks per-run.

## Daemon + listener

- The Hearth button in the task/wiki editors needs at least one online daemon
  child, managed by `lexa-cli machine listen` (env: `LEXA_URL`,
  `LEXA_API_KEY` or `LXK_HEARTH_DAEMON_TOKEN`,
  `HEARTH_AGENT=opencode|hermes|command-code`). The listener owns per-runtime
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

`POST /api/hearth/runtime-events` delivers only machine + agent CLI + a fresh
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
then persist the mapping in `hearth_sessions` BEFORE the run).

- Runs are blocking `POST /session/:id/message` (model as
  `{providerID, modelID}` — a `"provider/model"` string is rejected).
- Live logs tee via 3s polling of `GET /session/:id/message`.
- The result is the joined text parts; `session.error` fails the task.
- Cancel/timeout = `POST /session/:id/abort` (best effort — unblocks the
  message POST) + **drop the mapping row unconditionally**
  (`DELETE /api/hearth/sessions`; an aborted session is poisoned and must
  never be continued).
- The popover's "New session" uses the user-facing
  `POST /api/hearth/sessions/reset` (409 while the document has an active
  task on that runtime).
- Agent/skill change → the server returns `null` → the daemon mints a fresh
  session and rewrites the row (reset semantics, no history rows).
- Auto-compaction is server-side (`compaction.auto` in the serve session
  loop) — long-lived sessions compact themselves, no Lexa work.

## Serve lifecycle

Serve binds `127.0.0.1` on a flavor-separated port — prod 4096–4127,
staging 4196–4227, dev 4296–4327 (`flavorBaseFor(LEXA_FLAVOR)` +
`fnv1a(runtimeId) % 32`, +1..+4 fallback candidates, `HEARTH_SERVE_PORT`
override in the runtime env file first), readiness probed via
`GET /session` (200 = fully up).

Flavor is a derived label only (loopback → `dev`, else `prod`;
`LEXA_FLAVOR`/`--flavor` override) used for exactly this serve-port base —
never for state paths.

The daemon sweeps a stale `serve.pid` at boot (SIGKILL/power-loss orphans),
respawns crashed serve with a 5s→30s backoff (never gives up, sessions
survive — the session DB lives in the persistent sandbox), kills serve on
its SIGTERM (listener stop) and on the exit-3 auth-failure path. If serve
cannot boot, claimed tasks fail with "Hearth runtime unavailable — opencode
serve did not start" — no legacy cold-`run` fallback.

## Persistent sandbox + workspace (opencode only)

Every project gets a persistent workspace dir at
`~/.lexa/<host>/projects/<projectId>/` (seeded write-once with `README.md` +
a static orchestrator `AGENTS.md`); per run the daemon (over)writes
`.agents/agents/<agentId>/AGENTS.md` (the selected lexa-agent's rules) and
`.agents/skills/<skillId>/SKILL.md`.

The sealed per-run `.hearth/` HOME is replaced by a persistent per-runtime
sandbox at the group's `<LEXA_DIR>/runtimes/<runtimeId>/hearth-home/`
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
Hearth runs.

`lexa-cli machine workspace list|sync` inspects/re-syncs local workspaces.
hermes/command-code keep the legacy ephemeral `~/.lexa/<host>/runs/` layout.
