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
printf 'LXK_MCP_MASTER_KEY=AAAA\nLOG_LEVEL=debug\nTYPESAFE_API_KEY=tf-key\nLXK_S3_BUCKET=bucket\nPORT="3100"\nLXK_API_KEY=dead\n' > "${migdir}/.env"
mig_rc=0
lib_call migrate_legacy_deploy_env "${migdir}" >/dev/null 2>&1 || mig_rc=$?
assert_rc "migration with non-whitelist keys does not die" 0 "$mig_rc"
mig_body="$(cat "${migdir}/.env.toml" 2>/dev/null)"
assert_grep "migration carries LXK_MCP_MASTER_KEY" '^LXK_MCP_MASTER_KEY = "AAAA"$' "$mig_body"
assert_grep "migration carries LOG_LEVEL" '^LOG_LEVEL = "debug"$' "$mig_body"
assert_grep "migration carries TYPESAFE_API_KEY" '^TYPESAFE_API_KEY = "tf-key"$' "$mig_body"
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
assert_grep "grant_container_read warns when chown fails" 'could not re-own' "$gtfail_out"
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
assert_grep "dry-run prints final banner" 'running at http://127.0.0.1:9191' "$dry_out"
assert_eq "dry-run renders docker-compose.yml" "present" "$([ -f "${drydir}/lexa-deploy/docker-compose.yml" ] && echo present || echo absent)"
assert_grep "dry-run .env.toml writes LXK_TRUSTED_ORIGINS" '^LXK_TRUSTED_ORIGINS = ".*http://localhost:9191' "$(cat "${drydir}/lexa-deploy/.env.toml" 2>/dev/null)"
assert_grep "dry-run .env.toml writes DATABASE_PATH" '^DATABASE_PATH = "/app/data/lexa.db"$' "$(cat "${drydir}/lexa-deploy/.env.toml" 2>/dev/null)"
assert_grep "dry-run .env keeps tooling LXK_IMAGE_TAG" '^LXK_IMAGE_TAG=latest$' "$(cat "${drydir}/lexa-deploy/.env" 2>/dev/null)"
assert_eq "dry-run flat .env has no app keys" "0" "$(grep -c 'LXK_PUBLIC_URL' "${drydir}/lexa-deploy/.env" 2>/dev/null || true)"
assert_eq "dry-run .env.toml mode 0600" "600" "$(stat -c %a "${drydir}/lexa-deploy/.env.toml")"
assert_grep "dry-run marks env mount perms step" 'grant_container_read' "$dry_out"
assert_grep "dry-run logs grant_container_read intent" '\[dry-run\] chmod 640' "$dry_out"

fake_calls="$(grep -v 'compose version' "${FAKE_DOCKER_LOG}" || true)"
assert_eq "no mutating docker calls executed (shim log)" "" "$fake_calls"

echo "== installer re-run preserves operator keys =="

presdir="$(mktemp -d)"
mkdir -p "${presdir}/bin" "${presdir}/lexa-deploy"
cat > "${presdir}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${presdir}/bin/docker"
printf '[github]\nGITHUB_APP_ID = "999"\nGITHUB_PRIVATE_KEY_FILE = "/app/github-app.private-key.pem"\n\n[urls]\nLXK_PUBLIC_URL = "http://old.example"\n' > "${presdir}/lexa-deploy/.env.toml"
pres_rc=0
(cd "${presdir}" && INSTALL_DRY_RUN=1 PATH="${presdir}/bin:${PATH}" bash "$INSTALL" docker --port 9292 >/dev/null 2>&1) || pres_rc=$?
assert_rc "re-run install.sh docker completes" 0 "$pres_rc"
pres_body="$(cat "${presdir}/lexa-deploy/.env.toml")"
assert_grep "re-run preserves GITHUB_APP_ID" '^GITHUB_APP_ID = "999"$' "$pres_body"
assert_grep "re-run preserves GITHUB_PRIVATE_KEY_FILE" '^GITHUB_PRIVATE_KEY_FILE = "/app/github-app.private-key.pem"$' "$pres_body"
assert_grep "re-run updates installer-owned LXK_PUBLIC_URL" '^LXK_PUBLIC_URL = "http://127.0.0.1:9292"$' "$pres_body"

echo "== installer preserves pinned tooling keys =="

pindir="$(mktemp -d)"
mkdir -p "${pindir}/bin" "${pindir}/lexa-deploy"
cat > "${pindir}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${pindir}/bin/docker"
printf '[core]\nLXK_ENV = "production"\n' > "${pindir}/lexa-deploy/.env.toml"
printf 'COMPOSE_PROJECT_NAME=myproj\nLXK_IMAGE_TAG=v2026.2.9\n' > "${pindir}/lexa-deploy/.env"
pin_rc=0
(cd "${pindir}" && INSTALL_DRY_RUN=1 PATH="${pindir}/bin:${PATH}" bash "$INSTALL" docker --port 9494 >/dev/null 2>&1) || pin_rc=$?
assert_rc "pinned-tag re-run install.sh docker completes" 0 "$pin_rc"
pin_env="$(cat "${pindir}/lexa-deploy/.env")"
assert_grep "re-run preserves COMPOSE_PROJECT_NAME" '^COMPOSE_PROJECT_NAME=myproj$' "$pin_env"
assert_grep "re-run preserves pinned LXK_IMAGE_TAG" '^LXK_IMAGE_TAG=v2026.2.9$' "$pin_env"

pin2_rc=0
(cd "${pindir}" && INSTALL_DRY_RUN=1 PATH="${pindir}/bin:${PATH}" bash "$INSTALL" docker --port 9494 --image staging >/dev/null 2>&1) || pin2_rc=$?
assert_rc "--image re-run install.sh docker completes" 0 "$pin2_rc"
pin2_env="$(cat "${pindir}/lexa-deploy/.env")"
assert_grep "--image overrides pinned LXK_IMAGE_TAG" '^LXK_IMAGE_TAG=staging$' "$pin2_env"
assert_grep "--image keeps COMPOSE_PROJECT_NAME" '^COMPOSE_PROJECT_NAME=myproj$' "$pin2_env"

echo "== installer migrates a legacy deploy dir =="
legdir="$(mktemp -d)"
mkdir -p "${legdir}/bin" "${legdir}/lexa-deploy"
cat > "${legdir}/bin/docker" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${legdir}/bin/docker"
printf 'LXK_ENV=production\nLXK_PUBLIC_URL=http://old.example\nGITHUB_APP_ID=42\nGITHUB_WEBHOOK_SECRET=shh\nLXK_API_KEY=dead\n' > "${legdir}/lexa-deploy/.env"
leg_rc=0
(cd "${legdir}" && INSTALL_DRY_RUN=1 PATH="${legdir}/bin:${PATH}" bash "$INSTALL" docker --port 9393 >/dev/null 2>&1) || leg_rc=$?
assert_rc "legacy-dir install.sh docker completes" 0 "$leg_rc"
assert_eq "legacy .env renamed to .env.legacy" "present" "$([ -f "${legdir}/lexa-deploy/.env.legacy" ] && echo present || echo absent)"
leg_toml="$(cat "${legdir}/lexa-deploy/.env.toml")"
assert_grep "legacy migration preserves GITHUB_APP_ID" '^GITHUB_APP_ID = "42"$' "$leg_toml"
assert_grep "legacy migration preserves GITHUB_WEBHOOK_SECRET" '^GITHUB_WEBHOOK_SECRET = "shh"$' "$leg_toml"
assert_grep "legacy migration carries LXK_ENV" '^LXK_ENV = "production"$' "$leg_toml"
assert_eq "legacy migration drops dead key" "0" "$(grep -c 'LXK_API_KEY' "${legdir}/lexa-deploy/.env.toml" || true)"
assert_grep "legacy dir now has tooling-only .env" '^LXK_IMAGE_TAG=latest$' "$(cat "${legdir}/lexa-deploy/.env")"

if command -v docker >/dev/null 2>&1; then
  containers_after=$(docker ps -q 2>/dev/null | wc -l)
  assert_eq "no container started (docker ps before/after)" "$containers_before" "$containers_after"
fi

echo "== uninstall.sh =="

rc=0
un_out="$(bash "$UNINSTALL" 2>&1)" || rc=$?
assert_rc "uninstall without target dies" 1 "$rc"
assert_grep "uninstall without target: 'target required'" 'target required' "$un_out"

if command -v setsid >/dev/null 2>&1; then
  rc=0
  purge_out="$(setsid bash "$UNINSTALL" workers --purge </dev/null 2>&1)" || rc=$?
  assert_rc "uninstall --purge without tty dies" 1 "$rc"
  assert_grep "uninstall --purge headless: purge confirm required" 'headless: pass --flag instead|purge is destructive|re-run on a terminal' "$purge_out"
else
  echo "SKIP: setsid not available (cannot force no-tty)"
fi

echo ""
echo "pass=${PASS} fail=${FAIL}"
[ "$FAIL" -eq 0 ]
