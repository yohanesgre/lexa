#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8080}"

echo "Building wireframes..."
bash build.sh

echo "Serving on http://localhost:${PORT}"
python3 -m http.server "${PORT}" --directory dist