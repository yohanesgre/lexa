#!/usr/bin/env bash
set -euo pipefail

INSTANCE="${INSTANCE:-lexa-mcp}"
SERVICE_NAME="lexa-mcp-$INSTANCE"
INSTALL_DIR="$HOME/.local/share/$SERVICE_NAME"
CONFIG_DIR="$HOME/.config/$SERVICE_NAME"
SERVICE_FILE="$HOME/.config/systemd/user/$SERVICE_NAME.service"

echo "==> Uninstalling Lexa MCP Server ($INSTANCE)"

# ── Stop and disable service ──

if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  echo "==> Stopping service..."
  systemctl --user stop "$SERVICE_NAME" || true
fi

if systemctl --user is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
  echo "==> Disabling service..."
  systemctl --user disable "$SERVICE_NAME" || true
fi

# ── Remove service file ──

if [ -f "$SERVICE_FILE" ]; then
  rm -f "$SERVICE_FILE"
  echo "==> Removed service file"
fi

systemctl --user daemon-reload || true

# ── Remove install dir ──

if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "==> Removed install directory"
fi

# ── Remove config (prompt) ──

if [ -d "$CONFIG_DIR" ]; then
  read -p "Remove config directory? [$CONFIG_DIR] [Y/n] " -n 1 -r REPLY
  echo
  if [[ -z "$REPLY" ]] || [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf "$CONFIG_DIR"
    echo "==> Removed config directory"
  else
    echo "==> Kept config directory: $CONFIG_DIR"
  fi
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Lexa MCP Server ($INSTANCE) uninstalled successfully!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Uninstall another instance:"
echo "    INSTANCE=dev bash scripts/mcp/uninstall.sh"
echo "═══════════════════════════════════════════════════════"
