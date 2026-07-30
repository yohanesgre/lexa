#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-lexa-wireframe.yohanesgre.com}"
CF_TOKEN="${CF_API_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"
TUNNEL_NAME="lexa-wireframe"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "═══════════════════════════════════════════════════════"
echo "  Lexa Wireframes Setup"
echo "  $DOMAIN"
echo "═══════════════════════════════════════════════════════"

# ── Build ──
echo "==> Building dist..."
bash build.sh

# ── Cloudflare ──
CF_API="https://api.cloudflare.com/client/v4"

if [ -z "$CF_TOKEN" ]; then
  echo "── Cloudflare API Token ──"
  echo "  Permissions: Cloudflare One → Connectors (Write)"
  echo "               Zone → DNS (Write)"
  read -p "  Paste token: " CF_TOKEN
fi
[ -z "$CF_TOKEN" ] && { echo "ERROR: CF API token required"; exit 1; }
AUTH="Authorization: Bearer ${CF_TOKEN}"
CT="Content-Type: application/json"

# Account + Zone
BASE_DOMAIN="${DOMAIN#*.}"
echo "==> Account & Zone..."
ACCOUNT=$(curl -sfS "$CF_API/accounts" -H "$AUTH" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])")
ZONE=$(curl -sfS "$CF_API/zones?name=$BASE_DOMAIN" -H "$AUTH" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])")
echo "  Account: $ACCOUNT  Zone: $ZONE"

# Tunnel
echo "==> Tunnel..."
EXISTING=$(curl -sfS "$CF_API/accounts/$ACCOUNT/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false" -H "$AUTH" | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')")
if [ -n "$EXISTING" ]; then
  echo "  Using existing tunnel: $EXISTING"
  TUNNEL="$EXISTING"
else
  RESP=$(curl -sfS "$CF_API/accounts/$ACCOUNT/cfd_tunnel" -H "$AUTH" -H "$CT" -d "{\"name\":\"$TUNNEL_NAME\",\"config_src\":\"cloudflare\"}")
  TUNNEL=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])")
  echo "  Created: $TUNNEL"
fi
TOKEN=$(curl -sfS "$CF_API/accounts/$ACCOUNT/cfd_tunnel/$TUNNEL/token" -H "$AUTH" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'])")
echo "  Tunnel: $TUNNEL  Token: ready"

# DNS
echo "==> DNS..."
EXISTING_DNS=$(curl -sfS "$CF_API/zones/$ZONE/dns_records?type=CNAME&name=$DOMAIN" -H "$AUTH" | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')")
[ -n "$EXISTING_DNS" ] && curl -sfS -X DELETE "$CF_API/zones/$ZONE/dns_records/$EXISTING_DNS" -H "$AUTH" > /dev/null
curl -sfS "$CF_API/zones/$ZONE/dns_records" -H "$AUTH" -H "$CT" \
  -d "{\"type\":\"CNAME\",\"name\":\"$DOMAIN\",\"content\":\"$TUNNEL.cfargotunnel.com\",\"proxied\":true}" > /dev/null
echo "  $DOMAIN → tunnel"

# Ingress
echo "==> Ingress..."
INGRESS='{"config":{"ingress":[{"hostname":"'$DOMAIN'","service":"http://wireframes:80"},{"service":"http_status:404"}]}}'
RESULT=$(curl -sfS -X PUT "$CF_API/accounts/$ACCOUNT/cfd_tunnel/$TUNNEL/configurations" -H "$AUTH" -H "$CT" -d "$INGRESS" 2>&1)
if echo "$RESULT" | grep -q '"success":true'; then
  echo "  $DOMAIN → wireframes:80"
else
  echo "  ⚠ Ingress API call returned: $(echo "$RESULT" | head -c 200)"
  echo "  Configure manually: Zero Trust → Tunnels → $TUNNEL_NAME → Public Hostnames"
  echo "  Add: $DOMAIN → http://wireframes:80"
fi

# ── Start ──
echo "==> Starting..."
CF_TUNNEL_TOKEN="$TOKEN" docker compose up -d --build --wait

sleep 3
HEALTH=$(curl -s --max-time 10 "http://localhost:80" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "fail")
[ "$HEALTH" = "200" ] && echo "  Local: OK (HTTP $HEALTH)" || echo "  Local: FAILED"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Lexa Wireframes"
echo "  https://$DOMAIN"
echo "═══════════════════════════════════════════════════════"
