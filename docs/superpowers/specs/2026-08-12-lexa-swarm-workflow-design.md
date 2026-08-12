# Lexa Swarm Workflow — Design

Date: 2026-08-12
Status: Approved

## Goal

Define and encode the orchestration workflow for fullstack development on Lexa (FE / BE / CLI / docs / wireframes) using herdr panes with opencode swarm, packaged as a herdr skill + this spec.

## Why this exists

Lexa is a fullstack repo (TanStack Start + React FE, Effect-TS BE, Bun CLI, docs, private wireframes submodule). Sequential single-session work thrashes context across 4+ domains and serializes independent tracks. Parallel herdr panes per track keep domain context warm, allow model mixing, and give live visibility — but need rules to avoid file conflicts, contract drift, and invariant violations.

## Components

### Skill (`~/.agents/skills/lexa-swarm/SKILL.md`)

- Phase state machine: `plan → wireframe-gate → lanes → integrate → release`
- Encoded rules (from lexa AGENTS.md, non-negotiable):
  - Wireframe-first: WF lane completes before FE lane starts; never WF+FE in parallel
  - BE owns the shared contract (`shared/types.ts` + `docs/API.md`)
  - Agent file boundaries (designer may not touch `server/`, `shared/types.ts`, `docs/`, configs; fixer scope is per-task)
  - Architectural invariants (no service cycles, echo suppression, emission invariant, etc. — reference lexa AGENTS.md)
  - No scope creep, names exact, no commits unless user asks
- Lane manifest: pane ↔ track mapping, worktree name, allowed/forbidden paths, verify commands

### Scripts (bundled in skill dir)

| Script | Purpose |
|---|---|
| `spawn-layout.sh` | Create herdr layout: orchestrator pane + 6 work panes (WF, FE, BE, CLI, docs, dev-server) |
| `make-worktrees.sh` | One git worktree per lane on a feature branch, from `main` |
| `lane-agents.sh` | Write per-lane AGENTS.md (scoped rules, verify commands, status protocol) |
| `gate.sh` | `tsc --noEmit` + `vitest run` + `bash wireframes/build.sh` |
| `merge-gate.sh` | Orchestrator: merge lanes in order (contract first), run `gate.sh`, report |

### Orchestrator session

opencode session in the main herdr pane with the skill loaded. Runs phases, dispatches lanes, reads lane status, integrates, runs release checklist. User watches in herdr, intervenes anytime.

## Lane lifecycle

1. **Plan** — orchestrator decomposes feature into lanes, defines contract surface (API shape, `shared/types.ts` delta), writes `status/PLAN.md`. Non-UI features: WF lane skipped with explicit user sign-off in PLAN.md.
2. **Wireframe gate** — WF lane edits `wireframes/src/`, runs `bash wireframes/build.sh`, reports DONE. FE lane waits. Orchestrator runs `git submodule update --init wireframes` before any FE work.
3. **Lanes in parallel** — BE (contract owner: writes `shared/types.ts` + `docs/API.md` first, commits contract), CLI, docs, FE (starts only after contract commit exists AND wireframe gate passed). Dev-server pane runs `bun run dev:full` throughout; lanes smoke-test via curl.
4. **Lane exit** — `tsc --noEmit` green, lane-specific tests, `status/<lane>.md: DONE`. Heartbeat: each lane appends timestamp to its status file; stale >N = dead lane, orchestrator re-spawns (worktree + branch survive).
5. **Integrate** — orchestrator merges branches in order (contract first), reviews `git diff --stat` per branch for forbidden-path violations, runs `gate.sh`. Trivial fallout fixed by orchestrator; deep breakage re-dispatches owning lane with error excerpt.
6. **Release** — orchestrator runs release checklist (both CHANGELOGs, version bumps, wireframes submodule pointer, annotated tags).

## Contract coordination

- BE lane owns all `shared/` contract writes. FE lane never writes `shared/types.ts`.
- Contract commit is the synchronization point. FE lane polls for it or waits for orchestrator signal.
- No other cross-lane file writes. Lanes are path-disjoint by scoping.

## Error handling

| Scenario | Response |
|---|---|
| Lane blocked on contract | Lane → `WAIT` status; orchestrator pings BE lane, never dispatches FE early |
| Lane crash / pane killed | Worktree + branch persist; orchestrator re-spawns lane with resume |
| Gate fails after merge | Orchestrator fixes trivial fallout; deep → re-dispatches owning lane |
| Wireframe submodule missing | Orchestrator inits submodule before FE gate |
| Forbidden-path write attempted | Per-lane AGENTS.md denies; orchestrator checks diff before merge |
| Dead lane (stale heartbeat) | Orchestrator re-spawns, status file authoritatively "not done" |

## Testing & exit criteria

- Lane exit: `tsc --noEmit` green + lane tests + status file DONE
- Integration exit: `gate.sh` green + dev-server smoke (`curl /api/health`, feature endpoint)
- Release exit: release checklist ticked

## Non-goals

- Not a replacement for lexa design docs (SCHEMA/LAYERS/API/MCP remain authority)
- No CI changes, no deployment automation changes
- Skill does not auto-commit lane work; commits only on explicit user request
