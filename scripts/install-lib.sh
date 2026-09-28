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

Targets: docker | bare | workers | dev

Flags:
  --ref <tag|branch>             script + artifact source (default: newest v* tag;
                               resolved by the install-router track)
  --name <name>                  workers deploy name (default lexa)
  --port <n>                       host port (docker, default 8080)
  --bind <addr>                    bind address (default 127.0.0.1)
  --domain <d>                     custom domain (workers; skips prompt)
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
# env-file writers
#
# Keys the installer may write (whitelist, never free-form). The app keys are
# written to `.env.toml`; the compose-tooling keys to the flat `.env` that
# compose itself interpolates.
# Keys the app no longer reads — migration drops them, never carries them.
# ---------------------------------------------------------------------------
ENV_FILE_ALLOWED_KEYS=" LXK_ENV LXK_PUBLIC_URL LXK_TRUSTED_ORIGINS LXK_TRUSTED_PROXY_CIDRS LXK_ADMIN_EMAILS DATABASE_PATH PORT GITHUB_APP_ID GITHUB_PRIVATE_KEY GITHUB_PRIVATE_KEY_FILE GITHUB_WEBHOOK_SECRET COMPOSE_PROJECT_NAME LXK_IMAGE_TAG CF_TUNNEL_TOKEN "
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
# carrying LXK_MCP_MASTER_KEY / LOG_LEVEL / TYPESAFE_* / storage keys survives.
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
    echo "  (${dest} exists — leaving ${legacy} in place)"
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
  echo "  migrated ${legacy} → ${toml} (legacy kept at ${dest})"
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
  echo "  (could not re-own ${path} for uid ${uid}:${gid} — making it world-readable; keep the deploy dir private)"
  chmod 644 "$path" || true
  return 0
}

# ---------------------------------------------------------------------------
# parse_flags — whitelist-style parser; the ONLY reader of argv.
# Sets: TARGET REF NAME PORT BIND DOMAIN IMAGE_TAG
#       SYSTEMD ASSUME_YES PURGE CLEAN FROM_REPO HELP
# Unknown flag -> usage + die. Positional target accepted (first one only).
# ---------------------------------------------------------------------------
parse_flags() {
  # shellcheck disable=SC2034  # parse_flags outputs are the caller's contract
  TARGET="" REF="" NAME="" PORT=8080 BIND=127.0.0.1 DOMAIN=""
  IMAGE_TAG="" SYSTEMD=0 ASSUME_YES=0 PURGE=0 CLEAN=0 RESET_DB=0
  FROM_REPO="" HELP=0 CF_TOKEN=""
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
  # --ref wins, then RELEASE_TAG (compat), then newest-release resolution
  # (owned by the install-router track — do not duplicate that logic here).
  local want="${REF:-${RELEASE_TAG:-}}"
  if [ "${want}" = "main" ]; then
    die "--ref main has no release tarballs — pass a release tag (e.g. --ref v2026.2.9) or use the dev target for a main checkout"
  fi
  local tag
  if [ -n "${want}" ] && [ "${want}" != "latest" ]; then
    tag="${want}"
  else
    # Newest web-app release from the list — NOT `releases/latest`, which can
    # point at a CLI release (`cli-v*`) published after the newest app tag.
    # The `v[0-9]` anchor never matches `cli-v...`.
    tag=$(curl -fsSL "https://api.github.com/repos/${LEXA_REPO}/releases?per_page=30" \
      | grep -o '"tag_name": *"v[0-9][^"]*"' | head -1 | sed 's/.*"tag_name": *"//;s/"//')
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
exec bun server/entry.ts
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
# final_banner <url>
# ---------------------------------------------------------------------------
final_banner() {
  local url="$1"
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  Lexa — running at ${url}"
  echo ""
  echo "  NEXT → create the first admin (superadmin):"
  echo "         open ${url}/setup"
  echo "         (email + password, min 8 chars)"
  echo ""
  echo "  API keys (CLI) are minted post-setup:"
  echo "         login → Settings → API Keys (or lx login)"
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
