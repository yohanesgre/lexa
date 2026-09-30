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
#   - write_env_file / write_env_toml / compose_render accept whitelisted
#     keys/values only. Env writes merge (never truncate) so operator-added
#     keys (GITHUB_*) survive a re-run.
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

Targets: docker | bare | workers

Flags:
  --ref <tag|branch>             script + artifact source (default: newest v* tag;
                               resolved by the install-router track)
  --name <name>                  workers deploy name (default lexa)
  --port <n>                       host port (docker, default 8080)
  --bind <addr>                    bind address (default 127.0.0.1)
  --domain <d>                     custom domain (workers; skips prompt)
  --image <tag>                    container image tag
  --no-pull                        docker only: skip `docker compose pull` and
                                   use a locally available image
  --systemd                        bare: write + enable systemd unit
  --secrets-file <path>            optional secrets (KEY=value) applied at install
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

# _redact_secret_entries <text> — replace the value of any `LXK_*MASTER_KEY*=`
# entry with `***` (covers LXK_SECRETS_MASTER_KEY and ..._PREV). Applied to the
# dry-run argv echo: command substitution expands the key entry into step()'s
# argv, and a master key must never reach stdout.
_redact_secret_entries() {
  printf '%s' "$1" | sed -E 's/(LXK_[A-Z0-9_]*MASTER_KEY[A-Z0-9_]*=)[^[:space:]]*/\1***/g'
}

# step "node-name" cmd [args...]
# Prints the node marker, runs the command; on failure invokes the registered
# failure handler (E-path) then dies. Happy path output stays clean.
step() {
  local name="$1"
  shift
  if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
    printf '#» DRY-RUN %s\n' "$(_redact_secret_entries "$*")"
  else
    printf '#» %s\n' "$name"
  fi
  if "$@"; then
    return 0
  else
    local rc=$?
  fi
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
# wait_for <url> [tries] [log_file] — health-wait loop, 1s interval, default 60
# tries. On timeout a log_file (when given and present) is tailed before the
# escape, so a bare manual start surfaces its lexa.log.
# ---------------------------------------------------------------------------
wait_for() {
  local url="$1"
  local tries="${2:-60}"
  local log_file="${3:-}"
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
  local msg="Lexa didn't respond at ${url} after ${tries} tries (last error: ${err}). Check the log below and re-run."
  if [ -n "$log_file" ] && [ -f "$log_file" ]; then
    # The message names the log "below", so it must precede the tail.
    printf 'install: FATAL: %s\n' "$msg" >&2
    printf -- '--- last lines of %s ---\n' "$log_file" >&2
    tail -n 20 "$log_file" >&2 || true
    exit 2
  fi
  escape "$msg"
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
    die "No terminal available — pass the value as a flag instead (${prompt})."
  fi
  local reply=""
  # Prompt on its own line: typed input must not glue onto the label.
  # shellcheck disable=SC2069  # redirect order matters: silence before /dev/tty open
  printf '%s\n' "$prompt" 2>/dev/null > /dev/tty || die "No terminal available — pass the value as a flag instead (${prompt})."
  # shellcheck disable=SC2069
  IFS= read -r reply 2>/dev/null < /dev/tty || die "No terminal available — pass the value as a flag instead (${prompt})."
  if [ -z "$reply" ]; then
    printf '%s\n' "$default"
  else
    printf '%s\n' "$reply"
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
    die "No checksum tool found (need sha256sum or shasum) — install one so downloads can be verified."
  fi
  if [ "$actual" != "$expected" ]; then
    die "Checksum mismatch for ${file} (expected ${expected}, got ${actual}) — the download looks corrupted; nothing was installed."
  fi
}

# ---------------------------------------------------------------------------
# env-file writers
#
# Keys the installer may write (whitelist, never free-form). The app keys are
# written to `.env.toml`; the compose-tooling keys to the flat `.env` that
# compose itself interpolates.
# Keys the app no longer reads — migration drops them, never carries them.
# ---------------------------------------------------------------------------
ENV_FILE_ALLOWED_KEYS=" LXK_ENV LXK_PUBLIC_URL LXK_TRUSTED_ORIGINS LXK_TRUSTED_PROXY_CIDRS LXK_ADMIN_EMAILS DATABASE_PATH PORT GITHUB_APP_ID GITHUB_PRIVATE_KEY GITHUB_PRIVATE_KEY_FILE GITHUB_WEBHOOK_SECRET LXK_SECRETS_MASTER_KEY COMPOSE_PROJECT_NAME LXK_IMAGE_TAG CF_TUNNEL_TOKEN "
ENV_FILE_DEAD_KEYS=" VITE_LXK_API_KEY LXK_API_KEY LXK_ACCESS_AUD LXK_ACCESS_TEAM LXK_RUNTIME_DAEMON_TOKEN LXK_RUNTIME_REPO_CAP RUNTIME_STALE_RUN_MIN "
# Compose-tooling keys: compose itself interpolates these from the flat `.env`,
# so migration must NOT move them into `.env.toml` (that would drop the compose
# project name and orphan the `lexa-data` volume, or silently unpin the image).
# They are preserved in the flat `.env` across a legacy migration.
ENV_FILE_TOOLING_KEYS=" COMPOSE_PROJECT_NAME LXK_IMAGE_TAG CF_TUNNEL_TOKEN "

# _scan_basic_string <body> — mirror of `scanBasicString` in server/env-file.ts.
# Single left-to-right pass (never a chain of ${v//} replacements: order would
# mangle `\\n`). Sets _SCAN_CLOSED (1/0), _SCAN_TEXT, _SCAN_AFTER.
_scan_basic_string() {
  local s="$1"
  local out="" escaped=0 i=0 n=${#1} c
  while [ "$i" -lt "$n" ]; do
    c="${s:$i:1}"
    if [ "$escaped" = "1" ]; then
      case "$c" in
        n) out+=$'\n' ;;
        r) out+=$'\r' ;;
        t) out+=$'\t' ;;
        '"') out+='"' ;;
        '\') out+='\' ;;
        "'") out+="'" ;;
        *) out+="$c" ;;
      esac
      escaped=0
    elif [ "$c" = '\' ]; then
      escaped=1
    elif [ "$c" = '"' ]; then
      _SCAN_CLOSED=1
      _SCAN_TEXT="$out"
      _SCAN_AFTER="${s:$((i + 1))}"
      return 0
    else
      out+="$c"
    fi
    i=$((i + 1))
  done
  [ "$escaped" = "1" ] && out+='\'
  _SCAN_CLOSED=0
  _SCAN_TEXT="$out"
  _SCAN_AFTER=""
}

# _env_key_loader_valid <key> — the loader's leaf-key contract
# (LEAF_KEY_RE in server/env-file.ts: ^[A-Z][A-Z0-9_]*$). Migration carries any
# such key; the installer's own writes stay on the stricter whitelist.
_env_key_loader_valid() {
  case "$1" in
    ''|[!A-Z]*|*[!A-Z0-9_]*) return 1 ;;
  esac
  return 0
}

# _env_key_allowed <key> — installer write whitelist membership.
_env_key_allowed() {
  case "$ENV_FILE_ALLOWED_KEYS" in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

# _kv_replace_line <file> <key> <replacement-line>
# Replaces the first `KEY=`/`KEY =` line in place, or appends. Used by both
# writers so an existing file is merged, never truncated.
_kv_replace_line() {
  local file="$1" key="$2" repl="$3"
  local ln done=0 lhs
  if grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$file"; then
    # Secret-bearing temp: create under umask 077 AND chmod 600 immediately,
    # then re-assert 600 before the rename — `mv` carries the temp's mode to
    # the destination, so an interrupted run must never leave a 0644 file.
    ( umask 077; : > "${file}.next" )
    chmod 600 "${file}.next"
    while IFS= read -r ln || [ -n "$ln" ]; do
      lhs="${ln#"${ln%%[![:space:]]*}"}"
      lhs="${lhs%%=*}"
      lhs="${lhs%"${lhs##*[![:space:]]}"}"
      if [ "$done" -eq 0 ] && [ "$lhs" = "$key" ]; then
        printf '%s\n' "$repl" >> "${file}.next"
        done=1
      else
        printf '%s\n' "$ln" >> "${file}.next"
      fi
    done < "$file"
    chmod 600 "${file}.next"
    mv -f "${file}.next" "$file"
  else
    # Append: keep the new line on its own line even when the existing file
    # lacks a trailing newline.
    if [ -s "$file" ] && [ "$(tail -c1 "$file" | wc -l)" -eq 0 ]; then
      printf '\n' >> "$file"
    fi
    printf '%s\n' "$repl" >> "$file"
  fi
}

# toml_escape <value> — single-line TOML basic-string body (no surrounding
# quotes). Escapes backslash, quote, the named controls, and every remaining
# control char (< 0x20) as \uXXXX — mirrors escapeTomlString in
# server/env-file.ts so a carried value round-trips byte-exact.
toml_escape() {
  local src="$1"
  local out="" i=0 n=${#1} c hex
  while [ "$i" -lt "$n" ]; do
    c="${src:$i:1}"
    case "$c" in
      '\') out+='\\' ;;
      '"') out+='\"' ;;
      $'\n') out+='\n' ;;
      $'\r') out+='\r' ;;
      $'\t') out+='\t' ;;
      [[:cntrl:]])
        printf -v hex '\\u%04x' "'$c"
        out+="$hex"
        ;;
      *) out+="$c" ;;
    esac
    i=$((i + 1))
  done
  printf '%s' "$out"
}

# env_to_toml <key=value...> — sectioned TOML document on stdout. Sections are
# presentation only (the loader keys off the leaf names); order mirrors
# server/env-file.ts.
env_to_toml() {
  local core="" auth="" urls="" github="" other=""
  local kv key line
  for kv in "$@"; do
    key="${kv%%=*}"
    case "$key" in
      ''|*[!A-Z0-9_]*|[0-9]*) die "env_to_toml: invalid key: ${key}" ;;
    esac
    line="${key} = \"$(toml_escape "${kv#*=}")\""
    case "$key" in
      DATABASE_PATH|PORT|COMPOSE_PROJECT_NAME|LXK_IMAGE_TAG|CF_TUNNEL_TOKEN) core+="${line}"$'\n' ;;
      LXK_ADMIN_EMAILS) auth+="${line}"$'\n' ;;
      LXK_ENV|LXK_PUBLIC_URL|LXK_TRUSTED_ORIGINS|LXK_TRUSTED_PROXY_CIDRS) urls+="${line}"$'\n' ;;
      GITHUB_APP_ID|GITHUB_PRIVATE_KEY|GITHUB_PRIVATE_KEY_FILE|GITHUB_WEBHOOK_SECRET) github+="${line}"$'\n' ;;
      *) other+="${line}"$'\n' ;;
    esac
  done
  [ -n "$core" ] && printf '[core]\n%s\n' "$core"
  [ -n "$auth" ] && printf '[auth]\n%s\n' "$auth"
  [ -n "$urls" ] && printf '[urls]\n%s\n' "$urls"
  [ -n "$github" ] && printf '[github]\n%s\n' "$github"
  [ -n "$other" ] && printf '[other]\n%s\n' "$other"
  return 0
}

# _env_toml_write <path> <validator> <key=value...>
# Shared merge writer. `validator` is a function name receiving a key; it must
# return non-zero to reject. Merge (never truncate): a key already in the file
# is replaced in place, new keys are appended, operator keys survive. Fresh
# files get the canonical section layout. Mode 0600, tmp written under umask 077.
_env_toml_write() {
  local path="$1" validator="$2"
  shift 2
  local kv key val tmp="${path}.tmp" dir
  for kv in "$@"; do
    key="${kv%%=*}"
    if ! "$validator" "$key"; then
      rm -f "$tmp"
      die "write_env_toml: key not allowed: ${key}"
    fi
  done
  dir="$(dirname "$path")"
  [ "$dir" = "." ] || mkdir -p "$dir"
  if [ -f "$path" ]; then
    ( umask 077; cp -f "$path" "$tmp" )
    chmod 600 "$tmp"
    for kv in "$@"; do
      key="${kv%%=*}"
      val="${kv#*=}"
      _kv_replace_line "$tmp" "$key" "${key} = \"$(toml_escape "$val")\""
    done
    mv -f "$tmp" "$path"
  else
    ( umask 077; env_to_toml "$@" > "$tmp" )
    mv -f "$tmp" "$path"
  fi
  chmod 600 "$path"
  return 0
}

# write_env_toml <path> <key=value...>
# Installer-key write path: whitelist-validated (ENV_FILE_ALLOWED_KEYS).
write_env_toml() {
  local path="$1"
  shift
  _env_toml_write "$path" _env_key_allowed "$@"
}

# write_env_toml_loader <path> <key=value...>
# Migration write path: accepts every key the loader can represent
# (^[A-Z][A-Z0-9_]*$), not just the installer whitelist, so a legacy `.env`
# carrying LXK_SECRETS_MASTER_KEY / LOG_LEVEL / TANSTACK_AI_* / storage keys survives.
write_env_toml_loader() {
  local path="$1"
  shift
  _env_toml_write "$path" _env_key_loader_valid "$@"
}

# write_env_file <path> <key=value...>
# Flat dotenv writer for compose-tooling vars. Whitelisted keys only; merge
# semantics (existing keys preserved, passed keys replaced/appended), 0600.
write_env_file() {
  local path="$1"
  shift
  local kv key val tmp="${path}.tmp" dir
  for kv in "$@"; do
    key="${kv%%=*}"
    case "$ENV_FILE_ALLOWED_KEYS" in
      *" $key "*) ;;
      *) rm -f "$tmp"; die "write_env_file: key not allowed: ${key}" ;;
    esac
  done
  dir="$(dirname "$path")"
  [ "$dir" = "." ] || mkdir -p "$dir"
  if [ -f "$path" ]; then ( umask 077; cp -f "$path" "$tmp" ); else ( umask 077; : > "$tmp" ); fi
  chmod 600 "$tmp"
  for kv in "$@"; do
    key="${kv%%=*}"
    val="${kv#*=}"
    _kv_replace_line "$tmp" "$key" "${key}=${val}"
  done
  mv -f "$tmp" "$path"
  chmod 600 "$path"
  return 0
}

# dotenv_raw_value <value> — strip flat-dotenv quoting and unescape so the value
# can be re-encoded as a TOML basic string. Mirrors parseDotenv in
# server/env-file.ts: single-pass unescape for double quotes, no escapes inside
# single quotes, inline `#` comments stripped for unquoted values.
dotenv_raw_value() {
  local v="$1"
  case "$v" in
    \"*)
      v="${v#\"}"
      _scan_basic_string "$v"
      printf '%s' "$_SCAN_TEXT"
      ;;
    \'*\')
      v="${v#\'}"
      printf '%s' "${v%%\'*}"
      ;;
    *)
      v="${v%%#*}"
      printf '%s' "${v%"${v##*[![:space:]]}"}"
      ;;
  esac
}

# env_file_value <file> <key> — first flat-dotenv value for KEY, or empty.
# Used to read back operator-pinned tooling vars (e.g. LXK_IMAGE_TAG).
env_file_value() {
  local file="$1" key="$2" line=""
  [ -f "$file" ] || return 0
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" 2>/dev/null | head -1 || true)"
  [ -n "$line" ] || return 0
  line="${line#*=}"
  line="${line#"${line%%[![:space:]]*}"}"
  dotenv_raw_value "$line"
}

# secrets_master_key_entry <path>
# `LXK_SECRETS_MASTER_KEY=<value>` for the installer write path. The file's
# existing value is kept when present (merge preserves an operator/previous key
# verbatim), otherwise a fresh 32-byte base64 key is generated. A brand-new
# install therefore always ships a key; a re-run never rotates it.
secrets_master_key_entry() {
  local path="$1" existing=""
  existing="$(env_file_value "$path" LXK_SECRETS_MASTER_KEY || true)"
  if [ -z "$existing" ]; then
    existing="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  fi
  printf 'LXK_SECRETS_MASTER_KEY=%s\n' "$existing"
}

# migrate_legacy_deploy_env <dir>
# Pre-P4 deploy dirs keep app keys in a flat `.env`. When no `.env.toml` exists
# yet, carry every live, loader-representable key into `.env.toml` and keep the
# original as `.env.legacy` (0600) so the tooling-only `.env` can be written
# after. Compose-tooling keys (ENV_FILE_TOOLING_KEYS) stay in the flat `.env`.
# Parser mirrors server/env-file.ts parseDotenv: multi-line double-quoted
# values, inline `#` comments, single-pass escapes.
migrate_legacy_deploy_env() {
  local dir="$1"
  local toml="${dir}/.env.toml" legacy="${dir}/.env" dest="${dir}/.env.legacy"
  [ -f "$legacy" ] || return 0
  [ -f "$toml" ] && return 0
  if [ -e "$dest" ]; then
    echo "  (found an existing ${dest} — leaving ${legacy} untouched)"
    return 0
  fi
  local -a lines=() app_entries=() tooling_entries=() skipped=()
  local line=""
  while IFS= read -r line || [ -n "$line" ]; do
    lines+=("$line")
  done < "$legacy"

  local total=${#lines[@]} idx=0
  local key raw body acc value unterminated
  while [ "$idx" -lt "$total" ]; do
    line="${lines[$idx]}"
    idx=$((idx + 1))
    line="${line#"${line%%[![:space:]]*}"}"
    [ -z "$line" ] && continue
    case "$line" in '#'*) continue ;; esac
    case "$line" in
      export[[:space:]]*)
        line="${line#export}"
        line="${line#"${line%%[![:space:]]*}"}"
        ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    case "$ENV_FILE_DEAD_KEYS" in *" $key "*) continue ;; esac
    raw="${line#*=}"
    raw="${raw#"${raw%%[![:space:]]*}"}"
    case "$raw" in
      '"'*)
        body="${raw#\"}"
        acc=""
        value=""
        unterminated=0
        while :; do
          _scan_basic_string "$body"
          acc+="$_SCAN_TEXT"
          if [ "$_SCAN_CLOSED" = "1" ]; then
            value="$acc"
            break
          fi
          acc+=$'\n'
          if [ "$idx" -ge "$total" ]; then
            unterminated=1
            break
          fi
          body="${lines[$idx]}"
          idx=$((idx + 1))
        done
        if [ "$unterminated" = "1" ]; then
          skipped+=("$key")
          continue
        fi
        ;;
      "'"*)
        body="${raw#\'}"
        value="${body%%\'*}"
        if [ "$body" = "$value" ]; then
          skipped+=("$key")
          continue
        fi
        ;;
      *)
        raw="${raw%%#*}"
        value="${raw%"${raw##*[![:space:]]}"}"
        ;;
    esac
    case "$ENV_FILE_TOOLING_KEYS" in
      *" $key "*)
        tooling_entries+=("${key}=${value}")
        continue
        ;;
    esac
    if ! _env_key_loader_valid "$key"; then
      skipped+=("$key")
      continue
    fi
    app_entries+=("${key}=${value}")
  done

  # No app keys: leave the flat `.env` in place — the later tooling write merges
  # into it and preserves any operator tooling keys untouched.
  if [ "${#app_entries[@]}" -eq 0 ]; then
    return 0
  fi
  write_env_toml_loader "$toml" "${app_entries[@]}"
  mv -f "$legacy" "$dest"
  chmod 600 "$dest"
  # Re-emit surviving tooling keys into a fresh flat `.env` (compose reads it).
  if [ "${#tooling_entries[@]}" -gt 0 ]; then
    write_env_file "${dir}/.env" "${tooling_entries[@]}"
  fi
  echo "  migrated ${legacy} to ${toml} (original kept at ${dest})"
  if [ "${#skipped[@]}" -gt 0 ]; then
    printf '  (skipped %d key(s) the loader cannot represent: %s)\n' "${#skipped[@]}" "${skipped[*]}" >&2
  fi
  return 0
}

# _container_ids <image> — the uid:gid the runtime image actually runs as,
# quoted from the image itself (never hardcoded: a base-image change must not
# silently make the env mount unreadable). Cached per image for the run. Falls
# back to 1000:1000 when the probe cannot run (no shell in the image, offline).
_container_ids() {
  local image="$1"
  if [ "${_GRANT_IDS_IMAGE:-}" = "$image" ] && [ -n "${_GRANT_IDS_VALUE:-}" ]; then
    printf '%s\n' "$_GRANT_IDS_VALUE"
    return 0
  fi
  local probe="" uid="" gid=""
  probe="$(docker run --rm --entrypoint sh "$image" -c 'id -u; id -g' 2>/dev/null || true)"
  uid="$(printf '%s\n' "$probe" | sed -n '1p' | tr -cd '0-9')"
  gid="$(printf '%s\n' "$probe" | sed -n '2p' | tr -cd '0-9')"
  [ -n "$uid" ] || uid=1000
  [ -n "$gid" ] || gid=1000
  _GRANT_IDS_IMAGE="$image"
  _GRANT_IDS_VALUE="${uid}:${gid}"
  printf '%s\n' "$_GRANT_IDS_VALUE"
}

# grant_container_read <path> <image>
# The runtime image runs as an unprivileged uid (Dockerfile `USER bun`); when
# the installer runs as a different uid, a 0600 host file is unreadable in the
# container and the app crash-loops. Resolve the image's own uid:gid (never a
# hardcode), then re-own the file so the container reads it:
#   - non-root installer: host-uid:<image-gid> mode 0640 — the host keeps
#     read/write, the container reads via its group. The chown round-trips
#     through a one-shot root container (works unprivileged).
#   - root installer: <image-uid>:<image-gid> mode 0640.
# Falls back to 0644 only if the chown cannot run (keeps the mount readable).
# Dry-run: logs the intent, changes nothing.
grant_container_read() {
  local path="$1" image="$2"
  if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
    printf '[dry-run] chmod 640 %s && chown %s:<image-gid> %s\n' "$path" "$(id -u)" "$path"
    return 0
  fi
  local ids uid gid
  ids="$(_container_ids "$image")"
  uid="${ids%%:*}"
  gid="${ids##*:}"
  [ -n "$uid" ] || uid=1000
  [ -n "$gid" ] || gid=1000
  local claimed=0
  if [ "$(id -u)" = "0" ]; then
    chown "${uid}:${gid}" "$path" && claimed=1
  elif docker run --rm --user 0 -v "${path}:/lexa-env.toml" "$image" \
    chown "$(id -u):${gid}" /lexa-env.toml >/dev/null 2>&1; then
    claimed=1
  fi
  if [ "$claimed" = "1" ]; then
    chmod 640 "$path" || true
    return 0
  fi
  echo "  (couldn't set owners on ${path}; made it world-readable — keep this folder private)"
  chmod 644 "$path" || true
  return 0
}

# ---------------------------------------------------------------------------
# parse_flags — whitelist-style parser; the ONLY reader of argv.
# Sets: TARGET REF NAME PORT BIND DOMAIN IMAGE_TAG
#       SYSTEMD ASSUME_YES PURGE CLEAN FROM_REPO HELP NO_PULL
# Unknown flag -> usage + die. Positional target accepted (first one only).
# ---------------------------------------------------------------------------
parse_flags() {
  # shellcheck disable=SC2034  # parse_flags outputs are the caller's contract
  TARGET="" REF="" NAME="" PORT=8080 BIND=127.0.0.1 DOMAIN=""
  IMAGE_TAG="" SYSTEMD=0 ASSUME_YES=0 PURGE=0 CLEAN=0 RESET_DB=0 NO_PULL=0
  FROM_REPO="" HELP=0 CF_TOKEN="" SECRETS_FILE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref)
        [ $# -ge 2 ] || die "--ref requires a value"
        REF=$2
        shift 2
        ;;
      --name)
        [ $# -ge 2 ] || die "--name requires a value"
        NAME=$2
        shift 2
        ;;
      --staging|--prod|--flavor)
        die "$1 was removed: flavors are gone — use --ref <tag|branch> to pick main or a release tag"
        ;;
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
        die "--key was removed: API keys are minted post-setup (login → Settings → API Keys, or lx login device flow)"
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
      --no-pull) NO_PULL=1; shift ;;
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
      --secrets-file)
        [ $# -ge 2 ] || die "--secrets-file requires a value"
        SECRETS_FILE=$2
        shift 2
        ;;
      --help|-h) HELP=1; shift ;;
      -) die "Unknown flag: - — run with --help." ;;
      -*)
        usage >&2
        die "Unknown flag: $1 — run with --help."
        ;;
      *)
        if [ -z "$TARGET" ]; then
          TARGET=$1
        else
          die "Unexpected argument '$1' — the target is already set to ${TARGET}."
        fi
        shift
        ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# resolve_deploy_name <work_dir> [explicit]
# Prints the workers deploy name: explicit --name wins; else a single
# existing deploy-*/ dir is resumed; none -> fresh default "lexa";
# several -> die (ambiguous, never guess).
# ---------------------------------------------------------------------------
resolve_deploy_name() {
  local work_dir="$1" explicit="${2:-}"
  if [ -n "$explicit" ]; then printf '%s\n' "$explicit"; return 0; fi
  local found=0 name="" d base
  for d in "${work_dir}"/deploy-*/; do
    [ -d "$d" ] || continue
    found=$((found + 1))
    base="$(basename "$d")"
    name="${base#deploy-}"
  done
  if [ "$found" -eq 1 ]; then printf '%s\n' "$name"; return 0; fi
  if [ "$found" -gt 1 ]; then
    die "multiple previous workers deploys in ${work_dir} — pass --name explicitly"
  fi
  printf 'lexa\n'
}

# ---------------------------------------------------------------------------
# compose_render <mode> <port> <bind>
# Emits docker-compose.yml into ${DEPLOY_DIR} (default: .). Modeled on the
# repo's docker-compose.yml; mode != direct adds the cloudflared tunnel
# service. Values validated before interpolation.
#
# The app reads its config from the mounted `./.env.toml` (loader applies it
# at boot); the compose `environment:` interpolation block is gone. The flat
# `.env` is compose-tooling only: COMPOSE_PROJECT_NAME (compose itself),
# LXK_IMAGE_TAG (image tag interpolation), CF_TUNNEL_TOKEN (tunnel command).
# ---------------------------------------------------------------------------
compose_render() {
  local flavor="$1"
  local port="$2"
  local bind="$3"
  local deploy_dir="${DEPLOY_DIR:-.}"
  case "$flavor" in
    direct) ;;
    *) die "compose_render: invalid mode: ${flavor}" ;;
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
  mkdir -p "$deploy_dir"
  if [ "$flavor" = "direct" ] || [ -z "${CF_TUNNEL_TOKEN:-}" ]; then
    cat > "${deploy_dir}/docker-compose.yml" <<EOF
services:
  app:
    image: ghcr.io/yohanesgre/lexa:\${LXK_IMAGE_TAG:-latest}
    ports:
      - "${bind}:${port}:3000"
    volumes:
      - lexa-data:/app/data
      - type: bind
        source: ./.env.toml
        target: /app/.env.toml
        read_only: true
        bind:
          create_host_path: false
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
    image: ghcr.io/yohanesgre/lexa:\${LXK_IMAGE_TAG:-latest}
    volumes:
      - lexa-data:/app/data
      - type: bind
        source: ./.env.toml
        target: /app/.env.toml
        read_only: true
        bind:
          create_host_path: false
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
  command -v docker >/dev/null 2>&1 || die "Docker isn't installed — install it, then re-run: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || die "Docker Compose isn't installed — add the compose plugin, then re-run: https://docs.docker.com/compose/install/"
  docker info >/dev/null 2>&1 || die 'Docker Engine isn'"'"'t running — start Docker Desktop (or `sudo systemctl start docker`), then re-run.'
}

require_bun() {
  command -v bun >/dev/null 2>&1 && return 0
  if [ -x "${HOME}/.bun/bin/bun" ]; then
    export PATH="${HOME}/.bun/bin:${PATH}"
    command -v bun >/dev/null 2>&1 && return 0
  fi
  return 1
}

# _MISSING_TOOLS — aggregate preflight: one pass, one clear list (warn-and-stop,
# never auto-install). Entries are "<tool> — <fix command>".
_MISSING_TOOLS=()
_missing_tool() {
  _MISSING_TOOLS+=("$1 — $2")
}

# preflight_common — curl, tar, bun, and a sha256 tool, ALL collected before
# dying so one run lists every missing prerequisite.
preflight_common() {
  _MISSING_TOOLS=()
  command -v curl >/dev/null 2>&1 || _missing_tool "curl" "usually built in; install your distro's curl package"
  command -v tar >/dev/null 2>&1 || _missing_tool "tar" "usually built in; install your distro's tar package"
  require_bun || _missing_tool "bun" "curl -fsSL https://bun.sh/install | bash"
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    _missing_tool "sha256sum (or shasum)" "install your distro's coreutils package"
  fi
  if [ "${#_MISSING_TOOLS[@]}" -gt 0 ]; then
    local msg="Missing prerequisites — fix these, then re-run:"
    local item
    for item in "${_MISSING_TOOLS[@]}"; do
      msg+=$'\n'"  • ${item}"
    done
    die "$msg"
  fi
}

preflight_workers() {
  preflight_common
}

preflight_bare() {
  preflight_common
  if [ "${SYSTEMD}" = "1" ]; then
    [ "$(uname -s)" = "Linux" ] || die "systemd isn't available on this OS — start with: ${INSTALL_DIR:-bare}/lexa-start.sh"
    [ "$(id -u)" = "0" ] || die "--systemd needs root — run with sudo, or start with: ${INSTALL_DIR:-bare}/lexa-start.sh"
  fi
}

# ---------------------------------------------------------------------------
# Release fetch — GitHub releases (server | workers tarballs + checksums)
# ---------------------------------------------------------------------------
LEXA_REPO="${LEXA_REPO:-yohanesgre/lexa}"

fetch_release() {
  local kind="$1" dest="$2"
  mkdir -p "${dest}"
  # --ref wins, then RELEASE_TAG (compat), then newest-release resolution
  # (owned by the install-router track — do not duplicate that logic here).
  local want="${REF:-${RELEASE_TAG:-}}"
  if [ "${want}" = "main" ]; then
    die "--ref main has no release tarballs — pass a release tag (e.g. --ref v2026.2.9)"
  fi
  local tag="${want}"
  if [ -z "${tag}" ] && [ "${INSTALL_DRY_RUN:-0}" != "1" ]; then
    # Newest web-app release from the list — NOT `releases/latest`, which can
    # point at a CLI release (`cli-v*`) published after the newest app tag.
    # The `v[0-9]` anchor never matches `cli-v...`.
    tag=$(curl -fsSL "https://api.github.com/repos/${LEXA_REPO}/releases?per_page=30" \
      | grep -o '"tag_name": *"v[0-9][^"]*"' | head -1 | sed 's/.*"tag_name": *"//;s/"//')
    [ -n "${tag}" ] || die "could not resolve latest release of ${LEXA_REPO} (rate limit? pass RELEASE_TAG=vX.Y.Z)"
  fi
  [ -n "${tag}" ] || tag="dry-run"
  local tarball="lexa-${kind}-${tag}.tar.gz"
  step "fetch release" mutate curl -fsSL "https://github.com/${LEXA_REPO}/releases/download/${tag}/${tarball}" -o "${dest}/${tarball}"
  if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
    return 0
  fi
  if curl -fsSL "https://github.com/${LEXA_REPO}/releases/download/${tag}/checksums.txt" -o "${dest}/checksums.txt" 2>/dev/null; then
    local want_sha=""
    want_sha=$(grep "${tarball}" "${dest}/checksums.txt" | awk '{print $1}')
    [ -n "$want_sha" ] && step "verify checksum" verify_checksum "${dest}/${tarball}" "${want_sha}"
  else
    echo "  (no checksums.txt for ${tag} — download NOT verified; prefer a release tag)"
  fi
}

# unpack_release <fetch_dir> <install_dir> server|workers
# Multiple fetches of different tags can pile up in the fetch dir; extract
# the newest tarball, never treat a second match as a member name.
unpack_release() {
  local fetch_dir="$1" install_dir="$2" kind="$3"
  mkdir -p "${install_dir}"
  if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
    printf '[dry-run] tar xzf %s/lexa-%s-*.tar.gz -C %s\n' "$fetch_dir" "$kind" "$install_dir"
    return 0
  fi
  local tarball=""
  tarball="$(ls -t "${fetch_dir}"/lexa-"${kind}"-*.tar.gz 2>/dev/null | head -1 || true)"
  [ -n "${tarball}" ] || die "no lexa-${kind}-*.tar.gz found in ${fetch_dir}"
  step "unpack release" tar xzf "${tarball}" -C "${install_dir}"
}

# ---------------------------------------------------------------------------
# bare helpers — start script + systemd unit
# ---------------------------------------------------------------------------
write_start_script() {
  local dir="$1"
  cat > "${dir}/lexa-start.sh" <<START
#!/usr/bin/env bash
cd "${dir}"
exec bun server/entry.ts
START
  chmod +x "${dir}/lexa-start.sh"
  return 0
}

install_systemd_unit() {
  local dir="$1"
  [ "$(uname -s)" = "Linux" ] || die "systemd isn't available on this OS — start with: ${dir}/lexa-start.sh"
  [ "$(id -u)" = "0" ] || die "--systemd needs root — run with sudo, or start with: ${dir}/lexa-start.sh"
  cat > /etc/systemd/system/lexa.service <<UNIT
[Unit]
Description=Lexa server
After=network.target

[Service]
User=bun
WorkingDirectory=${dir}
ExecStart=$(command -v bun) server/entry.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  mutate systemctl daemon-reload
  mutate systemctl enable --now lexa
}

# ---------------------------------------------------------------------------
# bare helpers — manual start
# ---------------------------------------------------------------------------
# bare_start_manual <dir> — nohup the start script from inside the install dir
# and record its pid. A re-run with a live pid is a no-op (never double-start);
# a stale pid file is replaced.
bare_start_manual() {
  local dir="$1"
  if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
    printf '[dry-run] (cd %s && nohup ./lexa-start.sh > lexa.log 2>&1 & echo $! > lexa.pid)\n' "$dir"
    return 0
  fi
  local pidfile="${dir}/lexa.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  # `exec` replaces the backgrounded subshell with the server itself, so `$!`
  # is the server's pid (not a bash wrapper). The pid file is written with an
  # explicit path — `cd` happens inside the backgrounded list only, so a bare
  # `lexa.pid` would land in the caller's CWD.
  ( cd "$dir" && exec nohup ./lexa-start.sh > lexa.log 2>&1 ) & echo $! > "${dir}/lexa.pid"
  return 0
}

# ---------------------------------------------------------------------------
# final_banner <url>
# Per-target summary: URL, /setup, CLI keys, and the secrets state. Callers set
# BANNER_MASTER (e.g. `master key ✓ (dockers/.env.toml)`) and BANNER_GITHUB.
# An empty url means the address was not recorded (workers without a captured
# .deployed-url) — the banner points at the dashboard instead of inventing one.
# ---------------------------------------------------------------------------
final_banner() {
  local url="$1"
  local master="${BANNER_MASTER:-}"
  local github="${BANNER_GITHUB:-GitHub sync not configured — add later with --secrets-file}"
  echo ""
  echo "═══════════════════════════════════════════════"
  if [ -n "$url" ]; then
    echo "  Lexa is running at ${url}"
  else
    echo "  Lexa is deployed to Cloudflare."
    echo "  Find its address in the Cloudflare dashboard under Workers & Pages."
  fi
  echo ""
  echo "  Next: set up the first admin (superadmin)"
  if [ -n "$url" ]; then
    echo "        open ${url}/setup"
  else
    echo "        open <your worker URL>/setup"
  fi
  echo "        email + password (8+ characters)"
  echo ""
  echo "  Later: create CLI API keys in Settings → API Keys"
  echo "         (or run \`lx login\`)"
  echo ""
  if [ -n "$master" ]; then
    echo "  Secrets: ${master}"
    echo "           ${github}"
  else
    echo "  Secrets: ${github}"
  fi
  echo "═══════════════════════════════════════════════"
}

# set_banner_github [env_file] — GitHub nudge line from GITHUB_TRIO_OK, falling
# back to the persisted trio in the target env file on a re-run.
set_banner_github() {
  local file="${1:-}"
  if [ "${GITHUB_TRIO_OK:-0}" = "1" ]; then
    BANNER_GITHUB="GitHub sync configured"
    return 0
  fi
  if [ -n "$file" ] && _env_file_has_github_trio "$file"; then
    BANNER_GITHUB="GitHub sync configured"
  else
    BANNER_GITHUB="GitHub sync not configured — add later with --secrets-file"
  fi
}

# _env_file_has_github_trio <file> — a complete, persisted GitHub trio in an
# env file (TOML or flat). Empty values count as absent. Lets a re-run banner
# report the real state even when this run didn't re-supply the secrets.
_env_file_has_github_trio() {
  local file="$1" id="" wh="" pk=""
  [ -f "$file" ] || return 1
  id="$(env_file_value "$file" GITHUB_APP_ID)"
  wh="$(env_file_value "$file" GITHUB_WEBHOOK_SECRET)"
  pk="$(env_file_value "$file" GITHUB_PRIVATE_KEY)"
  [ -n "$pk" ] || pk="$(env_file_value "$file" GITHUB_PRIVATE_KEY_FILE)"
  [ -n "$id" ] && [ -n "$wh" ] && [ -n "$pk" ]
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
    die "No terminal available — pass the value as a flag instead (${prompt})."
  fi
  printf '%s\n' "$prompt" 2>/dev/null > /dev/tty || die "No terminal available — pass the value as a flag instead (${prompt})."
  local reply=""
  # shellcheck disable=SC2069
  IFS= read -rs reply 2>/dev/null < /dev/tty || die "No terminal available — pass the value as a flag instead (${prompt})."
  printf '\n' > /dev/tty
  printf '%s\n' "$reply"
}

# ---------------------------------------------------------------------------
# Cloudflare credentials + secrets
# ---------------------------------------------------------------------------

# _cf_token_from_wrangler — read the OAuth token wrangler login stored, so a
# logged-in operator needs no CF token. Silent; prints nothing on absence.
_cf_token_from_wrangler() {
  local cfg="${HOME}/.config/.wrangler/config/default.toml"
  [ -f "$cfg" ] || return 1
  local tok
  tok="$(grep -E '^[[:space:]]*oauth_token[[:space:]]*=' "$cfg" | head -1 | sed -E 's/^[^=]*=[[:space:]]*"//; s/"[[:space:]]*$//')"
  [ -n "$tok" ] || return 1
  printf '%s\n' "$tok"
}

# wrangler_secret_put <workdir> <name> <raw-value-file>
# The value travels on stdin from a 0600 file — never argv, never stdout. Runs
# from the workdir with the deploy's wrangler config so the account resolves
# from the deploy, not from whatever `wrangler` infers elsewhere.
wrangler_secret_put() {
  local workdir="$1" name="$2" src="$3"
  local cfg="deploy-${FLAVOR_NAME:-lexa}/wrangler.${FLAVOR_NAME:-lexa}.json"
  if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
    printf '[dry-run] bun x wrangler secret put %s --name %s --config %s < (stdin)\n' "$name" "${FLAVOR_NAME:-lexa}" "$cfg"
    return 0
  fi
  ( cd "$workdir" && bun x wrangler secret put "$name" --name "${FLAVOR_NAME:-lexa}" --config "$cfg" < "$src" )
}

# workers_secret_present <workdir> <name> — three-way remote check:
#   present  the remote worker already carries the secret (never rotate)
#   absent   no such secret — safe to mint
#   unknown  the check could not run (wrangler error, or an existing deploy
#            whose config is unreadable) — never mint on unknown
# The `secret list` read is read-only, so it also runs under dry-run (same
# precedent as workers_prune_legacy_secret) — a resumed deploy's real state is
# reported instead of a hardcoded `absent`.
workers_secret_present() {
  local workdir="$1" name="$2"
  local cfg="deploy-${FLAVOR_NAME:-lexa}/wrangler.${FLAVOR_NAME:-lexa}.json"
  if [ ! -r "${workdir}/${cfg}" ]; then
    # No config: a first deploy (nothing remote to preserve) reads absent; a
    # resumed deploy without its config is unknowable.
    if [ -d "${workdir}/deploy-${FLAVOR_NAME:-lexa}" ]; then
      printf 'unknown\n'
    else
      printf 'absent\n'
    fi
    return 0
  fi
  local out="" rc=0
  out="$(cd "$workdir" && bun x wrangler secret list --config "$cfg" 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'unknown\n'
    return 0
  fi
  if printf '%s' "$out" | grep -q "\"${name}\""; then
    printf 'present\n'
  else
    printf 'absent\n'
  fi
}

# workers_resolve_master_key <workdir> — resolve the envelope master key and
# set the global _WORKERS_MASTER_KEY. Preserve order: local custody
# (cf-workers/.env.toml, 0600) → remote presence → mint. Never rotate; never
# mint when the remote state can't be read (better to leave it than to rotate).
# Dry-run is pure: it prints the mint plan and a placeholder, never mints or
# writes. workers_secret_present is the override seam (tests shadow it).
workers_resolve_master_key() {
  local workdir="$1"
  _WORKERS_MASTER_KEY="$(env_file_value "${workdir}/.env.toml" LXK_SECRETS_MASTER_KEY || true)"
  if [ -z "${_WORKERS_MASTER_KEY}" ]; then
    case "$(workers_secret_present "${workdir}" "LXK_SECRETS_MASTER_KEY")" in
      present)
        : # already on the remote worker — leave it, do not mint or overwrite
        ;;
      absent)
        if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
          printf '[dry-run] mint LXK_SECRETS_MASTER_KEY → %s\n' "${workdir}/.env.toml"
          _WORKERS_MASTER_KEY="dry-run-placeholder"
        else
          _WORKERS_MASTER_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
          write_env_toml "${workdir}/.env.toml" "LXK_SECRETS_MASTER_KEY=${_WORKERS_MASTER_KEY}"
        fi
        ;;
      *)
        echo "  (couldn't read the master key on the worker — leaving it untouched; re-run to retry)"
        ;;
    esac
  fi
}

# workers_prune_legacy_secret <workdir> — one-time cleanup of the dead
# LXK_API_KEY Worker secret. It is no longer provisioned or read, but survives
# on pre-change installs; after a successful deploy the leftover is deleted.
# The list is read-only (also under dry-run, so the planned prune is visible);
# the delete is a mutation, so dry-run logs it instead. Any failure warns and
# continues — the install must never fail on this cleanup — and only
# LXK_API_KEY is ever named.
workers_prune_legacy_secret() {
  local workdir="$1"
  local name="${FLAVOR_NAME:-lexa}"
  local cfg="deploy-${name}/wrangler.${name}.json"
  [ -r "${workdir}/${cfg}" ] || return 0
  local out="" rc=0
  out="$(cd "$workdir" && bun x wrangler secret list --name "$name" --config "$cfg" --format json 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "  (couldn't read the worker's secrets — skipping the LXK_API_KEY cleanup)"
    return 0
  fi
  printf '%s' "$out" | grep -q '"LXK_API_KEY"' || return 0
  if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
    printf '[dry-run] bun x wrangler secret delete LXK_API_KEY --name %s --config %s\n' "$name" "$cfg"
    return 0
  fi
  if ( cd "$workdir" && bun x wrangler secret delete LXK_API_KEY --name "$name" --config "$cfg" >/dev/null 2>&1 ); then
    echo "  (removed LXK_API_KEY — it is no longer read)"
  else
    echo "  (couldn't remove the dead LXK_API_KEY secret — delete it later with: bun x wrangler secret delete LXK_API_KEY --name ${name} --config ${cfg})"
  fi
  return 0
}

# _tty_available — true only when /dev/tty can actually be OPENED. `test -r
# /dev/tty` is true even without a controlling terminal (the permission bits
# pass; open then fails with ENXIO), so prompt guards must probe the open.
_tty_available() {
  { : > /dev/tty; } 2>/dev/null
}

# SECRET_ENTRIES — "KEY=value" pairs collected from --secrets-file or the
# interactive wizard; applied per target (docker/bare: merged into .env.toml;
# workers: pushed as Worker secrets + written to custody).
SECRET_ENTRIES=()
GITHUB_TRIO_OK=0

# secrets_load_file <path> — KEY=value lines, each key validated against
# ENV_FILE_ALLOWED_KEYS. Values are dotenv-decoded (quotes / `\n` escapes).
secrets_load_file() {
  local path="$1" line key val n=0
  [ -f "$path" ] || die "Secrets file not found: ${path} — pass an existing file, then re-run."
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line#"${line%%[![:space:]]*}"}"
    [ -z "$line" ] && continue
    case "$line" in '#'*) continue ;; esac
    case "$line" in
      export[[:space:]]*)
        line="${line#export}"
        line="${line#"${line%%[![:space:]]*}"}"
        ;;
    esac
    case "$line" in
      *=*) ;;
      *) die "Secrets file: line ${n} isn't a KEY=value pair — fix it to KEY=value, then re-run." ;;
    esac
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    _env_key_allowed "$key" || die "Secrets file: key ${key} not allowed — use the installer whitelist keys (see docs/DEPLOYMENT.md), then re-run."
    val="${line#*=}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="$(dotenv_raw_value "$val")"
    SECRET_ENTRIES+=("${key}=${val}")
  done < "$path"
}

# secrets_wizard <target> — interactive optional-secrets entry. Fail-closed:
# the GitHub trio is only recorded when all three values are present/readable.
secrets_wizard() {
  local target="$1" answer app_id webhook pk_path pk
  answer=$(tty_read "Set up optional secrets now (GitHub sync)? [y/N]" "n")
  case "$answer" in
    [Yy]*) ;;
    *) return 0 ;;
  esac
  app_id=$(tty_read "GitHub App ID:" "")
  webhook=$(tty_read_secret "GitHub webhook secret:")
  pk_path=$(tty_read "Private key — paste the path to your .pem file:" "")
  if [ -z "$app_id" ] || [ -z "$webhook" ] || [ -z "$pk_path" ] || [ ! -r "$pk_path" ]; then
    echo "  GitHub sync needs all three values — skipping it. Add them later with --secrets-file."
    return 0
  fi
  if [ "$target" = "bare" ]; then
    SECRET_ENTRIES+=("GITHUB_APP_ID=${app_id}" "GITHUB_WEBHOOK_SECRET=${webhook}" "GITHUB_PRIVATE_KEY_FILE=${pk_path}")
  else
    pk="$(cat "$pk_path")"
    SECRET_ENTRIES+=("GITHUB_APP_ID=${app_id}" "GITHUB_WEBHOOK_SECRET=${webhook}" "GITHUB_PRIVATE_KEY=${pk}")
  fi
}

# secrets_normalize_for_target <target> — docker/workers have no filesystem
# (Workers) or take the key inline (docker): a GITHUB_PRIVATE_KEY_FILE entry is
# read and rewritten as inline GITHUB_PRIVATE_KEY. An unreadable path drops the
# entry so the trio check fails closed. Bare may keep the path.
secrets_normalize_for_target() {
  local target="$1" need_inline=0 kv k pk="" have_pk_file=0
  [ "${#SECRET_ENTRIES[@]}" -eq 0 ] && return 0
  if [ "$target" = "docker" ] || [ "$target" = "workers" ]; then
    need_inline=1
  fi
  [ "$need_inline" = "1" ] || return 0
  for kv in "${SECRET_ENTRIES[@]}"; do
    k="${kv%%=*}"
    if [ "$k" = "GITHUB_PRIVATE_KEY_FILE" ]; then
      have_pk_file=1
      pk="${kv#*=}"
    fi
  done
  [ "$have_pk_file" = "1" ] || return 0
  local out=()
  if [ ! -r "$pk" ]; then
    for kv in "${SECRET_ENTRIES[@]}"; do
      k="${kv%%=*}"
      [ "$k" = "GITHUB_PRIVATE_KEY_FILE" ] && continue
      out+=("$kv")
    done
    SECRET_ENTRIES=(${out[@]+"${out[@]}"})
    return 0
  fi
  local content
  content="$(cat "$pk")"
  for kv in "${SECRET_ENTRIES[@]}"; do
    k="${kv%%=*}"
    [ "$k" = "GITHUB_PRIVATE_KEY_FILE" ] && continue
    out+=("$kv")
  done
  out+=("GITHUB_PRIVATE_KEY=${content}")
  SECRET_ENTRIES=(${out[@]+"${out[@]}"})
}

# secrets_check_trio — GitHub sync needs all three values. None → nothing to do;
# all three → ok; partial → drop the whole trio with a warning (never write a
# partial trio). An empty value counts as absent, and a GITHUB_PRIVATE_KEY_FILE
# must be readable — the path is useless if the file isn't there.
secrets_check_trio() {
  GITHUB_TRIO_OK=0
  local have_id=0 have_wh=0 have_pk=0 kv k v
  for kv in ${SECRET_ENTRIES[@]+"${SECRET_ENTRIES[@]}"}; do
    k="${kv%%=*}"
    v="${kv#*=}"
    case "$k" in
      GITHUB_APP_ID)
        if [ -n "$v" ]; then have_id=1; fi
        ;;
      GITHUB_WEBHOOK_SECRET)
        if [ -n "$v" ]; then have_wh=1; fi
        ;;
      GITHUB_PRIVATE_KEY)
        if [ -n "$v" ]; then have_pk=1; fi
        ;;
      GITHUB_PRIVATE_KEY_FILE)
        if [ -n "$v" ] && [ -r "$v" ]; then have_pk=1; fi
        ;;
    esac
  done
  [ $((have_id + have_wh + have_pk)) -eq 0 ] && return 0
  if [ "$have_id" = "1" ] && [ "$have_wh" = "1" ] && [ "$have_pk" = "1" ]; then
    GITHUB_TRIO_OK=1
    return 0
  fi
  local out=()
  for kv in "${SECRET_ENTRIES[@]}"; do
    k="${kv%%=*}"
    case "$k" in
      GITHUB_APP_ID|GITHUB_WEBHOOK_SECRET|GITHUB_PRIVATE_KEY|GITHUB_PRIVATE_KEY_FILE) continue ;;
    esac
    out+=("$kv")
  done
  SECRET_ENTRIES=(${out[@]+"${out[@]}"})
  echo "  GitHub sync needs all three values — skipping it. Add them later with --secrets-file."
}

# collect_optional_secrets <target> — populate SECRET_ENTRIES from
# --secrets-file, else the TTY wizard (skipped with --yes / no terminal), then
# normalize + fail-closed trio check.
collect_optional_secrets() {
  local target="$1"
  SECRET_ENTRIES=()
  GITHUB_TRIO_OK=0
  if [ -n "${SECRETS_FILE:-}" ]; then
    secrets_load_file "${SECRETS_FILE}"
  elif [ "${ASSUME_YES:-0}" != "1" ] && _tty_available; then
    secrets_wizard "${target}"
  fi
  secrets_normalize_for_target "${target}"
  secrets_check_trio
}

# apply_secrets_to_env <path> — merge collected entries with no value in argv.
apply_secrets_to_env() {
  local path="$1"
  [ "${#SECRET_ENTRIES[@]}" -gt 0 ] || return 0
  write_env_toml "$path" "${SECRET_ENTRIES[@]}"
}

# workers_apply_secrets <workdir> — push the master key (from _WORKERS_MASTER_KEY,
# set by deploy_workers) and any collected GitHub secrets via wrangler, and write
# them to custody. Values travel on stdin from 0600 temp files.
workers_apply_secrets() {
  local workdir="$1" kv k vf
  if [ -n "${_WORKERS_MASTER_KEY:-}" ]; then
    vf="$(mktemp)"
    chmod 600 "$vf"
    printf '%s' "${_WORKERS_MASTER_KEY}" > "$vf"
    step "apply secrets" wrangler_secret_put "$workdir" LXK_SECRETS_MASTER_KEY "$vf"
    rm -f "$vf"
  fi
  for kv in ${SECRET_ENTRIES[@]+"${SECRET_ENTRIES[@]}"}; do
    k="${kv%%=*}"
    case "$k" in
      GITHUB_APP_ID|GITHUB_WEBHOOK_SECRET|GITHUB_PRIVATE_KEY) ;;
      *) continue ;;
    esac
    vf="$(mktemp)"
    chmod 600 "$vf"
    printf '%s' "${kv#*=}" > "$vf"
    step "apply secrets" wrangler_secret_put "$workdir" "$k" "$vf"
    rm -f "$vf"
  done
  if [ "${#SECRET_ENTRIES[@]}" -gt 0 ]; then
    write_env_toml "${workdir}/.env.toml" "${SECRET_ENTRIES[@]}"
  fi
}
