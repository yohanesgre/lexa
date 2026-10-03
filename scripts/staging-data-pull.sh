#!/usr/bin/env bash
# Lexa staging → local Workers data pull.
#   bun run staging:pull
#
# Pulls the STAGING D1 contents into the LOCAL Workers dev state so
# `bun run dev:workers` serves staging data locally (assistant included).
#
# - Requires wrangler.staging.local.jsonc at the repo root (gitignored; the
#   staging custody config). Clear error + hint if absent.
# - Backs up the existing local D1 state (MOVED, never deleted) to
#   .tmp/wrangler-d1-backup-<timestamp>. The do/, kv/, and r2/ state
#   directories are never touched.
# - Recreates the local D1 from the staging schema (read from sqlite_master),
#   then imports staging data. Full `wrangler d1 export` refuses any database
#   with FTS5 virtual tables (Lexa has wiki_fts / project_memory_fts), so the
#   schema is rebuilt from sqlite_master and the data export runs per-table,
#   skipping the virtual + shadow tables; the local FTS indexes are rebuilt
#   from the imported content afterwards.
# - Prints the local projects count as a post-check.
#
# Never prints secrets or dump contents.
#
# Usage: bash scripts/staging-data-pull.sh [--help]
# Requires bash >= 4 (mapfile).
set -euo pipefail

cd "$(dirname "$0")/.."

CFG="wrangler.staging.local.jsonc"
SCHEMA=".tmp/staging-schema.sql"
DUMP=".tmp/staging-dump.sql"
D1_STATE=".wrangler/state/v3/d1"

# Backup path (set once the local D1 state is moved). The ERR trap reports it
# plus the exact restore command so a failed export/import is recoverable.
backup=""
on_err() {
  local rc=$?
  if [ -n "$backup" ]; then
    echo "" >&2
    echo "staging-data-pull: FAILED (exit $rc)." >&2
    echo "  Local D1 backup: $backup" >&2
    echo "  Restore: mv \"$backup\" \"$D1_STATE\"" >&2
  fi
  exit "$rc"
}
trap on_err ERR

# Run wrangler with stdout → $1, stderr → $2. On failure print a redacted tail
# of the log (never dump contents, never the presigned R2 URL).
wrangler_capture() {
  local out="$1" log="$2"
  shift 2
  if ! bun x wrangler "$@" >"$out" 2>"$log"; then
    echo "staging-data-pull: wrangler failed (log: $log)" >&2
    tail -n 20 "$log" | sed '/cloudflarestorage\.com/d' >&2
    return 1
  fi
}

usage() {
  cat <<'EOF'
Lexa staging → local Workers data pull.

Usage: bash scripts/staging-data-pull.sh [--help]

Imports the staging D1 contents into the local Workers dev state
(.wrangler/state/v3/d1) so `bun run dev:workers` serves staging data
locally, assistant included.

Requires wrangler.staging.local.jsonc at the repo root (gitignored). Staging
is read with `wrangler d1 export --remote`; the existing local D1 state is
backed up under .tmp/ before import. Never prints secrets or dump contents.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --help) usage; exit 0 ;;
    *) echo "staging-data-pull: unknown flag $arg (try --help)" >&2; exit 1 ;;
  esac
done

if [ ! -f "$CFG" ]; then
  echo "staging-data-pull: config not found: $CFG" >&2
  echo "  Copy wrangler.staging.example.jsonc to $CFG and fill in the account, D1, and KV ids (see docs/DEPLOYMENT.md §Staging from a clone)." >&2
  exit 1
fi

mkdir -p .tmp

echo "── Lexa staging → local data pull ──"
echo ""

# Preflight: this script moves .wrangler/state/v3/d1, which a running dev
# server (workerd) holds open. Abort before touching anything.
if pgrep -f "vite dev" >/dev/null 2>&1; then
  echo "staging-data-pull: a dev server appears to be running (vite dev)." >&2
  echo "  Stop it first — this script moves $D1_STATE under a live workerd." >&2
  exit 1
fi

if [ -d "$D1_STATE" ]; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup=".tmp/wrangler-d1-backup-$stamp"
  echo "Reset: backing up local D1 state → $backup"
  mv "$D1_STATE" "$backup"
else
  echo "Reset: no existing local D1 state to back up."
fi

# Real data tables on staging: exclude SQLite internals, wrangler internals,
# the FTS5 virtual tables, and their shadow tables. d1_migrations is included
# so the local migration journal matches staging (dev:workers then no-ops).
list_tables() {
  local out=".tmp/list-tables.json" log=".tmp/list-tables.log"
  wrangler_capture "$out" "$log" d1 execute DB --remote --config "$CFG" --json --command "
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
      AND name NOT LIKE '\_cf\_%' ESCAPE '\'
      AND NOT EXISTS (
        SELECT 1 FROM sqlite_master AS v
        WHERE v.sql LIKE 'CREATE VIRTUAL TABLE%'
          AND (sqlite_master.name = v.name OR sqlite_master.name LIKE v.name || '\_%' ESCAPE '\')
      )
    ORDER BY name"
  bun -e 'const c = []; for await (const x of Bun.stdin.stream()) c.push(x); const j = JSON.parse(Buffer.concat(c).toString()); for (const r of j[0].results) console.log(r.name)' < "$out"
}

echo ""
echo "Schema: staging → $SCHEMA"
wrangler_capture .tmp/staging-schema.json .tmp/schema.log d1 execute DB --remote --config "$CFG" --json --command "
  SELECT sql FROM sqlite_master
  WHERE sql IS NOT NULL
    AND type IN ('table', 'index', 'trigger', 'view')
    AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
    AND name NOT LIKE '\_cf\_%' ESCAPE '\'
    AND NOT EXISTS (
      SELECT 1 FROM sqlite_master AS v
      WHERE v.sql LIKE 'CREATE VIRTUAL TABLE%'
        AND sqlite_master.type = 'table'
        AND sqlite_master.name LIKE v.name || '\_%' ESCAPE '\'
    )
  ORDER BY rowid"
bun -e 'const c = []; for await (const x of Bun.stdin.stream()) c.push(x); const j = JSON.parse(Buffer.concat(c).toString()); let out = ""; for (const r of j[0].results) out += r.sql.trim().replace(/;?\s*$/, "") + ";\n"; process.stdout.write(out)' < .tmp/staging-schema.json > "$SCHEMA"

if [ ! -s "$SCHEMA" ]; then
  echo "staging-data-pull: could not read staging schema (is wrangler authenticated?)." >&2
  exit 1
fi

echo "Schema: applying to local D1"
wrangler_capture .tmp/schema-apply.out .tmp/schema-apply.log d1 execute DB --local --file "$SCHEMA"

echo ""
echo "Export: staging data → $DUMP"
mapfile -t TABLES < <(list_tables)
if [ "${#TABLES[@]}" -eq 0 ]; then
  echo "staging-data-pull: could not list staging tables (is wrangler authenticated?)." >&2
  exit 1
fi

table_args=()
for t in "${TABLES[@]}"; do
  table_args+=(--table "$t")
done

# The transient presigned R2 download URL wrangler prints stays in the captured
# log (redacted from any failure tail); dump contents are never printed.
wrangler_capture .tmp/export.out .tmp/export.log d1 export DB --remote --config "$CFG" --skip-confirmation --no-schema \
  "${table_args[@]}" --output "$DUMP"

if [ ! -s "$DUMP" ]; then
  echo "staging-data-pull: export produced no data at $DUMP." >&2
  exit 1
fi

echo ""
echo "Import: $DUMP → local D1"
wrangler_capture .tmp/import.out .tmp/import.log d1 execute DB --local --file "$DUMP"

echo ""
echo "Index: rebuilding local FTS tables"
mapfile -t FTABLES < <(
  wrangler_capture .tmp/fts-tables.json .tmp/fts-tables.log d1 execute DB --local --json --command "SELECT name FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE%'"
  bun -e 'const c = []; for await (const x of Bun.stdin.stream()) c.push(x); const j = JSON.parse(Buffer.concat(c).toString()); for (const r of j[0].results) console.log(r.name)' < .tmp/fts-tables.json
)
for t in "${FTABLES[@]}"; do
  wrangler_capture .tmp/fts-rebuild.out .tmp/fts-rebuild.log d1 execute DB --local --command "INSERT INTO \"$t\"(\"$t\") VALUES('rebuild')"
done

echo ""
echo "Check: local projects count"
wrangler_capture .tmp/projects-count.out .tmp/projects-count.log d1 execute DB --local --command "SELECT COUNT(*) AS c FROM projects"
cat .tmp/projects-count.out

cat <<'EOF'

── Done ──

Notes:
  • Run `bun run dev:workers` to serve the staging contents locally.
  • Staging-encrypted secrets (assistant provider keys, MCP, Jev, GitHub) can
    only decrypt if .env.toml's LXK_SECRETS_MASTER_KEY matches staging's;
    otherwise re-enter the provider key locally.
  • Log in locally with the staging email/password.
  • `dev:full` (Bun) cannot show the assistant by design.
EOF
