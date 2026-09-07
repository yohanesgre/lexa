#!/usr/bin/env bash
# Shared library for install.sh / uninstall.sh.
#
# This file is SOURCED, never executed:
#   source "$(dirname "$0")/install-lib.sh"
#
# The sourcing script MUST set `set -euo pipefail` before sourcing. The lib
# deliberately does not set it: it would leak shell options into the caller's
# interactive context when the lib is loaded from other tooling (design doc §7:
# error handling is structural — set -e + step() wrappers, never inline).
#
# Graph contract (design-deploy-tooling.md §4/§7/§8/§15):
#   - A-path: happy-path node functions, one per node, clean sequence.
#   - E-path: die (exit 1, domain errors) vs escape (exit 2, env/runtime
#     breakage) vs retry (bounded, then caller escapes). step() runs a node
#     and routes failures to the registered failure handler so the happy
#     path stays clean.
#   - Boundary: parse_flags is the ONLY place argv is read. tty_read never
#     reads stdin (script may be piped) — /dev/tty only, flag > env > default.
#   - write_env_file / compose_render accept whitelisted keys/values only.
#   - Dry-run (§9 test-swap): INSTALL_DRY_RUN=1 swaps R — mutating commands
#     route through mutate() (docker/systemctl/curl -X/-f) and are logged,
#     not executed; step() marks nodes with "#» DRY-RUN". Same graph.

# shellcheck shell=bash

# shellcheck disable=SC2034  # double-source guard for callers
LIB_INSTALLED_GUARD=1

# ---------------------------------------------------------------------------
# usage / help
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
Usage: install.sh <target> [flags]

Targets: docker | bare | workers | dev

Flags:
  --flavor <staging|prod>          deployment flavor
  --staging                        shorthand for --flavor staging
  --prod                           shorthand for --flavor prod
  --port <n>                       host port (docker, default 8080)
  --bind <addr>                    bind address (default 127.0.0.1)
  --domain <d>                     custom domain (workers; skips prompt)
  --key <k>                        LXK_API_KEY (default: auto-generated)
  --image <tag>                    container image tag
  --systemd                        bare: write + enable systemd unit
  --reset-db                       workers: drop the existing D1 database and
                                   start migrations fresh (data is lost)
  --yes                            assume yes for confirmations
  --purge                          uninstall: also delete data
  --clean                          docker: remove lexa-data volume
  --from-repo <dir>                install from a local repo checkout
  --help                           show this help
EOF
}

# ---------------------------------------------------------------------------
# E-helpers: die (exit 1) / escape (exit 2) / step (A-node wrapper)
# ---------------------------------------------------------------------------
die() {
  printf 'install: ERROR: %s\n' "$*" >&2
  exit 1
}

escape() {
  printf 'install: FATAL: %s\n' "$*" >&2
  exit 2
}

# mutate <cmd...> — dry-run-aware mutator (§9 test-swap: swap R, same graph).
# INSTALL_DRY_RUN=1: log "[dry-run] <cmd>" and return 0 — nothing executes.
# Otherwise exec the command unchanged.
mutate() {
  if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

FAILURE_HANDLER=""

on_failure() {
  FAILURE_HANDLER="$1"
}

# step "node-name" cmd [args...]
# Prints the node marker, runs the command; on failure invokes the registered
# failure handler (E-path) then dies. Happy path output stays clean.
step() {
  local name="$1"
  shift
  if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
    printf '#» DRY-RUN %s\n' "$*"
  else
    printf '#» %s\n' "$name"
  fi
  if "$@"; then
    return 0
  fi
  local rc=$?
  if [ -n "$FAILURE_HANDLER" ] && declare -F "$FAILURE_HANDLER" >/dev/null 2>&1; then
    "$FAILURE_HANDLER" "$name" "$rc"
  fi
  die "step failed: ${name} (exit ${rc})"
}

# ---------------------------------------------------------------------------
# retry <n> <cmd...> — bounded retry with linear backoff (compose pull)
# ---------------------------------------------------------------------------
retry() {
  local tries="$1"
  shift
  local attempt=1
  until "$@"; do
    if [ "$attempt" -ge "$tries" ]; then
      return 1
    fi
    sleep $((attempt * 2))
    attempt=$((attempt + 1))
  done
}

# ---------------------------------------------------------------------------
# wait_for <url> [tries] — health-wait loop, 1s interval, default 60 tries
# ---------------------------------------------------------------------------
wait_for() {
  local url="$1"
  local tries="${2:-60}"
  if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
    mutate curl -fsS -o /dev/null --max-time 5 "$url"
    return 0
  fi
  local i=1
  local err=""
  while [ "$i" -le "$tries" ]; do
    if err=$(curl -fsS -o /dev/null --max-time 5 "$url" 2>&1); then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  escape "health check failed after ${tries} tries: ${url} (last error: ${err})"
}

# ---------------------------------------------------------------------------
# tty_read <prompt> [default] [env_var]
# Reads from /dev/tty only — stdin may be the piped script itself.
# Precedence: flag (caller: skip this fn when flag set) > env > prompt default.
# No tty available and no env override -> die with the flag to pass.
# ---------------------------------------------------------------------------
tty_read() {
  local prompt="$1"
  local default="${2:-}"
  local env_name="${3:-}"
  if [ -n "$env_name" ]; then
    local from_env=""
    from_env=$(printenv "$env_name" || true)
    if [ -n "$from_env" ]; then
      printf '%s\n' "$from_env"
      return 0
    fi
  fi
  if [ ! -r /dev/tty ]; then
    die "headless: pass --flag instead (${prompt})"
  fi
  local reply=""
  # Prompt on its own line: typed input must not glue onto the label.
  # shellcheck disable=SC2069  # redirect order matters: silence before /dev/tty open
  printf '%s\n' "$prompt" 2>/dev/null > /dev/tty || die "headless: pass --flag instead (${prompt})"
  # shellcheck disable=SC2069
  IFS= read -r reply 2>/dev/null < /dev/tty || die "headless: pass --flag instead (${prompt})"
  if [ -z "$reply" ]; then
    printf '%s\n' "$default"
  else
    printf '%s\n' "$reply"
  fi
}

# ---------------------------------------------------------------------------
# gen_api_key — prints lxk_<48 hex chars>
# ---------------------------------------------------------------------------
gen_api_key() {
  if command -v openssl >/dev/null 2>&1; then
    printf 'lxk_%s\n' "$(openssl rand -hex 24)"
  else
    printf 'lxk_%s\n' "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
}

# ---------------------------------------------------------------------------
# verify_checksum <file> <sha256>
# ---------------------------------------------------------------------------
verify_checksum() {
  local file="$1"
  local expected="$2"
  local actual=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$file" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$file" | awk '{print $1}')
  else
    die "no sha256 tool available (need sha256sum or shasum)"
  fi
  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for ${file}: expected ${expected}, got ${actual}"
  fi
}

# ---------------------------------------------------------------------------
# write_env_file <path> <key=value...>
# Whitelisted keys only; file written chmod 600.
# ---------------------------------------------------------------------------
ENV_FILE_ALLOWED_KEYS=" LXK_API_KEY LXK_ENV LXK_PUBLIC_URL LXK_TRUSTED_ORIGINS GITHUB_APP_ID GITHUB_PRIVATE_KEY_FILE GITHUB_WEBHOOK_SECRET CF_TUNNEL_TOKEN "

write_env_file() {
  local path="$1"
  shift
  local kv key val
  local tmp="${path}.tmp"
  : > "$tmp"
  chmod 600 "$tmp"
  for kv in "$@"; do
    key="${kv%%=*}"
    val="${kv#*=}"
    case "$ENV_FILE_ALLOWED_KEYS" in
      *" $key "*) ;;
      *) rm -f "$tmp"; die "write_env_file: key not allowed: ${key}" ;;
    esac
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
  done
  mv -f "$tmp" "$path"
}

# ---------------------------------------------------------------------------
# parse_flags — whitelist-style parser; the ONLY reader of argv.
# Sets: TARGET FLAVOR STAGING PROD PORT BIND DOMAIN API_KEY IMAGE_TAG
#       SYSTEMD ASSUME_YES PURGE CLEAN FROM_REPO HELP
# Unknown flag -> usage + die. Positional target accepted (first one only).
# ---------------------------------------------------------------------------
parse_flags() {
  # shellcheck disable=SC2034  # parse_flags outputs are the caller's contract
  TARGET="" FLAVOR="" STAGING=0 PROD=0 PORT=8080 BIND=127.0.0.1 DOMAIN=""
  API_KEY="" IMAGE_TAG="" SYSTEMD=0 ASSUME_YES=0 PURGE=0 CLEAN=0 RESET_DB=0
  FROM_REPO="" HELP=0 CF_TOKEN=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --flavor)
        [ $# -ge 2 ] || die "--flavor requires a value"
        FLAVOR=$2
        shift 2
        ;;
      --staging) STAGING=1; shift ;;
      --prod) PROD=1; shift ;;
      --port)
        [ $# -ge 2 ] || die "--port requires a value"
        PORT=$2
        shift 2
        ;;
      --bind)
        [ $# -ge 2 ] || die "--bind requires a value"
        BIND=$2
        shift 2
        ;;
      --domain)
        [ $# -ge 2 ] || die "--domain requires a value"
        DOMAIN=$2
        shift 2
        ;;
      --key)
        [ $# -ge 2 ] || die "--key requires a value"
        API_KEY=$2
        shift 2
        ;;
      --cf-token)
        [ $# -ge 2 ] || die "--cf-token requires a value"
        CF_TOKEN=$2
        shift 2
        ;;
      --image)
        [ $# -ge 2 ] || die "--image requires a value"
        IMAGE_TAG=$2
        shift 2
        ;;
      --from-repo)
        [ $# -ge 2 ] || die "--from-repo requires a value"
        FROM_REPO=$2
        shift 2
        ;;
      --systemd) SYSTEMD=1; shift ;;
      --reset-db) RESET_DB=1; shift ;;
      --yes) ASSUME_YES=1; shift ;;
      --purge) PURGE=1; shift ;;
      --clean) CLEAN=1; shift ;;
      --help|-h) HELP=1; shift ;;
      -) die "unknown flag: - (see --help)" ;;
      -*)
        usage >&2
        die "unknown flag: $1"
        ;;
      *)
        if [ -z "$TARGET" ]; then
          TARGET=$1
        else
          die "unexpected positional argument: $1 (target already set to ${TARGET})"
        fi
        shift
        ;;
    esac
  done
  if [ "$STAGING" = 1 ] && [ "$PROD" = 1 ]; then
    die "--staging and --prod are mutually exclusive"
  fi
  if [ "$STAGING" = 1 ]; then
    FLAVOR=staging
  fi
  if [ "$PROD" = 1 ]; then
    FLAVOR=prod
  fi
}

# ---------------------------------------------------------------------------
# compose_render <flavor> <port> <bind>
# Emits docker-compose.yml into ${DEPLOY_DIR} (default: .). Modeled on the
# repo's docker-compose.yml + docker-compose.staging.yml; flavor != direct
# adds the cloudflared tunnel service. Values validated before interpolation.
# ---------------------------------------------------------------------------
compose_render() {
  local flavor="$1"
  local port="$2"
  local bind="$3"
  local deploy_dir="${DEPLOY_DIR:-.}"
  local image_tag="${IMAGE_TAG:-latest}"
  case "$flavor" in
    direct|staging|prod) ;;
    *) die "compose_render: invalid flavor: ${flavor}" ;;
  esac
  case "$port" in
    ''|*[!0-9]*) die "compose_render: invalid port: ${port}" ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    die "compose_render: port out of range: ${port}"
  fi
  case "$bind" in
    ''|*[!A-Za-z0-9._-]*) die "compose_render: invalid bind address: ${bind}" ;;
  esac
  if [ "$flavor" = "staging" ]; then
    image_tag="${IMAGE_TAG:-staging}"
  fi
  mkdir -p "$deploy_dir"
  if [ "$flavor" = "direct" ] || [ -z "${CF_TUNNEL_TOKEN:-}" ]; then
    cat > "${deploy_dir}/docker-compose.yml" <<EOF
services:
  app:
    image: ghcr.io/yohanesgre/lexa:${image_tag}
    ports:
      - "${bind}:${port}:3000"
    volumes:
      - lexa-data:/app/data
    environment:
      - DATABASE_PATH=/app/data/lexa.db
      - PORT=3000
      - LXK_ENV=\${LXK_ENV:-}
      - LXK_API_KEY=\${LXK_API_KEY}
      - LXK_PUBLIC_URL=\${LXK_PUBLIC_URL:-}
      - LXK_TRUSTED_ORIGINS=\${LXK_TRUSTED_ORIGINS:-}
      - LXK_ADMIN_EMAILS=\${LXK_ADMIN_EMAILS:-}
      - GITHUB_APP_ID=\${GITHUB_APP_ID:-}
      - GITHUB_PRIVATE_KEY_FILE=\${GITHUB_PRIVATE_KEY_FILE:-}
      - GITHUB_WEBHOOK_SECRET=\${GITHUB_WEBHOOK_SECRET:-}
      - LOG_LEVEL=\${LOG_LEVEL:-}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:3000/api/health').catch(() => process.exit(1))"]
      interval: 30s
      retries: 3
      start_period: 10s

volumes:
  lexa-data:
EOF
  else
    cat > "${deploy_dir}/docker-compose.yml" <<EOF
services:
  app:
    image: ghcr.io/yohanesgre/lexa:${image_tag}
    volumes:
      - lexa-data:/app/data
    environment:
      - DATABASE_PATH=/app/data/lexa.db
      - PORT=3000
      - LXK_ENV=\${LXK_ENV:-}
      - LXK_API_KEY=\${LXK_API_KEY}
      - LXK_PUBLIC_URL=\${LXK_PUBLIC_URL:-}
      - LXK_TRUSTED_ORIGINS=\${LXK_TRUSTED_ORIGINS:-}
      - LXK_ADMIN_EMAILS=\${LXK_ADMIN_EMAILS:-}
      - GITHUB_APP_ID=\${GITHUB_APP_ID:-}
      - GITHUB_PRIVATE_KEY_FILE=\${GITHUB_PRIVATE_KEY_FILE:-}
      - GITHUB_WEBHOOK_SECRET=\${GITHUB_WEBHOOK_SECRET:-}
      - LOG_LEVEL=\${LOG_LEVEL:-}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:3000/api/health').catch(() => process.exit(1))"]
      interval: 30s
      retries: 3
      start_period: 10s

  tunnel:
    image: cloudflare/cloudflared
    command: tunnel --no-autoupdate run --token \${CF_TUNNEL_TOKEN}
    depends_on:
      app:
        condition: service_healthy
    restart: unless-stopped

volumes:
  lexa-data:
EOF
  fi
}

# Guard: this file is a library — refuse direct execution.
if [ "${BASH_SOURCE[0]:-}" = "$0" ]; then
  printf 'install-lib.sh is a library: source it, never execute it\n' >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Preflights (R per target — explicit, per-OS hints, fail-fast)
# ---------------------------------------------------------------------------
preflight_docker() {
  command -v docker >/dev/null 2>&1 || die "docker not found — install Docker (https://docs.docker.com/engine/install/)"
  docker compose version >/dev/null 2>&1 || die "docker compose plugin not found — install docker-compose-plugin"
}

require_bun() {
  command -v bun >/dev/null 2>&1 && return 0
  if [ -x "${HOME}/.bun/bin/bun" ]; then
    export PATH="${HOME}/.bun/bin:${PATH}"
    command -v bun >/dev/null 2>&1 && return 0
  fi
  return 1
}

preflight_bun() {
  require_bun || die "bun not found — install: curl -fsSL https://bun.sh/install | bash"
}

preflight_git_bun() {
  command -v git >/dev/null 2>&1 || die "git not found — install git first"
  preflight_bun
}

# ---------------------------------------------------------------------------
# Release fetch — GitHub releases (server | workers tarballs + checksums)
# ---------------------------------------------------------------------------
LEXA_REPO="${LEXA_REPO:-yohanesgre/lexa}"

fetch_release() {
  local kind="$1" dest="$2"
  mkdir -p "${dest}"
  local tag
  if [ -n "${RELEASE_TAG}" ] && [ "${RELEASE_TAG}" != "latest" ]; then
    tag="${RELEASE_TAG}"
  else
    tag=$(curl -fsSL "https://api.github.com/repos/${LEXA_REPO}/releases/latest" \
      | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"tag_name": *"//;s/"//')
    [ -n "${tag}" ] || die "could not resolve latest release of ${LEXA_REPO} (rate limit? pass RELEASE_TAG=vX.Y.Z)"
  fi
  local tarball="lexa-${kind}-${tag}.tar.gz"
  step "fetch release" curl -fsSL "https://github.com/${LEXA_REPO}/releases/download/${tag}/${tarball}" -o "${dest}/${tarball}"
  if curl -fsSL "https://github.com/${LEXA_REPO}/releases/download/${tag}/checksums.txt" -o "${dest}/checksums.txt" 2>/dev/null; then
    local want=""
    want=$(grep "${tarball}" "${dest}/checksums.txt" | awk '{print $1}')
    [ -n "${want}" ] && step "verify checksum" verify_checksum "${dest}/${tarball}" "${want}"
  else
    echo "  (checksums.txt unavailable for ${tag} — skipped; pin tags in production)"
  fi
}

# unpack_release <fetch_dir> <install_dir> server|workers
# Multiple fetches of different tags can pile up in the fetch dir; extract
# the newest tarball, never treat a second match as a member name.
unpack_release() {
  local fetch_dir="$1" install_dir="$2" kind="$3"
  mkdir -p "${install_dir}"
  local tarball
  tarball=$(ls -t "${fetch_dir}"/lexa-"${kind}"-*.tar.gz 2>/dev/null | head -1)
  [ -n "${tarball}" ] || die "no lexa-${kind}-*.tar.gz found in ${fetch_dir}"
  step "unpack" tar xzf "${tarball}" -C "${install_dir}"
}

# ---------------------------------------------------------------------------
# bare helpers — start script + systemd unit
# ---------------------------------------------------------------------------
write_start_script() {
  local dir="$1"
  cat > "${dir}/lexa-start.sh" <<START
#!/usr/bin/env bash
cd "${dir}"
exec bun --env-file=.env server/entry.ts
START
  chmod +x "${dir}/lexa-start.sh"
  return 0
}

install_systemd_unit() {
  local dir="$1"
  [ "$(id -u)" = "0" ] || die "--systemd requires root (sudo). Without root, run ${dir}/lexa-start.sh in tmux/nohup."
  cat > /etc/systemd/system/lexa.service <<UNIT
[Unit]
Description=Lexa server
After=network.target

[Service]
User=bun
WorkingDirectory=${dir}
ExecStart=$(command -v bun) --env-file=.env server/entry.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  mutate systemctl daemon-reload
  mutate systemctl enable --now lexa
}

# ---------------------------------------------------------------------------
# final_banner <url> <api_key>
# ---------------------------------------------------------------------------
final_banner() {
  local url="$1" api_key="$2"
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  Lexa — running at ${url}"
  echo "  API key: ${api_key}"
  echo ""
  echo "  NEXT → create the first admin (superadmin):"
  echo "         open ${url}/setup"
  echo "         (email + password, min 8 chars)"
  echo "═══════════════════════════════════════════════"
}

# ---------------------------------------------------------------------------
# confirm_tty — interactive y/n confirm (TTY only)
# ---------------------------------------------------------------------------
confirm_tty() {
  local prompt="$1" default="$2"
  local answer
  answer=$(tty_read "${prompt}" "${default}")
  case "${answer}" in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

# tty_read_soft — like tty_read but a failed /dev/tty read returns the
# default instead of dying. For prompts with a safe default (e.g. the
# workers.dev domain): headless automation gets the default, never a hard
# failure, and a real terminal still gets the prompt.
tty_read_soft() {
  local prompt="$1" default="${2:-}" env_name="${3:-}"
  if [ -n "$env_name" ]; then
    local from_env=""
    from_env=$(printenv "$env_name" || true)
    if [ -n "$from_env" ]; then
      printf '%s\n' "$from_env"
      return 0
    fi
  fi
  if [ ! -r /dev/tty ]; then
    printf '%s\n' "$default"
    return 0
  fi
  local reply=""
  printf '%s\n' "$prompt" 2>/dev/null > /dev/tty || { printf '%s\n' "$default"; return 0; }
  IFS= read -r reply 2>/dev/null < /dev/tty || { printf '%s\n' "$default"; return 0; }
  if [ -z "$reply" ]; then printf '%s\n' "$default"; else printf '%s\n' "$reply"; fi
}

# tty_read_secret — tty_read for secrets: the reply is never echoed (read -s)
# and a trailing newline keeps the next log line off the input line.
# Headless: env override or --flag; a TTY is required otherwise.
tty_read_secret() {
  local prompt="$1" env_name="${2:-}"
  if [ -n "$env_name" ]; then
    local from_env=""
    from_env=$(printenv "$env_name" || true)
    if [ -n "$from_env" ]; then
      printf '%s\n' "$from_env"
      return 0
    fi
  fi
  if [ ! -r /dev/tty ]; then
    die "headless: pass --flag instead (${prompt})"
  fi
  printf '%s\n' "$prompt" 2>/dev/null > /dev/tty || die "headless: pass --flag instead (${prompt})"
  local reply=""
  # shellcheck disable=SC2069
  IFS= read -rs reply 2>/dev/null < /dev/tty || die "headless: pass --flag instead (${prompt})"
  printf '\n' > /dev/tty
  printf '%s\n' "$reply"
}
