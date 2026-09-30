# Gate checks — detail

Parity with the release CI (`.github/workflows/ci.yml`, release-prep only) and AGENTS.md phase gates.

## When to run

- Before every `git commit`
- Before every PR create / tag
- Before every release-prep push (`chore/release-*` / `release/*`) — the only points CI runs
- Before `status/<lane>.md` → DONE

## Commands

```bash
# 1. Typecheck (required every gate)
tsc --noEmit
# or
bun run typecheck

# 2. Tests — scoped by default (see "Scoped test step" below)
bash scripts/verify-gate.sh --print-plan   # preview the chosen lane + command
bash scripts/verify-gate.sh                # typecheck + scoped tests + conditional checks
bash scripts/verify-gate.sh --full         # force the full suite (pre-merge)
# lane shortcuts (test:* scripts; ci-local.sh --lane tokens: shared|be|fe|cli)
bun run test:shared   # shared/ only
bun run test:be       # shared/ + server/
bun run test:fe       # shared/ + app/
bun run test:app      # app/ only (fastest frontend loop)
bun run test:cli      # cli/src/
bun run test          # full suite

# 3. Invariants (if touched server/, shared/, docs/SCHEMA.md, scripts/check-invariants.ts)
bun run check:invariants

# 4. Wireframes (if touched wireframes/src/)
bash wireframes/build.sh

# 5. Mobile check (if touched app/routes, app/components, app/styles)
bun scripts/check-mobile.mjs  # or bun run check:mobile (loads .env.toml via the loader)

# 6. Secrets / staged sanity
git diff --cached --name-only | grep -E '(\.env|\.pem|private-key|config\.json)' && echo "BLOCKED: secrets staged"
git diff --cached --name-only  # review what you're about to commit
git diff --cached | head -n 200  # spot stray console.log / debug

# 7. Lint / doctor (optional, non-blocking unless CI fails)
npx react-doctor@latest --scope changed  # if React changes
```

## Scoped test step (verify-gate.sh)

`bash scripts/verify-gate.sh` picks the test lane from `git status --porcelain`
(staged + unstaged + untracked):

| Changed               | Lane / command |
|---|---|
| `app/**`              | fe — `bun run test:fe` |
| `server/**` `shared/**` `migrations/**` | be — `bun run test:be` |
| `cli/**` only         | cli — `bun run test:cli` |
| app + be mixed        | one deduped `bun run test -- shared server app` |
| cli mixed with app/be, tooling, unknown | full — `bun run test` |
| `status/**` or `*.md` only | tests skipped (typecheck still runs) |
| no changes            | full — `bun run test` |

Flags: `--full` (force full suite), `--lane=<fe|be|cli|full>` (explicit
override; accepts `scripts/ci-local.sh`'s `fe|be|cli` tokens plus `full` —
ci-local also has `shared` and rejects `full`), `--print-plan` (print the
chosen lane + command(s), run nothing, exit 0).

Iteration contract: touched test file(s) during iteration
(`bun run test -- <path>`, ~1s), the lane at lane close, the full suite at
pre-merge only.

## CI parity

CI runs **only at release preparation** — a push to `chore/release-*` / `release/*`
or a manual `workflow_dispatch`; PRs and main merges rely on the local gate below
plus review. On those runs CI executes the full validation:
`typecheck` → `test:full` → `check:invariants` → build → `docker smoke` →
coverage 60% → `gitleaks` → `lint warn`.
Local `verify-gate.sh` covers the fast subset (first 3 + secrets + wireframes);
its test step is scoped by default — use `--full` for the complete suite. Full
docker smoke only in CI.

## Failure handling

- Any gate red → fix, don't commit with `--no-verify`.
- If you must bypass for WIP, use branch `wip/<slug>` and note in commit body `WIP: reason — will gate before PR`.
- Never tag release with red gate.

## Scoped reruns (save loop iterations)

Full suite is slow (~2 min) and can flake under parallel load (API `beforeAll`
hook timeouts). On red, rerun ONLY the failed files before concluding anything:

```bash
bun run test -- <path1> <path2>  # vitest scoped run, same config
```

Capture exit codes before pipes — `cmd | tail` reports `tail`'s status.
Use `set -o pipefail` or save output first, then inspect:

```bash
set -o pipefail
bun run test 2>&1 | tee /tmp/opencode/gate-<slug>.log | tail -n 30
```

Attribute reds on a pristine `main` worktree, never on the feature branch:

```bash
git worktree add .worktrees/<slug>-main main  # .worktrees/ is gitignored
cd .worktrees/<slug>-main && bun run test -- <failed files>
# identical failure on main = pre-existing (declare in PR body, proceed);
# green on main = branch caused it (fix first). Remove worktree after merge.
```
