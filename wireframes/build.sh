#!/usr/bin/env bash
# Build wireframes: replace <INCLUDE partials/FILE> with actual content.
# Reads from src/ → writes to ./ (wireframes root).
set -euo pipefail
cd "$(dirname "$0")"

for src_file in src/*.html; do
  base=$(basename "$src_file")
  out_file="$base"
  (
    while IFS= read -r line; do
      if [[ "$line" =~ ^[[:space:]]*"<INCLUDE "(.*)" />"[[:space:]]*$ ]]; then
        partial="partials/${BASH_REMATCH[1]}"
        # indent with the leading whitespace
        indent="${line%%<*}"
        if [[ -f "$partial" ]]; then
          sed "s/^/$indent/" "$partial"
        else
          echo "  <!-- MISSING: $partial -->"
        fi
      else
        echo "$line"
      fi
    done < "$src_file"
  ) > "$out_file"
  echo "  built $base"
done
echo "Done."
