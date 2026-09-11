#!/usr/bin/env bash
# Deprecated: use `lx machine install` instead (cli/src/index.ts).
# This wrapper is kept so existing scripts / docs don't break — it delegates
# to the CLI when run from this repo.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$REPO_DIR/cli/src/index.ts"

if [ ! -f "$CLI" ]; then
  echo "ERROR: lx not found at $CLI. This install.sh is deprecated." >&2
  echo "  Install lx and run: lx machine install" >&2
  exit 1
fi

echo "==> lx: ensuring Hearth machine listener (via deprecated install.sh wrapper) =="
exec bun run "$CLI" machine install "$@"
