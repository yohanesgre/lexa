# Lexa Swarm Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `lexa-swarm` skill (SKILL.md + bundled scripts) that spawns a herdr pane layout per track (WF, FE, BE, CLI, docs, dev-server) with one worktree per lane, enforces wireframe-first + BE-owns-contract rules, and integrates lanes via an orchestrator.

**Architecture:** Skill = process rules + lane manifest (single source of truth: `scripts/lanes.conf`). Scripts = thin mechanics over herdr socket API and git: worktrees, per-lane AGENTS.md, gate, merge. Orchestrator = opencode session in the main pane with the skill loaded.

**Tech Stack:** bash (POSIX, `set -euo pipefail`), git worktrees, herdr socket CLI (`herdr pane split/run/rename`, `herdr worktree create`), bun (lexa toolchain), opencode.

## Global Constraints

- Never auto-commit lane work; commits only on explicit user request. Design doc itself: already committed (`d2f160d`).
- Wireframe-first rule: FE lane NEVER starts before WF lane DONE + contract commit exists.
- BE owns `shared/types.ts` + `docs/API.md` writes. FE lane never writes them.
- All scripts: POSIX bash, `set -euo pipefail`, pass `bash -n`, no comments unless behavior is non-obvious.
- Scripts live in `~/.agents/skills/lexa-swarm/scripts/`; SKILL.md in `~/.agents/skills/lexa-swarm/`.
- Lane branches: `swarm/<feature>/<lane>`, worktrees at `~/projects/lexa-wt-<lane>`, base `main`.
- Lane exit: `tsc --noEmit` green + lane tests + `status/<lane>.md: DONE` with heartbeat timestamp.
- Status dir: `<main-checkout>/status/` (gitignored — add to lexa `.gitignore`).
- Dev-server pane runs `bun run dev:full`; no agent inside it.

---

### Task 1: Skill scaffold + SKILL.md

**Files:**
- Create: `~/.agents/skills/lexa-swarm/SKILL.md`
- Create: `~/.agents/skills/lexa-swarm/scripts/lanes.conf`

**Interfaces:**
- Consumes: nothing
- Produces: `LANE_*` vars sourced by all scripts; phase state machine doc; status protocol

- [ ] **Step 1: Create skill dirs**

```bash
mkdir -p ~/.agents/skills/lexa-swarm/scripts
```

- [ ] **Step 2: Write `scripts/lanes.conf`** (single source of truth for lanes)

```bash
# Lane manifest — single source of truth for the swarm layout
# Format: <lane>:<worktree-name>:<relative-path>:<agent-model-hint>
LANES=(
  "wf:lexa-wf:wireframes"
  "fe:lexa-fe:app"
  "be:lexa-be:server"
  "cli:lexa-cli:cli"
  "docs:lexa-docs:docs"
  "dev:lexa-dev:."
)
```

- [ ] **Step 3: Write `SKILL.md`** — phases `plan → wireframe-gate → lanes → integrate → release`; rules (wireframe-first, BE owns contract, agent file boundaries, invariants — reference lexa `AGENTS.md`); lane manifest usage; status protocol (`status/<lane>.md` DONE + heartbeat, stale >10 min = dead); orchestrator responsibilities (merge order contract-first, `git diff --stat` review, gate, release checklist). ~120 lines.

- [ ] **Step 4: Verify**

```bash
bash -n ~/.agents/skills/lexa-swarm/scripts/lanes.conf
source ~/.agents/skills/lexa-swarm/scripts/lanes.conf && echo "${LANES[0]}"
```

Expected: `bash -n` OK, prints `wf:lexa-wf:wireframes`.

- [ ] **Step 5: Commit**

```bash
git -C ~/projects/dotfiles status --short 2>/dev/null || true
# Skill lives OUTSIDE the repo (~/.agents/skills) — no commit; note it in reply.
```

---

### Task 2: `make-worktrees.sh`

**Files:**
- Create: `~/.agents/skills/lexa-swarm/scripts/make-worktrees.sh`
- Test: `~/.agents/skills/lexa-swarm/tests/test-worktrees.sh`

**Interfaces:**
- Consumes: `lanes.conf`, env `FEATURE` (slug), `REPO` (main checkout path)
- Produces: worktrees at `~/projects/lexa-wt-<lane>` on `swarm/<feature>/<lane>` from `main`; prints `<lane> <path>` lines

- [ ] **Step 1: Write failing test**

```bash
#!/usr/bin/env bash
set -euo pipefail
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git -C "$TMP" init -q -b main
git -C "$TMP" commit -q --allow-empty -m init
mkdir -p "$TMP/wireframes" "$TMP/app" "$TMP/server" "$TMP/cli" "$TMP/docs"
REPO="$TMP" FEATURE=test-lane \
  bash ~/.agents/skills/lexa-swarm/scripts/make-worktrees.sh
[ -d "$HOME/lexa-wf" ] || { echo "FAIL: wf worktree missing"; exit 1; }
git -C "$TMP" worktree list | grep -q "lexa-wf"
git -C "$HOME/lexa-wf" rev-parse --abbrev-ref HEAD | grep -q "swarm/test-lane/wf"
echo "PASS"
```

- [ ] **Step 2: Run test, verify it fails** (script doesn't exist)

```bash
bash ~/.agents/skills/lexa-swarm/tests/test-worktrees.sh
```

Expected: FAIL (bash: no such file).

- [ ] **Step 3: Write `make-worktrees.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lanes.conf"
REPO="${REPO:?set REPO to the main checkout}"
FEATURE="${FEATURE:?set FEATURE to a feature slug}"
WT_BASE="${WT_BASE:-$HOME}"

for lane in "${LANES[@]}"; do
  name="${lane%%:*}"; rest="${lane#*:}"
  wt="${rest%%:*}"
  [ "$name" = dev ] && continue
  path="$WT_BASE/$wt"
  if [ ! -d "$path/.git" ]; then
    git -C "$REPO" worktree add -b "swarm/$FEATURE/$name" "$path" main
  fi
  echo "$name $path"
done
```

- [ ] **Step 4: Run test, verify it passes**

```bash
bash ~/.agents/skills/lexa-swarm/tests/test-worktrees.sh
```

Expected: PASS. Cleanup: `rm -rf "$HOME/lexa-wf"`.

- [ ] **Step 5: Commit** — outside repo; note in reply.

---

### Task 3: `lane-agents.sh`

**Files:**
- Create: `~/.agents/skills/lexa-swarm/scripts/lane-agents.sh`
- Test: `~/.agents/skills/lexa-swarm/tests/test-lane-agents.sh`

**Interfaces:**
- Consumes: `lanes.conf`, `FEATURE`
- Produces: `<worktree>/AGENTS.md` per lane — scoped rules (allowed/forbidden paths from lexa AGENTS.md), verify commands, status protocol. dev lane: no AGENTS.md (no agent).

- [ ] **Step 1: Write failing test** (temp worktree fixture, assert file contents contain lane name and `tsc --noEmit`)

```bash
#!/usr/bin/env bash
set -euo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/lexa-wf" "$TMP/lexa-fe" "$TMP/lexa-be" "$TMP/lexa-cli" "$TMP/lexa-docs"
WT_BASE="$TMP" FEATURE=test-lane \
  bash ~/.agents/skills/lexa-swarm/scripts/lane-agents.sh
grep -q "You are the wf lane" "$TMP/lexa-wf/AGENTS.md"
grep -q "tsc --noEmit" "$TMP/lexa-fe/AGENTS.md"
grep -q "server/" "$TMP/lexa-be/AGENTS.md"
[ ! -f "$TMP/lexa-dev/AGENTS.md" ]
echo "PASS"
```

- [ ] **Step 2: Run test, verify it fails**

Expected: FAIL (no such file).

- [ ] **Step 3: Write `lane-agents.sh`** — per-lane heredoc templates. Common footer: status protocol (write `status/<lane>.md`, append timestamp each action, `DONE` + `tsc` green to finish). Lane-specific body: `wf` → wireframe-first mandate, `bash wireframes/build.sh`; `fe` → never touch `server/`/`shared/types.ts`/`docs/`/configs, wireframe gate required, port classes from `wireframes/src`; `be` → owns `shared/types.ts` + `docs/API.md`, commit contract first, Effect service patterns; `cli` → `cli/src` only, `bun run compile:cli` check, keep `packed.ts` stub unless shipping daemon change; `docs` → docs authority order, update CHANGELOG when feature lands; `dev` → skip. Verify lines: `tsc --noEmit`, `vitest run`, `bash -n` on changed scripts.

- [ ] **Step 4: Run test, verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit** — outside repo; note in reply.

---

### Task 4: `status.sh` + `gate.sh`

**Files:**
- Create: `~/.agents/skills/lexa-swarm/scripts/status.sh`
- Create: `~/.agents/skills/lexa-swarm/scripts/gate.sh`
- Test: `~/.agents/skills/lexa-swarm/tests/test-gate.sh`

**Interfaces:**
- Consumes: `STATUS_DIR` (default `<repo>/status`), `REPO`
- Produces: `status.sh` — `report <lane> <state>` writes `status/<lane>.md` with `state`, timestamp, last message; `gate.sh` — runs `tsc --noEmit`, `vitest run`, `bash wireframes/build.sh`, exits nonzero on any failure.

- [ ] **Step 1: Write failing test**

```bash
#!/usr/bin/env bash
set -euo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
STATUS_DIR="$TMP/status" bash ~/.agents/skills/lexa-swarm/scripts/status.sh report be DONE "contract committed"
grep -q "DONE" "$TMP/status/be.md"
bash ~/.agents/skills/lexa-swarm/scripts/status.sh stale 10 | grep -q "be.md"
echo "PASS"
```

- [ ] **Step 2: Run test, verify it fails**

Expected: FAIL.

- [ ] **Step 3: Write `status.sh`** — `report <lane> <state> [message]`: `mkdir -p "$STATUS_DIR"`, write `state: <state>\nts: <epoch>\nmsg: <message>`; `stale <minutes>`: print status files whose ts older than N minutes. Write `gate.sh`: `cd "${REPO:?}"`; run the three commands, capture failures, exit 1 listing each failed gate with tail of output.

- [ ] **Step 4: Run test, verify it passes**

Expected: PASS.

- [ ] **Step 5: Test gate on lexa main**

```bash
REPO=~/projects/lexa bash ~/.agents/skills/lexa-swarm/scripts/gate.sh
```

Expected: exit 0 (or list genuine pre-existing failures; report them).

- [ ] **Step 6: Commit** — outside repo; note in reply.

---

### Task 5: `spawn-layout.sh`

**Files:**
- Create: `~/.agents/skills/lexa-swarm/scripts/spawn-layout.sh`

**Interfaces:**
- Consumes: `lanes.conf`, worktrees from Task 2, running herdr server
- Produces: 7-pane layout in current herdr session: orchestrator (repo root, no opencode), then per lane a pane with `cwd=<worktree>`; lane panes run `opencode` (except dev runs `bun run dev:full`); panes renamed to lane names.

- [ ] **Step 1: Write script** — split sequence from current pane: split down → wf; split down → docs; split down → dev; back to first right column: split right → fe; split right → be; split right → cli. For each lane pane: `herdr pane split --direction down|right --ratio 50 --cwd "$WT_BASE/$wt"` capturing returned pane id; `herdr pane run <id> opencode` (lane) or `bun run dev:full` (dev); `herdr pane rename <id> <lane>`. Orchestrator: print "orchestrator ready" + `opencode` hint (orchestrator pane is the one running the skill session — do NOT spawn a second opencode there; script only labels it). Guard: skip pane creation if a pane named `<lane>` exists (`herdr pane list | grep`).

- [ ] **Step 2: Syntax + smoke check**

```bash
bash -n ~/.agents/skills/lexa-swarm/scripts/spawn-layout.sh
herdr status | head -5
```

Expected: `bash -n` OK; herdr server running.

- [ ] **Step 3: Manual smoke (user runs, in herdr session)** — from main pane run script; verify 7 panes, correct cwd per pane, dev pane shows vite+API boot. If pane ids aren't captured correctly, fallback: `herdr pane list` + match by cwd. Report result.

- [ ] **Step 4: Commit** — outside repo; note in reply.

---

### Task 6: `merge-gate.sh`

**Files:**
- Create: `~/.agents/skills/lexa-swarm/scripts/merge-gate.sh`
- Test: `~/.agents/skills/lexa-swarm/tests/test-merge.sh`

**Interfaces:**
- Consumes: `lanes.conf`, `FEATURE`, `REPO`, `gate.sh`
- Produces: merges `swarm/<feature>/<lane>` branches into main in order be → wf → fe → cli → docs (dev skipped), runs `gate.sh`, prints `git diff --stat` summary of each merged branch for orchestrator review.

- [ ] **Step 1: Write failing test** (temp repo: create branches with distinct files, run script, assert merge + gate called)

```bash
#!/usr/bin/env bash
set -euo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
git -C "$TMP" init -q -b main && git -C "$TMP" commit -q --allow-empty -m init
for b in be wf fe cli docs; do
  git -C "$TMP" checkout -q -b "swarm/t/$b"
  echo "$b" > "$TMP/$b.txt"; git -C "$TMP" add "$TMP/$b.txt"; git -C "$TMP" commit -q -m "$b"
  git -C "$TMP" checkout -q main
done
REPO="$TMP" FEATURE=t GATE_CMD=true \
  bash ~/.agents/skills/lexa-swarm/scripts/merge-gate.sh
for b in be wf fe cli docs; do git -C "$TMP" log --oneline main | grep -q "$b"; done
echo "PASS"
```

- [ ] **Step 2: Run test, verify it fails**

Expected: FAIL.

- [ ] **Step 3: Write `merge-gate.sh`** — merge order `be wf fe cli docs` (dev skipped); for each: `git -C "$REPO" merge --no-ff "swarm/$FEATURE/$lane" -m "merge(lane): $lane ($FEATURE)"`, print `git diff --stat main "swarm/$FEATURE/$lane"` BEFORE merge for review; after all merges run `GATE_CMD` (default `bash "$SCRIPT_DIR/gate.sh"`); on gate failure exit 3 with failing gate output.

- [ ] **Step 4: Run test, verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit** — outside repo; note in reply.

---

### Task 7: End-to-end smoke + skill polish

**Files:**
- Modify: `~/projects/lexa/.gitignore` (add `status/`)
- Create: `~/.agents/skills/lexa-swarm/README.md` (quickstart: 3 commands)

**Interfaces:**
- Consumes: all prior tasks
- Produces: working skill; verified runthrough

- [ ] **Step 1: Add `status/` to lexa `.gitignore`**

Append `status/` line.

- [ ] **Step 2: Write README.md** — quickstart: `FEATURE=<slug> REPO=~/projects/lexa make-worktrees.sh` → `lane-agents.sh` → (in herdr) `spawn-layout.sh` → orchestrator flow recap (4 phases). ~30 lines.

- [ ] **Step 3: Full smoke** — in a herdr session: create 3 worktrees + agents for a throwaway feature, spawn layout, wait for 4 opencode sessions booting in lane panes + dev-server boot, kill panes, clean worktrees. Report any failures.

- [ ] **Step 4: Self-review against spec** — check each spec section (components, lifecycle steps 1-6, error table rows, testing) has a home in SKILL.md or a script. Fix gaps inline.

- [ ] **Step 5: Commit** — `.gitignore` change: `git -C ~/projects/lexa add .gitignore && git -C ~/projects/lexa commit -m "chore: ignore swarm status dir"`. Skill files: outside repo; note in reply.

---

## Self-Review Notes (run after writing)

- Spec coverage: components (skill/scripts/orchestrator) → Tasks 1-6; lifecycle plan/wireframe-gate/lanes/integrate/release → SKILL.md phases + Task 6 merge order; error table rows → SKILL.md rules + status.sh stale; testing/exit criteria → Task 4 gate.sh + lane AGENTS.md verify lines.
- Placeholders: none — all steps carry real commands/code.
- Type consistency: `LANES` format `lane:wt:path` used identically in Tasks 2-6; `FEATURE`, `REPO`, `WT_BASE`, `STATUS_DIR`, `GATE_CMD` env names consistent across tasks.
