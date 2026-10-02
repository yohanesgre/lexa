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
[ -n "${TARGET}" ] || die "target required: workers | dev"
case "${TARGET}" in
  workers|dev) ;;
  *) die "unknown target '${TARGET}' (workers|dev)" ;;
esac

if [ "${PURGE}" = "1" ]; then
  if _tty_available; then
    if [ "${TARGET}" = "workers" ]; then
      answer=$(tty_read "This removes local credentials; D1/R2/KV resources are KEPT (delete them in the Cloudflare dashboard). Type 'purge' to confirm" "")
    else
      answer=$(tty_read "This DELETES the clone and its data. Type 'purge' to confirm" "")
    fi
    [ "${answer}" = "purge" ] || die "confirmation did not match — aborted (data intact)"
  else
    die "--purge is destructive — re-run on a terminal to confirm, or drop the flag to keep data"
  fi
fi

case "${TARGET}" in
  workers)
    require_bun
    WORK_DIR="${WORK_DIR:-cf-workers}"
    UNINSTALL_NAME="$(resolve_deploy_name "${WORK_DIR}" "${NAME}")"
    [ -f "${WORK_DIR}/deploy-${UNINSTALL_NAME}/wrangler.${UNINSTALL_NAME}.json" ] || die "no wrangler config at ${WORK_DIR}/deploy-${UNINSTALL_NAME}/ — was workers installed here? (pass --name if several deploys exist)"
    # Worker + route teardown via wrangler; resources (D1/R2/KV) default KEEP.
    # Tolerate ONLY the delete call itself: an absent worker (or a failed delete)
    # must not abort the rest of teardown — warn and continue. The steps after
    # this still run and still fail loudly.
    if ! (cd "${WORK_DIR}" && step "wrangler delete" bun x wrangler delete --config "deploy-${UNINSTALL_NAME}/wrangler.${UNINSTALL_NAME}.json"); then
      echo "  (worker not found or delete failed — continuing)"
    fi
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
