#!/usr/bin/env bash
set -euo pipefail

base_url="${BASE_URL:-http://127.0.0.1:8788}"
token="${SIRI_BRIDGE_TOKEN:-}"

if [[ -z "$token" ]]; then
  echo "SIRI_BRIDGE_TOKEN is required" >&2
  exit 2
fi

curl -fsS "$base_url/healthz" >/dev/null

curl -fsS \
  -X POST "$base_url/shortcuts/message" \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -d '{"message":"OpenClaw Siri bridge smoke test.","source":"shortcuts","device_name":"smoke-test"}'

echo
echo "smoke test accepted"
