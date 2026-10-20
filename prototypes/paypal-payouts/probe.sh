#!/usr/bin/env bash
# PROTOTYPE (throwaway): probe PayPal sandbox for PlayCount's money flow.
# Auth: none here. The cloud environment's network secret injects the OAuth
# token for api-m.sandbox.paypal.com. Fallback: set PAYPAL_CLIENT_ID and
# PAYPAL_CLIENT_SECRET and this script fetches a token itself.
#
#   ./probe.sh auth                       # 1. can we reach the sandbox?
#   ./probe.sh payout <personal-email>    # 2. batch to a real sandbox account + a no-account email
#   ./probe.sh batch <payout_batch_id>    #    re-check batch/item status later
#   ./probe.sh subscription               # 3. product + plan + subscription, prints approve link
#   ./probe.sh sub <subscription_id>      #    check status after approving
#
# Responses are saved to ./out/ (no secrets: the token never touches this script
# unless the env-var fallback is used, and it is never written out).
set -euo pipefail
API=https://api-m.sandbox.paypal.com
OUT="$(dirname "$0")/out"; mkdir -p "$OUT"
AUTH=()
if [[ -n "${PAYPAL_CLIENT_ID:-}" ]]; then
  TOKEN=$(curl -sS -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials "$API/v1/oauth2/token" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
  AUTH=(-H "Authorization: Bearer $TOKEN")
fi
call() { # call NAME METHOD PATH [JSON]
  local name=$1 method=$2 path=$3 body=${4:-}
  local args=(-sS -X "$method" "${AUTH[@]}" -H "Content-Type: application/json" -w '\nHTTP %{http_code}\n')
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}" "$API$path" | tee "$OUT/$name.txt"; echo
}
rid() { python3 -c 'import uuid;print(uuid.uuid4().hex[:12])'; }

case "${1:-}" in
  auth) call auth GET "/v1/identity/oauth2/userinfo?schema=paypalv1.1" ;;
  payout)
    email=${2:?personal sandbox email}; nobody="playcount-unclaimed-$(rid)@example.com"; id=$(rid)
    call payout POST /v1/payments/payouts "{
      \"sender_batch_header\": {\"sender_batch_id\": \"pc-$id\", \"email_subject\": \"PlayCount royalty\", \"email_message\": \"Your project earned a royalty from developers' coding agents.\"},
      \"items\": [
        {\"recipient_type\": \"EMAIL\", \"receiver\": \"$email\", \"amount\": {\"value\": \"3.21\", \"currency\": \"USD\"}, \"sender_item_id\": \"zod-$id\", \"note\": \"Royalty: zod\"},
        {\"recipient_type\": \"EMAIL\", \"receiver\": \"$nobody\", \"amount\": {\"value\": \"1.23\", \"currency\": \"USD\"}, \"sender_item_id\": \"rhf-$id\", \"note\": \"Royalty: react-hook-form\"}
      ]}" ;;
  batch) call "batch-${2:?id}" GET "/v1/payments/payouts/$2?fields=batch_header,items" ;;
  subscription)
    call product POST /v1/catalogs/products '{"name":"PlayCount Budget","type":"SERVICE","category":"SOFTWARE"}'
    pid=$(python3 -c 'import sys,json;print(json.loads(open(sys.argv[1]).read().rsplit("\nHTTP",1)[0])["id"])' "$OUT/product.txt")
    call plan POST /v1/billing/plans "{\"product_id\":\"$pid\",\"name\":\"PlayCount Budget \$10/mo\",\"billing_cycles\":[{\"frequency\":{\"interval_unit\":\"MONTH\",\"interval_count\":1},\"tenure_type\":\"REGULAR\",\"sequence\":1,\"total_cycles\":0,\"pricing_scheme\":{\"fixed_price\":{\"value\":\"10\",\"currency_code\":\"USD\"}}}],\"payment_preferences\":{\"auto_bill_outstanding\":true,\"payment_failure_threshold\":1}}"
    plid=$(python3 -c 'import sys,json;print(json.loads(open(sys.argv[1]).read().rsplit("\nHTTP",1)[0])["id"])' "$OUT/plan.txt")
    call subscription POST /v1/billing/subscriptions "{\"plan_id\":\"$plid\",\"application_context\":{\"brand_name\":\"PlayCount\",\"user_action\":\"SUBSCRIBE_NOW\",\"return_url\":\"https://example.com/ok\",\"cancel_url\":\"https://example.com/cancel\"}}" ;;
  sub) call "sub-${2:?id}" GET "/v1/billing/subscriptions/$2" ;;
  *) sed -n 2,14p "$0"; exit 1 ;;
esac
