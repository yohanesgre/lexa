#!/usr/bin/env bash
# verify-gate — pre-commit / pre-PR gate (typecheck → scoped tests → invariants → secrets).
#
# Usage: bash scripts/verify-gate.sh [--full] [--lane=<fe|be|cli|full>] [--print-plan]
#   default        scope the test step to the changed areas (see below)
#   --full         force the full suite regardless of changes
#   --lane=<l>     explicit override (fe|be|cli|full); accepts ci-local's fe|be|cli
#                  tokens plus full (ci-local also has shared and rejects full)
#   --print-plan   print the chosen lane(s) + command(s), run nothing, exit 0
#
# Scoping (from `git status --porcelain -uall`, staged + unstaged + untracked):
#   app/**                     -> fe lane   (bun run test:fe)
#   server/** shared/** migrations/** -> be lane (bun run test:be)
#   cli/** only                -> cli lane  (bun run test:cli)
#   app + be mixed             -> one deduped run over shared+server+app
#   cli mixed with app/be, tooling, unknown -> full (bun run test)
#   no changes                 -> full
#   status/** (repo-root only) or *.md only -> skip tests (typecheck still runs)
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
[ -f package.json ] || { echo "verify-gate: repo root not found under $ROOT"; exit 2; }

LANE_OVERRIDE=""
FORCE_FULL=0
PRINT_PLAN=0
for arg in "$@"; do
  case "$arg" in
    --full) FORCE_FULL=1 ;;
    --print-plan) PRINT_PLAN=1 ;;
    --lane=*)
      LANE_OVERRIDE="${arg#--lane=}"
      case "$LANE_OVERRIDE" in
        fe|be|cli|full) ;;
        *) echo "verify-gate: unknown --lane=$LANE_OVERRIDE (want fe|be|cli|full)"; exit 1 ;;
      esac
      ;;
    *) echo "verify-gate: unknown flag $arg"; exit 1 ;;
  esac
done

# ── Changed paths (staged + unstaged + untracked) ─────────────────────
CHANGED=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  path="${line:3}"
  if [[ "$path" == *" -> "* ]]; then path="${path##* -> }"; fi
  path="${path%\"}"; path="${path#\"}"
  CHANGED+=("$path")
done < <(git status --porcelain -uall)

has_app=0
has_be=0
has_cli=0
has_unknown=0
any=0
touched_invariants=0
touched_wireframes=0
for p in "${CHANGED[@]-}"; do
  [ -z "$p" ] && continue
  any=1
  case "$p" in
    status/*|*.md) ;;                                             # repo-root status/ or markdown only
    app/*) has_app=1 ;;
    server/*|shared/*|migrations/*) has_be=1 ;;
    cli/*) has_cli=1 ;;
    *) has_unknown=1 ;;
  esac
  case "$p" in
    server/*|shared/*|docs/SCHEMA*|*check-invariants*) touched_invariants=1 ;;
  esac
  case "$p" in
    wireframes/src/*) touched_wireframes=1 ;;
  esac
done

# ── Plan ──────────────────────────────────────────────────────────────
PLAN="full"
if [ -n "$LANE_OVERRIDE" ]; then
  PLAN="$LANE_OVERRIDE"
elif [ "$FORCE_FULL" -eq 1 ]; then
  PLAN="full"
elif [ "$any" -eq 0 ]; then
  PLAN="full"
elif [ "$has_unknown" -eq 1 ]; then
  PLAN="full"
elif [ "$has_cli" -eq 1 ] && { [ "$has_app" -eq 1 ] || [ "$has_be" -eq 1 ]; }; then
  PLAN="full"
elif [ "$has_cli" -eq 1 ]; then
  PLAN="cli"
elif [ "$has_app" -eq 1 ] && [ "$has_be" -eq 1 ]; then
  PLAN="mixed"
elif [ "$has_app" -eq 1 ]; then
  PLAN="fe"
elif [ "$has_be" -eq 1 ]; then
  PLAN="be"
else
  PLAN="skip"
fi

case "$PLAN" in
  full)  PLAN_LABEL="full";  PLAN_CMDS=("bun" "run" "test") ;;
  fe)    PLAN_LABEL="fe";    PLAN_CMDS=("bun" "run" "test:fe") ;;
  be)    PLAN_LABEL="be";    PLAN_CMDS=("bun" "run" "test:be") ;;
  cli)   PLAN_LABEL="cli";   PLAN_CMDS=("bun" "run" "test:cli") ;;
  mixed) PLAN_LABEL="mixed"; PLAN_CMDS=("bun" "run" "test" "--" "shared" "server" "app") ;;
  skip)  PLAN_LABEL="skip";  PLAN_CMDS=() ;;
esac

say_plan() {
  printf "\033[1m▶ %s\033[0m\n" "$*"
}
say_plan "Gate plan: test lane = $PLAN_LABEL"
if [ "$PLAN_LABEL" = "skip" ]; then
  printf "  tests: skipped (status/** or *.md only)\n"
else
  printf "  command: %s\n" "${PLAN_CMDS[*]}"
fi

if [ "$PRINT_PLAN" -eq 1 ]; then
  exit 0
fi

LOG_DIR="${GATE_LOG_DIR:-/tmp/opencode}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/gate-$(date +%Y%m%d-%H%M%S).log"

fail=0

say() { printf "\033[1m▶ %s\033[0m\n" "$*"; }
ok() { printf "  \033[32m✓ %s\033[0m\n" "$*"; }
bad() { printf "  \033[31m✗ %s\033[0m\n" "$*"; fail=1; }

say "Gate log: $LOG (full output, screen shows tail only)"

say "Gate: tsc --noEmit"
if bun run typecheck 2>&1 | tee -a "$LOG" | tail -n 30; then ok "typecheck passed"; else bad "typecheck failed"; fi

if [ "$PLAN_LABEL" = "skip" ]; then
  say "Gate: vitest run (skipped — status/** or *.md only)"
  ok "tests skipped"
else
  say "Gate: vitest run ($PLAN_LABEL)"
  if "${PLAN_CMDS[@]}" 2>&1 | tee -a "$LOG" | tail -n 30; then ok "tests passed ($PLAN_LABEL)"; else bad "tests failed ($PLAN_LABEL)"; fi
fi

if [ "$touched_invariants" -eq 1 ]; then
  say "Gate: check:invariants (touched server/shared/schema)"
  if bun run check:invariants 2>&1 | tee -a "$LOG" | tail -n 30; then ok "invariants passed"; else bad "invariants failed"; fi
fi

if [ "$touched_wireframes" -eq 1 ]; then
  say "Gate: wireframes/build.sh (wireframes/src touched)"
  if bash wireframes/build.sh 2>&1 | tee -a "$LOG" | tail -n 20; then ok "wireframes build passed"; else bad "wireframes build failed"; fi
fi

say "Gate: secrets / staged check"
STAGED="$(git diff --cached --name-only || true)"
# `(^|/)\.env` covers .env, .env.toml, .env.legacy, .env.staging/.prod; the
# tracked .env.toml.example template is explicitly exempt.
if echo "$STAGED" | grep -vE '\.env\.toml\.example$' | grep -qE '((^|/)\.env|private-key\.pem|\.private-key\.pem|config\.json)'; then
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
printf "Full log: %s\n" "$LOG"
