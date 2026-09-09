#!/usr/bin/env bash
# Lexa uninstall script — teardown per target. Data is KEPT unless --purge
# (which requires typing 'purge' on a TTY). Flow source of truth:
# status/design-deploy-tooling.md §13.
set -euo pipefail

SELF="${BASH_SOURCE[0]:-}"
if [ -n "$SELF" ] && [ -f "$SELF" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
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
    [ -d "${DEPLOY_DIR}" ] || die "deploy dir '${DEPLOY_DIR}' not found — pass DEPLOY_DIR env or cd next to it"
    DEPLOY_DIR="$(cd "${DEPLOY_DIR}" && pwd)"
    (cd "${DEPLOY_DIR}" && step "compose down" mutate docker compose down)
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
    UNINSTALL_NAME="$(resolve_deploy_name "${WORK_DIR}" "${NAME}")"
    [ -f "${WORK_DIR}/deploy-${UNINSTALL_NAME}/wrangler.${UNINSTALL_NAME}.json" ] || die "no wrangler config at ${WORK_DIR}/deploy-${UNINSTALL_NAME}/ — was workers installed here? (pass --name if several deploys exist)"
    # Worker + route teardown via wrangler; resources (D1/R2/KV) default KEEP.
    (cd "${WORK_DIR}" && step "wrangler delete" bunx wrangler delete --config "deploy-${UNINSTALL_NAME}/wrangler.${UNINSTALL_NAME}.json" || true)
    if [ "${PURGE}" = "1" ]; then
      rm -f "${WORK_DIR}/.cf-token"
      echo "  --purge: D1/R2/KV resources must be deleted from the CF dashboard"
      echo "  (or via the CF API) — see deploy-${UNINSTALL_NAME}/wrangler.${UNINSTALL_NAME}.json for resource names"
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
