#!/usr/bin/env bash
# ci-local — local mirror of .github/workflows/ci.yml
# Usage: bun run ci:local  |  bash scripts/ci-local.sh
# Env: LXK_SKIP_PREPARE=1 is set inside (matches CI).
# Missing optional tools (docker, gitleaks) warn and skip.
# Wireframes private submodule: skips gracefully if absent.
set -euo pipefail

export LXK_SKIP_PREPARE=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HARD_FAILS=0
WARNS=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
DIM='\033[0;90m'
RST='\033[0m'

section() { echo ""; echo -e "${DIM}━━━ $* ━━━${RST}"; }
ok()      { echo -e "${GREEN}✔ $*${RST}"; }
warn()    { echo -e "${YELLOW}⚠ $*${RST}"; WARNS=$((WARNS+1)); }
fail()    { echo -e "${RED}✘ $*${RST}"; HARD_FAILS=$((HARD_FAILS+1)); }

trap 'docker rm -f lexa-ci >/dev/null 2>&1 || true' EXIT

# ── Restore wireframes submodule gracefully ───────────────────────────
section "wireframes submodule"
if git submodule update --init --recursive 2>&1; then
  ok "wireframes submodule restored"
else
  warn "wireframes submodule unavailable (private) - skipping wireframes checks"
fi

# ── Install dependencies ──────────────────────────────────────────────
section "bun install --frozen-lockfile"
if bun install --frozen-lockfile; then
  ok "install"
else
  fail "bun install failed"
  echo "Summary: $HARD_FAILS hard failure(s), $WARNS warning(s)"; exit 1
fi

# ── Typecheck ─────────────────────────────────────────────────────────
section "typecheck"
if bun run typecheck; then ok "typecheck"; else fail "typecheck"; fi

# ── Tests ─────────────────────────────────────────────────────────────
section "tests"
if bun run test; then ok "tests"; else fail "tests"; fi

# ── Invariant compliance ──────────────────────────────────────────────
section "check:invariants"
if bun run check:invariants; then ok "invariants"; else fail "invariants"; fi

# ── Build (vite) ──────────────────────────────────────────────────────
section "build"
if bun run build; then ok "build"; else fail "build"; fi

# ── Docker build smoke ────────────────────────────────────────────────
section "docker build smoke"
if ! command -v docker >/dev/null 2>&1; then
  warn "docker not found - skipping docker smoke"
else
  docker rm -f lexa-ci >/dev/null 2>&1 || true
  if docker build -t lexa:ci . 2>&1 | tee /tmp/docker-build.log; then
    ok "docker build"
    # shellcheck disable=SC2046
    if docker run -d --name lexa-ci -p 3001:3000 -e LXK_API_KEY=test-ci-key -e LXK_ADMIN_EMAILS=ci@example.com lexa:ci >/dev/null; then
      echo "waiting for /api/health..."
      HEALTH_OK=0
      for i in $(seq 1 30); do
        if curl -sf http://localhost:3001/api/health 2>/dev/null | grep -q '"ok":true'; then
          ok "docker health check passed"
          HEALTH_OK=1
          break
        fi
        sleep 1
      done
      if [ "$HEALTH_OK" -eq 0 ]; then
        warn "docker health check failed - warn not hard"
        docker logs lexa-ci 2>&1 || true
        curl -v http://localhost:3001/api/health 2>&1 || true
      fi
      docker rm -f lexa-ci >/dev/null 2>&1 || true
      trap - EXIT
      # re-arm trap for remainder (no-op if container already removed)
      trap 'docker rm -f lexa-ci >/dev/null 2>&1 || true' EXIT
    else
      warn "docker run failed - warn not hard"
    fi
  else
    if grep -qiE "network.*not supported|failed to create endpoint|operation not supported" /tmp/docker-build.log 2>/dev/null; then
      warn "docker build failed (network not supported in this env) - warn not hard"
    else
      warn "docker build failed - warn not hard"
    fi
  fi
fi

# ── Audit dependencies (warn) ─────────────────────────────────────────
section "audit (warn)"
set +e
if bun audit --help >/dev/null 2>&1; then
  bun audit || warn "bun audit found vulnerabilities"
elif bun pm audit --help >/dev/null 2>&1; then
  bun pm audit || warn "bun pm audit found vulnerabilities"
else
  npm audit --audit-level=moderate 2>&1 || warn "npm audit found vulnerabilities"
fi
set -e

# ── Gitleaks scan ─────────────────────────────────────────────────────
section "gitleaks"
if command -v gitleaks >/dev/null 2>&1; then
  if gitleaks detect --source . --no-banner --redact -v 2>&1; then
    ok "gitleaks"
  else
    fail "gitleaks found leaks"
  fi
else
  warn "gitleaks not installed - skipping (brew install gitleaks / go install github.com/gitleaks/gitleaks/v8@latest)"
fi

# ── Wireframes build check ────────────────────────────────────────────
section "wireframes build check"
if [ ! -d wireframes/src ]; then
  warn "wireframes/src missing - skipping wireframes build check"
else
  if bash wireframes/build.sh; then
    if git diff --exit-code -- wireframes/dist >/dev/null 2>&1; then
      ok "wireframes/dist clean"
    else
      fail "wireframes/dist dirty - run bash wireframes/build.sh and commit"
      git diff -- wireframes/dist | head -n 80 || true
    fi
  else
    fail "wireframes/build.sh failed"
  fi
fi

# ── CLI compile check ─────────────────────────────────────────────────
section "CLI compile check"
if bun run compile:cli 2>&1; then
  if git diff --exit-code -- cli/src/packed.ts cli/src/packed-compose.ts >/dev/null 2>&1; then
    ok "CLI compile (no dirty packed files)"
  else
    warn "cli/src/packed.ts or packed-compose.ts dirty after compile:cli - warn not hard (restoring stubs)"
    git diff -- cli/src/packed.ts cli/src/packed-compose.ts | head -n 100 || true
  fi
  git checkout -- cli/src/packed.ts cli/src/packed-compose.ts 2>/dev/null || true
  rm -rf bin/lexa-cli bin/daemon-bundle.js 2>/dev/null || true
else
  warn "bun run compile:cli failed - warn not hard"
  git checkout -- cli/src/packed.ts cli/src/packed-compose.ts 2>/dev/null || true
  rm -rf bin/lexa-cli bin/daemon-bundle.js 2>/dev/null || true
fi

# ── Lint (warn) ───────────────────────────────────────────────────────
section "lint (warn)"
set +e
if [ -f .oxlintrc.json ] || [ -f oxlint.json ] || [ -f .oxlintrc.js ]; then
  echo "oxlint config found"
else
  echo "no oxlint config found - will run with defaults or fallback"
fi
if [ -x ./node_modules/.bin/oxlint ]; then
  echo "running oxlint (warn mode)"
  ./node_modules/.bin/oxlint . || warn "oxlint found warnings"
elif bun pm ls oxlint >/dev/null 2>&1; then
  echo "running bunx oxlint (warn mode)"
  bunx oxlint . || warn "oxlint found warnings"
else
  echo "oxlint not found, falling back to bun run doctor"
  bun run doctor 2>&1 || warn "doctor found warnings"
fi
set -e

# ── Prettier check (warn) ─────────────────────────────────────────────
section "prettier (warn)"
set +e
if ls .prettierrc* prettier.config.* 1>/dev/null 2>&1; then
  echo "prettier config found - checking format"
  if [ -x ./node_modules/.bin/prettier ]; then
    ./node_modules/.bin/prettier --check . 2>&1 || warn "prettier formatting issues"
  else
    bunx prettier --check . 2>&1 || warn "prettier formatting issues (or prettier not installed)"
  fi
else
  echo "no prettier config - skipping prettier check"
fi
set -e

# ── Knip / depcheck (warn) ────────────────────────────────────────────
section "knip / depcheck (warn)"
set +e
if [ -x ./node_modules/.bin/knip ]; then
  echo "running knip (warn mode)"
  ./node_modules/.bin/knip --no-progress 2>&1 || warn "knip found issues"
elif bun pm ls knip >/dev/null 2>&1; then
  echo "running bunx knip (warn mode)"
  bunx knip --no-progress 2>&1 || warn "knip found issues"
elif [ -x ./node_modules/.bin/depcheck ]; then
  echo "running depcheck (warn mode)"
  ./node_modules/.bin/depcheck 2>&1 || warn "depcheck found issues"
else
  echo "knip/depcheck not installed - skipping (install knip to enable)"
fi
set -e

# ── Coverage (v8, 60% threshold) ──────────────────────────────────────
section "coverage (60% threshold, v8)"
set +e
echo "running coverage with v8 provider (thresholds 60% server/shared)"
bunx vitest run --coverage --coverage.provider=v8 --coverage.reporter=text --coverage.reporter=lcov --coverage.thresholds.lines 60 --coverage.thresholds.functions 60 --coverage.thresholds.branches 60 --coverage.thresholds.statements 60 --coverage.include="server/**" --coverage.include="shared/**" 2>&1 | tee /tmp/coverage.log
RC=${PIPESTATUS[0]:-$?}
if [ "$RC" -eq 0 ]; then
  ok "coverage thresholds passed"
else
  if grep -qiE "MISSING DEPENDENCY|Cannot find dependency.*coverage" /tmp/coverage.log 2>/dev/null; then
    warn "coverage provider missing (rc=$RC, is @vitest/coverage-v8 installed?)"
  else
    warn "coverage thresholds not met (rc=$RC) - warn not hard"
  fi
fi
set -e

# ── Tag / changelog guard ─────────────────────────────────────────────
section "tag guard"
TAG=""
if [ -n "${GITHUB_REF_NAME:-}" ]; then
  TAG="$GITHUB_REF_NAME"
  # only run guard if ref looks like a tag
  if [[ "$TAG" != v* && "$TAG" != cli-v* ]]; then
    echo "GITHUB_REF_NAME=$TAG does not look like a version tag - skipping tag guard"
    TAG=""
  fi
else
  # local: check if HEAD is exactly tagged
  TAG="$(git describe --exact-match --tags HEAD 2>/dev/null || true)"
fi
if [ -z "$TAG" ]; then
  echo "no tag at HEAD - skipping tag guard (push a tag to exercise it)"
else
  echo "tag guard: $TAG"
  set +e
  TAG_RC=0
  if [[ "$TAG" == cli-v* ]]; then
    VER="${TAG#cli-v}"
    PKG_VER="$(bun -e "console.log(require('./cli/package.json').version)" 2>/dev/null)"
    if [ "$PKG_VER" != "$VER" ]; then
      fail "cli/package.json version $PKG_VER does not match tag $TAG (expected cli-v$PKG_VER)"
      TAG_RC=1
    elif ! grep -qE "## \[${VER}\] - [0-9]{4}-[0-9]{2}-[0-9]{2}" cli/CHANGELOG.md 2>/dev/null; then
      fail "cli/CHANGELOG.md missing dated section ## [$VER] - YYYY-MM-DD for tag $TAG"
      TAG_RC=1
    else
      ok "cli tag guard passed: $TAG matches cli/package.json $PKG_VER and cli/CHANGELOG.md"
    fi
  else
    VER="${TAG#v}"
    PKG_VER="$(bun -e "console.log(require('./package.json').version)" 2>/dev/null)"
    if [ "$PKG_VER" != "$VER" ]; then
      fail "package.json version $PKG_VER does not match tag $TAG (expected v$PKG_VER)"
      TAG_RC=1
    elif ! grep -qE "## \[${VER}\] - [0-9]{4}-[0-9]{2}-[0-9]{2}" CHANGELOG.md 2>/dev/null; then
      fail "CHANGELOG.md missing dated section ## [$VER] - YYYY-MM-DD for tag $TAG"
      TAG_RC=1
    else
      ok "tag guard passed: $TAG matches package.json $PKG_VER and CHANGELOG.md"
    fi
  fi
  set -e
fi

# ── Check mobile ──────────────────────────────────────────────────────
section "check:mobile"
if ! grep -q '"check:mobile"' package.json 2>/dev/null; then
  echo "check:mobile script not found in package.json - skipping"
else
  if [ "${CI_LOCAL_SKIP_MOBILE:-}" = "1" ]; then
    warn "CI_LOCAL_SKIP_MOBILE=1 - skipping check:mobile"
  else
    # check:mobile needs a running dev server + playwright chromium
    # If neither localhost:5173 nor :3000 responds, skip with warn rather than hard-fail.
    if ! curl -sf http://localhost:5173/ >/dev/null 2>&1 && ! curl -sf http://localhost:3000/api/health >/dev/null 2>&1; then
      warn "no dev server at :5173 or :3000 - skipping check:mobile (run bun run dev:full in another terminal, then re-run; or CI_LOCAL_SKIP_MOBILE=1 to silence)"
    else
      set +e
      bun run check:mobile 2>&1 | tee /tmp/check-mobile.log
      MRC=${PIPESTATUS[0]:-$?}
      set -e
      if [ "$MRC" -eq 0 ]; then
        ok "check:mobile"
      elif grep -qiE "Executable doesn't exist|chrome-headless-shell|browserType\.launch|playwright install" /tmp/check-mobile.log 2>/dev/null; then
        if npx playwright install chromium --with-deps 2>&1 | tee /tmp/playwright-install.log; then
          set +e
          bun run check:mobile 2>&1 | tee /tmp/check-mobile.log
          MRC=${PIPESTATUS[0]:-$?}
          set -e
          if [ "$MRC" -eq 0 ]; then ok "check:mobile (after install)"; else warn "check:mobile failed after playwright install (rc=$MRC) - warn not hard"; fi
        else
          warn "playwright browsers missing and auto-install failed (rc=$MRC) - warn not hard"
        fi
      else
        warn "check:mobile failed (rc=$MRC) - warn not hard"
      fi
    fi
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$HARD_FAILS" -eq 0 ]; then
  echo -e "${GREEN}ci:local passed${RST} (${WARNS} warning(s))"
else
  echo -e "${RED}ci:local failed${RST}: $HARD_FAILS hard failure(s), $WARNS warning(s)"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[ "$HARD_FAILS" -eq 0 ]
