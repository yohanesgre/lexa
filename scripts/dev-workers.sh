#!/usr/bin/env bash
# Lexa local dev — Workers flavor (workerd via the Cloudflare Vite plugin).
#   bun run dev / bun run dev:workers
#
# - Ensures `.dev.vars` exists: the Workers runtime reads `.dev.vars`, not
#   `.env.toml`. Derived from the env file through the loader's emit path
#   (`bun server/env-file.ts --emit-dotenv`), filtered to the `LXK_*` keys the
#   runtime consumes, written 0600. Idempotent — an existing `.dev.vars` is
#   never overwritten.
# - Applies local D1 migrations, then execs `vite dev` with LEXA_FLAVOR=workers.
# - One workerd instance co-hosts the handler and the API; browser auth rides
#   the session cookie.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .dev.vars ]; then
  if [ ! -f .env.toml ] && [ ! -f .env ]; then
    echo "No .env.toml found — run \`bun run setup\` first." >&2
    exit 1
  fi
  derived="$(bun server/env-file.ts --emit-dotenv | grep -E '^LXK_[A-Z0-9_]*=' || true)"
  if [ -z "$derived" ]; then
    echo "No LXK_* keys found in the env file — run \`bun run setup\` first." >&2
    exit 1
  fi
  printf '%s\n' "$derived" > .dev.vars
  chmod 600 .dev.vars
  echo "Wrote .dev.vars from the env file (0600)."
fi

bun x wrangler d1 migrations apply DB --local

exec env LEXA_FLAVOR=workers vite dev "$@"
