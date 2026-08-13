#!/usr/bin/env bash
# Lexa local dev — one command: API server (:3000) + vite frontend (:5173).
#   bun run dev:full
#
# - Loads .env (LXK_API_KEY etc.) into the shell so both processes see it.
# - vite auto-loads VITE_LXK_API_KEY from .env for the browser auth header.
# - The API server injects the current key into served HTML (meta tag), so
#   `bun run setup` rotating the key never breaks the browser — no rebuild.
# - Ctrl-C stops BOTH processes.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env found — run \`bun run setup\` first." >&2
  exit 1
fi

set -a
. ./.env
set +a

# Sample data on every boot (dev convenience). Delete data/lexa.db* to reset.
export LXK_SEED_DEV="${LXK_SEED_DEV:-1}"
# Dev flavor — enables the vite dev origin in Better Auth trustedOrigins
# (cookie-bearing auth POSTs through the :5173 proxy) regardless of .env state.
export LXK_ENV="${LXK_ENV:-dev}"

cleanup() {
  echo ""
  echo "Stopping dev servers…"
  kill "$SERVER_PID" "$VITE_PID" 2>/dev/null || true
  wait "$SERVER_PID" "$VITE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "── Lexa dev ──"
echo "  API:      http://localhost:3000  (bun server/entry.ts)"
echo "  Frontend: http://localhost:5173  (vite, proxies /api → :3000)"
echo ""

bun --env-file=.env run server/entry.ts &
SERVER_PID=$!

# Pin the vite port so the banner stays true; fail loudly if it's taken.
bun run dev --port 5173 --strictPort &
VITE_PID=$!

wait -n "$SERVER_PID" "$VITE_PID"
