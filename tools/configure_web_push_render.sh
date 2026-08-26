#!/usr/bin/env bash
set -euo pipefail

VAULT="${VAULT:-Good Shepherd - Infrastructure}"
ITEM="${ITEM:-Good Shepherd Web Push VAPID}"
SERVICE_ID="${SERVICE_ID:-srv-d7h5hkhf9bms739m317g}"
SUBJECT="${WEB_PUSH_VAPID_SUBJECT:-mailto:dev@thriveks.com}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}
need op
need curl
need node

if op item get "$ITEM" --vault "$VAULT" >/dev/null 2>&1; then
  PUBLIC_KEY="$(op item get "$ITEM" --vault "$VAULT" --fields username)"
  PRIVATE_KEY="$(op item get "$ITEM" --vault "$VAULT" --fields password --reveal)"
else
  read -r PUBLIC_KEY PRIVATE_KEY < <(node - <<'NODE'
const { createECDH } = require('crypto');
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
process.stdout.write(ecdh.getPublicKey().toString('base64url') + ' ' + ecdh.getPrivateKey().toString('base64url'));
NODE
)
  op item create \
    --category login \
    --title "$ITEM" \
    --vault "$VAULT" \
    "username=$PUBLIC_KEY" \
    "password=$PRIVATE_KEY" >/dev/null
  echo "✓ Created persistent Web Push VAPID keys in 1Password"
fi

RENDER_API_KEY="$(op item get "Render API key" --vault "$VAULT" --fields password --reveal)"

update_var() {
  local key="$1"
  local value="$2"
  local response_file
  response_file="$(mktemp)"
  local code
  code="$(curl -sS -o "$response_file" -w "%{http_code}" \
    -X PUT \
    "https://api.render.com/v1/services/$SERVICE_ID/env-vars/$key" \
    -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Content-Type: application/json" \
    --data "$(node -e 'console.log(JSON.stringify({value:process.argv[1]}))' "$value")")"

  if [ "$code" = "200" ]; then
    echo "✓ $key configured"
    rm -f "$response_file"
  else
    echo "✗ $key failed — HTTP $code" >&2
    cat "$response_file" >&2
    rm -f "$response_file"
    exit 1
  fi
}

update_var WEB_PUSH_VAPID_PUBLIC_KEY "$PUBLIC_KEY"
update_var WEB_PUSH_VAPID_PRIVATE_KEY "$PRIVATE_KEY"
update_var WEB_PUSH_VAPID_SUBJECT "$SUBJECT"

echo "✓ Good Shepherd Web Push credentials are configured on Render."
echo "  VAPID private key was not printed."
