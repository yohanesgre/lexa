#!/usr/bin/env bash
# Lexa staging deploy — clone-path Workers environment (docs/DEPLOYMENT.md §Staging from a clone).
#   bun run deploy:staging          build, migrate, deploy, push key (keeps data)
#   bun run deploy:staging:reset    wipe all staging resources, recreate, redeploy
#
# Fixed paths (repo root):
#   config       wrangler.staging.local.jsonc   (gitignored; carries account + resource ids)
#   key custody  .env.staging.toml              (0600; TOML: LXK_SECRETS_MASTER_KEY = "<base64>")
#
# Every wrangler call passes --config. The root wrangler.jsonc (prod) is never
# read or written; the filled config's "name" MUST be lexa-staging or we abort.
#
# Usage: bash scripts/deploy-staging.sh [--reset] [--yes] [--help]
#   --reset  delete R2, then worker (clears Durable Object storage), D1, KV,
#            then recreate the resources and run the normal deploy steps
#            (already-absent resources are skipped)
#   --yes    skip the typed confirmation prompt for --reset
#   --help   print this usage and exit 0
set -euo pipefail

cd "$(dirname "$0")/.."

CFG="wrangler.staging.local.jsonc"
ENV_FILE=".env.staging.toml"
LEGACY_ENV_FILE=".env.staging"
WORKER="lexa-staging"
D1_NAME="lexa-staging"
KV_NAME="lexa-staging"
BUCKET_FALLBACK="lexa-staging-blobs"
URL="https://lexa-staging.yohanesgre.workers.dev"

RESET=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Lexa staging deploy — clone-path Workers environment (docs/DEPLOYMENT.md §Staging from a clone).

Usage: bash scripts/deploy-staging.sh [--reset] [--yes] [--help]

  (no flags)  build:workers, apply remote D1 migrations, deploy, push
              LXK_SECRETS_MASTER_KEY from .env.staging.toml
  --reset     wipe all staging resources (R2, then worker + Durable Object
              storage, D1, KV), recreate them, then run the deploy steps;
              already-absent resources are skipped
  --yes       skip the typed confirmation prompt for --reset
  --help      print this usage and exit 0

Fixed paths (repo root):
  config       wrangler.staging.local.jsonc   (gitignored)
  key custody  .env.staging.toml              (0600; TOML: LXK_SECRETS_MASTER_KEY = "<base64>")
EOF
}

for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    --yes) ASSUME_YES=1 ;;
    --help) usage; exit 0 ;;
    *) echo "deploy-staging: unknown flag $arg (try --help)" >&2; exit 1 ;;
  esac
done

if [ ! -f "$CFG" ]; then
  echo "deploy-staging: config not found: $CFG — copy wrangler.staging.example.jsonc to it and fill in the account, D1, and KV ids (see docs/DEPLOYMENT.md §Staging from a clone)." >&2
  exit 1
fi

cfg_name="$(grep -m1 -E '^[[:space:]]*"name"[[:space:]]*:' "$CFG" | sed -E 's/^[^:]*:[[:space:]]*"([^"]+)".*/\1/')"
if [ "$cfg_name" != "$WORKER" ]; then
  echo "deploy-staging: refusing to run — $CFG name is '${cfg_name:-<missing>}', expected '$WORKER'." >&2
  exit 1
fi

cfg_d1="$(grep -m1 -E '^[[:space:]]*"database_id"[[:space:]]*:' "$CFG" | sed -E 's/^[^:]*:[[:space:]]*"([^"]+)".*/\1/')"
cfg_kv="$(grep -m1 -E '^[[:space:]]*"id"[[:space:]]*:' "$CFG" | sed -E 's/^[^:]*:[[:space:]]*"([^"]+)".*/\1/')"
cfg_bucket="$(grep -m1 -E '^[[:space:]]*"bucket_name"[[:space:]]*:' "$CFG" | sed -E 's/^[^:]*:[[:space:]]*"([^"]+)".*/\1/')"
[ -n "$cfg_bucket" ] || cfg_bucket="$BUCKET_FALLBACK"

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$LEGACY_ENV_FILE" ]; then
    cat >&2 <<'EOF'
deploy-staging: .env.staging.toml missing, but legacy .env.staging exists — convert it with:
  v="$(cut -d= -f2- .env.staging)"; printf 'LXK_SECRETS_MASTER_KEY = "%s"\n' "$v" > .env.staging.toml && chmod 600 .env.staging.toml && rm .env.staging
EOF
    exit 1
  fi
  echo "deploy-staging: $ENV_FILE missing — mint it with: printf 'LXK_SECRETS_MASTER_KEY = \"%s\"\\n' \"\$(openssl rand -base64 32)\" > $ENV_FILE && chmod 600 $ENV_FILE" >&2
  exit 1
fi

if [ -f "$LEGACY_ENV_FILE" ]; then
  echo "deploy-staging: legacy $LEGACY_ENV_FILE present — ignored; using $ENV_FILE." >&2
fi

# Extract the key through the repo loader (TOML-aware). The loader's dotenv
# emit quotes values containing characters outside its bare charset (base64
# `=`/`+`/`/`), so strip one layer of surrounding double quotes.
key="$(bun server/env-file.ts --path "$ENV_FILE" --emit-dotenv | sed -n 's/^LXK_SECRETS_MASTER_KEY=//p' | sed -e 's/^"//' -e 's/"$//' || true)"
if [ -z "$key" ]; then
  echo "deploy-staging: no LXK_SECRETS_MASTER_KEY in $ENV_FILE — add LXK_SECRETS_MASTER_KEY = \"<base64>\" (see docs/DEPLOYMENT.md §Staging from a clone)." >&2
  exit 1
fi

deploy_steps() {
  echo "▶ build:workers"
  bun run build:workers

  echo "▶ d1 migrations apply DB --remote"
  bun x wrangler d1 migrations apply DB --remote --config "$CFG"

  echo "▶ deploy"
  bun x wrangler deploy --config "$CFG"

  echo "▶ push LXK_SECRETS_MASTER_KEY"
  printf '%s' "$key" | bun x wrangler secret put LXK_SECRETS_MASTER_KEY --config "$CFG"

  echo
  echo "Deployed: $URL"
  echo "First superadmin: open $URL/setup"
}

# --- teardown absence probes (--reset only) ---------------------------------
# A failed delete is tolerated only when the resource is provably already gone
# (idempotent reset). Each probe prints exactly one of: absent | present |
# uncertain. run_teardown_delete aborts on anything but "absent", with the
# original delete error already printed.

d1_absent() {
  local out
  out="$(bun x wrangler d1 list --json --config "$CFG" 2>/dev/null)" || { echo uncertain; return 0; }
  printf '%s\n' "$out" | NAME="$D1_NAME" bun -e '
    let rows; try { rows = JSON.parse(await Bun.stdin.text()); } catch { console.log("uncertain"); process.exit(0); }
    console.log((rows || []).some(r => r.name === process.env.NAME) ? "present" : "absent");
  ' 2>/dev/null || echo uncertain
}

kv_absent() {
  local out
  out="$(bun x wrangler kv namespace list --config "$CFG" 2>/dev/null)" || { echo uncertain; return 0; }
  printf '%s\n' "$out" | KV_ID="$cfg_kv" KV_NAME="$KV_NAME" bun -e '
    let rows; try { rows = JSON.parse(await Bun.stdin.text()); } catch { console.log("uncertain"); process.exit(0); }
    console.log((rows || []).some(r => r.id === process.env.KV_ID || r.title === process.env.KV_NAME) ? "present" : "absent");
  ' 2>/dev/null || echo uncertain
}

r2_absent() {
  local out
  out="$(bun x wrangler r2 bucket list --config "$CFG" 2>/dev/null)" || { echo uncertain; return 0; }
  if printf '%s\n' "$out" | tr -s '[:space:]' '\n' | grep -qxF -- "$cfg_bucket"; then
    echo present
  else
    echo absent
  fi
}

worker_absent() {
  if grep -qE '\[code: (10007|10090)\]|workers\.api\.error\.script_not_found'; then
    echo absent
  else
    echo uncertain
  fi
}

run_teardown_delete() {
  local probe="$1" present_msg="$2" absent_msg="$3"; shift 3
  local out rc state
  out="$("$@" 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '%s\n' "$out"
    return 0
  fi
  printf '%s\n' "$out" >&2
  state="$(printf '%s\n' "$out" | "$probe")"
  case "$state" in
    absent)
      echo "deploy-staging: $absent_msg — continuing (idempotent reset)." >&2
      ;;
    present)
      echo "$present_msg" >&2
      exit 1
      ;;
    *)
      echo "deploy-staging: could not confirm the resource is absent — aborting; original error above." >&2
      exit 1
      ;;
  esac
}

if [ "$RESET" -eq 1 ]; then
  if [ "$ASSUME_YES" -eq 0 ]; then
    if [ -t 0 ]; then
      echo "This deletes ALL staging resources (R2, worker + Durable Object storage, D1, KV)." >&2
      printf "Type 'reset' to confirm: " >&2
      read -r answer
      if [ "$answer" != "reset" ]; then
        echo "deploy-staging: aborted (confirmation not given)." >&2
        exit 1
      fi
    else
      echo "deploy-staging: refusing --reset without --yes (no TTY for confirmation)." >&2
      exit 1
    fi
  fi

  # R2 first: it is the only delete that can fail on a healthy resource (a
  # non-empty bucket). Aborting here leaves worker/D1/KV intact, so a re-run
  # after emptying the bucket still works.
  echo "▶ delete R2 bucket $cfg_bucket"
  run_teardown_delete r2_absent \
    "deploy-staging: R2 bucket '$cfg_bucket' could not be deleted — it still holds objects.
  Empty it in the Cloudflare dashboard (R2 → $cfg_bucket → Empty bucket), then re-run --reset." \
    "R2 bucket '$cfg_bucket' is already absent" \
    bun x wrangler r2 bucket delete "$cfg_bucket" --config "$CFG"

  echo "▶ delete worker $WORKER (clears Durable Object storage)"
  run_teardown_delete worker_absent \
    "deploy-staging: worker '$WORKER' still exists but could not be deleted." \
    "worker '$WORKER' is already absent" \
    bun x wrangler delete "$WORKER" --config "$CFG" --force

  echo "▶ delete D1 $D1_NAME"
  run_teardown_delete d1_absent \
    "deploy-staging: D1 database '$D1_NAME' still exists but could not be deleted." \
    "D1 database '$D1_NAME' is already absent" \
    bun x wrangler d1 delete DB --config "$CFG" -y

  echo "▶ delete KV namespace $cfg_kv"
  run_teardown_delete kv_absent \
    "deploy-staging: KV namespace '$cfg_kv' still exists but could not be deleted." \
    "KV namespace '$cfg_kv' is already absent" \
    bun x wrangler kv namespace delete --namespace-id "$cfg_kv" --config "$CFG" -y

  # The create commands append binding blocks to the config; snapshot it and
  # restore on any exit so nothing appended persists. The new ids are captured
  # from stdout first, then written back into the restored config.
  snapshot="$(mktemp)"
  cp "$CFG" "$snapshot"
  trap 'cp "$snapshot" "$CFG"; rm -f "$snapshot"' EXIT

  echo "▶ create D1 $D1_NAME"
  d1_out="$(bun x wrangler d1 create "$D1_NAME" --config "$CFG")"
  printf '%s\n' "$d1_out"

  echo "▶ create KV namespace $KV_NAME"
  kv_out="$(bun x wrangler kv namespace create "$KV_NAME" --config "$CFG")"
  printf '%s\n' "$kv_out"

  echo "▶ create R2 bucket $cfg_bucket"
  bun x wrangler r2 bucket create "$cfg_bucket" --config "$CFG"

  new_d1="$(printf '%s\n' "$d1_out" | sed -nE 's/.*database_id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
  new_kv="$(printf '%s\n' "$kv_out" | sed -nE 's/.*[[:space:]]id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"

  if [ -z "$new_d1" ]; then
    echo "  D1 create output had no database_id — falling back to d1 list --json"
    new_d1="$(bun x wrangler d1 list --json --config "$CFG" | NAME="$D1_NAME" bun -e 'const rows=JSON.parse(await Bun.stdin.text());const m=(rows||[]).find(r=>r.name===process.env.NAME);if(m)console.log(m.uuid||m.id||"")')"
  fi
  if [ -z "$new_kv" ]; then
    echo "  KV create output had no id — falling back to kv namespace list"
    new_kv="$(bun x wrangler kv namespace list --config "$CFG" | NAME="$KV_NAME" bun -e 'const rows=JSON.parse(await Bun.stdin.text());const m=(rows||[]).find(r=>r.title===process.env.NAME);if(m)console.log(m.id||"")')"
  fi

  if [ -z "$new_d1" ] || [ -z "$new_kv" ]; then
    echo "deploy-staging: could not resolve new resource ids (d1='${new_d1:-}' kv='${new_kv:-}')." >&2
    exit 1
  fi

  cp "$snapshot" "$CFG"
  sed -i -E 's/("database_id"[[:space:]]*:[[:space:]]*")[^"]*(")/\1'"$new_d1"'\2/' "$CFG"
  sed -i -E 's/("id"[[:space:]]*:[[:space:]]*")[^"]*(")/\1'"$new_kv"'\2/' "$CFG"
  trap - EXIT
  rm -f "$snapshot"

  echo "  bound database_id=$new_d1"
  echo "  bound kv id=$new_kv"
fi

deploy_steps
