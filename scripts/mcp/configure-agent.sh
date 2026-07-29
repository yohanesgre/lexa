#!/usr/bin/env bash
set -euo pipefail

INSTANCE="${INSTANCE:-lexa-mcp}"
AGENT="${AGENT:-opencode}"
SERVICE_NAME="lexa-mcp-$INSTANCE"
CONFIG_DIR="$HOME/.config/$SERVICE_NAME"
ENV_FILE="$CONFIG_DIR/env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: Config not found: $ENV_FILE"
  echo "Run the installer first: bash scripts/mcp/install.sh"
  exit 1
fi

source "$ENV_FILE"

MODE="${MODE:-local}"

case "$MODE" in
  local)
    TS_HOST=$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Self',{}).get('DNSName','').rstrip('.'))" 2>/dev/null || echo "")
    if [ -n "$TS_HOST" ]; then
      MCP_URL="https://${TS_HOST}/mcp"
    else
      MCP_URL="http://localhost:$PORT/mcp"
    fi
    ;;
  remote)
    MCP_URL="${WORKER_URL}/mcp"
    ;;
  *)
    echo "ERROR: Unknown mode '$MODE'. Use: local | remote"
    exit 1
    ;;
esac

echo "==> Configuring $AGENT for Lexa MCP ($INSTANCE · $MODE)"
echo "    URL:  $MCP_URL"
echo ""

case "$AGENT" in
  opencode)
    OCO_FILE="$HOME/.config/opencode/opencode.json"
    mkdir -p "$(dirname "$OCO_FILE")"

    if [ -f "$OCO_FILE" ]; then
      python3 -c "
import json, sys
try:
    with open('$OCO_FILE') as f:
        cfg = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    cfg = {}
cfg.setdefault('mcp', {})
cfg['mcp']['lexa'] = {
    'type': 'remote',
    'url': '$MCP_URL',
    'headers': {'Authorization': 'Bearer $LXK_API_KEY'}
}
with open('$OCO_FILE', 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
" 2>/dev/null || {
        # python3 failed — fallback to manual JSON
        cat > "$OCO_FILE" << OCOEOF
{
  "mcp": {
    "lexa": {
      "type": "remote",
      "url": "$MCP_URL",
      "headers": { "Authorization": "Bearer $LXK_API_KEY" }
    }
  }
}
OCOEOF
      }
      echo "==> Updated: $OCO_FILE"
    else
      cat > "$OCO_FILE" << OCOEOF
{
  "mcp": {
    "lexa": {
      "type": "remote",
      "url": "$MCP_URL",
      "headers": { "Authorization": "Bearer $LXK_API_KEY" }
    }
  }
}
OCOEOF
      echo "==> Created: $OCO_FILE"
    fi
    ;;

  hermes)
    HERMES_FILE="$HOME/.config/hermes/config.json"
    mkdir -p "$(dirname "$HERMES_FILE")"

    if [ -f "$HERMES_FILE" ]; then
      python3 -c "
import json, sys
try:
    with open('$HERMES_FILE') as f:
        cfg = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    cfg = {}
cfg.setdefault('mcpServers', {})
cfg['mcpServers']['lexa'] = {
    'url': '$MCP_URL',
    'headers': {'Authorization': 'Bearer $LXK_API_KEY'}
}
with open('$HERMES_FILE', 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
" 2>/dev/null || {
        cat > "$HERMES_FILE" << HERMEOF
{
  "mcpServers": {
    "lexa": {
      "url": "$MCP_URL",
      "headers": { "Authorization": "Bearer $LXK_API_KEY" }
    }
  }
}
HERMEOF
      }
      echo "==> Updated: $HERMES_FILE"
    else
      cat > "$HERMES_FILE" << HERMEOF
{
  "mcpServers": {
    "lexa": {
      "url": "$MCP_URL",
      "headers": { "Authorization": "Bearer $LXK_API_KEY" }
    }
  }
}
HERMEOF
      echo "==> Created: $HERMES_FILE"
    fi
    ;;

  *)
    echo "ERROR: Unknown agent '$AGENT'. Use: opencode | hermes"
    exit 1
    ;;
esac

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  $AGENT configured for Lexa MCP ($INSTANCE)"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  URL:  $MCP_URL"
echo "  Auth: Bearer lxk_..."
echo ""
echo "  Restart $AGENT to pick up changes."
echo ""
echo "  Configure another agent:"
echo "    AGENT=hermes bash scripts/mcp/configure-agent.sh"
echo ""
echo "  Switch to remote mode (direct to Worker):"
echo "    MODE=remote bash scripts/mcp/configure-agent.sh"
echo "═══════════════════════════════════════════════════════"
