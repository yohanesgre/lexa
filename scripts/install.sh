#!/usr/bin/env bash
# Lexa install script — self-hosting entry point.
#
# Recommended (installer hub, newest release, BASE_URL pinned to its tag):
#   curl -fsSL https://install.yohanesgre.com/lexa/install.sh \
#     | bash -s -- [docker|bare|workers|dev] [flags]
#
# Direct (explicit tag, or main for bleeding edge):
#   curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/<tag>/scripts/install.sh \
#     | bash -s -- [docker|bare|workers|dev] [flags]
#
# Targets: docker (default when docker exists) | bare | workers | dev
# Provisioning of the first superadmin is ALWAYS the web /setup wizard —
# this script only prepares the runtime (R3: passwords never touch argv/env).
# Flow source of truth: status/design-deploy-tooling.md (§2 graphs, §15 contract).
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
# Target detection (§15: interactive defaults with confirmation; headless
# never guesses — die with the explicit target list).
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
    if [ -r /dev/tty ]; then
      answer=$(tty_read "Docker detected — deploy Lexa to docker? [Y/n]" "y")
      case "${answer}" in [Nn]*) TARGET="" ;; *) TARGET="docker" ;; esac
    else
      TARGET="docker"
    fi
  fi
  if [ -z "${TARGET}" ]; then
    if [ -r /dev/tty ]; then
      echo "Docker not found. Choose target:"
      echo "  1) bare     (bun + start script / --systemd)"
      echo "  2) workers  (Cloudflare Workers — D1/R2/KV)"
      echo "  3) dev      (clone repo + dev:full)"
      choice=$(tty_read "Target" "1")
      case "${choice}" in
        1) TARGET="bare" ;;
        2) TARGET="workers" ;;
        3) TARGET="dev" ;;
        *) die "unknown choice '${choice}'" ;;
      esac
    else
      die "no docker found and no target specified — re-run with an explicit target: bare | workers | dev"
    fi
  fi
fi
case "${TARGET}" in
  docker|bare|workers|dev) ;;
  *) die "unknown target '${TARGET}' (docker|bare|workers|dev)" ;;
esac

CF_TOKEN="${CF_TOKEN:-}"
PUBLIC_URL="${PUBLIC_URL:-}"
RELEASE_TAG="${RELEASE_TAG:-}"
BARE_PORT="${BARE_PORT:-3000}"

# ---------------------------------------------------------------------------
# docker — compose render → up → health
# ---------------------------------------------------------------------------
deploy_docker() {
  preflight_docker
  DEPLOY_DIR="${DEPLOY_DIR:-lexa-deploy}"
  mkdir -p "${DEPLOY_DIR}"
  cd "${DEPLOY_DIR}"
  local public_url="${PUBLIC_URL:-http://127.0.0.1:${PORT}}"
  # Local deploy — the operator may reach the app via either loopback
  # hostname; trust both or Better Auth rejects one of them.
  local trusted="${public_url},http://localhost:${PORT},http://127.0.0.1:${PORT}"
  write_env_file ".env" \
    "LXK_ENV=production" \
    "LXK_PUBLIC_URL=${public_url}" \
    "LXK_TRUSTED_ORIGINS=${trusted}"
  # Local docker deploy = direct semantics (host port mapping, no tunnel) —
  # the wizard URL must be reachable on the host.
  DEPLOY_DIR="${PWD}" compose_render direct "${PORT}" "${BIND}"
  step "compose pull" retry 3 mutate docker compose pull
  step "compose up" mutate docker compose up -d --wait
  step "wait health" wait_for "http://${BIND}:${PORT}/api/health"
  final_banner "http://${BIND}:${PORT}"
}

# ---------------------------------------------------------------------------
# bare — release tarball → env + start script (+ optional systemd)
# ---------------------------------------------------------------------------
deploy_bare() {
  BARE_PORT="${PORT:-3000}"
  PUBLIC_URL="${PUBLIC_URL:-http://localhost:${BARE_PORT}}"
  if [ -n "${FROM_REPO}" ]; then
    # Repo checkout flow: build must already exist (bun run build).
    INSTALL_DIR="${REPO_ROOT}"
    [ -d "${INSTALL_DIR}/dist/client" ] || die "${FROM_REPO}: no dist/ — run 'bun install && bun run build' first"
  else
    fetch_release "server" "${INSTALL_DIR:-${HOME}/.lexa-server}"
    INSTALL_DIR="${INSTALL_DIR:-${HOME}/.lexa-server}"
    unpack_release "${INSTALL_DIR}" "${INSTALL_DIR}" server
    # The tarball ships package.json + bun.lock without node_modules —
    # resolve them once so `bun server/entry.ts` can run. --ignore-scripts
    # skips the prepare hook (the Effect checkout is not shipped in the
    # tarball and is dev-only).
    step "bun install" bun install --frozen-lockfile --production --ignore-scripts
  fi
  if [ -f "${INSTALL_DIR}/.env" ] && [ -n "${FROM_REPO}" ]; then
    echo "  ✓ ${FROM_REPO}/.env exists — kept (dev env untouched)"
  else
    local bare_public="${PUBLIC_URL:-http://localhost:${BARE_PORT}}"
    step "write env" write_env_file "${INSTALL_DIR}/.env" \
      "LXK_ENV=production" \
      "PORT=${BARE_PORT}" \
      "DATABASE_PATH=${INSTALL_DIR}/data/lexa.db" \
      "LXK_PUBLIC_URL=${bare_public}" \
      "LXK_TRUSTED_ORIGINS=${bare_public},http://127.0.0.1:${BARE_PORT}"
    step "data dir" mkdir -p "${INSTALL_DIR}/data"
  fi
  step "write start script" write_start_script "${INSTALL_DIR}"
  if [ "${SYSTEMD}" = "1" ]; then
    step "systemd unit" install_systemd_unit "${INSTALL_DIR}"
  fi
  step "wait health" wait_for "http://localhost:${BARE_PORT}/api/health"
  final_banner "${PUBLIC_URL}"
  if [ "${SYSTEMD}" != "1" ]; then
    echo "  start manually: ${INSTALL_DIR}/lexa-start.sh (tmux/nohup for background)"
  fi
}

# ---------------------------------------------------------------------------
# workers — release tarball → bun scripts/workers-install.ts (provisioning,
# migrations, deploy). Prompts: custom domain (always offered, workers.dev
# default) + CF token. The helper prints the deployed URL itself.
# ---------------------------------------------------------------------------
deploy_workers() {
  require_bun
  # Pre-resolve paths BEFORE any download/wipe: domain reuse reads the old
  # wrangler config, and the fresh-install guard must fire before network.
  _ww_dir="${WORK_DIR:-lexa-workers-release}"
  [ -n "${FROM_REPO}" ] && _ww_dir="${REPO_ROOT}"
  # Deploy name: explicit --name wins; a single previous deploy-*/ dir is
  # resumed; fresh installs default to "lexa".
  FLAVOR_NAME="$(resolve_deploy_name "${_ww_dir}" "${NAME}")"
  if [ -z "${NAME}" ] && [ "${FLAVOR_NAME}" != "lexa" ]; then
    echo "  (resuming previous workers deploy '${FLAVOR_NAME}')"
  fi
  if [ ! -d "${_ww_dir}/deploy-${FLAVOR_NAME}" ]; then
    if [ "${ASSUME_YES}" = "1" ] || [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
      echo "  (no previous deploy '${FLAVOR_NAME}' in ${_ww_dir} — fresh install)"
    else
      confirm_tty "No previous deploy '${FLAVOR_NAME}' in ${_ww_dir} — start fresh (new Cloudflare resources)? [y/N]" "n" \
        || die "aborted (nothing changed)"
    fi
  fi
  # Token: --cf-token flag > CF_API_TOKEN env > saved file > TTY prompt.
  # Only TTY-typed tokens are ever offered for saving; env/flag values
  # never touch disk (safe for ephemeral CI tokens).
  _token_file="${_ww_dir}/.cf-token"
  if [ -z "${CF_TOKEN}" ] && [ -n "${CF_API_TOKEN:-}" ]; then
    CF_TOKEN="${CF_API_TOKEN}"
  fi
  if [ -z "${CF_TOKEN}" ] && [ -f "${_token_file}" ]; then
    CF_TOKEN="$(cat "${_token_file}")"
    echo "  (using saved Cloudflare token — delete ${_token_file} to re-enter)"
  fi
  if [ -z "${CF_TOKEN}" ]; then
    [ -r /dev/tty ] || die "Cloudflare API token required (env CF_API_TOKEN or --cf-token)"
    CF_TOKEN=$(tty_read_secret "Cloudflare API token (needs: Workers Scripts, D1, Workers KV Storage, Workers R2 Storage — all Edit, account scope)")
    _save_answer=$(tty_read "Save this token to ${_token_file} for future upgrades? [y/N]" "n")
    case "${_save_answer}" in
      [Yy]*)
        mkdir -p "${_ww_dir}"
        : > "${_token_file}"
        chmod 600 "${_token_file}"
        printf '%s' "${CF_TOKEN}" > "${_token_file}"
        echo "  (token saved — remove the file to forget it)"
        ;;
    esac
  fi
  [ -n "${CF_TOKEN}" ] || die "Cloudflare API token required (env CF_API_TOKEN or --cf-token)"
  # Domain: a previous deploy's LXK_PUBLIC_URL becomes the default (Enter
  # keeps it, "-" switches back to workers.dev). Read BEFORE the wipe below.
  if [ -z "${DOMAIN}" ]; then
    _prev_cfg="$(ls "${_ww_dir}"/deploy-"${FLAVOR_NAME}"/wrangler.*.json 2>/dev/null | head -1)"
    _prev_domain=""
    if [ -n "${_prev_cfg}" ]; then
      _prev_url="$(grep -o '"LXK_PUBLIC_URL": *"[^"]*"' "${_prev_cfg}" 2>/dev/null | head -1 | sed 's/.*"LXK_PUBLIC_URL": *"//;s/"$//')"
      case "${_prev_url}" in
        https://*) _prev_domain="${_prev_url#https://}" ;;
        http://*) _prev_domain="${_prev_url#http://}" ;;
      esac
    fi
    if [ -n "${_prev_domain}" ]; then
      answer=$(tty_read_soft "Custom domain [${_prev_domain}] — Enter keeps it, '-' for workers.dev, or type a new domain" "${_prev_domain}")
      if [ "${answer}" = "-" ]; then DOMAIN=""; else DOMAIN="${answer}"; fi
    else
      # Soft prompt: EOF/headless → workers.dev default (never a hard failure —
      # the domain has a safe default). Hard-fatal prompts stay tty_read.
      answer=$(tty_read_soft "Custom domain — press Enter for a free workers.dev subdomain [lexa.<account>.workers.dev]" "")
      [ -n "${answer}" ] && DOMAIN="${answer}"
    fi
  fi

  if [ -n "${FROM_REPO}" ]; then
    WORK_DIR="${REPO_ROOT}"
    [ -f "${WORK_DIR}/dist/server/wrangler.json" ] || die "${FROM_REPO}: workers build missing — run 'LEXA_FLAVOR=workers bun run build'"
  else
    fetch_release "workers" "${WORK_DIR:-lexa-workers-release}"
    WORK_DIR="${WORK_DIR:-lexa-workers-release}"
    # Retry safety: a previous failed run may have left stale extractions
    # (old-tag dist/migrations/scripts mixed with the new tarball's). The
    # dir is installer-owned — keep only the downloads (+ the saved token).
    find "${WORK_DIR}" -mindepth 1 -maxdepth 1 ! -name '*.tar.gz' ! -name 'checksums.txt' ! -name '.cf-token' -exec rm -rf {} +
    unpack_release "${WORK_DIR}" "${WORK_DIR}" workers
  fi

  cf_args=(--cf-token "${CF_TOKEN}" --name "${FLAVOR_NAME}")
  [ "${RESET_DB}" = "1" ] && cf_args+=(--reset-db)
  [ -n "${DOMAIN}" ] && cf_args+=(--domain "${DOMAIN}")
  (cd "${WORK_DIR}" && step "workers install" bun scripts/workers-install.ts "${cf_args[@]}")
  if [ -n "${DOMAIN}" ]; then
    final_banner "https://${DOMAIN}"
  else
    echo "  deployed to your workers.dev subdomain — URL printed above."
    echo "  NEXT → create the first admin (superadmin): open <worker-url>/setup"
    echo "  Machine keys (CLI/daemons) are minted post-setup: login → Settings → API Keys"
  fi
}

# ---------------------------------------------------------------------------
# dev — clone repo → bun install → setup → dev:full (clone goes to PWD)
# ---------------------------------------------------------------------------
deploy_dev() {
  preflight_git_bun
  REPO_DIR="${REPO_DIR:-lexa}"
  [ -d "${REPO_DIR}" ] || step "git clone" git clone "https://github.com/yohanesgre/lexa.git" "${REPO_DIR}"
  cd "${REPO_DIR}"
  step "bun install" bun install
  if [ "${ASSUME_YES}" = "1" ]; then
    bun run setup --yes --admin-email "${ADMIN_EMAIL:-admin@lexa.local}"
  else
    bun run setup
  fi
  step "dev:full" bun run dev:full
}

case "${TARGET}" in
  docker)  deploy_docker ;;
  bare)    deploy_bare ;;
  workers) deploy_workers ;;
  dev)     deploy_dev ;;
esac
