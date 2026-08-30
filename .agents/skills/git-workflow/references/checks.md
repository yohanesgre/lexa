# Gate checks — detail

Parity with CI (`.github/workflows/*`) and AGENTS.md phase gates.

## When to run

- Before every `git commit`
- Before every PR create / tag
- Before `status/<lane>.md` → DONE

## Commands

```bash
# 1. Typecheck (required every gate)
tsc --noEmit
# or
bun run typecheck

# 2. Tests
vitest run                          # shared/ pure + any touched modules
# Full suite if schema/service/repo changed:
bun run test  # alias vitest run

# 3. Invariants (if touched server/, shared/, docs/SCHEMA.md, scripts/check-invariants.ts)
bun run check:invariants

# 4. Wireframes (if touched wireframes/src/)
bash wireframes/build.sh

# 5. Mobile check (if touched app/routes, app/components, app/styles)
bun --env-file=.env scripts/check-mobile.mjs  # or bun run check:mobile

# 6. Secrets / staged sanity
git diff --cached --name-only | grep -E '(\.env|\.pem|private-key|config\.json)' && echo "BLOCKED: secrets staged"
git diff --cached --name-only  # review what you're about to commit
git diff --cached | head -n 200  # spot stray console.log / debug

# 7. Lint / doctor (optional, non-blocking unless CI fails)
npx react-doctor@latest --scope changed  # if React changes
```

## CI parity

CI runs: `typecheck` → `vitest` (coverage 60%) → `check:invariants` → `docker smoke` → `gitleaks` → `lint warn`.
Local `verify-gate.sh` covers the fast subset (first 3 + secrets + wireframes). Full docker smoke only in CI.

## Failure handling

- Any gate red → fix, don't commit with `--no-verify`.
- If you must bypass for WIP, use branch `wip/<slug>` and note in commit body `WIP: reason — will gate before PR`.
- Never tag release with red gate.
