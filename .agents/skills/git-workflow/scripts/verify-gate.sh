#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

fail=0

say() { printf "\033[1m▶ %s\033[0m\n" "$*"; }
ok() { printf "  \033[32m✓ %s\033[0m\n" "$*"; }
bad() { printf "  \033[31m✗ %s\033[0m\n" "$*"; fail=1; }

say "Gate: tsc --noEmit"
if bun run typecheck 2>&1 | tail -n 30; then ok "typecheck passed"; else bad "typecheck failed"; fi

say "Gate: vitest run"
if bun run test 2>&1 | tail -n 30; then ok "tests passed"; else bad "tests failed"; fi

if git diff --cached --name-only | grep -qiE "(server/|shared/|docs/SCHEMA|check-invariants)" || git diff --name-only | grep -qiE "(server/|shared/|docs/SCHEMA)"; then
  say "Gate: check:invariants (touched server/shared/schema)"
  if bun run check:invariants 2>&1 | tail -n 30; then ok "invariants passed"; else bad "invariants failed"; fi
fi

if git diff --cached --name-only | grep -qi "^wireframes/src/" || git diff --name-only | grep -qi "^wireframes/src/"; then
  say "Gate: wireframes/build.sh (wireframes/src touched)"
  if bash wireframes/build.sh 2>&1 | tail -n 20; then ok "wireframes build passed"; else bad "wireframes build failed"; fi
fi

say "Gate: secrets / staged check"
STAGED="$(git diff --cached --name-only || true)"
if echo "$STAGED" | grep -qE '(\.env(\.|$)|private-key\.pem|\.private-key\.pem|config\.json)'; then
  bad "secrets staged: $STAGED"
else
  ok "no secrets staged"
fi
if echo "$STAGED" | grep -q "wireframes/dist/"; then
  bad "wireframes/dist staged — never edit dist directly"
else
  ok "no dist staged"
fi

if [ -n "$STAGED" ]; then
  say "Staged:"
  echo "$STAGED" | sed 's/^/  - /'
else
  say "No staged changes (gate ran on working tree)"
fi

if [ $fail -eq 0 ]; then
  printf "\n\033[32mGate GREEN — safe to commit.\033[0m\n"
else
  printf "\n\033[31mGate RED — fix before commit.\033[0m\n"
  exit 1
fi
