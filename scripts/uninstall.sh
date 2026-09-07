#!/usr/bin/env bash
# Lexa uninstall script — teardown per target. Data is KEPT unless --purge
# (which requires typing 'purge' on a TTY). Flow source of truth:
# status/design-deploy-tooling.md §13.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/install-lib.sh" ]; then
  # shellcheck source=scripts/install-lib.sh
  source "${SCRIPT_DIR}/install-lib.sh"
else
  LIB_URL="${INSTALL_BASE_URL:-https://raw.githubusercontent.com/yohanesgre/lexa/main/scripts}/install-lib.sh"
  SCRIPT_DIR="$(mktemp -d /tmp/lexa-uninstall.XXXXXX)"
  curl -fsSL "${LIB_URL}" -o "${SCRIPT_DIR}/install-lib.sh"
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/install-lib.sh"
fi

parse_flags "$@"
[ -n "${TARGET}" ] || die "target required: docker | bare | workers | dev"
case "${TARGET}" in
  docker|bare|workers|dev) ;;
  *) die "unknown target '${TARGET}' (docker|bare|workers|dev)" ;;
esac

if [ "${PURGE}" = "1" ]; then
  if [ -r /dev/tty ]; then
    answer=$(tty_read "This DELETES data (volume/DB). Type 'purge' to confirm" "")
    [ "${answer}" = "purge" ] || die "confirmation did not match — aborted (data intact)"
  else
    die "--purge is destructive — re-run on a terminal to confirm, or drop the flag to keep data"
  fi
fi

case "${TARGET}" in
  docker)
    DEPLOY_DIR="${DEPLOY_DIR:-lexa-deploy}"
    [ -d "${DEPLOY_DIR}" ] || die "deploy dir '${DEPLOY_DIR}' not found — pass --from-repo? no: pass DEPLOY_DIR env or cd next to it"
    cd "${DEPLOY_DIR}"
    step "compose down" mutate docker compose down
    if [ "${PURGE}" = "1" ]; then
      step "remove data volume" mutate docker volume rm lexa-data
    else
      echo "  ✓ data volume 'lexa-data' KEPT"
    fi
    step "remove deploy dir" rm -rf "${DEPLOY_DIR}"
    ;;

  bare)
    if [ "${SYSTEMD}" = "1" ]; then
      step "systemd stop" mutate systemctl disable --now lexa
      step "remove unit" rm -f /etc/systemd/system/lexa.service && mutate systemctl daemon-reload
    fi
    pkill -f "server/entry.ts" 2>/dev/null || true
    INSTALL_DIR="${INSTALL_DIR:-${HOME}/.lexa-server}"
    [ -d "${INSTALL_DIR}" ] || die "install dir '${INSTALL_DIR}' not found"
    if [ "${PURGE}" = "1" ]; then
      step "remove install dir + data" rm -rf "${INSTALL_DIR}"
    else
      echo "  ✓ install dir '${INSTALL_DIR}' KEPT (data inside)"
      echo "    remove manually when ready: rm -rf ${INSTALL_DIR}"
    fi
    ;;

  workers)
    require_bun
    WORK_DIR="${WORK_DIR:-lexa-workers-release}"
    [ -f "${WORK_DIR}/deploy-${FLAVOR}/wrangler.${FLAVOR}.json" ] || die "no wrangler config at ${WORK_DIR}/deploy-${FLAVOR}/ — was workers installed here?"
    # Worker + route teardown via wrangler; resources (D1/R2/KV) default KEEP.
    (cd "${WORK_DIR}" && step "wrangler delete" bunx wrangler delete --config "deploy-${FLAVOR}/wrangler.${FLAVOR}.json" || true)
    if [ "${PURGE}" = "1" ]; then
      echo "  --purge: D1/R2/KV resources must be deleted from the CF dashboard"
      echo "  (or via the CF API) — names: lexa-${FLAVOR} / lexa-blobs-${FLAVOR} / lexa-${FLAVOR}"
    else
      echo "  ✓ D1/R2/KV resources KEPT (delete from CF dashboard if unwanted)"
    fi
    ;;

  dev)
    REPO_DIR="${REPO_DIR:-lexa}"
    [ -d "${REPO_DIR}" ] || die "repo dir '${REPO_DIR}' not found"
    pkill -f "server/entry.ts" 2>/dev/null || true
    pkill -f "vite dev" 2>/dev/null || true
    echo "  ✓ dev processes stopped"
    if [ "${PURGE}" = "1" ]; then
      step "remove clone + data" rm -rf "${REPO_DIR}"
    else
      echo "  ✓ clone '${REPO_DIR}' KEPT (remove manually if unwanted)"
    fi
    ;;
esac

echo "✓ uninstall (${TARGET}) complete"
