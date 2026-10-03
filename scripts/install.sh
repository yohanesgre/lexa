#!/usr/bin/env bash
# Lexa install script — self-hosting entry point.
#
# Recommended (installer hub, newest release, BASE_URL pinned to its tag):
#   curl -fsSL https://install.yohanesgre.com/lexa/install.sh \
#     | bash -s -- [workers] [flags]
#
# Direct (explicit tag, or main for bleeding edge):
#   curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/<tag>/scripts/install.sh \
#     | bash -s -- [workers] [flags]
#
# Target: workers (Cloudflare Workers). Installs into a self-describing dir in
# the CWD: cf-workers/. Provisioning of the first superadmin is ALWAYS the web
# /setup wizard — this script only prepares the runtime (R3: passwords never
# touch argv/env).
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
  TARGET="workers"
fi

# dev was removed — development starts from a clone.
die_dev_removed() {
  printf '%s\n' "The 'dev' target was removed — development starts from a clone:
  git clone https://github.com/yohanesgre/lexa && cd lexa
  bun install && bun run setup && bun run dev:full" >&2
  exit 1
}

case "${TARGET}" in
  workers) ;;
  dev) die_dev_removed ;;
  *) die "Unknown target '${TARGET}'. Available: workers." ;;
esac

CF_TOKEN="${CF_TOKEN:-}"
RELEASE_TAG="${RELEASE_TAG:-}"
# Read by final_banner() in install-lib.sh; export so shellcheck sees it as an
# externally consumed rather than a dead assignment.
BANNER_MASTER=""
export BANNER_MASTER

# ---------------------------------------------------------------------------
# workers — release tarball → bun scripts/workers-install.ts (provisioning,
# migrations, deploy); dir: cf-workers/. Token chain: --cf-token → CF_API_TOKEN
# → cf-workers/.cf-token → wrangler login → TTY prompt. Master key is minted
# once and kept in cf-workers/.env.toml custody.
# ---------------------------------------------------------------------------
deploy_workers() {
  preflight_workers
  collect_optional_secrets
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
      echo "  (the wrangler login could not be verified — run \`wrangler whoami\` to refresh it, or enter a token)"
      CF_TOKEN=""
      _CF_FROM_OAUTH=0
    fi
  fi
  if [ -z "${CF_TOKEN}" ]; then
    _tty_available || die "No Cloudflare credentials found — run \`wrangler login\` once, or pass a token via --cf-token / CF_API_TOKEN, or run \`wrangler whoami\` once to refresh an expired login, then re-run."
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
  [ -n "${CF_TOKEN}" ] || die "No Cloudflare credentials found — run \`wrangler login\` once, or pass a token via --cf-token / CF_API_TOKEN, or run \`wrangler whoami\` once to refresh an expired login, then re-run."
  export CLOUDFLARE_API_TOKEN="${CF_TOKEN}"
  export CF_API_TOKEN="${CF_TOKEN}"
  # Cloudflare account: --account wins; then CLOUDFLARE_ACCOUNT_ID from the
  # environment; else the previous deploy's wrangler config records it (read
  # BEFORE the release unpack wipes deploy-<name>/), else workers-install.ts
  # resolves from the token's account list and dies on ambiguity. Export when
  # the id is known at shell level so every wrangler call is unambiguous; a
  # fresh multi-account install stays unresolved here and the TS step refuses
  # (headless) or prompts (TTY).
  _shell_account="${ACCOUNT:-${CLOUDFLARE_ACCOUNT_ID:-}}"
  if [ -z "${_shell_account}" ]; then
    _shell_account="$(resolve_shell_account "${_ww_dir}" "${FLAVOR_NAME}")"
  fi
  if [ -n "${_shell_account}" ]; then
    export CLOUDFLARE_ACCOUNT_ID="${_shell_account}"
  fi
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
      # A workers.dev host is not a custom domain — treat it as none so the
      # re-run prompt never offers it (the zone lookup would die on workers.dev).
      case "${_prev_domain}" in
        *.workers.dev) _prev_domain="" ;;
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
  # remote state can't be read (better to leave it than to rotate). Dry-run is
  # pure: it prints the mint plan and a placeholder put, never mints or writes.
  _custody="${_ww_dir}/.env.toml"
  workers_resolve_master_key "${_ww_dir}"

  if [ -n "${FROM_REPO}" ]; then
    WORK_DIR="${REPO_ROOT}"
    [ -f "${WORK_DIR}/dist/server/wrangler.json" ] || die "No build found in ${FROM_REPO} — run 'LEXA_FLAVOR=workers bun run build' first, then re-run this script."
  else
    fetch_release "workers" "${_ww_dir}"
    WORK_DIR="${_ww_dir}"
    # Retry safety: a previous failed run may have left stale extractions
    # (old-tag dist/migrations/scripts mixed with the new tarball's). Keep the
    # downloads (+ saved token + master-key custody + the deploy-* dirs, whose
    # wrangler config records the account/domain a re-run resumes).
    prune_workdir "${WORK_DIR}"
    unpack_release "${WORK_DIR}" "${WORK_DIR}" workers
  fi

  cf_args=(--name "${FLAVOR_NAME}")
  [ -n "${ACCOUNT}" ] && cf_args+=(--account "${ACCOUNT}")
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
  workers_prune_legacy_secret "${_ww_dir}"

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
  final_banner "${deployed_url}"
}

case "${TARGET}" in
  workers) deploy_workers ;;
esac
