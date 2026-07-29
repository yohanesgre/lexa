#!/usr/bin/env bash
set -euo pipefail

INSTANCE="${INSTANCE:-lexa-mcp}"
SERVICE_NAME="lexa-mcp-$INSTANCE"
INSTALL_DIR="$HOME/.local/share/$SERVICE_NAME"
CONFIG_DIR="$HOME/.config/$SERVICE_NAME"
SERVICE_DIR="$HOME/.config/systemd/user"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# ── Check deps ──

command -v node >/dev/null 2>&1 || { echo "ERROR: node is required but not installed"; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "ERROR: npx is required but not installed. Install with: npm install -g npx"; exit 1; }

echo "==> Installing Lexa MCP Server ($INSTANCE)"

# ── Install dir ──

mkdir -p "$INSTALL_DIR"

cp "$REPO_DIR/scripts/mcp/mcp-server.ts" "$INSTALL_DIR/mcp-server.ts"
cp "$REPO_DIR/shared/markdown.ts" "$INSTALL_DIR/markdown.ts"
cp "$REPO_DIR/shared/types.ts" "$INSTALL_DIR/types.ts"

# Fix import paths for flat directory structure
sed -i 's|../shared/markdown.ts|./markdown.ts|g' "$INSTALL_DIR/mcp-server.ts"
sed -i 's|../shared/types.ts|./types.ts|g' "$INSTALL_DIR/mcp-server.ts"

# ── Node deps ──

cat > "$INSTALL_DIR/package.json" << 'PKGJSON'
{
  "private": true,
  "dependencies": {
    "marked": "^18.0.7"
  }
}
PKGJSON

echo "==> Installing npm dependencies..."
(cd "$INSTALL_DIR" && npm install --omit=dev --silent)

# ── Config ──

mkdir -p "$CONFIG_DIR"

# Load existing config as defaults
CUR_WORKER=""
CUR_KEY=""
CUR_PORT=""
if [ -f "$CONFIG_DIR/env" ]; then
  source "$CONFIG_DIR/env"
  CUR_WORKER="${WORKER_URL:-}"
  CUR_KEY="${LXK_API_KEY:-}"
  CUR_PORT="${PORT:-}"
  echo ""
  echo "── Reconfiguring Lexa MCP Server ($INSTANCE) ──"
  echo ""
else
  echo ""
  echo "── Lexa MCP Server ($INSTANCE) Configuration ──"
  echo ""
fi

# Smart defaults
DEFAULT_WORKER="$CUR_WORKER"
DEFAULT_PORT="${CUR_PORT:-9000}"
DEFAULT_KEY="$CUR_KEY"
if [ "$INSTANCE" = "dev" ]; then
  DEFAULT_WORKER="${CUR_WORKER:-http://localhost:8794}"
  DEFAULT_PORT="${CUR_PORT:-9001}"
else
  DEFAULT_WORKER="${CUR_WORKER:-https://lexa.example.com}"
fi

# Worker URL
read -p "  Worker URL [$DEFAULT_WORKER]: " WORKER_URL
WORKER_URL="${WORKER_URL:-$DEFAULT_WORKER}"

# API key
KEY_PROMPT="  API key (lxk_...)"
[ -n "$DEFAULT_KEY" ] && KEY_PROMPT="  API key [current key]: "
read -p "$KEY_PROMPT" LXK_API_KEY
if [ -z "$LXK_API_KEY" ] && [ -n "$DEFAULT_KEY" ]; then
  LXK_API_KEY="$DEFAULT_KEY"
fi
while [[ ! "$LXK_API_KEY" =~ ^lxk_ ]] || [ ${#LXK_API_KEY} -lt 10 ]; do
  if [ -z "$LXK_API_KEY" ]; then
    read -p "  API key required. Get one from Lexa Settings → API Keys: " LXK_API_KEY
  else
    read -p "  Invalid key. Must start with 'lxk_' and be at least 10 chars: " LXK_API_KEY
  fi
done

# Port
read -p "  Local port [$DEFAULT_PORT]: " PORT
PORT="${PORT:-$DEFAULT_PORT}"

cat > "$CONFIG_DIR/env" << ENVEOF
WORKER_URL=$WORKER_URL
LXK_API_KEY=$LXK_API_KEY
PORT=$PORT
ENVEOF

echo ""
echo "==> Config saved: $CONFIG_DIR/env"
echo "    Worker:  $WORKER_URL"
echo "    Port:    $PORT"

# ── systemd service ──

mkdir -p "$SERVICE_DIR"

sed "s|%INSTALL_DIR%|$INSTALL_DIR|g" "$REPO_DIR/scripts/mcp/lexa-mcp.service" > "$SERVICE_DIR/lexa-mcp.service"

echo "==> Enabling and starting service..."
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME" 2>/dev/null || systemctl --user start "$SERVICE_NAME"

# ── Done ──

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Lexa MCP Server ($INSTANCE) installed successfully!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Config:    $CONFIG_DIR/env"
echo "  Status:    systemctl --user status $SERVICE_NAME"
echo "  Logs:      journalctl --user -u $SERVICE_NAME -f"
echo "  Endpoint:  http://localhost:${PORT:-9000}/mcp"
echo ""
echo "  MCP client config (Tailscale Funnel):"
echo "    http://<your-machine>.ts.net:${PORT:-9000}/mcp"
echo ""
echo "  Install another instance:"
echo "    INSTANCE=dev bash scripts/mcp/install.sh"
echo "═══════════════════════════════════════════════════════"
