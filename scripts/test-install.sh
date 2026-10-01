#!/usr/bin/env bash
# Tests for scripts/install.sh / install-lib.sh / uninstall.sh.
# No framework: assert helpers + PASS/FAIL counters, non-zero exit on any FAIL.
# Dry-run test uses a fake `docker` shim on PATH to prove no mutating docker
# call executes under INSTALL_DRY_RUN=1 (design-deploy-tooling.md §9 test-swap).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${SCRIPT_DIR}/install-lib.sh"
INSTALL="${SCRIPT_DIR}/install.sh"
UNINSTALL="${SCRIPT_DIR}/uninstall.sh"

PASS=0
FAIL=0

assert_eq() {
  local desc="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    printf 'PASS: %s\n' "$desc"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s (want=%q got=%q)\n' "$desc" "$want" "$got"
    FAIL=$((FAIL + 1))
  fi
}

assert_rc() {
  assert_eq "$1 (rc)" "$2" "$3"
}

assert_grep() {
  local desc="$1" pattern="$2" text="$3"
  if printf '%s' "$text" | grep -qE "$pattern"; then
    printf 'PASS: %s\n' "$desc"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s (pattern %q not found)\n' "$desc" "$pattern"
    FAIL=$((FAIL + 1))
  fi
}

# lib_eval '<snippet>' — source the lib in a subshell (set -euo pipefail,
# matching the callers) and eval the snippet; die() exits the subshell with 1.
lib_eval() {
  bash -c '
    set -euo pipefail
    source "$1"
    shift
    eval "$*"
  ' _ "$LIB" "$@"
}

# lib_call <fn> [args...] — source the lib and invoke a function with the exact
# argv (no eval); stdout/rc captured by the caller.
lib_call() {
  bash -c 'set -euo pipefail; source "$1"; shift; "$@"' _ "$LIB" "$@"
}

# workers_resolve <stub-status> <dir> — source the lib, shadow the
# workers_secret_present override seam with a stub returning <stub-status>, then
# run workers_resolve_master_key <dir>; the resolved key is echoed as the final
# `MASTER=<value>` line (empty when unset). This exercises the real mint path.
workers_resolve() {
  local status="$1" dir="$2"
  bash -c '
    set -euo pipefail
    source "$1"
    status="$2"
    workers_secret_present() { printf "%s\n" "$status"; }
    workers_resolve_master_key "$3"
    printf "MASTER=%s\n" "${_WORKERS_MASTER_KEY:-}"
  ' _ "$LIB" "$status" "$dir"
}

echo "== syntax + lint =="

for f in "$INSTALL" "$LIB" "$UNINSTALL"; do
  rc=0
  bash -n "$f" 2>/dev/null || rc=$?
  assert_rc "bash -n $(basename "$f")" 0 "$rc"
done

if command -v shellcheck >/dev/null 2>&1; then
  for f in "$INSTALL" "$LIB" "$UNINSTALL" "${SCRIPT_DIR}/test-install.sh"; do
    rc=0
    shellcheck -S warning "$f" 2>/dev/null || rc=$?
    assert_rc "shellcheck $(basename "$f")" 0 "$rc"
  done
else
  echo "SKIP: shellcheck not installed (CI runner has it)"
fi

echo "== workers-install selector (bun unit) =="

if command -v bun >/dev/null 2>&1; then
  sel_rc=0
  sel_out="$(bun test "${SCRIPT_DIR}/workers-install.test.ts" 2>&1)" || sel_rc=$?
  assert_rc "workers-install unit tests pass (exact/sole/ambiguous/none)" 0 "$sel_rc"
  assert_grep "workers-install unit tests actually ran" '[0-9]+ pass' "$sel_out"
else
  echo "SKIP: bun unavailable — workers-install selector unit tests need the runtime"
fi

echo "== parse_flags =="

got="$(lib_eval 'parse_flags --ref v2026.2.9 --name lexa --port 9999; printf "%s:%s:%s" "$REF" "$NAME" "$PORT"')"
assert_eq "parse_flags --ref --name --port sets REF:NAME:PORT" "v2026.2.9:lexa:9999" "$got"

rc=0
lib_eval 'parse_flags --staging' >/dev/null 2>&1 || rc=$?
assert_rc "parse_flags --staging dies (flavors removed)" 1 "$rc"

echo "== resolve_deploy_name =="

got="$(lib_eval 'resolve_deploy_name /nonexistent myname')"
assert_eq "explicit --name wins" "myname" "$got"

namedir="$(mktemp -d)"
got="$(lib_eval "resolve_deploy_name '${namedir}' ''")"
assert_eq "no deploy dir defaults to lexa" "lexa" "$got"
mkdir -p "${namedir}/deploy-foo"
got="$(lib_eval "resolve_deploy_name '${namedir}' ''")"
assert_eq "single deploy dir resumes" "foo" "$got"
got="$(lib_eval "resolve_deploy_name '${namedir}' 'bar'")"
assert_eq "explicit beats resume" "bar" "$got"
mkdir -p "${namedir}/deploy-bar"
rc=0
lib_eval "resolve_deploy_name '${namedir}' ''" >/dev/null 2>&1 || rc=$?
assert_rc "several deploy dirs die" 1 "$rc"
rm -rf "${namedir}"

rc=0
lib_eval 'parse_flags --bogus' >/dev/null 2>&1 || rc=$?
assert_rc "parse_flags --bogus dies" 1 "$rc"

echo "== verify_checksum =="

tmp="$(mktemp -d)"
printf 'lexa-checksum-body\n' > "${tmp}/blob"
good="$(sha256sum "${tmp}/blob" | awk '{print $1}')"

rc=0
lib_eval "verify_checksum '${tmp}/blob' '${good}'" >/dev/null 2>&1 || rc=$?
assert_rc "verify_checksum match" 0 "$rc"

rc=0
lib_eval "verify_checksum '${tmp}/blob' 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'" >/dev/null 2>&1 || rc=$?
assert_rc "verify_checksum mismatch dies" 1 "$rc"

echo "== env_to_toml / toml_escape =="

got="$(lib_call toml_escape 'a"b')"
assert_eq "toml_escape quotes" 'a\"b' "$got"
got="$(lib_call toml_escape 'a\b')"
assert_eq "toml_escape backslash" 'a\\b' "$got"
got="$(lib_call toml_escape $'a\nb')"
assert_eq "toml_escape newline" 'a\nb' "$got"
got="$(lib_call toml_escape $'a\tb')"
assert_eq "toml_escape tab" 'a\tb' "$got"
got="$(lib_call toml_escape $'a\x01b')"
assert_eq "toml_escape control char (<0x20)" 'a\u0001b' "$got"
got="$(lib_call toml_escape $'a\x1fb')"
assert_eq "toml_escape 0x1f" 'a\u001fb' "$got"

toml_out="$(lib_call env_to_toml 'GITHUB_APP_ID=123' 'LXK_ENV=production' 'DATABASE_PATH=/app/data/lexa.db')"
assert_grep "env_to_toml github section" '^\[github\]$' "$toml_out"
assert_grep "env_to_toml string value" '^GITHUB_APP_ID = "123"$' "$toml_out"
assert_grep "env_to_toml urls section" '^\[urls\]$' "$toml_out"
assert_grep "env_to_toml core section" '^\[core\]$' "$toml_out"

got="$(lib_call env_to_toml 'GITHUB_WEBHOOK_SECRET=a b#c')"
assert_grep "env_to_toml quotes spaces and #" '^GITHUB_WEBHOOK_SECRET = "a b#c"$' "$got"

pem="$(lib_call env_to_toml "$(printf 'GITHUB_PRIVATE_KEY=%s' $'-----BEGIN KEY-----\nMIIB\n-----END KEY-----')")"
assert_grep "env_to_toml multiline PEM escapes newlines" 'GITHUB_PRIVATE_KEY = "-----BEGIN KEY-----\\nMIIB\\n-----END KEY-----"' "$pem"

rc=0
lib_call env_to_toml 'bad key=1' >/dev/null 2>&1 || rc=$?
assert_rc "env_to_toml invalid key dies" 1 "$rc"

echo "== write_env_toml =="

tomldir="$(mktemp -d)"
lib_call write_env_toml "${tomldir}/.env.toml" 'LXK_ENV=staging' 'GITHUB_APP_ID=111' >/dev/null 2>&1
assert_eq "write_env_toml mode 0600" "600" "$(stat -c %a "${tomldir}/.env.toml")"
assert_grep "write_env_toml content" '^LXK_ENV = "staging"$' "$(cat "${tomldir}/.env.toml")"

lib_call write_env_toml "${tomldir}/.env.toml" 'LXK_ENV=production' >/dev/null 2>&1
toml_merged="$(cat "${tomldir}/.env.toml")"
assert_grep "write_env_toml updates passed key" '^LXK_ENV = "production"$' "$toml_merged"
assert_grep "write_env_toml preserves operator-added key" '^GITHUB_APP_ID = "111"$' "$toml_merged"
assert_eq "write_env_toml no duplicate LXK_ENV" "1" "$(grep -c 'LXK_ENV' "${tomldir}/.env.toml")"

rogue_toml_rc=0
lib_call write_env_toml "${tomldir}/rogue.toml" 'ROGUE_KEY=1' >/dev/null 2>&1 || rogue_toml_rc=$?
assert_rc "write_env_toml rogue key dies" 1 "$rogue_toml_rc"
assert_eq "write_env_toml rogue writes no file" "absent" "$([ -e "${tomldir}/rogue.toml" ] && echo present || echo absent)"

# NIT: appending must not glue onto a file with no trailing newline.
printf 'LXK_ENV = "staging"' > "${tomldir}/noeol.toml"
lib_call write_env_toml "${tomldir}/noeol.toml" 'PORT=3000' >/dev/null 2>&1
assert_grep "write_env_toml appends after missing trailing newline" '^PORT = "3000"$' "$(cat "${tomldir}/noeol.toml")"
assert_eq "write_env_toml did not glue lines" "2" "$(wc -l < "${tomldir}/noeol.toml")"

echo "== secrets_master_key_entry =="

secretsdir="$(mktemp -d)"
secrets_entry="$(lib_call secrets_master_key_entry "${secretsdir}/.env.toml")"
assert_grep "secrets key entry names LXK_SECRETS_MASTER_KEY" '^LXK_SECRETS_MASTER_KEY=' "$secrets_entry"
secrets_val="${secrets_entry#LXK_SECRETS_MASTER_KEY=}"
assert_eq "generated secrets key decodes to 32 bytes" "32" "$(printf '%s' "$secrets_val" | base64 -d 2>/dev/null | wc -c | tr -d ' ')"

# Write it, then a second call must return the SAME value (merge/re-run preserves).
lib_call write_env_toml "${secretsdir}/.env.toml" "$secrets_entry" >/dev/null 2>&1
secrets_again="$(lib_call secrets_master_key_entry "${secretsdir}/.env.toml")"
assert_eq "secrets key preserved on re-run" "$secrets_entry" "$secrets_again"
assert_grep "written secrets key lands in .env.toml" '^LXK_SECRETS_MASTER_KEY = ".*"$' "$(cat "${secretsdir}/.env.toml")"

echo "== workers_resolve_master_key =="

# Real mint path (no dry-run): stub the remote presence check to `absent`, then
# the custody file must be written 0600 with a 32-byte base64 key and the
# global _WORKERS_MASTER_KEY must carry it.
mk_dir="$(mktemp -d)"
mk_out="$(workers_resolve absent "${mk_dir}" 2>&1)"
mk_val="$(printf '%s' "$mk_out" | sed -n 's/^MASTER=//p' | tail -1)"
assert_eq "mint (absent): custody file written" "present" "$([ -f "${mk_dir}/.env.toml" ] && echo present || echo absent)"
assert_eq "mint (absent): custody mode 0600" "600" "$(stat -c %a "${mk_dir}/.env.toml" 2>/dev/null || echo none)"
assert_eq "mint (absent): key decodes to 32 bytes" "32" "$(printf '%s' "$mk_val" | base64 -d 2>/dev/null | wc -c | tr -d ' ')"
assert_eq "mint (absent): _WORKERS_MASTER_KEY set" "yes" "$([ -n "$mk_val" ] && echo yes || echo no)"
assert_grep "mint (absent): key persisted in custody" '^LXK_SECRETS_MASTER_KEY = ".*"$' "$(cat "${mk_dir}/.env.toml")"

# Second call with the custody file present must reuse the SAME value — the
# remote check is never consulted and the key is never rotated.
mk_again="$(workers_resolve absent "${mk_dir}" 2>&1 | sed -n 's/^MASTER=//p' | tail -1)"
assert_eq "re-run preserves the minted key (never rotated)" "$mk_val" "$mk_again"

# `present`: the remote worker already holds it — no custody write, no mint.
mk_pres_dir="$(mktemp -d)"
mk_pres_out="$(workers_resolve present "${mk_pres_dir}" 2>&1)"
mk_pres_val="$(printf '%s' "$mk_pres_out" | sed -n 's/^MASTER=//p' | tail -1)"
assert_eq "presence=present: no custody file" "absent" "$([ -f "${mk_pres_dir}/.env.toml" ] && echo present || echo absent)"
assert_eq "presence=present: _WORKERS_MASTER_KEY empty" "" "$mk_pres_val"

# `unknown`: the check could not run — nothing minted, nothing written, a note.
mk_unk_dir="$(mktemp -d)"
mk_unk_out="$(workers_resolve unknown "${mk_unk_dir}" 2>&1)"
mk_unk_val="$(printf '%s' "$mk_unk_out" | sed -n 's/^MASTER=//p' | tail -1)"
assert_grep "presence=unknown: warns it couldn't read the master key" "couldn't read the master key" "$mk_unk_out"
assert_eq "presence=unknown: no custody file (no mint)" "absent" "$([ -f "${mk_unk_dir}/.env.toml" ] && echo present || echo absent)"
assert_eq "presence=unknown: _WORKERS_MASTER_KEY empty" "" "$mk_unk_val"

echo "== migrate_legacy_deploy_env =="

mdir="$(mktemp -d)"
printf 'LXK_ENV=production\nLXK_PUBLIC_URL=http://127.0.0.1:8080\nGITHUB_APP_ID=123\nGITHUB_PRIVATE_KEY="line1\\nline2"\nLXK_API_KEY=dead\n' > "${mdir}/.env"
lib_call migrate_legacy_deploy_env "${mdir}" >/dev/null 2>&1
assert_eq "migration renames .env to .env.legacy" "present" "$([ -f "${mdir}/.env.legacy" ] && echo present || echo absent)"
assert_eq "migration removes .env" "absent" "$([ -f "${mdir}/.env" ] && echo present || echo absent)"
mig_toml="$(cat "${mdir}/.env.toml")"
assert_grep "migration carries app key" '^LXK_ENV = "production"$' "$mig_toml"
assert_grep "migration preserves GITHUB_APP_ID" '^GITHUB_APP_ID = "123"$' "$mig_toml"
assert_grep "migration unescapes quoted value" 'GITHUB_PRIVATE_KEY = "line1\\nline2"' "$mig_toml"
assert_eq "migration drops dead key" "0" "$(grep -c 'LXK_API_KEY' "${mdir}/.env.toml" || true)"
assert_eq "migration .env.legacy mode 0600" "600" "$(stat -c %a "${mdir}/.env.legacy")"

# Idempotence: an existing .env.toml means no second migration.
lib_call migrate_legacy_deploy_env "${mdir}" >/dev/null 2>&1
assert_eq "migration skips when .env.toml exists" "absent" "$([ -f "${mdir}/.env" ] && echo present || echo absent)"

# SEV1: a legacy .env carrying keys outside the installer whitelist must migrate,
# not abort the install. These are loader-valid RuntimeEnv keys.
migdir="$(mktemp -d)"
printf 'LXK_SECRETS_MASTER_KEY=AAAA\nLOG_LEVEL=debug\nTANSTACK_AI_DEBUG=1\nLXK_S3_BUCKET=bucket\nPORT="3100"\nLXK_API_KEY=dead\n' > "${migdir}/.env"
mig_rc=0
lib_call migrate_legacy_deploy_env "${migdir}" >/dev/null 2>&1 || mig_rc=$?
assert_rc "migration with non-whitelist keys does not die" 0 "$mig_rc"
mig_body="$(cat "${migdir}/.env.toml" 2>/dev/null)"
assert_grep "migration carries LXK_SECRETS_MASTER_KEY" '^LXK_SECRETS_MASTER_KEY = "AAAA"$' "$mig_body"
assert_grep "migration carries LOG_LEVEL" '^LOG_LEVEL = "debug"$' "$mig_body"
assert_grep "migration carries TANSTACK_AI_DEBUG" '^TANSTACK_AI_DEBUG = "1"$' "$mig_body"
assert_grep "migration carries storage key" '^LXK_S3_BUCKET = "bucket"$' "$mig_body"
assert_grep "migration carries PORT=3100" '^PORT = "3100"$' "$mig_body"
assert_eq "migration still drops dead key" "0" "$(grep -c 'LXK_API_KEY' "${migdir}/.env.toml" || true)"

# MED1: parser divergence — multi-line double-quoted values, inline `#` comments,
# and `\\` before `n` unescape order (mirror server/env-file.ts parseDotenv).
pardir="$(mktemp -d)"
printf 'MULTI="line1\nline2"\nINLINE=value # trailing comment\nBACKSLASH="cmd\\\\nargs"\nQH="a#b"\nSQ=\x27sq#val\x27\n' > "${pardir}/.env"
lib_call migrate_legacy_deploy_env "${pardir}" >/dev/null 2>&1
par_toml="$(cat "${pardir}/.env.toml" 2>/dev/null)"
assert_grep "migration spans a multi-line quoted value" '^MULTI = "line1\\nline2"$' "$par_toml"
assert_grep "migration strips inline # comment for unquoted" '^INLINE = "value"$' "$par_toml"
assert_grep "migration keeps quoted # verbatim" '^QH = "a#b"$' "$par_toml"
bs_line="$(grep '^BACKSLASH' "${pardir}/.env.toml" 2>/dev/null || true)"
assert_eq "migration unescapes \\\\n as literal backslash-n" 'BACKSLASH = "cmd\\nargs"' "$bs_line"
assert_grep "migration single-quoted value has no escapes" '^SQ = "sq#val"$' "$par_toml"

# MED2: compose-tooling keys stay in the flat .env (moving COMPOSE_PROJECT_NAME
# would rename the compose project and orphan the volume; LXK_IMAGE_TAG must
# keep its pin across the migration rename).
toolleg="$(mktemp -d)"
printf 'GITHUB_APP_ID=7\nCOMPOSE_PROJECT_NAME=myproj\nLXK_IMAGE_TAG=v2026.2.9\n' > "${toolleg}/.env"
lib_call migrate_legacy_deploy_env "${toolleg}" >/dev/null 2>&1
tleg_toml="$(cat "${toolleg}/.env.toml" 2>/dev/null)"
tleg_env="$(cat "${toolleg}/.env" 2>/dev/null)"
assert_eq "migration keeps COMPOSE_PROJECT_NAME out of .env.toml" "0" "$(grep -c 'COMPOSE_PROJECT_NAME' "${toolleg}/.env.toml" || true)"
assert_eq "migration keeps LXK_IMAGE_TAG out of .env.toml" "0" "$(grep -c 'LXK_IMAGE_TAG' "${toolleg}/.env.toml" || true)"
assert_grep "migration re-emits COMPOSE_PROJECT_NAME to flat .env" '^COMPOSE_PROJECT_NAME=myproj$' "$tleg_env"
assert_grep "migration re-emits pinned LXK_IMAGE_TAG to flat .env" '^LXK_IMAGE_TAG=v2026.2.9$' "$tleg_env"
assert_grep "migration still carries an app key" '^GITHUB_APP_ID = "7"$' "$tleg_toml"

# MED5: the installer-written TOML must be APPLIED by the loader (not just
# parse). Uses the real loader when bun + the checkout are present.
if command -v bun >/dev/null 2>&1 && [ -f "${SCRIPT_DIR}/../server/env-file.ts" ]; then
  loaddir="$(mktemp -d)"
  printf '[core]\nPORT = "3100"\n' > "${loaddir}/.env.toml"
  port_val="$(cd "${SCRIPT_DIR}/.." && bun server/env-file.ts --path "${loaddir}/.env.toml" --export-shell 2>/dev/null | sed -n "s/^export PORT='\(.*\)'\$/\1/p")"
  assert_eq "loader applies installer .env.toml PORT=3100" "3100" "$port_val"
else
  echo "SKIP: bun unavailable — loader-apply check needs the checkout"
fi

echo "== write_env_file =="

envdir="$(mktemp -d)"
lib_eval "write_env_file '${envdir}/.env' LXK_ENV=staging LXK_PUBLIC_URL=http://127.0.0.1:8080" >/dev/null 2>&1
assert_eq "write_env_file mode 0600" "600" "$(stat -c %a "${envdir}/.env")"
assert_grep "write_env_file content" '^LXK_ENV=staging$' "$(cat "${envdir}/.env")"

lib_eval "write_env_file '${envdir}/.env' COMPOSE_PROJECT_NAME=lexa" >/dev/null 2>&1
env_merged="$(cat "${envdir}/.env")"
assert_grep "write_env_file preserves existing key" '^LXK_ENV=staging$' "$env_merged"
assert_grep "write_env_file appends new key" '^COMPOSE_PROJECT_NAME=lexa$' "$env_merged"

rogue_rc=0
lib_eval "write_env_file '${envdir}/rogue.env' ROGUE_KEY=1" >/dev/null 2>&1 || rogue_rc=$?
assert_rc "write_env_file rogue key dies" 1 "$rogue_rc"
if [ -e "${envdir}/rogue.env" ]; then
  assert_eq "write_env_file rogue key writes no file" "absent" "present"
else
  assert_eq "write_env_file rogue key writes no file" "absent" "absent"
fi

echo "== compose_render mounts .env.toml, tooling-only =="

compdir="$(mktemp -d)"
DEPLOY_DIR="${compdir}" lib_eval "compose_render direct 8080 127.0.0.1" >/dev/null 2>&1
compose_body="$(cat "${compdir}/docker-compose.yml")"
assert_grep "compose binds .env.toml (long form source)" 'source: \./\.env\.toml$' "$compose_body"
assert_grep "compose binds .env.toml (target)" 'target: /app/\.env\.toml$' "$compose_body"
assert_grep "compose bind is read-only" 'read_only: true$' "$compose_body"
assert_grep "compose bind refuses host-path creation" 'create_host_path: false$' "$compose_body"
assert_grep "compose uses LXK_IMAGE_TAG interpolation" 'ghcr.io/yohanesgre/lexa:\$\{LXK_IMAGE_TAG:-latest\}' "$compose_body"
assert_eq "compose drops app-var interpolation" "0" "$(grep -c 'LXK_PUBLIC_URL=' "${compdir}/docker-compose.yml" || true)"
assert_eq "compose drops DATABASE_PATH interpolation" "0" "$(grep -c 'DATABASE_PATH=' "${compdir}/docker-compose.yml" || true)"

rc=0
DEPLOY_DIR="${compdir}" lib_eval "compose_render staging 8080 127.0.0.1" >/dev/null 2>&1 || rc=$?
assert_rc "compose_render invalid mode dies" 1 "$rc"

echo "== grant_container_read =="

# Non-root installer (uid 1001 != image uid 1000): the image's own uid:gid is
# probed from the image, then the chown round-trips through a one-shot root
# container. Hermetic: `id` and `docker` are PATH shims — the shim answers the
# `--entrypoint sh` probe with the configured uid/gid and logs the chown argv,
# so the host file's mode is the only real side effect (640 on claimed, 644 on
# failure).
gtroot="$(mktemp -d)"
mkdir -p "${gtroot}/bin"
cat > "${gtroot}/bin/id" <<'SHIM'
#!/usr/bin/env bash
if [ "$1" = "-u" ]; then
  printf '1001\n'
  exit 0
fi
exec /usr/bin/id "$@"
SHIM
chmod +x "${gtroot}/bin/id"
cat > "${gtroot}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
[ -n "${DOCKER_SHIM_LOG:-}" ] && printf 'docker %s\n' "$*" >> "${DOCKER_SHIM_LOG}"
case "$*" in
  *"--entrypoint sh"*)
    printf '%s\n' "${DOCKER_SHIM_UID:-1000}"
    printf '%s\n' "${DOCKER_SHIM_GID:-1000}"
    exit 0
    ;;
esac
exit "${DOCKER_SHIM_RC:-0}"
SHIM
chmod +x "${gtroot}/bin/docker"

gtfile="${gtroot}/.env.toml"
: > "${gtfile}"
chmod 600 "${gtfile}"
( export PATH="${gtroot}/bin:${PATH}" DOCKER_SHIM_LOG="${gtroot}/docker.log" DOCKER_SHIM_RC=0
  lib_call grant_container_read "${gtfile}" myimg >/dev/null 2>&1 ) || true
gtlog="$(cat "${gtroot}/docker.log" 2>/dev/null || true)"
assert_grep "grant_container_read probes the image for uid/gid" 'entrypoint sh' "$gtlog"
assert_grep "grant_container_read chowns to group 1000 via docker" 'chown 1001:1000 /lexa-env\.toml' "$gtlog"
assert_grep "grant_container_read runs the chown container as root" 'user 0' "$gtlog"
assert_grep "grant_container_read mounts the env file" ':/lexa-env\.toml' "$gtlog"
assert_eq "grant_container_read mode 640 after docker chown" "640" "$(stat -c %a "${gtfile}")"

# An image whose gid is not 1000 (e.g. a rebuilt base image): the chown target
# group must follow the image, not a hardcoded 1000.
gtalt="${gtroot}/.env.alt"
: > "${gtalt}"
chmod 600 "${gtalt}"
( export PATH="${gtroot}/bin:${PATH}" DOCKER_SHIM_LOG="${gtroot}/docker-alt.log" DOCKER_SHIM_RC=0 \
    DOCKER_SHIM_UID=1000 DOCKER_SHIM_GID=2000
  lib_call grant_container_read "${gtalt}" altimg >/dev/null 2>&1 ) || true
gtaltlog="$(cat "${gtroot}/docker-alt.log" 2>/dev/null || true)"
assert_grep "grant_container_read derives the group from the image (gid 2000)" 'chown 1001:2000 /lexa-env\.toml' "$gtaltlog"
assert_eq "grant_container_read alt-image mode 640" "640" "$(stat -c %a "${gtalt}")"

gtfail="${gtroot}/.env.fail"
: > "${gtfail}"
chmod 600 "${gtfail}"
gtfail_out="$( export PATH="${gtroot}/bin:${PATH}" DOCKER_SHIM_RC=1
  lib_call grant_container_read "${gtfail}" myimg 2>&1 )" || true
assert_grep "grant_container_read warns when chown fails" "couldn't set owners on" "$gtfail_out"
assert_eq "grant_container_read mode 644 on chown failure" "644" "$(stat -c %a "${gtfail}")"

echo "== INSTALL_DRY_RUN=1 install.sh docker =="

drydir="$(mktemp -d)"
mkdir "${drydir}/bin"
export FAKE_DOCKER_LOG="${drydir}/docker.log"
: > "${FAKE_DOCKER_LOG}"
cat > "${drydir}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
echo "docker $*" >> "${FAKE_DOCKER_LOG}"
exit 0
SHIM
chmod +x "${drydir}/bin/docker"

containers_before=0
if command -v docker >/dev/null 2>&1; then
  containers_before=$(docker ps -q 2>/dev/null | wc -l)
fi

dry_rc=0
dry_out="$(cd "${drydir}" && INSTALL_DRY_RUN=1 PATH="${drydir}/bin:${PATH}" bash "$INSTALL" docker --port 9191 2>&1)" || dry_rc=$?
assert_rc "dry-run install.sh docker completes" 0 "$dry_rc"
assert_grep "dry-run marks nodes with '#» DRY-RUN'" '#» DRY-RUN' "$dry_out"
assert_grep "dry-run logs '[dry-run] docker compose pull'" '\[dry-run\] docker compose pull' "$dry_out"
assert_grep "dry-run logs '[dry-run] docker compose up'" '\[dry-run\] docker compose up' "$dry_out"
assert_grep "dry-run health-wait faked via mutate curl" '\[dry-run\] curl -fsS' "$dry_out"
assert_grep "dry-run prints final banner" 'Lexa is running at http://127.0.0.1:9191' "$dry_out"
assert_eq "dry-run renders docker-compose.yml" "present" "$([ -f "${drydir}/dockers/docker-compose.yml" ] && echo present || echo absent)"
assert_grep "dry-run .env.toml writes LXK_TRUSTED_ORIGINS" '^LXK_TRUSTED_ORIGINS = ".*http://localhost:9191' "$(cat "${drydir}/dockers/.env.toml" 2>/dev/null)"
assert_grep "dry-run .env.toml writes DATABASE_PATH" '^DATABASE_PATH = "/app/data/lexa.db"$' "$(cat "${drydir}/dockers/.env.toml" 2>/dev/null)"
assert_grep "dry-run .env keeps tooling LXK_IMAGE_TAG" '^LXK_IMAGE_TAG=latest$' "$(cat "${drydir}/dockers/.env" 2>/dev/null)"
assert_eq "dry-run flat .env has no app keys" "0" "$(grep -c 'LXK_PUBLIC_URL' "${drydir}/dockers/.env" 2>/dev/null || true)"
assert_eq "dry-run .env.toml mode 0600" "600" "$(stat -c %a "${drydir}/dockers/.env.toml")"
dry_key="$(sed -n 's/^LXK_SECRETS_MASTER_KEY = "\(.*\)"$/\1/p' "${drydir}/dockers/.env.toml" | head -1)"
assert_eq "dry-run install generates a 32-byte secrets key" "32" "$(printf '%s' "$dry_key" | base64 -d 2>/dev/null | wc -c | tr -d ' ')"
assert_grep "dry-run marks env mount perms step" 'grant_container_read' "$dry_out"
assert_grep "dry-run logs grant_container_read intent" '\[dry-run\] chmod 640' "$dry_out"

fake_calls="$(grep -v -e 'compose version' -e 'docker info' "${FAKE_DOCKER_LOG}" || true)"
assert_eq "no mutating docker calls executed (shim log)" "" "$fake_calls"

echo "== INSTALL_DRY_RUN=1 install.sh docker --no-pull =="

nopulldir="$(mktemp -d)"
mkdir -p "${nopulldir}/bin"
export FAKE_DOCKER_LOG="${nopulldir}/docker.log"
: > "${FAKE_DOCKER_LOG}"
cat > "${nopulldir}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
echo "docker $*" >> "${FAKE_DOCKER_LOG}"
exit 0
SHIM
chmod +x "${nopulldir}/bin/docker"

nopull_rc=0
nopull_out="$(cd "${nopulldir}" && INSTALL_DRY_RUN=1 PATH="${nopulldir}/bin:${PATH}" bash "$INSTALL" docker --port 9291 --no-pull 2>&1)" || nopull_rc=$?
assert_rc "--no-pull dry-run install.sh docker completes" 0 "$nopull_rc"
assert_grep "--no-pull announces the skipped pull" 'skipping image pull \(--no-pull\)' "$nopull_out"
assert_eq "--no-pull logs no '[dry-run] docker compose pull'" "0" "$(printf '%s' "$nopull_out" | grep -c '\[dry-run\] docker compose pull' || true)"
assert_grep "--no-pull still logs compose up" '\[dry-run\] docker compose up' "$nopull_out"
nopull_pull="$(grep -c 'compose pull' "${FAKE_DOCKER_LOG}" || true)"
assert_eq "--no-pull executes no 'docker compose pull'" "0" "$nopull_pull"
nopull_inspect="$(grep -c 'image inspect' "${FAKE_DOCKER_LOG}" || true)"
assert_eq "--no-pull dry-run skips 'docker image inspect'" "0" "$nopull_inspect"

echo "== install.sh docker --no-pull dies on a missing local image =="

missingdir="$(mktemp -d)"
mkdir -p "${missingdir}/bin"
cat > "${missingdir}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
case "$1 $2" in
  "image inspect") exit 1 ;;
esac
exit 0
SHIM
chmod +x "${missingdir}/bin/docker"
missing_rc=0
missing_out="$(cd "${missingdir}" && PATH="${missingdir}/bin:${PATH}" bash "$INSTALL" docker --port 9495 --no-pull 2>&1)" || missing_rc=$?
assert_rc "--no-pull missing image exits non-zero" 1 "$missing_rc"
assert_grep "--no-pull missing image names the local image" 'ghcr.io/yohanesgre/lexa:latest not found locally' "$missing_out"
assert_grep "--no-pull missing image gives the fix" 'build it first, or drop --no-pull' "$missing_out"

echo "== installer re-run preserves operator keys =="

presdir="$(mktemp -d)"
mkdir -p "${presdir}/bin" "${presdir}/dockers"
cat > "${presdir}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${presdir}/bin/docker"
printf '[github]\nGITHUB_APP_ID = "999"\nGITHUB_PRIVATE_KEY_FILE = "/app/github-app.private-key.pem"\n\n[urls]\nLXK_PUBLIC_URL = "http://old.example"\n' > "${presdir}/dockers/.env.toml"
pres_rc=0
(cd "${presdir}" && INSTALL_DRY_RUN=1 PATH="${presdir}/bin:${PATH}" bash "$INSTALL" docker --port 9292 >/dev/null 2>&1) || pres_rc=$?
assert_rc "re-run install.sh docker completes" 0 "$pres_rc"
pres_body="$(cat "${presdir}/dockers/.env.toml")"
assert_grep "re-run preserves GITHUB_APP_ID" '^GITHUB_APP_ID = "999"$' "$pres_body"
assert_grep "re-run preserves GITHUB_PRIVATE_KEY_FILE" '^GITHUB_PRIVATE_KEY_FILE = "/app/github-app.private-key.pem"$' "$pres_body"
assert_grep "re-run updates installer-owned LXK_PUBLIC_URL" '^LXK_PUBLIC_URL = "http://127.0.0.1:9292"$' "$pres_body"
pres_key1="$(sed -n 's/^LXK_SECRETS_MASTER_KEY = "\(.*\)"$/\1/p' "${presdir}/dockers/.env.toml" | head -1)"
assert_eq "re-run .env.toml carries a 32-byte secrets key" "32" "$(printf '%s' "$pres_key1" | base64 -d 2>/dev/null | wc -c | tr -d ' ')"
pres2_rc=0
(cd "${presdir}" && INSTALL_DRY_RUN=1 PATH="${presdir}/bin:${PATH}" bash "$INSTALL" docker --port 9292 >/dev/null 2>&1) || pres2_rc=$?
assert_rc "second re-run install.sh docker completes" 0 "$pres2_rc"
pres_key2="$(sed -n 's/^LXK_SECRETS_MASTER_KEY = "\(.*\)"$/\1/p' "${presdir}/dockers/.env.toml" | head -1)"
assert_eq "re-run preserves LXK_SECRETS_MASTER_KEY" "$pres_key1" "$pres_key2"

echo "== dry-run never prints a master key =="

# Regression: command substitution expands the key entry into step()'s argv, and
# the dry-run branch echoes the whole argv. A preserved master key must never
# reach stdout — it must be redacted to `=***`.
redactdir="$(mktemp -d)"
mkdir -p "${redactdir}/bin" "${redactdir}/dockers"
cat > "${redactdir}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${redactdir}/bin/docker"
redact_fixture="SYNTHETICMASTERKEYVALUE"
printf 'LXK_SECRETS_MASTER_KEY = "%s"\n' "${redact_fixture}" > "${redactdir}/dockers/.env.toml"
redact_rc=0
redact_out="$(cd "${redactdir}" && INSTALL_DRY_RUN=1 PATH="${redactdir}/bin:${PATH}" bash "$INSTALL" docker --port 9595 2>&1)" || redact_rc=$?
assert_rc "redaction dry-run install.sh docker completes" 0 "$redact_rc"
assert_eq "dry-run stdout does not leak the master key" "0" "$(printf '%s' "$redact_out" | grep -c "${redact_fixture}" || true)"
assert_grep "dry-run redacts the master key entry to =***" 'LXK_SECRETS_MASTER_KEY=\*\*\*' "$redact_out"
assert_grep "redacted key is on the write_env_toml dry-run line" '#» DRY-RUN write_env_toml .*LXK_SECRETS_MASTER_KEY=\*\*\*' "$redact_out"

echo "== installer preserves pinned tooling keys =="

pindir="$(mktemp -d)"
mkdir -p "${pindir}/bin" "${pindir}/dockers"
cat > "${pindir}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${pindir}/bin/docker"
printf '[core]\nLXK_ENV = "production"\n' > "${pindir}/dockers/.env.toml"
printf 'COMPOSE_PROJECT_NAME=myproj\nLXK_IMAGE_TAG=v2026.2.9\n' > "${pindir}/dockers/.env"
pin_rc=0
(cd "${pindir}" && INSTALL_DRY_RUN=1 PATH="${pindir}/bin:${PATH}" bash "$INSTALL" docker --port 9494 >/dev/null 2>&1) || pin_rc=$?
assert_rc "pinned-tag re-run install.sh docker completes" 0 "$pin_rc"
pin_env="$(cat "${pindir}/dockers/.env")"
assert_grep "re-run preserves COMPOSE_PROJECT_NAME" '^COMPOSE_PROJECT_NAME=myproj$' "$pin_env"
assert_grep "re-run preserves pinned LXK_IMAGE_TAG" '^LXK_IMAGE_TAG=v2026.2.9$' "$pin_env"

pin2_rc=0
(cd "${pindir}" && INSTALL_DRY_RUN=1 PATH="${pindir}/bin:${PATH}" bash "$INSTALL" docker --port 9494 --image vtest >/dev/null 2>&1) || pin2_rc=$?
assert_rc "--image re-run install.sh docker completes" 0 "$pin2_rc"
pin2_env="$(cat "${pindir}/dockers/.env")"
assert_grep "--image overrides pinned LXK_IMAGE_TAG" '^LXK_IMAGE_TAG=vtest$' "$pin2_env"
assert_grep "--image keeps COMPOSE_PROJECT_NAME" '^COMPOSE_PROJECT_NAME=myproj$' "$pin2_env"

echo "== installer migrates a legacy deploy dir =="
legdir="$(mktemp -d)"
mkdir -p "${legdir}/bin" "${legdir}/dockers"
cat > "${legdir}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${legdir}/bin/docker"
printf 'LXK_ENV=production\nLXK_PUBLIC_URL=http://old.example\nGITHUB_APP_ID=42\nGITHUB_WEBHOOK_SECRET=shh\nLXK_API_KEY=dead\n' > "${legdir}/dockers/.env"
leg_rc=0
(cd "${legdir}" && INSTALL_DRY_RUN=1 PATH="${legdir}/bin:${PATH}" bash "$INSTALL" docker --port 9393 >/dev/null 2>&1) || leg_rc=$?
assert_rc "legacy-dir install.sh docker completes" 0 "$leg_rc"
assert_eq "legacy .env renamed to .env.legacy" "present" "$([ -f "${legdir}/dockers/.env.legacy" ] && echo present || echo absent)"
leg_toml="$(cat "${legdir}/dockers/.env.toml")"
assert_grep "legacy migration preserves GITHUB_APP_ID" '^GITHUB_APP_ID = "42"$' "$leg_toml"
assert_grep "legacy migration preserves GITHUB_WEBHOOK_SECRET" '^GITHUB_WEBHOOK_SECRET = "shh"$' "$leg_toml"
assert_grep "legacy migration carries LXK_ENV" '^LXK_ENV = "production"$' "$leg_toml"
assert_eq "legacy migration drops dead key" "0" "$(grep -c 'LXK_API_KEY' "${legdir}/dockers/.env.toml" || true)"
assert_grep "legacy dir now has tooling-only .env" '^LXK_IMAGE_TAG=latest$' "$(cat "${legdir}/dockers/.env")"

if command -v docker >/dev/null 2>&1; then
  containers_after=$(docker ps -q 2>/dev/null | wc -l)
  assert_eq "no container started (docker ps before/after)" "$containers_before" "$containers_after"
fi

echo "== T-dirs: self-describing target dirs in the CWD =="

# Every target drops a self-describing dir in the CWD; the legacy names are gone.
BASH_BIN="$(command -v bash)"
have_bun=0
command -v bun >/dev/null 2>&1 && have_bun=1
[ "$have_bun" -eq 0 ] && [ -x "${HOME}/.bun/bin/bun" ] && have_bun=1
# Workers dry-runs run with a temp HOME (wrangler-config isolation), so the
# installer there can only resolve bun from PATH — guard them on PATH alone.
have_bun_path=0
command -v bun >/dev/null 2>&1 && have_bun_path=1

dirs_docker="$(mktemp -d)"
mkdir -p "${dirs_docker}/bin"
cat > "${dirs_docker}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${dirs_docker}/bin/docker"
dirs_rc=0
(cd "${dirs_docker}" && INSTALL_DRY_RUN=1 PATH="${dirs_docker}/bin:${PATH}" bash "$INSTALL" docker --port 9101 >/dev/null 2>&1) || dirs_rc=$?
assert_rc "T-dirs docker dry-run completes" 0 "$dirs_rc"
assert_eq "T-dirs docker writes dockers/" "present" "$([ -d "${dirs_docker}/dockers" ] && echo present || echo absent)"
assert_eq "T-dirs docker writes no lexa-deploy/" "absent" "$([ -e "${dirs_docker}/lexa-deploy" ] && echo present || echo absent)"
assert_eq "T-dirs docker writes no bare/" "absent" "$([ -e "${dirs_docker}/bare" ] && echo present || echo absent)"
assert_eq "T-dirs docker writes no cf-workers/" "absent" "$([ -e "${dirs_docker}/cf-workers" ] && echo present || echo absent)"

if [ "$have_bun_path" -eq 1 ]; then
  dirs_workers="$(mktemp -d)"
  dirs_workers_home="$(mktemp -d)"
  workers_rc=0
  (cd "${dirs_workers}" && HOME="${dirs_workers_home}" INSTALL_DRY_RUN=1 bash "$INSTALL" workers --cf-token test-token >/dev/null 2>&1) || workers_rc=$?
  assert_rc "T-dirs workers dry-run completes" 0 "$workers_rc"
  assert_eq "T-dirs workers writes cf-workers/" "present" "$([ -d "${dirs_workers}/cf-workers" ] && echo present || echo absent)"
  assert_eq "T-dirs workers writes no lexa-workers-release/" "absent" "$([ -e "${dirs_workers}/lexa-workers-release" ] && echo present || echo absent)"
  assert_eq "T-dirs workers writes no dockers/" "absent" "$([ -e "${dirs_workers}/dockers" ] && echo present || echo absent)"
else
  echo "SKIP: bun unavailable — T-dirs workers case needs the runtime"
fi

if [ "$have_bun" -eq 1 ]; then
  dirs_bare="$(mktemp -d)"
  bare_rc=0
  (cd "${dirs_bare}" && INSTALL_DRY_RUN=1 bash "$INSTALL" bare --port 3101 >/dev/null 2>&1) || bare_rc=$?
  assert_rc "T-dirs bare dry-run completes" 0 "$bare_rc"
  assert_eq "T-dirs bare writes bare/" "present" "$([ -d "${dirs_bare}/bare" ] && echo present || echo absent)"
  assert_eq "T-dirs bare ships lexa-start.sh" "present" "$([ -f "${dirs_bare}/bare/lexa-start.sh" ] && echo present || echo absent)"
  assert_eq "T-dirs bare writes no lexa-deploy/" "absent" "$([ -e "${dirs_bare}/lexa-deploy" ] && echo present || echo absent)"
else
  echo "SKIP: bun unavailable — bare T-dirs case needs the runtime"
fi

echo "== T-dev-removed: dev target aborts with clone guidance =="

devdir="$(mktemp -d)"
dev_rc=0
dev_out="$(cd "${devdir}" && bash "$INSTALL" dev 2>&1)" || dev_rc=$?
assert_rc "T-dev-removed dev target exits non-zero" 1 "$dev_rc"
assert_grep "T-dev-removed names the removed target" "The 'dev' target was removed" "$dev_out"
assert_grep "T-dev-removed gives the clone command" 'git clone https://github.com/yohanesgre/lexa && cd lexa' "$dev_out"
assert_grep "T-dev-removed gives the dev:full command" 'bun install && bun run setup && bun run dev:full' "$dev_out"
assert_eq "T-dev-removed creates no clone dir" "absent" "$([ -e "${devdir}/lexa" ] && echo present || echo absent)"

echo "== T-preflight-missing: aggregate prereq list (restricted PATH) =="

pftmp="$(mktemp -d)"
mkdir -p "${pftmp}/bin"
# Keep only the one external the script needs before the preflight (dirname);
# curl/tar/bun/sha256sum are then absent from PATH, and HOME hides ~/.bun.
ln -s "$(command -v dirname)" "${pftmp}/bin/dirname"
pf_rc=0
pf_out="$(cd "${pftmp}" && PATH="${pftmp}/bin" HOME="${pftmp}/home" "$BASH_BIN" "$INSTALL" bare 2>&1)" || pf_rc=$?
assert_rc "T-preflight-missing exits non-zero" 1 "$pf_rc"
assert_grep "T-preflight-missing header copy" 'Missing prerequisites — fix these, then re-run:' "$pf_out"
assert_grep "T-preflight-missing lists curl + fix" 'curl — usually built in' "$pf_out"
assert_grep "T-preflight-missing lists tar + fix" 'tar — usually built in' "$pf_out"
assert_grep "T-preflight-missing lists bun + install cmd" 'bun — curl -fsSL https://bun\.sh/install \| bash' "$pf_out"
assert_grep "T-preflight-missing lists sha256 tool" 'sha256sum \(or shasum\) — install your distro' "$pf_out"
assert_eq "T-preflight-missing lists ALL four tools" "4" "$(printf '%s' "$pf_out" | grep -c '^  • ' || true)"
assert_eq "T-preflight-missing creates no target dir" "absent" "$([ -e "${pftmp}/bare" ] && echo present || echo absent)"

echo "== T-secrets-file: --secrets-file applies, never prints values =="

sec_tmp="$(mktemp -d)"
mkdir -p "${sec_tmp}/bin"
cat > "${sec_tmp}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${sec_tmp}/bin/docker"
sec_pem="${sec_tmp}/github-app.pem"
printf -- '-----BEGIN KEY-----\nMIIBSYNTHETICKEYBODY\n-----END KEY-----\n' > "${sec_pem}"
sec_fix_secret="whsec_SYNTHETICWEBHOOKVALUE"
printf 'GITHUB_APP_ID=123456\nGITHUB_WEBHOOK_SECRET=%s\nGITHUB_PRIVATE_KEY_FILE=%s\n' \
  "${sec_fix_secret}" "${sec_pem}" > "${sec_tmp}/secrets.env"
sec_rc=0
sec_out="$(cd "${sec_tmp}" && INSTALL_DRY_RUN=1 PATH="${sec_tmp}/bin:${PATH}" \
  bash "$INSTALL" docker --port 9333 --secrets-file "${sec_tmp}/secrets.env" 2>&1)" || sec_rc=$?
assert_rc "T-secrets-file docker dry-run completes" 0 "$sec_rc"
sec_toml="$(cat "${sec_tmp}/dockers/.env.toml" 2>/dev/null)"
assert_grep "T-secrets-file writes GITHUB_APP_ID" '^GITHUB_APP_ID = "123456"$' "$sec_toml"
assert_grep "T-secrets-file writes GITHUB_WEBHOOK_SECRET" "^GITHUB_WEBHOOK_SECRET = \"${sec_fix_secret}\"\$" "$sec_toml"
# docker has no mounted filesystem for the PEM: the file is inlined.
assert_grep "T-secrets-file inlines GITHUB_PRIVATE_KEY for docker" '^GITHUB_PRIVATE_KEY = "-----BEGIN KEY-----\\nMIIBSYNTHETICKEYBODY' "$sec_toml"
assert_grep "T-secrets-file banner reports GitHub configured" 'GitHub sync configured' "$sec_out"
assert_eq "T-secrets-file never prints the webhook secret" "0" "$(printf '%s' "$sec_out" | grep -c "${sec_fix_secret}" || true)"
assert_eq "T-secrets-file never prints the PEM body" "0" "$(printf '%s' "$sec_out" | grep -c 'MIIBSYNTHETICKEYBODY' || true)"

# Partial trio: fail-closed — the whole GitHub set is dropped, nothing half-written.
part_tmp="$(mktemp -d)"
mkdir -p "${part_tmp}/bin"
cat > "${part_tmp}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${part_tmp}/bin/docker"
printf 'GITHUB_APP_ID=999\n' > "${part_tmp}/secrets.env"
part_rc=0
part_out="$(cd "${part_tmp}" && INSTALL_DRY_RUN=1 PATH="${part_tmp}/bin:${PATH}" \
  bash "$INSTALL" docker --port 9334 --secrets-file "${part_tmp}/secrets.env" 2>&1)" || part_rc=$?
assert_rc "T-secrets-file partial trio still completes" 0 "$part_rc"
assert_grep "T-secrets-file partial trio warns + skips" 'GitHub sync needs all three values — skipping it' "$part_out"
assert_eq "T-secrets-file partial trio writes no GITHUB_APP_ID" "0" "$(grep -c 'GITHUB_APP_ID' "${part_tmp}/dockers/.env.toml" 2>/dev/null || true)"
assert_eq "T-secrets-file banner shows GitHub unconfigured" "1" "$(printf '%s' "$part_out" | grep -c 'GitHub sync not configured' || true)"

# A key outside the installer whitelist is refused (never written).
bad_tmp="$(mktemp -d)"
mkdir -p "${bad_tmp}/bin"
cat > "${bad_tmp}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${bad_tmp}/bin/docker"
printf 'ROGUE_KEY=1\n' > "${bad_tmp}/secrets.env"
bad_rc=0
bad_out="$(cd "${bad_tmp}" && INSTALL_DRY_RUN=1 PATH="${bad_tmp}/bin:${PATH}" \
  bash "$INSTALL" docker --port 9335 --secrets-file "${bad_tmp}/secrets.env" 2>&1)" || bad_rc=$?
assert_rc "T-secrets-file rejects a non-whitelisted key" 1 "$bad_rc"
assert_grep "T-secrets-file names the rejected key" 'Secrets file: key ROGUE_KEY not allowed — use the installer whitelist keys \(see docs/DEPLOYMENT\.md\), then re-run\.' "$bad_out"

# A missing --secrets-file names the path and the next action.
nf_out="$(lib_eval 'secrets_load_file /nonexistent/lexa-nope.env' 2>&1 || true)"
assert_grep "T-secrets-file missing file names the path + next action" 'Secrets file not found: /nonexistent/lexa-nope\.env — pass an existing file, then re-run\.' "$nf_out"

# MED1: an empty trio member counts as absent — the whole trio is skipped.
empty_tmp="$(mktemp -d)"
mkdir -p "${empty_tmp}/bin"
cat > "${empty_tmp}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${empty_tmp}/bin/docker"
empty_pem="${empty_tmp}/key.pem"
printf -- '-----BEGIN KEY-----\nMIIBEMPTYID\n-----END KEY-----\n' > "${empty_pem}"
printf 'GITHUB_APP_ID=\nGITHUB_WEBHOOK_SECRET=%s\nGITHUB_PRIVATE_KEY_FILE=%s\n' \
  "${sec_fix_secret}" "${empty_pem}" > "${empty_tmp}/secrets.env"
empty_rc=0
empty_out="$(cd "${empty_tmp}" && INSTALL_DRY_RUN=1 PATH="${empty_tmp}/bin:${PATH}" \
  bash "$INSTALL" docker --port 9336 --secrets-file "${empty_tmp}/secrets.env" 2>&1)" || empty_rc=$?
assert_rc "T-secrets-file empty GITHUB_APP_ID still completes" 0 "$empty_rc"
assert_grep "T-secrets-file empty GITHUB_APP_ID skips the trio" 'GitHub sync needs all three values — skipping it' "$empty_out"
assert_eq "T-secrets-file empty GITHUB_APP_ID writes no GITHUB_APP_ID" "0" "$(grep -c 'GITHUB_APP_ID' "${empty_tmp}/dockers/.env.toml" 2>/dev/null || true)"

# MED1: an unreadable GITHUB_PRIVATE_KEY_FILE counts as absent (bare keeps the
# path, so the trio check itself must require -r); a readable path completes it.
uf_out="$(lib_eval 'SECRET_ENTRIES=("GITHUB_APP_ID=1" "GITHUB_WEBHOOK_SECRET=wh" "GITHUB_PRIVATE_KEY_FILE=/nonexistent/nope.pem"); secrets_check_trio; printf "TRIO=%s" "$GITHUB_TRIO_OK"' 2>&1)"
assert_grep "T-secrets-file unreadable key file skips the trio" 'GitHub sync needs all three values — skipping it' "$uf_out"
assert_grep "T-secrets-file unreadable key file leaves GITHUB_TRIO_OK=0" 'TRIO=0' "$uf_out"
# The PEM path is substituted into the snippet text (double-quoted) — the child
# runs under `set -u`, so an env-prefix var would never reach it.
uf_ok="$(lib_eval "SECRET_ENTRIES=(\"GITHUB_APP_ID=1\" \"GITHUB_WEBHOOK_SECRET=wh\" \"GITHUB_PRIVATE_KEY_FILE=${empty_pem}\"); secrets_check_trio; printf \"TRIO=%s\" \"\$GITHUB_TRIO_OK\"")"
assert_grep "T-secrets-file readable key file completes the trio" 'TRIO=1' "$uf_ok"

# MED5: a malformed line reports only its number — never the line content.
mal_tmp="$(mktemp -d)"
mkdir -p "${mal_tmp}/bin"
cat > "${mal_tmp}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${mal_tmp}/bin/docker"
printf 'GITHUB_APP_ID=1\nthis line has no equals sign\n' > "${mal_tmp}/secrets.env"
mal_rc=0
mal_out="$(cd "${mal_tmp}" && INSTALL_DRY_RUN=1 PATH="${mal_tmp}/bin:${PATH}" \
  bash "$INSTALL" docker --port 9337 --secrets-file "${mal_tmp}/secrets.env" 2>&1)" || mal_rc=$?
assert_rc "T-secrets-file malformed line exits non-zero" 1 "$mal_rc"
assert_grep "T-secrets-file malformed line reports its number" 'line 2' "$mal_out"
assert_eq "T-secrets-file malformed line never echoes the content" "0" "$(printf '%s' "$mal_out" | grep -c 'this line has no equals sign' || true)"

# workers: values are pushed with `wrangler secret put` and written to custody.
if [ "$have_bun_path" -eq 1 ]; then
  sec_w_tmp="$(mktemp -d)"
  sec_w_home="$(mktemp -d)"
  sec_w_pem="${sec_w_tmp}/key.pem"
  printf -- '-----BEGIN KEY-----\nMIIBWORKERKEY\n-----END KEY-----\n' > "${sec_w_pem}"
  printf 'GITHUB_APP_ID=654321\nGITHUB_WEBHOOK_SECRET=%s\nGITHUB_PRIVATE_KEY_FILE=%s\n' \
    "${sec_fix_secret}" "${sec_w_pem}" > "${sec_w_tmp}/secrets.env"
  secw_rc=0
  secw_out="$(cd "${sec_w_tmp}" && HOME="${sec_w_home}" INSTALL_DRY_RUN=1 \
    bash "$INSTALL" workers --cf-token test-token --secrets-file "${sec_w_tmp}/secrets.env" 2>&1)" || secw_rc=$?
  assert_rc "T-secrets-file workers dry-run completes" 0 "$secw_rc"
  assert_grep "T-secrets-file workers plans GITHUB_APP_ID put" 'wrangler secret put GITHUB_APP_ID --name lexa' "$secw_out"
  assert_grep "T-secrets-file workers plans GITHUB_WEBHOOK_SECRET put" 'wrangler secret put GITHUB_WEBHOOK_SECRET --name lexa' "$secw_out"
  assert_grep "T-secrets-file workers plans GITHUB_PRIVATE_KEY put" 'wrangler secret put GITHUB_PRIVATE_KEY --name lexa' "$secw_out"
  secw_custody="$(cat "${sec_w_tmp}/cf-workers/.env.toml" 2>/dev/null)"
  assert_grep "T-secrets-file workers writes custody GITHUB_APP_ID" '^GITHUB_APP_ID = "654321"$' "$secw_custody"
  assert_grep "T-secrets-file workers passes the deploy config to secret put" 'wrangler secret put GITHUB_APP_ID --name lexa --config deploy-lexa/wrangler.lexa.json' "$secw_out"
  assert_eq "T-secrets-file workers never prints the webhook secret" "0" "$(printf '%s' "$secw_out" | grep -c "${sec_fix_secret}" || true)"
else
  echo "SKIP: bun unavailable — T-secrets-file workers case needs the runtime"
fi

echo "== T-prune-legacy-secret: workers auto-prune the dead LXK_API_KEY =="

# A `bun` shim answers `x wrangler secret list` from a fixture and logs the
# `secret delete` argv — no real Cloudflare call, ever.
prune_tmp="$(mktemp -d)"
mkdir -p "${prune_tmp}/bin" "${prune_tmp}/cf-workers/deploy-lexa"
printf '{"name":"lexa","vars":{"LXK_ENV":"production","LXK_PUBLIC_URL":"https://lexa.example.workers.dev"}}\n' \
  > "${prune_tmp}/cf-workers/deploy-lexa/wrangler.lexa.json"
cat > "${prune_tmp}/bin/bun" <<'SHIM'
#!/usr/bin/env bash
case "$*" in
  *"wrangler secret list"*)
    printf '%s\n' "$*" >> "${PRUNE_LIST_LOG:-/dev/null}"
    printf '%s' "${PRUNE_LIST:-[]}"
    exit "${PRUNE_LIST_RC:-0}"
    ;;
  *"wrangler secret delete"*)
    printf '%s\n' "$*" >> "${PRUNE_DELETE_LOG:-/dev/null}"
    exit "${PRUNE_DELETE_RC:-0}"
    ;;
esac
exit 0
SHIM
chmod +x "${prune_tmp}/bin/bun"
prune_present='[{"name":"LXK_SECRETS_MASTER_KEY","type":"secret_text"},{"name":"LXK_API_KEY","type":"secret_text"}]'
prune_absent='[{"name":"LXK_SECRETS_MASTER_KEY","type":"secret_text"}]'
prune_prev='[{"name":"LXK_API_KEY_PREV","type":"secret_text"}]'

# Present + dry-run: the planned delete is visible; nothing executes.
prune_out="$( export PATH="${prune_tmp}/bin:${PATH}" FLAVOR_NAME=lexa INSTALL_DRY_RUN=1 \
  PRUNE_LIST="${prune_present}" PRUNE_DELETE_LOG="${prune_tmp}/delete.log"
  lib_call workers_prune_legacy_secret "${prune_tmp}/cf-workers" 2>&1 )" || true
assert_grep "T-prune-legacy-secret dry-run plans the delete" \
  '\[dry-run\] bun x wrangler secret delete LXK_API_KEY --name lexa --config deploy-lexa/wrangler\.lexa\.json' "$prune_out"
assert_eq "T-prune-legacy-secret dry-run executes no delete" "absent" \
  "$([ -e "${prune_tmp}/delete.log" ] && echo present || echo absent)"

# Absent: nothing to do — no output, no delete.
prune_out="$( export PATH="${prune_tmp}/bin:${PATH}" FLAVOR_NAME=lexa INSTALL_DRY_RUN=1 \
  PRUNE_LIST="${prune_absent}"
  lib_call workers_prune_legacy_secret "${prune_tmp}/cf-workers" 2>&1 )" || true
assert_eq "T-prune-legacy-secret absent prints nothing" "" "$prune_out"

# A differently-named secret is NOT the dead key — the match is exact, so no
# output and no delete (a prefix like LXK_API_KEY_PREV must not trip it).
rm -f "${prune_tmp}/delete.log"
prune_out="$( export PATH="${prune_tmp}/bin:${PATH}" FLAVOR_NAME=lexa \
  PRUNE_LIST="${prune_prev}" PRUNE_DELETE_LOG="${prune_tmp}/delete.log"
  lib_call workers_prune_legacy_secret "${prune_tmp}/cf-workers" 2>&1 )" || true
assert_eq "T-prune-legacy-secret prefix-only name prints nothing" "" "$prune_out"
assert_eq "T-prune-legacy-secret prefix-only name executes no delete" "absent" \
  "$([ -e "${prune_tmp}/delete.log" ] && echo present || echo absent)"

# A successful delete names only LXK_API_KEY, and pins the exact argv.
: > "${prune_tmp}/delete.log"
: > "${prune_tmp}/list.log"
prune_rc=0
prune_out="$( export PATH="${prune_tmp}/bin:${PATH}" FLAVOR_NAME=lexa \
  PRUNE_LIST="${prune_present}" PRUNE_DELETE_RC=0 PRUNE_DELETE_LOG="${prune_tmp}/delete.log" \
  PRUNE_LIST_LOG="${prune_tmp}/list.log"
  lib_call workers_prune_legacy_secret "${prune_tmp}/cf-workers" 2>&1 )" || prune_rc=$?
assert_rc "T-prune-legacy-secret successful delete exits 0" 0 "$prune_rc"
assert_grep "T-prune-legacy-secret prints the removal copy" \
  '\(removed LXK_API_KEY — it is no longer read\)' "$prune_out"
prune_log="$(cat "${prune_tmp}/delete.log" 2>/dev/null || true)"
assert_grep "T-prune-legacy-secret delete pins the full argv" \
  'wrangler secret delete LXK_API_KEY --name lexa --config deploy-lexa/wrangler\.lexa\.json' "$prune_log"
assert_eq "T-prune-legacy-secret delete never names another secret" "0" \
  "$(printf '%s' "$prune_log" | grep -c 'LXK_SECRETS_MASTER_KEY' || true)"
prune_list_log="$(cat "${prune_tmp}/list.log" 2>/dev/null || true)"
assert_grep "T-prune-legacy-secret list pins --name lexa" \
  'wrangler secret list --name lexa' "$prune_list_log"
assert_grep "T-prune-legacy-secret list pins the deploy config" \
  'lexa --config deploy-lexa/wrangler\.lexa\.json' "$prune_list_log"
assert_grep "T-prune-legacy-secret list pins --format json" \
  'wrangler\.lexa\.json --format json' "$prune_list_log"

# A failed delete warns + continues (rc 0).
prune_rc=0
prune_out="$( export PATH="${prune_tmp}/bin:${PATH}" FLAVOR_NAME=lexa \
  PRUNE_LIST="${prune_present}" PRUNE_DELETE_RC=1 PRUNE_DELETE_LOG="${prune_tmp}/delete.log"
  lib_call workers_prune_legacy_secret "${prune_tmp}/cf-workers" 2>&1 )" || prune_rc=$?
assert_rc "T-prune-legacy-secret failed delete still exits 0" 0 "$prune_rc"
assert_grep "T-prune-legacy-secret failed delete warns + continues" \
  "couldn't remove the dead LXK_API_KEY secret" "$prune_out"

# An unreadable list warns + skips (never deletes on unknown state).
prune_out="$( export PATH="${prune_tmp}/bin:${PATH}" FLAVOR_NAME=lexa \
  PRUNE_LIST="${prune_present}" PRUNE_LIST_RC=1 PRUNE_DELETE_LOG="${prune_tmp}/delete.log"
  lib_call workers_prune_legacy_secret "${prune_tmp}/cf-workers" 2>&1 )" || true
assert_grep "T-prune-legacy-secret list failure warns + skips" \
  "couldn't read the worker's secrets" "$prune_out"

# Wiring: a full workers dry-run reaches the prune step (fixture reports the
# dead secret present) and still executes nothing.
if [ "$have_bun_path" -eq 1 ]; then
  prune_int="$(mktemp -d)"
  prune_int_home="$(mktemp -d)"
  mkdir -p "${prune_int}/bin" "${prune_int}/cf-workers/deploy-lexa"
  printf '{"name":"lexa","vars":{"LXK_ENV":"production","LXK_PUBLIC_URL":"https://lexa.example.workers.dev"}}\n' \
    > "${prune_int}/cf-workers/deploy-lexa/wrangler.lexa.json"
  cp "${prune_tmp}/bin/bun" "${prune_int}/bin/bun"
  prune_int_rc=0
  prune_int_out="$(cd "${prune_int}" && HOME="${prune_int_home}" INSTALL_DRY_RUN=1 \
    PATH="${prune_int}/bin:${PATH}" PRUNE_LIST="${prune_present}" PRUNE_DELETE_LOG="${prune_int}/delete.log" \
    bash "$INSTALL" workers --cf-token test-token 2>&1)" || prune_int_rc=$?
  assert_rc "T-prune-legacy-secret workers dry-run completes" 0 "$prune_int_rc"
  assert_grep "T-prune-legacy-secret workers dry-run plans the prune" \
    '\[dry-run\] bun x wrangler secret delete LXK_API_KEY --name lexa' "$prune_int_out"
  assert_eq "T-prune-legacy-secret workers dry-run executes no delete" "absent" \
    "$([ -e "${prune_int}/delete.log" ] && echo present || echo absent)"
else
  echo "SKIP: bun unavailable — T-prune-legacy-secret wiring needs the runtime"
fi

echo "== T-workers-dry-run-purity: no custody write, no mint =="

if [ "$have_bun_path" -eq 1 ]; then
  # Fresh dry-run: no deploy config, no custody → mint is planned, nothing written.
  wpur_tmp="$(mktemp -d)"
  wpur_home="$(mktemp -d)"
  wpur_rc=0
  wpur_out="$(cd "${wpur_tmp}" && HOME="${wpur_home}" INSTALL_DRY_RUN=1 bash "$INSTALL" workers --cf-token test-token 2>&1)" || wpur_rc=$?
  assert_rc "T-workers-dry-run-purity fresh dry-run completes" 0 "$wpur_rc"
  assert_eq "T-workers-dry-run-purity fresh dry-run writes no cf-workers/.env.toml" "absent" \
    "$([ -e "${wpur_tmp}/cf-workers/.env.toml" ] && echo present || echo absent)"
  assert_grep "T-workers-dry-run-purity prints the mint plan" '\[dry-run\] mint LXK_SECRETS_MASTER_KEY' "$wpur_out"
  assert_eq "T-workers-dry-run-purity generates no key material" "0" \
    "$(printf '%s' "$wpur_out" | grep -cE 'LXK_SECRETS_MASTER_KEY=[A-Za-z0-9+/]{43}=' || true)"
  assert_grep "T-workers-dry-run-purity keeps the master-key put plan visible" \
    'wrangler secret put LXK_SECRETS_MASTER_KEY' "$wpur_out"
  assert_eq "T-workers-dry-run-purity token from --cf-token is never written to disk" "absent" \
    "$([ -e "${wpur_tmp}/cf-workers/.cf-token" ] && echo present || echo absent)"

  # A `bun` shim answers `wrangler secret list` (read-only) from a fixture — no
  # real Cloudflare call.
  wpur_bin="$(mktemp -d)"
  cat > "${wpur_bin}/bun" <<'SHIM'
#!/usr/bin/env bash
case "$*" in
  *"wrangler secret list"*)
    printf '%s' "${SECRET_LIST:-[]}"
    exit "${SECRET_LIST_RC:-0}"
    ;;
esac
exit 0
SHIM
  chmod +x "${wpur_bin}/bun"

  # Config readable + remote already has the key → no mint, no put plan, no write.
  wstr_tmp="$(mktemp -d)"
  wstr_home="$(mktemp -d)"
  mkdir -p "${wstr_tmp}/cf-workers/deploy-lexa"
  printf '{"name":"lexa","vars":{"LXK_PUBLIC_URL":"https://lexa.example.workers.dev"}}\n' > "${wstr_tmp}/cf-workers/deploy-lexa/wrangler.lexa.json"
  wstr_rc=0
  wstr_out="$(cd "${wstr_tmp}" && HOME="${wstr_home}" PATH="${wpur_bin}:${PATH}" INSTALL_DRY_RUN=1 \
    SECRET_LIST='[{"name":"LXK_SECRETS_MASTER_KEY"}]' \
    bash "$INSTALL" workers --cf-token test-token 2>&1)" || wstr_rc=$?
  assert_rc "T-workers-dry-run-purity present-key dry-run completes" 0 "$wstr_rc"
  assert_eq "T-workers-dry-run-purity present key is not re-minted" "0" \
    "$(printf '%s' "$wstr_out" | grep -c '\[dry-run\] mint LXK_SECRETS_MASTER_KEY' || true)"
  assert_eq "T-workers-dry-run-purity present key has no put plan" "0" \
    "$(printf '%s' "$wstr_out" | grep -c 'wrangler secret put LXK_SECRETS_MASTER_KEY' || true)"
  assert_eq "T-workers-dry-run-purity present key writes no custody" "absent" \
    "$([ -e "${wstr_tmp}/cf-workers/.env.toml" ] && echo present || echo absent)"

  # Config readable + remote absent → mint plan, still no file.
  wabs_tmp="$(mktemp -d)"
  wabs_home="$(mktemp -d)"
  mkdir -p "${wabs_tmp}/cf-workers/deploy-lexa"
  printf '{"name":"lexa","vars":{"LXK_PUBLIC_URL":"https://lexa.example.workers.dev"}}\n' > "${wabs_tmp}/cf-workers/deploy-lexa/wrangler.lexa.json"
  wabs_rc=0
  wabs_out="$(cd "${wabs_tmp}" && HOME="${wabs_home}" PATH="${wpur_bin}:${PATH}" INSTALL_DRY_RUN=1 \
    SECRET_LIST='[]' \
    bash "$INSTALL" workers --cf-token test-token 2>&1)" || wabs_rc=$?
  assert_rc "T-workers-dry-run-purity absent-key dry-run completes" 0 "$wabs_rc"
  assert_grep "T-workers-dry-run-purity absent key plans the mint" '\[dry-run\] mint LXK_SECRETS_MASTER_KEY' "$wabs_out"
  assert_eq "T-workers-dry-run-purity absent key writes no custody" "absent" \
    "$([ -e "${wabs_tmp}/cf-workers/.env.toml" ] && echo present || echo absent)"

  # Operator custody value: untouched, not re-minted, put plan uses it.
  wop_tmp="$(mktemp -d)"
  wop_home="$(mktemp -d)"
  mkdir -p "${wop_tmp}/cf-workers/deploy-lexa"
  printf '{"name":"lexa","vars":{"LXK_PUBLIC_URL":"https://lexa.example.workers.dev"}}\n' > "${wop_tmp}/cf-workers/deploy-lexa/wrangler.lexa.json"
  printf '[other]\nLXK_SECRETS_MASTER_KEY = "OPERATORKEYVALUE"\n' > "${wop_tmp}/cf-workers/.env.toml"
  wop_before="$(cat "${wop_tmp}/cf-workers/.env.toml")"
  wop_rc=0
  wop_out="$(cd "${wop_tmp}" && HOME="${wop_home}" PATH="${wpur_bin}:${PATH}" INSTALL_DRY_RUN=1 \
    SECRET_LIST='[]' \
    bash "$INSTALL" workers --cf-token test-token 2>&1)" || wop_rc=$?
  assert_rc "T-workers-dry-run-purity operator custody dry-run completes" 0 "$wop_rc"
  assert_eq "T-workers-dry-run-purity operator custody file untouched" "$wop_before" \
    "$(cat "${wop_tmp}/cf-workers/.env.toml")"
  assert_eq "T-workers-dry-run-purity operator custody is not re-minted" "0" \
    "$(printf '%s' "$wop_out" | grep -c '\[dry-run\] mint LXK_SECRETS_MASTER_KEY' || true)"
  assert_grep "T-workers-dry-run-purity operator custody keeps the put plan" \
    'wrangler secret put LXK_SECRETS_MASTER_KEY' "$wop_out"
else
  echo "SKIP: bun unavailable — T-workers-dry-run-purity needs the runtime"
fi

echo "== T-bare-start: manual start is backgrounded + idempotent =="

barestart_tmp="$(mktemp -d)"
if [ "$have_bun" -eq 1 ]; then
  bs_out="$(cd "${barestart_tmp}" && INSTALL_DRY_RUN=1 bash "$INSTALL" bare --port 9222 2>&1)" || true
  assert_grep "T-bare-start dry-run backgrounds lexa-start.sh" 'nohup \./lexa-start\.sh > lexa\.log 2>&1' "$bs_out"
  assert_grep "T-bare-start banner shows the log path" 'Running in the background — logs: bare/lexa\.log' "$bs_out"
  assert_grep "T-bare-start banner shows the stop command" 'kill \$\(cat bare/lexa\.pid\)' "$bs_out"
  assert_grep "T-bare-start health wait surfaces the log" 'wait_for http://localhost:9222/api/health 60 bare/lexa\.log' "$bs_out"
else
  echo "SKIP: bun unavailable — bare T-bare-start needs the runtime"
fi

# A live pid in lexa.pid makes the start a no-op (never double-start).
bs_live_dir="$(mktemp -d)"
sleep 60 &
bs_live_pid=$!
printf '%s\n' "${bs_live_pid}" > "${bs_live_dir}/lexa.pid"
lib_call bare_start_manual "${bs_live_dir}" >/dev/null 2>&1 || true
assert_eq "T-bare-start live pid is a no-op (no lexa.log)" "absent" "$([ -e "${bs_live_dir}/lexa.log" ] && echo present || echo absent)"
kill "${bs_live_pid}" 2>/dev/null || true
wait "${bs_live_pid}" 2>/dev/null || true

# SEV: run the writer for real against a stub start script — the recorded pid
# must be the server (recorded in ${dir}/lexa.pid), never a `bash` wrapper in
# the caller's CWD.
bs_real_dir="$(mktemp -d)"
bs_real_cwd="$(mktemp -d)"
cat > "${bs_real_dir}/lexa-start.sh" <<'STUB'
#!/usr/bin/env bash
exec sleep 30
STUB
chmod +x "${bs_real_dir}/lexa-start.sh"
( cd "${bs_real_cwd}" && lib_call bare_start_manual "${bs_real_dir}" ) >/dev/null 2>&1 || true
assert_eq "T-bare-start writes lexa.pid inside the install dir" "present" "$([ -f "${bs_real_dir}/lexa.pid" ] && echo present || echo absent)"
assert_eq "T-bare-start writes no ./lexa.pid in the caller CWD" "absent" "$([ -e "${bs_real_cwd}/lexa.pid" ] && echo present || echo absent)"
bs_real_pid="$(cat "${bs_real_dir}/lexa.pid" 2>/dev/null || true)"
if [ -n "${bs_real_pid}" ] && kill -0 "${bs_real_pid}" 2>/dev/null; then
  assert_eq "T-bare-start recorded pid is alive (kill -0)" "alive" "alive"
  # The pid is recorded immediately, but the nohup→bash→server exec chain
  # settles a few ms later: poll for the exec'd image (never a bash wrapper).
  bs_real_cmd=""
  bs_poll=0
  while [ "$bs_poll" -lt 20 ]; do
    bs_real_cmd="$(ps -o args= -p "${bs_real_pid}" 2>/dev/null || true)"
    case "$bs_real_cmd" in *"sleep 30"*) break ;; esac
    sleep 0.1
    bs_poll=$((bs_poll + 1))
  done
  assert_grep "T-bare-start recorded pid is the exec'd server, not a bash wrapper" 'sleep 30' "${bs_real_cmd}"
  kill "${bs_real_pid}" 2>/dev/null || true
else
  assert_eq "T-bare-start recorded pid is alive (kill -0)" "alive" "dead"
fi

echo "== T-from-repo-existing: --from-repo keeps an existing env, never claims secrets =="

if [ "$have_bun" -eq 1 ]; then
  bare_repo="$(mktemp -d)"
  mkdir -p "${bare_repo}/scripts" "${bare_repo}/dist/client"
  printf 'LXK_ENV = "production"\n' > "${bare_repo}/.env.toml"
  fr_rc=0
  fr_out="$(cd "${bare_repo}" && INSTALL_DRY_RUN=1 bash "$INSTALL" bare --from-repo "${bare_repo}" --port 9338 2>&1)" || fr_rc=$?
  assert_rc "T-from-repo-existing bare dry-run completes" 0 "$fr_rc"
  assert_grep "T-from-repo-existing keeps the existing env" 'exists — kept \(dev env untouched\)' "$fr_out"
  assert_grep "T-from-repo-existing notes secrets are skipped" 'Skipping secrets setup' "$fr_out"
  assert_eq "T-from-repo-existing drops the master-key banner line" "0" "$(printf '%s' "$fr_out" | grep -c 'master key' || true)"
  assert_eq "T-from-repo-existing banner reports GitHub unconfigured" "1" "$(printf '%s' "$fr_out" | grep -c 'GitHub sync not configured' || true)"
  assert_eq "T-from-repo-existing never writes a master key" "0" "$(grep -c 'LXK_SECRETS_MASTER_KEY' "${bare_repo}/.env.toml" 2>/dev/null || true)"
  assert_eq "T-from-repo-existing leaves the env untouched" "1" "$(grep -c '^LXK_ENV = "production"$' "${bare_repo}/.env.toml" 2>/dev/null || true)"

  # A complete GitHub trio already in that env reads back as configured.
  bare_repo_trio="$(mktemp -d)"
  mkdir -p "${bare_repo_trio}/scripts" "${bare_repo_trio}/dist/client"
  {
    printf 'LXK_ENV = "production"\n'
    printf 'GITHUB_APP_ID = "123456"\n'
    printf 'GITHUB_WEBHOOK_SECRET = "whsec_SYNTH"\n'
    printf 'GITHUB_PRIVATE_KEY = "-----BEGIN KEY-----\\nMIIBSYNTHETICKEYBODY\\n-----END KEY-----"\n'
  } > "${bare_repo_trio}/.env.toml"
  fr_trio_rc=0
  fr_trio_out="$(cd "${bare_repo_trio}" && INSTALL_DRY_RUN=1 bash "$INSTALL" bare --from-repo "${bare_repo_trio}" --port 9339 2>&1)" || fr_trio_rc=$?
  assert_rc "T-from-repo-existing complete-trio dry-run completes" 0 "$fr_trio_rc"
  assert_eq "T-from-repo-existing reads back a complete trio as configured" "1" "$(printf '%s' "$fr_trio_out" | grep -c 'GitHub sync configured' || true)"
else
  echo "SKIP: bun unavailable — T-from-repo-existing needs the runtime"
fi

echo "== T-oauth-fallback: wrangler login token chain =="
oauth_home="$(mktemp -d)"
mkdir -p "${oauth_home}/.config/.wrangler/config"
printf 'oauth_token = "oauth_SYNTHETICTOKEN"\n' > "${oauth_home}/.config/.wrangler/config/default.toml"
got="$(HOME="${oauth_home}" lib_call _cf_token_from_wrangler)"
assert_eq "T-oauth-fallback reads the stored wrangler token" "oauth_SYNTHETICTOKEN" "$got"
oauth_absent_home="$(mktemp -d)"
oauth_rc=0
HOME="${oauth_absent_home}" lib_call _cf_token_from_wrangler >/dev/null 2>&1 || oauth_rc=$?
assert_rc "T-oauth-fallback absent login returns non-zero" 1 "$oauth_rc"

if [ "$have_bun_path" -eq 1 ]; then
  oauth_cwd="$(mktemp -d)"
  oauth_out="$(cd "${oauth_cwd}" && HOME="${oauth_home}" INSTALL_DRY_RUN=1 bash "$INSTALL" workers 2>&1)" || true
  assert_grep "T-oauth-fallback install uses the login silently" 'using your wrangler login — no token needed' "$oauth_out"
  assert_grep "T-oauth-fallback banner reports the deploy" 'Lexa is deployed to Cloudflare' "$oauth_out"
  assert_grep "T-oauth-fallback banner points at the dashboard" 'Find its address in the Cloudflare dashboard' "$oauth_out"
  assert_eq "T-oauth-fallback never fabricates a workers.dev URL" "0" "$(printf '%s' "$oauth_out" | grep -c 'https://lexa\.workers\.dev' || true)"
  assert_eq "T-oauth-fallback oauth token never written to disk" "absent" \
    "$([ -e "${oauth_cwd}/cf-workers/.cf-token" ] && echo present || echo absent)"
else
  echo "SKIP: bun unavailable — T-oauth-fallback login dry-run case needs the runtime"
fi

# No token anywhere: a clear, actionable error instead of a hung prompt.
oauth_none_cwd="$(mktemp -d)"
oauth_none_home="$(mktemp -d)"
oauth_none_rc=0
oauth_none_out="$(cd "${oauth_none_cwd}" && HOME="${oauth_none_home}" INSTALL_DRY_RUN=1 bash "$INSTALL" workers 2>&1)" || oauth_none_rc=$?
# The rc is 1 either way (preflight without bun); the message needs the runtime.
assert_rc "T-oauth-fallback no-credentials exits non-zero" 1 "$oauth_none_rc"
if [ "$have_bun_path" -eq 1 ]; then
  assert_grep "T-oauth-fallback no-credentials message" 'No Cloudflare credentials found — run `wrangler login` once' "$oauth_none_out"
else
  echo "SKIP: bun unavailable — T-oauth-fallback no-credentials message needs the runtime"
fi

# Dry-run touches no prior state: a stale .deployed-url must survive the run.
dw_tmp="$(mktemp -d)"
mkdir -p "${dw_tmp}/cf-workers"
printf 'https://prior-deploy.example.workers.dev\n' > "${dw_tmp}/cf-workers/.deployed-url"
dw_out="$(cd "${dw_tmp}" && INSTALL_DRY_RUN=1 bash "$INSTALL" workers --cf-token test-token 2>&1)" || true
assert_eq "T-workers-dry-run keeps a prior .deployed-url" "https://prior-deploy.example.workers.dev" \
  "$(cat "${dw_tmp}/cf-workers/.deployed-url" 2>/dev/null | tr -d '\n')"
assert_eq "T-workers-dry-run never banners the stale URL" "0" \
  "$(printf '%s' "$dw_out" | grep -c 'prior-deploy\.example\.workers\.dev' || true)"

echo "== uninstall.sh =="

rc=0
un_out="$(bash "$UNINSTALL" 2>&1)" || rc=$?
assert_rc "uninstall without target dies" 1 "$rc"
assert_grep "uninstall without target: 'target required'" 'target required' "$un_out"

if command -v setsid >/dev/null 2>&1; then
  rc=0
  purge_out="$(setsid bash "$UNINSTALL" workers --purge </dev/null 2>&1)" || rc=$?
  assert_rc "uninstall --purge without tty dies" 1 "$rc"
  assert_grep "uninstall --purge headless: purge confirm required" 'No terminal available — pass the value as a flag instead|purge is destructive|re-run on a terminal' "$purge_out"
else
  echo "SKIP: setsid not available (cannot force no-tty)"
fi

# wrangler delete tolerance: a failed worker delete warns + continues (rc 0),
# later teardown steps still run; a successful delete prints no warning.
ut_tmp="$(mktemp -d)"
mkdir -p "${ut_tmp}/bin" "${ut_tmp}/cf-workers/deploy-lexa"
: > "${ut_tmp}/cf-workers/deploy-lexa/wrangler.lexa.json"
printf '#!/usr/bin/env bash\nexit 1\n' > "${ut_tmp}/bin/bun"
chmod +x "${ut_tmp}/bin/bun"
ut_rc=0
ut_out="$(cd "${ut_tmp}" && PATH="${ut_tmp}/bin:${PATH}" WORK_DIR=cf-workers bash "$UNINSTALL" workers 2>&1)" || ut_rc=$?
assert_rc "uninstall workers tolerates a failed wrangler delete" 0 "$ut_rc"
assert_grep "uninstall workers warns on delete failure" 'worker not found or delete failed — continuing' "$ut_out"
assert_grep "uninstall workers still runs later steps" 'D1/R2/KV resources KEPT' "$ut_out"
assert_grep "uninstall workers failing step reports the real exit code" 'step failed: wrangler delete \(exit 1\)' "$ut_out"
printf '#!/usr/bin/env bash\nexit 0\n' > "${ut_tmp}/bin/bun"
chmod +x "${ut_tmp}/bin/bun"
ut_ok_out="$(cd "${ut_tmp}" && PATH="${ut_tmp}/bin:${PATH}" WORK_DIR=cf-workers bash "$UNINSTALL" workers 2>&1)" || true
assert_eq "uninstall workers prints no tolerance line on success" "0" "$(printf '%s' "$ut_ok_out" | grep -c 'worker not found or delete failed' || true)"

echo ""
echo "pass=${PASS} fail=${FAIL}"
[ "$FAIL" -eq 0 ]
