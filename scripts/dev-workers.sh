#!/usr/bin/env bash
# Lexa local Worker dev (vite + workerd via the Cloudflare Vite plugin).
#   bun run dev            # the default local loop
#   bun run dev:workers    # same script, explicit alias
#
# - Ensures `.dev.vars` is current: the Workers runtime reads `.dev.vars`, not
#   `.env.toml`. Derived from the env file through the loader's emit path
#   (`bun server/env-file.ts --path <file> --emit-dotenv`), keeping only the
#   runtime-relevant prefixes (`LXK_`, `LOG_LEVEL`, `TANSTACK_AI_`, `CRON_SECRET`),
#   created 0600 from birth (umask) with a chmod backstop.
# - Regenerates `.dev.vars` when it is missing or when the source env file is
#   NEWER (mtime); otherwise reuses it. Logs which path it took.
# - Applies local D1 migrations, then execs `vite dev` with LEXA_FLAVOR=workers.
# - vite is resolved from node_modules/.bin via `bun x` (bare `vite` is not on
#   PATH inside this script).
# - One workerd instance co-hosts the handler and the API; browser auth rides
#   the session cookie.
set -euo pipefail

cd "$(dirname "$0")/.."

# Never leave a partial .dev.vars behind: the write below stages to
# .dev.vars.tmp and atomically renames it; this clears the staging file if the
# script is interrupted before the rename.
trap 'rm -f .dev.vars.tmp' EXIT

if [ -f .env.toml ]; then
  env_file=.env.toml
elif [ -f .env ]; then
  env_file=.env
else
  env_file=""
fi

regen=0
if [ ! -f .dev.vars ]; then
  if [ -z "$env_file" ]; then
    echo "No .env.toml found — run \`bun run setup\` first." >&2
    exit 1
  fi
  regen=1
  echo "Generating .dev.vars (missing) from $env_file."
elif [ -n "$env_file" ] && [ "$env_file" -nt .dev.vars ]; then
  regen=1
  echo "Regenerating .dev.vars ($env_file is newer) from $env_file."
else
  echo "Reusing existing .dev.vars."
  chmod 600 .dev.vars 2>/dev/null || true
fi

if [ "$regen" -eq 1 ]; then
  if ! raw="$(bun server/env-file.ts --path "$env_file" --emit-dotenv)"; then
    echo "env-file: failed to read $env_file" >&2
    exit 1
  fi
  derived="$(printf '%s\n' "$raw" | grep -E '^(LXK_|LOG_LEVEL|TANSTACK_AI_|CRON_SECRET)' || true)"
  if [ -z "$derived" ]; then
    echo "No runtime keys found in $env_file — run \`bun run setup\` first." >&2
    exit 1
  fi
  (umask 077; printf '%s\n' "$derived" > .dev.vars.tmp)
  chmod 600 .dev.vars.tmp
  mv -f .dev.vars.tmp .dev.vars
  echo "Wrote .dev.vars from $env_file (0600)."
fi

bun x wrangler d1 migrations apply DB --local

exec env LEXA_FLAVOR=workers bun x vite dev "$@"
