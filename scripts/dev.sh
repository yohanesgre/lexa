#!/usr/bin/env bash
# Lexa local dev — one command: API server (:3000) + vite frontend (:5173).
#   bun run dev
#
# - Loads .env.toml (or legacy .env) into the shell so both processes see it.
# - Vite inherits those exported values from the process environment; it is not
#   TOML-aware and additionally auto-loads a legacy flat .env if one exists.
# - Browser auth rides the session cookie.
# - The API server injects the current key into served HTML (meta tag), so
#   `bun run setup` rotating the key never breaks the browser — no rebuild.
# - Ctrl-C stops BOTH processes.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env.toml ] && [ ! -f .env ]; then
  echo "No .env.toml found — run \`bun run setup\` first." >&2
  exit 1
fi

ENV_EXPORTS="$(bun server/env-file.ts --export-shell)" || {
  echo "Failed to load .env.toml — fix the error above." >&2
  exit 1
}
eval "$ENV_EXPORTS"

# Defaults apply only when the file did not set them.
# Sample data on every boot (dev convenience) unless opted out.
# `bun run setup` with N (or --no-seed) writes LXK_SEED_DEV=0;
# Delete data/lexa.db* to reset.
export LXK_SEED_DEV="${LXK_SEED_DEV:-1}"
# Dev flavor — enables the vite dev origin in Better Auth trustedOrigins
# (cookie-bearing auth POSTs through the :5173 proxy) regardless of file state.
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

bun run server/entry.ts &
SERVER_PID=$!

# Pin the vite port so the banner stays true; fail loudly if it's taken.
# Invoke vite directly (not `bun run dev:workers`, which is the Workers flavor) so this
# stays Bun flavor and keeps the /api → :3000 proxy.
bun x vite dev --port 5173 --strictPort &
VITE_PID=$!

wait -n "$SERVER_PID" "$VITE_PID"
