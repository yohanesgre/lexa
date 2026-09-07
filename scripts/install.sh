#!/usr/bin/env bash
# Lexa install script — self-hosting entry point.
#
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

FLAVOR="${FLAVOR:-staging}"
CF_TOKEN="${CF_TOKEN:-}"
PUBLIC_URL="${PUBLIC_URL:-}"
RELEASE_TAG="${RELEASE_TAG:-}"
BARE_PORT="${BARE_PORT:-3000}"
case "${FLAVOR}" in
  staging|prod) ;;
  *) die "unknown flavor '${FLAVOR}' (staging|prod)" ;;
esac

# ---------------------------------------------------------------------------
# docker — compose render → up → health
# ---------------------------------------------------------------------------
deploy_docker() {
  preflight_docker
  DEPLOY_DIR="${DEPLOY_DIR:-lexa-deploy}"
  mkdir -p "${DEPLOY_DIR}"
  cd "${DEPLOY_DIR}"
  [ -n "${API_KEY}" ] || API_KEY=$(gen_api_key)
  local public_url="${PUBLIC_URL:-http://127.0.0.1:${PORT}}"
  # Local deploy — the operator may reach the app via either loopback
  # hostname; trust both or Better Auth rejects one of them.
  local trusted="${public_url},http://localhost:${PORT},http://127.0.0.1:${PORT}"
  write_env_file ".env" \
    "LXK_API_KEY=${API_KEY}" \
    "LXK_ENV=${FLAVOR}" \
    "LXK_PUBLIC_URL=${public_url}" \
    "LXK_TRUSTED_ORIGINS=${trusted}"
  # Local docker deploy = direct semantics (host port mapping, no tunnel) —
  # the wizard URL must be reachable on the host. Flavor still sets LXK_ENV.
  [ -n "${IMAGE_TAG}" ] || { [ "${FLAVOR}" = "staging" ] && IMAGE_TAG="staging"; }
  DEPLOY_DIR="${PWD}" compose_render direct "${PORT}" "${BIND}"
  step "compose pull" retry 3 mutate docker compose pull
  step "compose up" mutate docker compose up -d --wait
  step "wait health" wait_for "http://${BIND}:${PORT}/api/health"
  final_banner "http://${BIND}:${PORT}" "${API_KEY}"
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
  [ -n "${API_KEY}" ] || API_KEY=$(gen_api_key)
  if [ -f "${INSTALL_DIR}/.env" ] && [ -n "${FROM_REPO}" ]; then
    echo "  ✓ ${FROM_REPO}/.env exists — kept (dev env untouched)"
  else
    local bare_public="${PUBLIC_URL:-http://localhost:${BARE_PORT}}"
    step "write env" write_env_file "${INSTALL_DIR}/.env" \
      "LXK_API_KEY=${API_KEY}" \
      "LXK_ENV=${FLAVOR}" \
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
  final_banner "${PUBLIC_URL}" "${API_KEY}"
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
  if [ -z "${DOMAIN}" ]; then
    # Soft prompt: EOF/headless → workers.dev default (never a hard failure —
    # the domain has a safe default). Hard-fatal prompts stay tty_read.
    answer=$(tty_read_soft "Custom domain — press Enter for a free workers.dev subdomain [lexa.<account>.workers.dev]" "")
    [ -n "${answer}" ] && DOMAIN="${answer}"
  fi
  # headless without --domain → workers.dev default (no prompt, no failure)
  if [ -z "${CF_TOKEN}" ] && [ -r /dev/tty ]; then
    CF_TOKEN=$(tty_read "Cloudflare API token (Workers scripts, D1, R2, KV)" "")
  fi
  [ -n "${CF_TOKEN}" ] || die "Cloudflare API token required (env CF_API_TOKEN or --cf-token)"
  [ -n "${CF_TOKEN}" ] || die "Cloudflare API token required (env CF_API_TOKEN or --cf-token)"
  [ -n "${API_KEY}" ] || API_KEY=$(gen_api_key)

  if [ -n "${FROM_REPO}" ]; then
    WORK_DIR="${REPO_ROOT}"
    [ -f "${WORK_DIR}/dist/server/wrangler.json" ] || die "${FROM_REPO}: workers build missing — run 'LEXA_FLAVOR=workers bun run build'"
  else
    fetch_release "workers" "${WORK_DIR:-lexa-workers-release}"
    WORK_DIR="${WORK_DIR:-lexa-workers-release}"
    unpack_release "${WORK_DIR}" "${WORK_DIR}" workers
  fi

  cf_args=(--cf-token "${CF_TOKEN}" --api-key "${API_KEY}" --flavor "${FLAVOR}")
  [ -n "${DOMAIN}" ] && cf_args+=(--domain "${DOMAIN}")
  (cd "${WORK_DIR}" && step "workers install" bun scripts/workers-install.ts "${cf_args[@]}")
  if [ -n "${DOMAIN}" ]; then
    final_banner "https://${DOMAIN}" "${API_KEY}"
  else
    echo "  deployed to your workers.dev subdomain — URL printed above."
    echo "  NEXT → create the first admin (superadmin): open <worker-url>/setup"
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
