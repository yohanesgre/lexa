#!/usr/bin/env bash
# Lexa install script — self-hosting entry point.
#
# Recommended (installer hub, newest release, BASE_URL pinned to its tag):
#   curl -fsSL https://install.yohanesgre.com/lexa/install.sh \
#     | bash -s -- [docker|bare|workers] [flags]
#
# Direct (explicit tag, or main for bleeding edge):
#   curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/<tag>/scripts/install.sh \
#     | bash -s -- [docker|bare|workers] [flags]
#
# Targets: docker (default when docker exists) | bare | workers
# Each target installs into a self-describing dir in the CWD: dockers/, bare/,
# cf-workers/. Provisioning of the first superadmin is ALWAYS the web /setup
# wizard — this script only prepares the runtime (R3: passwords never touch
# argv/env).
set -euo pipefail

BASE_URL="${INSTALL_BASE_URL:-https://raw.githubusercontent.com/yohanesgre/lexa/main/scripts}"

# Piped runs (curl | bash) have no BASH_SOURCE — the lib is then bootstrapped
# into a temp dir. Direct runs (bash scripts/install.sh) use the checkout.
SELF="${BASH_SOURCE[0]:-}"
if [ -n "$SELF" ] && [ -f "$SELF" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
  # shellcheck source=scripts/install-lib.sh
  source "${SCRIPT_DIR}/install-lib.sh"
else
  SCRIPT_DIR="$(mktemp -d /tmp/lexa-install.XXXXXX)"
  curl -fsSL "${BASE_URL}/install-lib.sh" -o "${SCRIPT_DIR}/install-lib.sh"
  source "${SCRIPT_DIR}/install-lib.sh"
fi

# ---------------------------------------------------------------------------
# Target detection: interactive defaults with confirmation; headless never
# guesses — die with the explicit target list.
# ---------------------------------------------------------------------------
parse_flags "$@"

if [ -n "${FROM_REPO}" ]; then
  # From-repo runs keep everything next to the checkout (no temp bootstrap).
  SCRIPT_DIR="$(cd "${FROM_REPO}/scripts" 2>/dev/null && pwd)" || die "--from-repo: ${FROM_REPO}/scripts not found"
  REPO_ROOT="$(cd "${FROM_REPO}" && pwd)"
fi

if [ "${HELP}" = "1" ]; then
  usage
  exit 0
fi

if [ -z "${TARGET}" ]; then
  if command -v docker >/dev/null 2>&1; then
    if _tty_available; then
      answer=$(tty_read "Docker found. Deploy Lexa with Docker? [Y/n]" "y")
      case "${answer}" in [Nn]*) TARGET="" ;; *) TARGET="docker" ;; esac
    else
      TARGET="docker"
    fi
  fi
  if [ -z "${TARGET}" ]; then
    if _tty_available; then
      echo "Docker isn't installed. Choose how to deploy:"
      echo "  1) Bare — runs on this machine (needs bun)"
      echo "  2) Cloudflare Workers — serverless on your Cloudflare account"
      choice=$(tty_read "Choice [1]:" "1")
      case "${choice}" in
        1) TARGET="bare" ;;
        2) TARGET="workers" ;;
        *) die "Unknown choice '${choice}'. Available: 1, 2." ;;
      esac
    else
      die "Docker isn't installed — re-run with an explicit target: bare | workers"
    fi
  fi
fi

# dev was removed — development starts from a clone.
die_dev_removed() {
  printf '%s\n' "The 'dev' target was removed — development starts from a clone:
  git clone https://github.com/yohanesgre/lexa && cd lexa
  bun install && bun run setup && bun run dev:full" >&2
  exit 1
}

case "${TARGET}" in
  docker|bare|workers) ;;
  dev) die_dev_removed ;;
  *) die "Unknown target '${TARGET}'. Available: docker, bare, workers." ;;
esac

CF_TOKEN="${CF_TOKEN:-}"
PUBLIC_URL="${PUBLIC_URL:-}"
RELEASE_TAG="${RELEASE_TAG:-}"
BARE_PORT="${BARE_PORT:-3000}"
# Read by final_banner() in install-lib.sh; export so shellcheck sees them as
# externally consumed rather than dead assignments.
BANNER_MASTER=""
BANNER_GITHUB=""
export BANNER_MASTER BANNER_GITHUB

# ---------------------------------------------------------------------------
# docker — compose render → up → health (dir: dockers/)
# ---------------------------------------------------------------------------
deploy_docker() {
  preflight_docker
  collect_optional_secrets docker
  DEPLOY_DIR="${DEPLOY_DIR:-dockers}"
  mkdir -p "${DEPLOY_DIR}"
  cd "${DEPLOY_DIR}"
  local public_url="${PUBLIC_URL:-http://127.0.0.1:${PORT}}"
  # Local deploy — the operator may reach the app via either loopback
  # hostname; trust both or Better Auth rejects one of them.
  local trusted="${public_url},http://localhost:${PORT},http://127.0.0.1:${PORT}"
  # One-time: a pre-P4 deploy dir keeps its app keys in a flat `.env`. Convert
  # them to the canonical `.env.toml` (merge — GITHUB_* survive) before the
  # tooling-only `.env` is written.
  migrate_legacy_deploy_env "${PWD}"
  step "write config" write_env_toml "${PWD}/.env.toml" \
    "LXK_ENV=production" \
    "LXK_PUBLIC_URL=${public_url}" \
    "LXK_TRUSTED_ORIGINS=${trusted}" \
    "DATABASE_PATH=/app/data/lexa.db" \
    "PORT=3000" \
    "$(secrets_master_key_entry "${PWD}/.env.toml")"
  step "apply secrets" apply_secrets_to_env "${PWD}/.env.toml"
  # Flat `.env` = compose tooling only. COMPOSE_PROJECT_NAME (if already set by
  # the operator) is preserved by the merge; setting it here would rename the
  # compose project and orphan the existing `lexa-data` volume. A pinned
  # LXK_IMAGE_TAG is likewise preserved and only overridden by --image.
  local image_tag="${IMAGE_TAG:-$(env_file_value "${PWD}/.env" LXK_IMAGE_TAG)}"
  image_tag="${image_tag:-latest}"
  local tooling=("LXK_IMAGE_TAG=${image_tag}")
  [ -n "${CF_TOKEN:-}" ] && tooling+=("CF_TUNNEL_TOKEN=${CF_TOKEN}")
  step "write compose env" write_env_file "${PWD}/.env" "${tooling[@]}"
  # Local docker deploy = direct semantics (host port mapping, no tunnel) —
  # the wizard URL must be reachable on the host.
  DEPLOY_DIR="${PWD}" step "generate compose file" compose_render direct "${PORT}" "${BIND}"
  if [ "${NO_PULL:-0}" = "1" ]; then
    echo "  skipping image pull (--no-pull)"
    if [ "${INSTALL_DRY_RUN:-0}" != "1" ] \
      && ! docker image inspect "ghcr.io/yohanesgre/lexa:${image_tag}" >/dev/null 2>&1; then
      die "image ghcr.io/yohanesgre/lexa:${image_tag} not found locally — build it first, or drop --no-pull"
    fi
  else
    step "compose pull" retry 3 mutate docker compose pull
  fi
  # The container runs as uid 1000 (USER bun); when the installer runs as a
  # different uid a 0600 `.env.toml` would be unreadable and crash-loop.
  step "container permissions" grant_container_read "${PWD}/.env.toml" "ghcr.io/yohanesgre/lexa:${image_tag}"
  step "compose up" mutate docker compose up -d --wait
  step "health check" wait_for "http://${BIND}:${PORT}/api/health"
  BANNER_MASTER=""
  if [ -f "${PWD}/.env.toml" ]; then
    BANNER_MASTER="master key ✓ (${DEPLOY_DIR}/.env.toml)"
  fi
  set_banner_github "${PWD}/.env.toml"
  final_banner "http://${BIND}:${PORT}"
}

# ---------------------------------------------------------------------------
# bare — release tarball → env + start script (+ optional systemd); dir: bare/
# ---------------------------------------------------------------------------
deploy_bare() {
  preflight_bare
  BARE_PORT="${PORT:-3000}"
  PUBLIC_URL="${PUBLIC_URL:-http://localhost:${BARE_PORT}}"
  INSTALL_DIR="${INSTALL_DIR:-bare}"
  # A repo checkout with its own env keeps it untouched — collecting secrets
  # here would silently drop them (nothing gets written), so skip collection
  # and report the existing config as-is.
  local keep_existing_env=0
  local existing_env=""
  if [ -n "${FROM_REPO}" ]; then
    # Repo checkout flow: build must already exist (bun run build).
    INSTALL_DIR="${REPO_ROOT}"
    [ -d "${INSTALL_DIR}/dist/client" ] || die "No build found in ${FROM_REPO} — run 'bun run build' first, then re-run this script."
    if [ -f "${INSTALL_DIR}/.env.toml" ] || [ -f "${INSTALL_DIR}/.env" ]; then
      keep_existing_env=1
    fi
  else
    fetch_release "server" "${INSTALL_DIR}"
    unpack_release "${INSTALL_DIR}" "${INSTALL_DIR}" server
    # The tarball ships package.json + bun.lock without node_modules —
    # resolve them once so `bun server/entry.ts` can run. --ignore-scripts
    # skips the prepare hook (the Effect checkout is not shipped in the
    # tarball and is dev-only).
    step "bun install" mutate bun install --frozen-lockfile --production --ignore-scripts
  fi
  if [ "${keep_existing_env}" != "1" ]; then
    collect_optional_secrets bare
  fi
  if [ "${keep_existing_env}" = "1" ]; then
    existing_env="${INSTALL_DIR}/.env.toml"
    [ -f "${existing_env}" ] || existing_env="${INSTALL_DIR}/.env"
    echo "  ✓ ${existing_env} exists — kept (dev env untouched)"
    echo "  Skipping secrets setup — add secrets to ${existing_env} directly."
  else
    local bare_public="${PUBLIC_URL:-http://localhost:${BARE_PORT}}"
    migrate_legacy_deploy_env "${INSTALL_DIR}"
    step "write config" write_env_toml "${INSTALL_DIR}/.env.toml" \
      "LXK_ENV=production" \
      "PORT=${BARE_PORT}" \
      "DATABASE_PATH=${INSTALL_DIR}/data/lexa.db" \
      "LXK_PUBLIC_URL=${bare_public}" \
      "LXK_TRUSTED_ORIGINS=${bare_public},http://127.0.0.1:${BARE_PORT}" \
      "$(secrets_master_key_entry "${INSTALL_DIR}/.env.toml")"
    step "apply secrets" apply_secrets_to_env "${INSTALL_DIR}/.env.toml"
    step "create data folder" mkdir -p "${INSTALL_DIR}/data"
  fi
  step "write start script" write_start_script "${INSTALL_DIR}"
  if [ "${SYSTEMD}" = "1" ]; then
    step "install systemd service" install_systemd_unit "${INSTALL_DIR}"
  else
    # Manual mode auto-starts before the health wait; a re-run with a live
    # lexa.pid is a no-op (never double-start).
    step "start server" bare_start_manual "${INSTALL_DIR}"
  fi
  step "health check" wait_for "http://localhost:${BARE_PORT}/api/health" 60 "${INSTALL_DIR}/lexa.log"
  BANNER_MASTER=""
  if [ "${keep_existing_env}" != "1" ]; then
    BANNER_MASTER="master key ✓ (${INSTALL_DIR}/.env.toml)"
  fi
  if [ "${keep_existing_env}" = "1" ]; then
    set_banner_github "${existing_env}"
  else
    set_banner_github "${INSTALL_DIR}/.env.toml"
  fi
  final_banner "${PUBLIC_URL}"
  if [ "${SYSTEMD}" != "1" ]; then
    echo "  Running in the background — logs: ${INSTALL_DIR}/lexa.log · stop: kill \$(cat ${INSTALL_DIR}/lexa.pid)"
  fi
}

# ---------------------------------------------------------------------------
# workers — release tarball → bun scripts/workers-install.ts (provisioning,
# migrations, deploy); dir: cf-workers/. Token chain: --cf-token → CF_API_TOKEN
# → cf-workers/.cf-token → wrangler login → TTY prompt. Master key is minted
# once and kept in cf-workers/.env.toml custody.
# ---------------------------------------------------------------------------
deploy_workers() {
  preflight_workers
  collect_optional_secrets workers
  # Pre-resolve paths BEFORE any download/wipe: domain reuse reads the old
  # wrangler config, and the fresh-install guard must fire before network.
  _ww_dir="${WORK_DIR:-cf-workers}"
  [ -n "${FROM_REPO}" ] && _ww_dir="${REPO_ROOT}"
  # Deploy name: explicit --name wins; a single previous deploy-*/ dir is
  # resumed; fresh installs default to "lexa".
  FLAVOR_NAME="$(resolve_deploy_name "${_ww_dir}" "${NAME}")"
  if [ -z "${NAME}" ] && [ "${FLAVOR_NAME}" != "lexa" ]; then
    echo "  (resuming deploy '${FLAVOR_NAME}')"
  fi
  if [ ! -d "${_ww_dir}/deploy-${FLAVOR_NAME}" ]; then
    if [ "${ASSUME_YES}" = "1" ] || [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
      echo "  (no previous deploy for '${FLAVOR_NAME}' — starting fresh)"
    else
      confirm_tty "First deploy for '${FLAVOR_NAME}' — create its Cloudflare resources (D1, R2, KV) now? [y/N]" "n" \
        || die "Cancelled — nothing was changed."
    fi
  fi
  # Token chain: --cf-token flag > CF_API_TOKEN env > saved file > wrangler
  # login > TTY prompt. Only TTY-typed tokens are ever offered for saving;
  # env/flag values never touch disk (safe for ephemeral CI tokens).
  _token_file="${_ww_dir}/.cf-token"
  if [ -z "${CF_TOKEN}" ] && [ -n "${CF_API_TOKEN:-}" ]; then
    CF_TOKEN="${CF_API_TOKEN}"
  fi
  if [ -z "${CF_TOKEN}" ] && [ -f "${_token_file}" ]; then
    CF_TOKEN="$(cat "${_token_file}")"
    echo "  (using the saved Cloudflare token — delete ${_token_file} to enter a new one)"
  fi
  _CF_FROM_OAUTH=0
  if [ -z "${CF_TOKEN}" ]; then
    local _oauth_tok=""
    if _oauth_tok="$(_cf_token_from_wrangler)"; then
      CF_TOKEN="${_oauth_tok}"
      _CF_FROM_OAUTH=1
      echo "  (using your wrangler login — no token needed)"
    fi
  fi
  # A token read from wrangler login is verified once before use; a rejected
  # one falls through to the prompt chain (never loops).
  if [ -n "${CF_TOKEN}" ] && [ "${_CF_FROM_OAUTH}" = "1" ] && [ "${INSTALL_DRY_RUN:-0}" != "1" ]; then
    # The token travels on curl's stdin config (-K -), never in argv.
    if ! printf 'header = "Authorization: Bearer %s"\n' "${CF_TOKEN}" \
      | curl -fsS -o /dev/null --max-time 10 "https://api.cloudflare.com/client/v4/accounts" -K - 2>/dev/null; then
      echo "  (the wrangler login could not be verified — enter a token instead)"
      CF_TOKEN=""
      _CF_FROM_OAUTH=0
    fi
  fi
  if [ -z "${CF_TOKEN}" ]; then
    _tty_available || die "No Cloudflare credentials found — run \`wrangler login\` once, or pass a token via --cf-token / CF_API_TOKEN, then re-run."
    CF_TOKEN=$(tty_read_secret "Paste a Cloudflare API token — it needs Workers Scripts, D1, Workers KV, and R2 (Edit), account-scoped. Create one at https://dash.cloudflare.com/profile/api-tokens — or run \`wrangler login\` once and skip this.")
    _save_answer=$(tty_read "Save this token for future upgrades? [y/N]" "n")
    case "${_save_answer}" in
      [Yy]*)
        mkdir -p "${_ww_dir}"
        : > "${_token_file}"
        chmod 600 "${_token_file}"
        printf '%s' "${CF_TOKEN}" > "${_token_file}"
        echo "  (token saved — remove ${_token_file} to forget it)"
        ;;
    esac
  fi
  [ -n "${CF_TOKEN}" ] || die "No Cloudflare credentials found — run \`wrangler login\` once, or pass a token via --cf-token / CF_API_TOKEN, then re-run."
  export CLOUDFLARE_API_TOKEN="${CF_TOKEN}"
  export CF_API_TOKEN="${CF_TOKEN}"
  # Domain: a previous deploy's LXK_PUBLIC_URL becomes the default (Enter
  # keeps it, "-" switches back to workers.dev). Read BEFORE the wipe below.
  if [ -z "${DOMAIN}" ]; then
    _prev_cfg="$(ls "${_ww_dir}"/deploy-"${FLAVOR_NAME}"/wrangler.*.json 2>/dev/null | head -1 || true)"
    _prev_domain=""
    if [ -n "${_prev_cfg}" ]; then
      _prev_url="$(grep -o '"LXK_PUBLIC_URL": *"[^"]*"' "${_prev_cfg}" 2>/dev/null | head -1 | sed 's/.*"LXK_PUBLIC_URL": *"//;s/"$//')"
      case "${_prev_url}" in
        https://*) _prev_domain="${_prev_url#https://}" ;;
        http://*) _prev_domain="${_prev_url#http://}" ;;
      esac
    fi
    if [ -n "${_prev_domain}" ]; then
      answer=$(tty_read_soft "Custom domain [${_prev_domain}]: Enter keeps it, type a new one, or '-' for workers.dev" "${_prev_domain}")
      if [ "${answer}" = "-" ]; then DOMAIN=""; else DOMAIN="${answer}"; fi
    else
      # Soft prompt: EOF/headless → workers.dev default (never a hard failure —
      # the domain has a safe default). Hard-fatal prompts stay tty_read.
      answer=$(tty_read_soft "Custom domain? Press Enter to use the free workers.dev address [lexa.<account>.workers.dev]" "")
      [ -n "${answer}" ] && DOMAIN="${answer}"
    fi
  fi
  # Master key custody (cf-workers/.env.toml, 0600). Preserve order:
  # local custody → remote presence → mint. Never rotate; never mint when the
  # remote state can't be read (better to leave it than to rotate).
  _custody="${_ww_dir}/.env.toml"
  _WORKERS_MASTER_KEY="$(env_file_value "${_custody}" LXK_SECRETS_MASTER_KEY || true)"
  if [ -z "${_WORKERS_MASTER_KEY}" ]; then
    case "$(workers_secret_present "${_ww_dir}" "LXK_SECRETS_MASTER_KEY")" in
      present)
        : # already on the remote worker — leave it, do not mint or overwrite
        ;;
      absent)
        _WORKERS_MASTER_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
        write_env_toml "${_custody}" "LXK_SECRETS_MASTER_KEY=${_WORKERS_MASTER_KEY}"
        ;;
      *)
        echo "  (couldn't read the master key on the worker — leaving it untouched; re-run to retry)"
        ;;
    esac
  fi

  if [ -n "${FROM_REPO}" ]; then
    WORK_DIR="${REPO_ROOT}"
    [ -f "${WORK_DIR}/dist/server/wrangler.json" ] || die "No build found in ${FROM_REPO} — run 'LEXA_FLAVOR=workers bun run build' first, then re-run this script."
  else
    fetch_release "workers" "${_ww_dir}"
    WORK_DIR="${_ww_dir}"
    # Retry safety: a previous failed run may have left stale extractions
    # (old-tag dist/migrations/scripts mixed with the new tarball's). The
    # dir is installer-owned — keep only the downloads (+ saved token +
    # master-key custody).
    if [ "${INSTALL_DRY_RUN:-0}" != "1" ]; then
      find "${WORK_DIR}" -mindepth 1 -maxdepth 1 ! -name '*.tar.gz' ! -name 'checksums.txt' ! -name '.cf-token' ! -name '.env.toml' -exec rm -rf {} +
    fi
    unpack_release "${WORK_DIR}" "${WORK_DIR}" workers
  fi

  cf_args=(--name "${FLAVOR_NAME}")
  [ "${RESET_DB}" = "1" ] && cf_args+=(--reset-db)
  [ -n "${DOMAIN}" ] && cf_args+=(--domain "${DOMAIN}")
  # A stale URL from a previous deploy must never outlive this run's result.
  # Dry-run touches no prior state: keep the file and treat the URL as unknown.
  local deployed_url=""
  if [ "${INSTALL_DRY_RUN:-0}" != "1" ]; then
    rm -f "${_ww_dir}/.deployed-url"
  fi
  (cd "${WORK_DIR}" && step "deploy to Cloudflare" mutate bun scripts/workers-install.ts "${cf_args[@]}")
  workers_apply_secrets "${_ww_dir}"

  if [ "${INSTALL_DRY_RUN:-0}" != "1" ]; then
    deployed_url="$(cat "${_ww_dir}/.deployed-url" 2>/dev/null | tr -d '\n' || true)"
  fi
  # A custom domain is operator-supplied and deterministic; a workers.dev host
  # is only known when the deploy recorded it. Never synthesize one.
  if [ -z "${deployed_url}" ] && [ -n "${DOMAIN}" ]; then
    deployed_url="https://${DOMAIN}"
  fi
  BANNER_MASTER=""
  if [ -f "${_custody}" ]; then
    BANNER_MASTER="master key ✓ (custody: ${_ww_dir}/.env.toml)"
  fi
  set_banner_github "${_custody}"
  final_banner "${deployed_url}"
}

case "${TARGET}" in
  docker)  deploy_docker ;;
  bare)    deploy_bare ;;
  workers) deploy_workers ;;
esac
