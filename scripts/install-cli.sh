#!/usr/bin/env bash
# Install lx on a clean machine — no bun, no git, no repo needed.
#
#   curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/main/scripts/install-cli.sh | bash
#
# The binary is standalone (bun-compiled) and embeds the Docker compose files
# (image refs, volumes, tunnel), so `lx deploy` pulls a prebuilt image
# from ghcr.io — no checkout, no build. Overrides:
#   LEXA_CLI_URL    URL of the prebuilt binary (default: latest cli-v* release)
#   LEXA_CLI_DIR    install dir (default: ~/.local/bin)
set -euo pipefail

CLI_DIR="${LEXA_CLI_DIR:-$HOME/.local/bin}"
CLI_BIN="$CLI_DIR/lx"

CLI_URLS=()
if [ -n "${LEXA_CLI_URL:-}" ]; then
  CLI_URLS+=("$LEXA_CLI_URL")
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
  CLI_URLS+=("https://github.com/yohanesgre/lexa/releases/download/${CLI_TAG}/lx")
  # Pre-rename releases published the asset as `lexa-cli`; fall back so the
  # installer keeps working during the rename transition.
  CLI_URLS+=("https://github.com/yohanesgre/lexa/releases/download/${CLI_TAG}/lexa-cli")
fi

echo "═══ lx installer ═══"
mkdir -p "$CLI_DIR"
downloaded=0
attempt=0
total=${#CLI_URLS[@]}
for url in "${CLI_URLS[@]}"; do
  attempt=$((attempt + 1))
  echo "==> Downloading binary: $url"
  if curl -fsSL "$url" -o "$CLI_BIN"; then
    downloaded=1
    break
  fi
  if [ "$attempt" -lt "$total" ]; then
    echo "  Download failed — trying the next source." >&2
  fi
done
if [ "$downloaded" -ne 1 ]; then
  echo "ERROR: could not download the lx binary" >&2
  exit 1
fi
chmod 755 "$CLI_BIN"

echo ""
echo "════════════════════════════════════════════════"
echo "  lx installed: $CLI_BIN"
echo ""
echo "  Next: $CLI_BIN login <url>"
echo "  (add $CLI_DIR to PATH if needed)"
echo "════════════════════════════════════════════════"
