#!/usr/bin/env bash
# Lexa local dev — Workers flavor (workerd via the Cloudflare Vite plugin).
#   bun run dev:workers
#
# - Ensures `.dev.vars` exists: the Workers runtime reads `.dev.vars`, not
#   `.env.toml`. Derived from the env file through the loader's emit path
#   (`bun server/env-file.ts --path <file> --emit-dotenv`), filtered to the
#   runtime key set (`LXK_*`, `LOG_LEVEL`, `TANSTACK_AI_*`, `CRON_SECRET`),
#   created 0600 from birth (umask) with a chmod backstop.
# - Idempotent — an existing `.dev.vars` is NEVER overwritten.
# - Applies local D1 migrations, then execs `vite dev` with LEXA_FLAVOR=workers.
# - vite is resolved from node_modules/.bin via `bun x` (bare `vite` is not on
#   PATH inside this script).
# - One workerd instance co-hosts the handler and the API; browser auth rides
#   the session cookie.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .dev.vars ]; then
  if [ -f .env.toml ]; then
    env_file=.env.toml
  elif [ -f .env ]; then
    env_file=.env
  else
    echo "No .env.toml found — run \`bun run setup\` first." >&2
    exit 1
  fi
  if ! raw="$(bun server/env-file.ts --path "$env_file" --emit-dotenv)"; then
    echo "env-file: failed to read $env_file" >&2
    exit 1
  fi
  derived="$(printf '%s\n' "$raw" | grep -E '^(LXK_|LOG_LEVEL|TANSTACK_AI_|CRON_SECRET)' || true)"
  if [ -z "$derived" ]; then
    echo "No runtime keys found in $env_file — run \`bun run setup\` first." >&2
    exit 1
  fi
  (umask 077; printf '%s\n' "$derived" > .dev.vars)
  chmod 600 .dev.vars
  echo "Wrote .dev.vars from $env_file (0600)."
fi

bun x wrangler d1 migrations apply DB --local

exec env LEXA_FLAVOR=workers bun x vite dev "$@"
