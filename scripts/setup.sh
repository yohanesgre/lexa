#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-}"
FLAVOR="${2:-dev}"
BARE="${3:-}"
CF_TOKEN="${CF_API_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

usage() {
  echo "Usage: $0 <domain> [dev|staging|prod]"
  echo "  dev     — local, no tunnel, .env"
  echo "  staging — remote, lexa-preview.<domain>, .env.staging"
  echo "  prod    — remote, lexa.<domain>, .env.prod"
  exit 1
}

[ -z "$DOMAIN" ] && usage

case "$FLAVOR" in
  dev)     SUBDOMAIN="";               TUNNEL_NAME="";              COMPOSE_NAME="lexa-dev";     COMPOSE_FILES="-f docker-compose.yml"                    ENV_FILE=".env" ;;
  staging) SUBDOMAIN="lexa-preview";   TUNNEL_NAME="lexa-staging";  COMPOSE_NAME="lexa-staging"; COMPOSE_FILES="-f docker-compose.yml -f docker-compose.staging.yml" ENV_FILE=".env.staging" ;;
  prod)    SUBDOMAIN="lexa";           TUNNEL_NAME="lexa-prod";     COMPOSE_NAME="lexa-prod";    COMPOSE_FILES="-f docker-compose.yml -f docker-compose.prod.yml"    ENV_FILE=".env.prod" ;;
  *) usage ;;
esac

FULL_DOMAIN="${SUBDOMAIN}.${DOMAIN}"
CF_API="https://api.cloudflare.com/client/v4"

echo "═══════════════════════════════════════════════════════"
echo "  Lexa Setup — $FLAVOR"
[ -n "$FULL_DOMAIN" ] && echo "  $FULL_DOMAIN"
echo "═══════════════════════════════════════════════════════"

# ── Cloudflare (staging/prod only) ──
if [ "$FLAVOR" != "dev" ]; then
  if [ -z "$CF_TOKEN" ]; then
    echo "── Cloudflare API Token ──"
    echo "  Permissions: Cloudflare One → Cloudflare One Connectors (Write)"
    echo "               Zone → DNS (Write)"
    echo "               Access: Apps and Policies → Edit"
    echo "               Access: Identity Providers → Read"
    read -p "  Paste token: " CF_TOKEN
  fi
  [ -z "$CF_TOKEN" ] && { echo "ERROR: CF API token required"; exit 1; }
  AUTH="Authorization: Bearer ${CF_TOKEN}"
  CT="Content-Type: application/json"

  # Account + Zone
  echo "==> Account & Zone..."
  ACCOUNT=$(curl -sfS "$CF_API/accounts" -H "$AUTH" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])")
  ZONE=$(curl -sfS "$CF_API/zones?name=$DOMAIN" -H "$AUTH" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])")
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
  EXISTING_DNS=$(curl -sfS "$CF_API/zones/$ZONE/dns_records?type=CNAME&name=$FULL_DOMAIN" -H "$AUTH" | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')")
  [ -n "$EXISTING_DNS" ] && curl -sfS -X DELETE "$CF_API/zones/$ZONE/dns_records/$EXISTING_DNS" -H "$AUTH" > /dev/null
  curl -sfS "$CF_API/zones/$ZONE/dns_records" -H "$AUTH" -H "$CT" \
    -d "{\"type\":\"CNAME\",\"name\":\"$FULL_DOMAIN\",\"content\":\"$TUNNEL.cfargotunnel.com\",\"proxied\":true}" > /dev/null
  echo "  $FULL_DOMAIN → tunnel"

  # Ingress
  echo "==> Ingress..."
  INGRESS='{"config":{"ingress":[{"hostname":"'$FULL_DOMAIN'","service":"http://app:3000"},{"service":"http_status:404"}]}}'
  RESULT=$(curl -sfS -X PUT "$CF_API/accounts/$ACCOUNT/cfd_tunnel/$TUNNEL/configurations" -H "$AUTH" -H "$CT" -d "$INGRESS" 2>&1)
  if echo "$RESULT" | grep -q '"success":true'; then
    echo "  $FULL_DOMAIN → app:3000"
  else
    echo "  ⚠ Ingress API call returned: $(echo "$RESULT" | head -c 200)"
    echo "  Configure manually: Zero Trust → Tunnels → $TUNNEL_NAME → Public Hostnames"
    echo "  Add: $FULL_DOMAIN → http://app:3000"
  fi

  # ── Access (auth guard) ──
  echo "==> Access (auth guard)..."

  # Google OAuth credentials
  if [ -z "${GOOGLE_CLIENT_ID:-}" ]; then
    read -p "  Google OAuth Client ID (.apps.googleusercontent.com): " GOOGLE_CLIENT_ID
  fi
  if [ -z "${GOOGLE_CLIENT_SECRET:-}" ]; then
    read -p "  Google OAuth Client Secret: " GOOGLE_CLIENT_SECRET
  fi

  # CF Access team domain for redirect URI
  if [ -z "${CF_TEAM_DOMAIN:-}" ]; then
    echo "  Your CF Access team domain: Zero Trust → Settings → Custom Pages → Team domain"
    read -p "  e.g. lexa.cloudflareaccess.com: " CF_TEAM_DOMAIN
  fi
  REDIRECT_URI="https://${CF_TEAM_DOMAIN}/cdn-cgi/access/callback"
  echo "  Redirect URI: $REDIRECT_URI"
  echo "  (verify this matches your Google OAuth redirect in console)"

  # Google identity provider — reuse existing if present
  EXISTING_IDP=$(curl -sfS "$CF_API/accounts/$ACCOUNT/access/identity_providers" -H "$AUTH" | python3 -c "
import sys,json
for idp in json.load(sys.stdin)['result']:
    if idp['type'] == 'google':
        print(idp['id'])
        break
" 2>&1)
  if [ -n "$EXISTING_IDP" ]; then
    echo "  Updating existing Google IdP: $EXISTING_IDP"
    curl -sfS -X PUT "$CF_API/accounts/$ACCOUNT/access/identity_providers/$EXISTING_IDP" -H "$AUTH" -H "$CT" \
      -d "{\"name\":\"Google Login\",\"type\":\"google\",\"config\":{\"client_id\":\"$GOOGLE_CLIENT_ID\",\"client_secret\":\"$GOOGLE_CLIENT_SECRET\"}}" > /dev/null
    IDP_ID="$EXISTING_IDP"
  else
    RESP=$(curl -sfS -X POST "$CF_API/accounts/$ACCOUNT/access/identity_providers" -H "$AUTH" -H "$CT" \
      -d "{\"name\":\"Google Login\",\"type\":\"google\",\"config\":{\"client_id\":\"$GOOGLE_CLIENT_ID\",\"client_secret\":\"$GOOGLE_CLIENT_SECRET\"}}")
    IDP_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])")
    echo "  Created Google IdP: $IDP_ID"
  fi

  # Access application — reuse if domain already exists
  APP_NAME="Lexa ($FLAVOR)"
  EXISTING_APP=$(curl -sfS "$CF_API/accounts/$ACCOUNT/access/apps?domain=$FULL_DOMAIN" -H "$AUTH" | python3 -c "
import sys,json
apps = json.load(sys.stdin)['result']
print(apps[0]['id'] if apps else '')
" 2>&1)
  if [ -n "$EXISTING_APP" ]; then
    echo "  Using existing Access app: $EXISTING_APP"
    APP_ID="$EXISTING_APP"
  else
    RESP=$(curl -sfS -X POST "$CF_API/accounts/$ACCOUNT/access/apps" -H "$AUTH" -H "$CT" \
      -d "{\"name\":\"$APP_NAME\",\"domain\":\"$FULL_DOMAIN\",\"type\":\"self_hosted\",\"session_duration\":\"24h\",\"allowed_idps\":[\"$IDP_ID\"],\"auto_redirect_to_identity\":true}")
    APP_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])")
    echo "  Created Access app: $APP_ID"
  fi

  # Policy — restrict to email domain, reuse if exists
  read -p "  Allowed email domain (e.g. yohanesgre.com): " EMAIL_DOMAIN
  EXISTING_POLICY=$(curl -sfS "$CF_API/accounts/$ACCOUNT/access/apps/$APP_ID/policies" -H "$AUTH" | python3 -c "
import sys,json
pols = json.load(sys.stdin)['result']
if pols: print(pols[0]['id'])
" 2>&1)
  if [ -n "$EXISTING_POLICY" ]; then
    echo "  Updating existing policy: $EXISTING_POLICY"
    curl -sfS -X PUT "$CF_API/accounts/$ACCOUNT/access/apps/$APP_ID/policies/$EXISTING_POLICY" -H "$AUTH" -H "$CT" \
      -d "{\"name\":\"Allow @$EMAIL_DOMAIN\",\"decision\":\"allow\",\"include\":[{\"email_domain\":{\"domain\":\"$EMAIL_DOMAIN\"}}],\"precedence\":1}" > /dev/null
  else
    curl -sfS -X POST "$CF_API/accounts/$ACCOUNT/access/apps/$APP_ID/policies" -H "$AUTH" -H "$CT" \
      -d "{\"name\":\"Allow @$EMAIL_DOMAIN\",\"decision\":\"allow\",\"include\":[{\"email_domain\":{\"domain\":\"$EMAIL_DOMAIN\"}}],\"precedence\":1}" > /dev/null
  fi
  echo "  Policy: allow @$EMAIL_DOMAIN"
fi

# ── API Key / Admin email / Seed ──
if [ "$FLAVOR" = "dev" ]; then
  echo ""
  echo "── Lexa application setup (dev) ──"
  echo "  Running: bun run setup"
  echo "  (Admin email, API key, migrations, and seed are handled by the wizard.)"
  bun run setup
  # reload values written by the wizard
  set -a; . ./.env; set +a
else
  # Staging/prod: env file must include CF_TUNNEL_TOKEN (from the CF API above),
  # so the app-level pieces are prompted here, then the web wizard (/setup)
  # can complete the admin email + seed inside the container.
  echo ""
  echo "── Admin user ──"
  echo "  First Google login with this email will be auto-promoted to admin."
  read -p "  Admin email: " ADMIN_EMAIL

  echo ""
  echo "── API Key ──"
  read -p "  API key (lxk_...) [Enter to generate]: " API_KEY
  if [ -z "$API_KEY" ]; then
    API_KEY="lxk_$(python3 -c "
import secrets; raw=secrets.token_bytes(32)
chars='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
v=int.from_bytes(raw); r=''
while v>0: r=chars[v%62]+r; v//=62
while len(r)<43: r='0'+r
print(r)
")"
    echo "  Generated: $API_KEY"
  fi

  cat > "$ENV_FILE" << ENVEOF
LXK_API_KEY=$API_KEY
VITE_LXK_API_KEY=$API_KEY
LXK_ADMIN_EMAILS=${ADMIN_EMAIL:-}
CF_TUNNEL_TOKEN=$TOKEN
ENVEOF
  echo "  Wrote $ENV_FILE"
fi

# ── Start ──
if [ "$BARE" = "--bare" ]; then
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  Lexa $FLAVOR — bare metal"
  echo ""
  echo "  bun run setup"
  echo "  rm -f data/lexa.db*"
  echo "  bun dev:full"
  echo ""
  echo "  API key: ${API_KEY:-run bun run setup}"
  echo "═══════════════════════════════════════════════════════"
  exit 0
fi
echo "==> Building and starting..."
COMPOSE_PROJECT_NAME="$COMPOSE_NAME" docker compose $COMPOSE_FILES --env-file "$ENV_FILE" up -d --build --wait

sleep 3
HEALTH=$(curl -s --max-time 10 "http://localhost:3000/api/health" 2>/dev/null || echo "fail")
[ "$HEALTH" = '{"ok":true}' ] && echo "  Local: OK" || echo "  Local: FAILED"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Lexa $FLAVOR"
[ -n "$FULL_DOMAIN" ] && echo "  https://$FULL_DOMAIN"
echo "  API key: $API_KEY"
echo "═══════════════════════════════════════════════════════"
