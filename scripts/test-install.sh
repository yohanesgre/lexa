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

got="$(lib_eval 'parse_flags --staging --port 9999; printf "%s:%s" "$FLAVOR" "$PORT"')"
assert_eq "parse_flags --staging --port 9999 sets FLAVOR:PORT" "staging:9999" "$got"

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

echo "== write_env_file =="

envdir="$(mktemp -d)"
lib_eval "write_env_file '${envdir}/.env' LXK_ENV=staging LXK_PUBLIC_URL=http://127.0.0.1:8080" >/dev/null 2>&1
assert_eq "write_env_file mode 0600" "600" "$(stat -c %a "${envdir}/.env")"
assert_grep "write_env_file content" '^LXK_ENV=staging$' "$(cat "${envdir}/.env")"

rogue_rc=0
lib_eval "write_env_file '${envdir}/rogue.env' ROGUE_KEY=1" >/dev/null 2>&1 || rogue_rc=$?
assert_rc "write_env_file rogue key dies" 1 "$rogue_rc"
if [ -e "${envdir}/rogue.env" ]; then
  assert_eq "write_env_file rogue key writes no file" "absent" "present"
else
  assert_eq "write_env_file rogue key writes no file" "absent" "absent"
fi

echo "== compose_render forwards auth origin env =="

compdir="$(mktemp -d)"
DEPLOY_DIR="${compdir}" lib_eval "compose_render direct 8080 127.0.0.1" >/dev/null 2>&1
assert_grep "compose direct forwards LXK_PUBLIC_URL" '^\s+- LXK_PUBLIC_URL=' "$(cat "${compdir}/docker-compose.yml")"
assert_grep "compose direct forwards LXK_TRUSTED_ORIGINS" '^\s+- LXK_TRUSTED_ORIGINS=' "$(cat "${compdir}/docker-compose.yml")"
DEPLOY_DIR="${compdir}" lib_eval "compose_render staging 8080 127.0.0.1" >/dev/null 2>&1
assert_grep "compose staging forwards LXK_PUBLIC_URL" '^\s+- LXK_PUBLIC_URL=' "$(cat "${compdir}/docker-compose.yml")"

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
assert_grep "dry-run .env writes LXK_TRUSTED_ORIGINS" '^LXK_TRUSTED_ORIGINS=.*http://localhost:9191' "$(cat "${drydir}/lexa-deploy/.env" 2>/dev/null)"

fake_calls="$(grep -v 'compose version' "${FAKE_DOCKER_LOG}" || true)"
assert_eq "no mutating docker calls executed (shim log)" "" "$fake_calls"

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
