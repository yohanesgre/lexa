#!/usr/bin/env bash
# Deprecated: use `lexa-cli machine install` instead (cli/src/index.ts).
# This wrapper is kept so existing scripts / docs don't break — it delegates
# to the CLI when run from this repo.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$REPO_DIR/cli/src/index.ts"

if [ ! -f "$CLI" ]; then
  echo "ERROR: lexa-cli not found at $CLI. This install.sh is deprecated." >&2
  echo "  Install lexa-cli and run: lexa-cli machine install" >&2
  exit 1
fi

echo "==> lexa-cli: ensuring Hearth machine listener (via deprecated install.sh wrapper) =="
exec bun run "$CLI" machine install "$@"
