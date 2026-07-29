#!/usr/bin/env bash
# Build wireframes: recursively replace <INCLUDE partials/FILE> with actual content.
# Reads from src/ → writes to ./ (wireframes root).
# Supports nested includes — partials can include other partials.
set -euo pipefail
cd "$(dirname "$0")"

MAX_DEPTH=10

resolve_file() {
  local file="$1" indent="${2:-}" depth="${3:-0}"
  if (( depth > MAX_DEPTH )); then
    echo "${indent}<!-- MAX_DEPTH exceeded for $file -->"
    return
  fi
  while IFS= read -r line; do
    if [[ "$line" =~ ^([[:space:]]*)"<INCLUDE "(.*)" />"[[:space:]]*$ ]]; then
      local partial="partials/${BASH_REMATCH[2]}"
      local sub_indent="${indent}${BASH_REMATCH[1]}"
      if [[ -f "$partial" ]]; then
        resolve_file "$partial" "$sub_indent" $((depth + 1))
      else
        echo "${indent}<!-- MISSING: $partial -->"
      fi
    else
      echo "${indent}${line}"
    fi
  done < "$file"
}

for src_file in src/*.html; do
  base=$(basename "$src_file")
  out_file="$base"
  resolve_file "$src_file" "" 0 > "$out_file"
  echo "  built $base"
done
echo "Done."
