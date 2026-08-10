#!/usr/bin/env bash
# Install lexa-cli on a clean machine — no bun, no git, no repo needed.
#
#   curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/main/scripts/install-cli.sh | bash
#
# The binary is standalone (bun-compiled) and embeds the Docker compose files
# (image refs, volumes, tunnel), so `lexa-cli deploy` pulls a prebuilt image
# from ghcr.io — no checkout, no build. Overrides:
#   LEXA_CLI_URL    URL of the prebuilt binary (default: latest cli-v* release)
#   LEXA_CLI_DIR    install dir (default: ~/.local/bin)
set -euo pipefail

CLI_DIR="${LEXA_CLI_DIR:-$HOME/.local/bin}"
CLI_BIN="$CLI_DIR/lexa-cli"

if [ -n "${LEXA_CLI_URL:-}" ]; then
  CLI_URL="$LEXA_CLI_URL"
else
  # CLI releases are independent of web app releases: cli-vX.Y.Z tags publish
  # the binary as a release asset; vX.Y.Z tags publish the app image. Resolve
  # the newest cli-v* tag — `releases/latest` may be a web app release with
  # no CLI asset.
  CLI_TAG="$(curl -fsSL "https://api.github.com/repos/yohanesgre/lexa/releases?per_page=30" \
    | grep -o '"tag_name": *"cli-v[^"]*"' | head -1 | sed 's/.*"cli-v/cli-v/; s/"$//')"
  if [ -z "$CLI_TAG" ]; then
    echo "ERROR: no cli-v* release found" >&2
    exit 1
  fi
  CLI_URL="https://github.com/yohanesgre/lexa/releases/download/${CLI_TAG}/lexa-cli"
fi

echo "═══ lexa-cli installer ═══"
echo "==> Downloading binary: $CLI_URL"
mkdir -p "$CLI_DIR"
curl -fsSL "$CLI_URL" -o "$CLI_BIN"
chmod 755 "$CLI_BIN"

echo ""
echo "════════════════════════════════════════════════"
echo "  lexa-cli installed: $CLI_BIN"
echo ""
echo "  Next: $CLI_BIN deploy <domain> prod"
echo "  (add $CLI_DIR to PATH if needed)"
echo "════════════════════════════════════════════════"
