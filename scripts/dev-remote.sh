#!/usr/bin/env bash
# Lexa remote dev — vite frontend (:5173) against a REMOTE Lexa server.
#   bun run dev:remote [target-url]
#
# - Runs vite ONLY; the remote server co-hosts the API (no local Bun API boot).
# - Does NOT load .env.toml — the remote server owns its own env.
# - vite proxies /api to the target and rewrites the outgoing Origin to it so
#   Better Auth accepts cookie-bearing POSTs (staging trusts only its publicUrl).
# - Default target: staging. Override with $LEXA_DEV_API_TARGET or the first arg.
# - Ctrl-C stops vite.
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-${LEXA_DEV_API_TARGET:-https://lexa-staging.yohanesgre.workers.dev}}"
export LEXA_DEV_API_TARGET="$TARGET"

echo "── Lexa remote dev ──"
echo "  Frontend: http://localhost:5173  (vite, proxies /api → $TARGET)"
echo ""

exec bun run dev --port 5173 --strictPort
