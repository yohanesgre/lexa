#!/usr/bin/env bash
# Install the Forge daemon as a systemd user service (Linux with systemd).
# Usage: bash scripts/forge/install.sh
# Requires: LEXA_URL, LEXA_API_KEY (or LXK_FORGE_DAEMON_TOKEN), FORGE_AGENT
# The FORGE_AGENT env var is respected when the config file is first written:
#   FORGE_AGENT=command-code bash scripts/forge/install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SERVICE_NAME="lexa-forge"
INSTALL_DIR="$HOME/.local/share/$SERVICE_NAME"
CONFIG_DIR="$HOME/.config/$SERVICE_NAME"

command -v bun >/dev/null 2>&1 || { echo "ERROR: bun is required but not installed"; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "ERROR: systemctl not found — systemd user services unavailable"; exit 1; }

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"

# Copy the daemon (standalone — it only needs bun stdlib + fetch).
cp "$REPO_DIR/scripts/forge/daemon.ts" "$INSTALL_DIR/daemon.ts"

# Config
if [ ! -f "$CONFIG_DIR/env" ]; then
  cat > "$CONFIG_DIR/env" << ENVEOF
LEXA_URL=http://localhost:3000
LEXA_API_KEY=
LXK_FORGE_DAEMON_TOKEN=
FORGE_AGENT=${FORGE_AGENT:-opencode}
ENVEOF
  echo "Wrote $CONFIG_DIR/env — edit it to set LEXA_URL and your API key/token."
else
  echo "Config exists at $CONFIG_DIR/env (FORGE_AGENT=$(grep '^FORGE_AGENT=' "$CONFIG_DIR/env" | cut -d= -f2 || echo unset))"
fi

# systemd user unit
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/$SERVICE_NAME.service" << UNITEOF
[Unit]
Description=Lexa Forge daemon (runtime agent)
After=network-online.target

[Service]
Type=simple
ExecStart=bun run "$INSTALL_DIR/daemon.ts"
EnvironmentFile=$CONFIG_DIR/env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNITEOF

systemctl --user daemon-reload
echo ""
echo "Forge daemon installed. Start it with:"
echo "  systemctl --user enable --now $SERVICE_NAME"
echo "  journalctl --user -u $SERVICE_NAME -f"
