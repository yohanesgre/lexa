#!/usr/bin/env bash
# Tests for scripts/install.sh / install-lib.sh / uninstall.sh.
# No framework: assert helpers + PASS/FAIL counters, non-zero exit on any FAIL.
# Dry-run tests prove no mutating command executes under INSTALL_DRY_RUN=1 and
# no real Cloudflare call is made (design-deploy-tooling.md §9 test-swap).
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

got="$(lib_eval 'parse_flags --ref v2026.2.9 --name lexa; printf "%s:%s" "$REF" "$NAME"')"
assert_eq "parse_flags --ref --name sets REF:NAME" "v2026.2.9:lexa" "$got"

got="$(lib_eval 'parse_flags --account acct-123; printf "%s" "$ACCOUNT"')"
assert_eq "parse_flags --account sets ACCOUNT" "acct-123" "$got"

rc=0
lib_eval 'parse_flags --account' >/dev/null 2>&1 || rc=$?
assert_rc "parse_flags --account requires a value" 1 "$rc"

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

echo "== resolve_shell_account =="

acctdir="$(mktemp -d)"
mkdir -p "${acctdir}/deploy-lexa"
printf '{\n  "name": "lexa",\n  "account_id": "acct-abc123"\n}\n' > "${acctdir}/deploy-lexa/wrangler.lexa.json"
got="$(lib_call resolve_shell_account "${acctdir}" lexa)"
assert_eq "resolve_shell_account reads the prior config account_id" "acct-abc123" "$got"

got="$(lib_call resolve_shell_account "${acctdir}/missing" lexa)"
assert_eq "resolve_shell_account absent dir is empty" "" "$got"

malformed_dir="$(mktemp -d)"
mkdir -p "${malformed_dir}/deploy-lexa"
printf '{ this is not json\n' > "${malformed_dir}/deploy-lexa/wrangler.lexa.json"
got="$(lib_call resolve_shell_account "${malformed_dir}" lexa)"
assert_eq "resolve_shell_account malformed JSON is empty" "" "$got"
rm -rf "${acctdir}" "${malformed_dir}"

echo "== prune_workdir =="

prunedir="$(mktemp -d)"
mkdir -p "${prunedir}/deploy-lexa" "${prunedir}/deploy-staging" \
  "${prunedir}/dist" "${prunedir}/scripts" "${prunedir}/migrations"
: > "${prunedir}/.env.toml"
: > "${prunedir}/x.tar.gz"
: > "${prunedir}/checksums.txt"
: > "${prunedir}/.cf-token"
lib_call prune_workdir "${prunedir}"
assert_eq "prune_workdir keeps deploy-lexa/" "present" "$([ -d "${prunedir}/deploy-lexa" ] && echo present || echo absent)"
assert_eq "prune_workdir keeps deploy-staging/" "present" "$([ -d "${prunedir}/deploy-staging" ] && echo present || echo absent)"
assert_eq "prune_workdir keeps .env.toml custody" "present" "$([ -f "${prunedir}/.env.toml" ] && echo present || echo absent)"
assert_eq "prune_workdir keeps the release tarball" "present" "$([ -f "${prunedir}/x.tar.gz" ] && echo present || echo absent)"
assert_eq "prune_workdir keeps checksums.txt" "present" "$([ -f "${prunedir}/checksums.txt" ] && echo present || echo absent)"
assert_eq "prune_workdir keeps .cf-token" "present" "$([ -f "${prunedir}/.cf-token" ] && echo present || echo absent)"
assert_eq "prune_workdir removes dist/" "absent" "$([ -e "${prunedir}/dist" ] && echo present || echo absent)"
assert_eq "prune_workdir removes scripts/" "absent" "$([ -e "${prunedir}/scripts" ] && echo present || echo absent)"
assert_eq "prune_workdir removes migrations/" "absent" "$([ -e "${prunedir}/migrations" ] && echo present || echo absent)"
rm -rf "${prunedir}"

prunedry="$(mktemp -d)"
mkdir -p "${prunedry}/dist"
INSTALL_DRY_RUN=1 lib_call prune_workdir "${prunedry}" >/dev/null 2>&1
assert_eq "prune_workdir skips entirely under INSTALL_DRY_RUN=1" "present" "$([ -e "${prunedry}/dist" ] && echo present || echo absent)"
rm -rf "${prunedry}"

echo "== deploy_worker_name =="

dwdir="$(mktemp -d)"
mkdir -p "${dwdir}/deploy-prod"
printf '{"name":"lexa"}\n' > "${dwdir}/deploy-prod/wrangler.prod.json"
got="$(lib_call deploy_worker_name "${dwdir}" prod)"
assert_eq "deploy_worker_name reads the config name (prod → lexa)" "lexa" "$got"
got="$(lib_call deploy_worker_name "${dwdir}/missing" prod)"
assert_eq "deploy_worker_name missing config maps prod → lexa" "lexa" "$got"
got="$(lib_call deploy_worker_name "${dwdir}/missing" staging)"
assert_eq "deploy_worker_name missing config maps staging → lexa-staging" "lexa-staging" "$got"
got="$(lib_call deploy_worker_name "${dwdir}/missing" acme)"
assert_eq "deploy_worker_name unknown flavor falls back to itself" "acme" "$got"

dwcustom="$(mktemp -d)"
mkdir -p "${dwcustom}/deploy-prod"
printf '{"name":"custom-worker"}\n' > "${dwcustom}/deploy-prod/wrangler.prod.json"
got="$(lib_call deploy_worker_name "${dwcustom}" prod)"
assert_eq "deploy_worker_name config name beats the alias map" "custom-worker" "$got"

dwbad="$(mktemp -d)"
mkdir -p "${dwbad}/deploy-prod"
printf '{ this is not json\n' > "${dwbad}/deploy-prod/wrangler.prod.json"
got="$(lib_call deploy_worker_name "${dwbad}" prod)"
assert_eq "deploy_worker_name unparseable config maps prod → lexa" "lexa" "$got"

# A realistic full workers config (the shape workers-install.ts emits) still
# resolves to the top-level name, not a nested one.
dwreal="$(mktemp -d)"
mkdir -p "${dwreal}/deploy-prod"
printf '{\n  "name": "lexa",\n  "account_id": "acct-abc123",\n  "main": "dist/index.js",\n  "vars": {\n    "LXK_ENV": "production",\n    "LXK_PUBLIC_URL": "https://lexa.example.workers.dev"\n  },\n  "d1_databases": [\n    { "binding": "DB", "database_name": "lexa-db", "database_id": "abc-123" }\n  ]\n}\n' \
  > "${dwreal}/deploy-prod/wrangler.prod.json"
got="$(lib_call deploy_worker_name "${dwreal}" prod)"
assert_eq "deploy_worker_name realistic config resolves the top-level name" "lexa" "$got"
rm -rf "${dwdir}" "${dwcustom}" "${dwbad}" "${dwreal}"

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

toml_out="$(lib_call env_to_toml 'LXK_SECRETS_MASTER_KEY=abc' 'LXK_ENV=production' 'DATABASE_PATH=/app/data/lexa.db')"
assert_grep "env_to_toml secrets key lands in other section" '^\[other\]$' "$toml_out"
assert_grep "env_to_toml string value" '^LXK_SECRETS_MASTER_KEY = "abc"$' "$toml_out"
assert_grep "env_to_toml urls section" '^\[urls\]$' "$toml_out"
assert_grep "env_to_toml core section" '^\[core\]$' "$toml_out"

gh_toml="$(lib_call env_to_toml 'GITHUB_APP_ID=123')"
assert_eq "env_to_toml emits no github section" "0" "$(printf '%s' "$gh_toml" | grep -c '^\[github\]$' || true)"

got="$(lib_call env_to_toml 'LXK_SECRETS_MASTER_KEY=a b#c')"
assert_grep "env_to_toml quotes spaces and #" '^LXK_SECRETS_MASTER_KEY = "a b#c"$' "$got"

pem="$(lib_call env_to_toml "$(printf 'LXK_SECRETS_MASTER_KEY=%s' $'-----BEGIN KEY-----\nMIIB\n-----END KEY-----')")"
assert_grep "env_to_toml multiline value escapes newlines" 'LXK_SECRETS_MASTER_KEY = "-----BEGIN KEY-----\\nMIIB\\n-----END KEY-----"' "$pem"

rc=0
lib_call env_to_toml 'bad key=1' >/dev/null 2>&1 || rc=$?
assert_rc "env_to_toml invalid key dies" 1 "$rc"

echo "== write_env_toml =="

tomldir="$(mktemp -d)"
lib_call write_env_toml "${tomldir}/.env.toml" 'LXK_ENV=staging' 'LXK_ADMIN_EMAILS=ops@example.com' >/dev/null 2>&1
assert_eq "write_env_toml mode 0600" "600" "$(stat -c %a "${tomldir}/.env.toml")"
assert_grep "write_env_toml content" '^LXK_ENV = "staging"$' "$(cat "${tomldir}/.env.toml")"

lib_call write_env_toml "${tomldir}/.env.toml" 'LXK_ENV=production' >/dev/null 2>&1
toml_merged="$(cat "${tomldir}/.env.toml")"
assert_grep "write_env_toml updates passed key" '^LXK_ENV = "production"$' "$toml_merged"
assert_grep "write_env_toml preserves operator-added key" '^LXK_ADMIN_EMAILS = "ops@example.com"$' "$toml_merged"
assert_eq "write_env_toml no duplicate LXK_ENV" "1" "$(grep -c 'LXK_ENV' "${tomldir}/.env.toml")"

rogue_toml_rc=0
lib_call write_env_toml "${tomldir}/rogue.toml" 'ROGUE_KEY=1' >/dev/null 2>&1 || rogue_toml_rc=$?
assert_rc "write_env_toml rogue key dies" 1 "$rogue_toml_rc"
assert_eq "write_env_toml rogue writes no file" "absent" "$([ -e "${tomldir}/rogue.toml" ] && echo present || echo absent)"

gh_toml_rc=0
lib_call write_env_toml "${tomldir}/github.toml" 'GITHUB_APP_ID=1' >/dev/null 2>&1 || gh_toml_rc=$?
assert_rc "write_env_toml rejects a GITHUB_* key (dead key)" 1 "$gh_toml_rc"
assert_eq "write_env_toml GITHUB rejection writes no file" "absent" "$([ -e "${tomldir}/github.toml" ] && echo present || echo absent)"

# NIT: appending must not glue onto a file with no trailing newline.
printf 'LXK_ENV = "staging"' > "${tomldir}/noeol.toml"
lib_call write_env_toml "${tomldir}/noeol.toml" 'PORT=3000' >/dev/null 2>&1
assert_grep "write_env_toml appends after missing trailing newline" '^PORT = "3000"$' "$(cat "${tomldir}/noeol.toml")"
assert_eq "write_env_toml did not glue lines" "2" "$(wc -l < "${tomldir}/noeol.toml")"

echo "== GITHUB_* are dead keys (never allowed, never carried) =="

dead_keys="$(lib_eval 'printf "%s" "$ENV_FILE_DEAD_KEYS"')"
allowed_keys="$(lib_eval 'printf "%s" "$ENV_FILE_ALLOWED_KEYS"')"
for ghkey in GITHUB_APP_ID GITHUB_PRIVATE_KEY GITHUB_PRIVATE_KEY_FILE GITHUB_WEBHOOK_SECRET; do
  assert_grep "ENV_FILE_DEAD_KEYS lists ${ghkey}" " ${ghkey} " "$dead_keys"
  assert_eq "ENV_FILE_ALLOWED_KEYS excludes ${ghkey}" "0" "$(printf '%s' "$allowed_keys" | grep -c " ${ghkey} " || true)"
done

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

echo "== T-dirs: self-describing target dirs in the CWD =="

BASH_BIN="$(command -v bash)"
# Workers dry-runs run with a temp HOME (wrangler-config isolation), so the
# installer there can only resolve bun from PATH — guard them on PATH alone.
have_bun_path=0
command -v bun >/dev/null 2>&1 && have_bun_path=1

if [ "$have_bun_path" -eq 1 ]; then
  dirs_workers="$(mktemp -d)"
  dirs_workers_home="$(mktemp -d)"
  workers_rc=0
  (cd "${dirs_workers}" && HOME="${dirs_workers_home}" INSTALL_DRY_RUN=1 bash "$INSTALL" workers --cf-token test-token >/dev/null 2>&1) || workers_rc=$?
  assert_rc "T-dirs workers dry-run completes" 0 "$workers_rc"
  assert_eq "T-dirs workers writes cf-workers/" "present" "$([ -d "${dirs_workers}/cf-workers" ] && echo present || echo absent)"
  assert_eq "T-dirs workers writes no lexa-workers-release/" "absent" "$([ -e "${dirs_workers}/lexa-workers-release" ] && echo present || echo absent)"
else
  echo "SKIP: bun unavailable — T-dirs workers case needs the runtime"
fi

echo "== T-dev-removed: dev target aborts with clone guidance =="

devdir="$(mktemp -d)"
dev_rc=0
dev_out="$(cd "${devdir}" && bash "$INSTALL" dev 2>&1)" || dev_rc=$?
assert_rc "T-dev-removed dev target exits non-zero" 1 "$dev_rc"
assert_grep "T-dev-removed names the removed target" "The 'dev' target was removed" "$dev_out"
assert_grep "T-dev-removed gives the clone command" 'git clone https://github.com/yohanesgre/lexa && cd lexa' "$dev_out"
assert_grep "T-dev-removed gives the dev command" 'bun install && bun run setup && bun run dev' "$dev_out"
assert_eq "T-dev-removed creates no clone dir" "absent" "$([ -e "${devdir}/lexa" ] && echo present || echo absent)"

echo "== T-preflight-missing: aggregate prereq list (restricted PATH) =="

pftmp="$(mktemp -d)"
mkdir -p "${pftmp}/bin"
# Keep only the one external the script needs before the preflight (dirname);
# curl/tar/bun/sha256sum are then absent from PATH, and HOME hides ~/.bun.
ln -s "$(command -v dirname)" "${pftmp}/bin/dirname"
pf_rc=0
pf_out="$(cd "${pftmp}" && PATH="${pftmp}/bin" HOME="${pftmp}/home" "$BASH_BIN" "$INSTALL" workers 2>&1)" || pf_rc=$?
assert_rc "T-preflight-missing exits non-zero" 1 "$pf_rc"
assert_grep "T-preflight-missing header copy" 'Missing prerequisites — fix these, then re-run:' "$pf_out"
assert_grep "T-preflight-missing lists curl + fix" 'curl — usually built in' "$pf_out"
assert_grep "T-preflight-missing lists tar + fix" 'tar — usually built in' "$pf_out"
assert_grep "T-preflight-missing lists bun + install cmd" 'bun — curl -fsSL https://bun\.sh/install \| bash' "$pf_out"
assert_grep "T-preflight-missing lists sha256 tool" 'sha256sum \(or shasum\) — install your distro' "$pf_out"
assert_eq "T-preflight-missing lists ALL four tools" "4" "$(printf '%s' "$pf_out" | grep -c '^  • ' || true)"
assert_eq "T-preflight-missing creates no target dir" "absent" "$([ -e "${pftmp}/cf-workers" ] && echo present || echo absent)"

echo "== T-secrets-file: --secrets-file applies, never prints values =="

sec_fix_secret="SYNTHETICMASTERKEYVALUE"

# A GITHUB_* key is no longer allowed in --secrets-file: rejected, never skipped.
gh_tmp="$(mktemp -d)"
printf 'GITHUB_APP_ID=123456\n' > "${gh_tmp}/secrets.env"
gh_rc=0
gh_out="$(cd "${gh_tmp}" && INSTALL_DRY_RUN=1 bash "$INSTALL" workers --cf-token test-token --secrets-file "${gh_tmp}/secrets.env" 2>&1)" || gh_rc=$?
assert_rc "T-secrets-file rejects a GitHub key" 1 "$gh_rc"
assert_grep "T-secrets-file names the rejected GitHub key" 'Secrets file: key GITHUB_APP_ID not allowed — use the installer whitelist keys \(see docs/DEPLOYMENT\.md\), then re-run\.' "$gh_out"
assert_eq "T-secrets-file GitHub key writes no GITHUB_APP_ID" "0" "$(grep -rl 'GITHUB_APP_ID' "${gh_tmp}/cf-workers" 2>/dev/null | wc -l | tr -d ' ')"

# A key outside the installer whitelist is refused (never written).
bad_tmp="$(mktemp -d)"
printf 'ROGUE_KEY=1\n' > "${bad_tmp}/secrets.env"
bad_rc=0
bad_out="$(cd "${bad_tmp}" && INSTALL_DRY_RUN=1 bash "$INSTALL" workers --cf-token test-token --secrets-file "${bad_tmp}/secrets.env" 2>&1)" || bad_rc=$?
assert_rc "T-secrets-file rejects a non-whitelisted key" 1 "$bad_rc"
assert_grep "T-secrets-file names the rejected key" 'Secrets file: key ROGUE_KEY not allowed — use the installer whitelist keys \(see docs/DEPLOYMENT\.md\), then re-run\.' "$bad_out"

# A missing --secrets-file names the path and the next action.
nf_out="$(lib_eval 'secrets_load_file /nonexistent/lexa-nope.env' 2>&1 || true)"
assert_grep "T-secrets-file missing file names the path + next action" 'Secrets file not found: /nonexistent/lexa-nope\.env — pass an existing file, then re-run\.' "$nf_out"

# MED5: a malformed line reports only its number — never the line content.
mal_tmp="$(mktemp -d)"
printf 'LXK_SECRETS_MASTER_KEY=1\nthis line has no equals sign\n' > "${mal_tmp}/secrets.env"
mal_rc=0
mal_out="$(cd "${mal_tmp}" && INSTALL_DRY_RUN=1 bash "$INSTALL" workers --cf-token test-token --secrets-file "${mal_tmp}/secrets.env" 2>&1)" || mal_rc=$?
assert_rc "T-secrets-file malformed line exits non-zero" 1 "$mal_rc"
assert_grep "T-secrets-file malformed line reports its number" 'line 2' "$mal_out"
assert_eq "T-secrets-file malformed line never echoes the content" "0" "$(printf '%s' "$mal_out" | grep -c 'this line has no equals sign' || true)"

# workers: the master key is pushed with `wrangler secret put` and written to custody.
if [ "$have_bun_path" -eq 1 ]; then
  sec_w_tmp="$(mktemp -d)"
  sec_w_home="$(mktemp -d)"
  printf 'LXK_SECRETS_MASTER_KEY=%s\n' "${sec_fix_secret}" > "${sec_w_tmp}/secrets.env"
  secw_rc=0
  secw_out="$(cd "${sec_w_tmp}" && HOME="${sec_w_home}" INSTALL_DRY_RUN=1 \
    bash "$INSTALL" workers --cf-token test-token --secrets-file "${sec_w_tmp}/secrets.env" 2>&1)" || secw_rc=$?
  assert_rc "T-secrets-file workers dry-run completes" 0 "$secw_rc"
  assert_grep "T-secrets-file workers plans the master-key put" 'wrangler secret put LXK_SECRETS_MASTER_KEY --name lexa' "$secw_out"
  secw_custody="$(cat "${sec_w_tmp}/cf-workers/.env.toml" 2>/dev/null)"
  assert_grep "T-secrets-file workers writes the master key to custody" "^LXK_SECRETS_MASTER_KEY = \"${sec_fix_secret}\"\$" "$secw_custody"
  assert_grep "T-secrets-file workers passes the deploy config to secret put" 'wrangler secret put LXK_SECRETS_MASTER_KEY --name lexa --config deploy-lexa/wrangler.lexa.json' "$secw_out"
  assert_eq "T-secrets-file workers never prints the master key" "0" "$(printf '%s' "$secw_out" | grep -c "${sec_fix_secret}" || true)"
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

echo "== T-workers-ambiguous: several deploy-* dirs + no --name die before credentials =="

# Two previous deploy dirs and no --name: resolve_deploy_name dies with the
# ambiguity message. That die runs above the credential chain, so the run needs
# no token — INSTALL_DRY_RUN keeps it offline, --yes skips the fresh-deploy confirm.
if [ "$have_bun_path" -eq 1 ]; then
  amb_tmp="$(mktemp -d)"
  amb_home="$(mktemp -d)"
  mkdir -p "${amb_tmp}/cf-workers/deploy-lexa" "${amb_tmp}/cf-workers/deploy-staging"
  amb_rc=0
  amb_out="$(cd "${amb_tmp}" && HOME="${amb_home}" INSTALL_DRY_RUN=1 \
    bash "$INSTALL" workers --yes 2>&1)" || amb_rc=$?
  assert_rc "T-workers-ambiguous several deploy dirs exit 1" 1 "$amb_rc"
  assert_grep "T-workers-ambiguous dies with the resolve_deploy_name message" \
    'multiple previous workers deploys in cf-workers — pass --name explicitly' "$amb_out"
  rm -rf "${amb_tmp}" "${amb_home}"
else
  echo "SKIP: bun unavailable — T-workers-ambiguous needs the runtime"
fi

echo "== T-worker-alias: wrangler commands target the config worker, not the flavor =="

# A prod-flavor deploy whose config names worker `lexa`: the deprecated alias
# (--name prod) still reaches workers-install.ts, but every wrangler secret/
# list/prune call must target `lexa` from the config — never the flavor `prod`.
if [ "$have_bun_path" -eq 1 ]; then
  alias_tmp="$(mktemp -d)"
  alias_home="$(mktemp -d)"
  mkdir -p "${alias_tmp}/bin" "${alias_tmp}/cf-workers/deploy-prod"
  printf '{"name":"lexa","vars":{"LXK_PUBLIC_URL":"https://lexa.example.workers.dev"}}\n' \
    > "${alias_tmp}/cf-workers/deploy-prod/wrangler.prod.json"
  : > "${alias_tmp}/list.log"
  cat > "${alias_tmp}/bin/bun" <<'SHIM'
#!/usr/bin/env bash
case "$*" in
  *"wrangler secret list"*)
    printf '%s\n' "$*" >> "${ALIAS_LIST_LOG:-/dev/null}"
    printf '%s' "${ALIAS_LIST:-[]}"
    exit 0
    ;;
esac
exit 0
SHIM
  chmod +x "${alias_tmp}/bin/bun"
  alias_rc=0
  alias_out="$(cd "${alias_tmp}" && HOME="${alias_home}" PATH="${alias_tmp}/bin:${PATH}" INSTALL_DRY_RUN=1 \
    ALIAS_LIST='[{"name":"LXK_API_KEY","type":"secret_text"}]' \
    ALIAS_LIST_LOG="${alias_tmp}/list.log" \
    bash "$INSTALL" workers --cf-token test-token --name prod 2>&1)" || alias_rc=$?
  assert_rc "T-worker-alias prod-flavor dry-run completes" 0 "$alias_rc"
  assert_grep "T-worker-alias master-key put targets config worker lexa" \
    'wrangler secret put LXK_SECRETS_MASTER_KEY --name lexa --config deploy-prod/wrangler\.prod\.json' "$alias_out"
  assert_grep "T-worker-alias prune delete targets config worker lexa" \
    '\[dry-run\] bun x wrangler secret delete LXK_API_KEY --name lexa --config deploy-prod/wrangler\.prod\.json' "$alias_out"
  alias_list_log="$(cat "${alias_tmp}/list.log" 2>/dev/null || true)"
  assert_grep "T-worker-alias secret list pins config worker lexa" \
    'wrangler secret list --name lexa --config deploy-prod/wrangler\.prod\.json' "$alias_list_log"
  assert_eq "T-worker-alias no wrangler secret call targets the flavor prod" "0" \
    "$(printf '%s' "$alias_out" | grep -cE 'wrangler secret (put|delete|list)( [A-Za-z_]+)? --name prod' || true)"
  rm -rf "${alias_tmp}" "${alias_home}"
else
  echo "SKIP: bun unavailable — T-worker-alias needs the runtime"
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

echo "== T-workers-account: --account reaches the deploy plan =="

# Hermetic: a fake `bun` satisfies preflight and the read-only secret checks
# (fresh dir → no config → no bun call); the deploy step is dry-run, so the
# workers-install.ts argv is printed, never executed. No Cloudflare call.
acct_tmp="$(mktemp -d)"
acct_home="$(mktemp -d)"
mkdir -p "${acct_tmp}/bin"
cat > "${acct_tmp}/bin/bun" <<'SHIM'
#!/usr/bin/env bash
exit 0
SHIM
chmod +x "${acct_tmp}/bin/bun"
acct_rc=0
acct_out="$(cd "${acct_tmp}" && HOME="${acct_home}" PATH="${acct_tmp}/bin:${PATH}" INSTALL_DRY_RUN=1 \
  bash "$INSTALL" workers --cf-token test-token --account test-account 2>&1)" || acct_rc=$?
assert_rc "T-workers-account --account dry-run completes" 0 "$acct_rc"
assert_grep "T-workers-account plan passes --account through" \
  'bun scripts/workers-install\.ts --name lexa --account test-account' "$acct_out"
assert_grep "T-workers-account usage documents the flag" \
  'account <id>' "$(lib_call usage)"

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

echo "== copy: wrangler login refresh hint =="

assert_grep "copy: verification failure names wrangler whoami refresh" \
  'wrangler whoami.*to refresh it, or enter a token' "$(cat "$INSTALL")"
assert_grep "copy: headless credentials die names wrangler whoami refresh" \
  'wrangler whoami.*once to refresh an expired login, then re-run' "$(cat "$INSTALL")"

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
