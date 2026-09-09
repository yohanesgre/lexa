#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"
[ -d status ] || { echo "plan-check: status/ not found under $ROOT"; exit 2; }

fail=0
ok() { printf "  ok: %s\n" "$*"; }
bad() { printf "  fail: %s\n" "$*"; fail=1; }

PLAN="${1:-}"
if [ -z "$PLAN" ]; then
  echo "usage: plan-check.sh <plan>"
  exit 2
fi

DIR="status/$PLAN"
[ -f "$DIR/plan.md" ] || { bad "$DIR/plan.md missing"; }
[ -f "$DIR/status.md" ] || { bad "$DIR/status.md missing"; }

if [ -f "$DIR/plan.md" ]; then
  grep -qE "Out|Non-scope" "$DIR/plan.md" && ok "plan.md has scope Out" || bad "plan.md without scope Out/Non-scope (legacy SPEC docs stay RED by design)"
fi

if [ -f "$DIR/status.md" ]; then
  LINES="$(wc -l < "$DIR/status.md")"
  [ "$LINES" -eq 3 ] && ok "status.md is 3 lines" || bad "status.md is $LINES lines, want 3"
  for key in state ts msg; do
    grep -q "^$key:" "$DIR/status.md" && ok "status.md has $key" || bad "status.md missing $key"
  done
  if grep -q "^state: DONE" "$DIR/status.md"; then
    [ -f "$DIR/report.md" ] && ok "DONE has report.md" || bad "DONE without report.md"
  fi
fi

LOOSE="$(find status -maxdepth 1 -type f ! -name TIMELINE.md -print || true)"
if [ -z "$LOOSE" ]; then
  ok "no loose files in status/"
else
  bad "loose files in status/: $LOOSE"
fi

grep -q "| $PLAN |" status/TIMELINE.md 2>/dev/null \
  && ok "TIMELINE has $PLAN" || bad "TIMELINE missing $PLAN"

if [ -d "$DIR/lanes" ]; then
  shopt -s nullglob
  LANES=("$DIR"/lanes/*.md)
  shopt -u nullglob
  if [ ${#LANES[@]} -eq 0 ]; then
    ok "lanes dir empty (none dispatched yet)"
  else
    for lane in "${LANES[@]}"; do
      LINES="$(wc -l < "$lane")"
      [ "$LINES" -eq 3 ] && ok "lane $(basename "$lane") is 3 lines" || bad "lane $(basename "$lane") is $LINES lines, want 3"
    done
  fi
else
  ok "no lanes dir (single-track)"
fi

if [ $fail -eq 0 ]; then
  echo "plan-check GREEN for $PLAN"
else
  echo "plan-check RED for $PLAN"
  exit 1
fi
