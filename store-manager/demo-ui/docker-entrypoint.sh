#!/bin/sh
# Load only the protected Store Manager values needed by the server-side UI.

set -eu

state_dir="${STORE_MANAGER_STATE_DIR:-/run/store-manager}"

read_state() {
  state_name="$1"
  state_path="${state_dir}/${state_name}"
  if [ ! -f "$state_path" ] || [ ! -r "$state_path" ]; then
    printf 'Error: Store Manager state %s is unavailable.\n' "$state_name" >&2
    exit 1
  fi
  IFS= read -r state_value < "$state_path"
  printf '%s' "$state_value"
}

STORE_MANAGER_STORE_ID="$(read_state store-id)"
STORE_MANAGER_BUSINESS_DATE="$(read_state business-date)"
STORE_MANAGER_WEBHOOK_PORT="$(read_state webhook-port)"
STORE_MANAGER_WEBHOOK_SECRET="$(read_state webhook-secret)"
STORE_MANAGER_HERMES_CHAT_ENABLED="${STORE_MANAGER_HERMES_CHAT_ENABLED:-0}"
STORE_MANAGER_TELEGRAM_ENABLED="${STORE_MANAGER_TELEGRAM_ENABLED:-0}"

case "$STORE_MANAGER_STORE_ID" in
  *[!A-Za-z0-9_-]*|'') printf '%s\n' 'Error: Store Manager store ID is invalid.' >&2; exit 1 ;;
esac
case "$STORE_MANAGER_BUSINESS_DATE" in
  ????-??-??) ;;
  *) printf '%s\n' 'Error: Store Manager business date is invalid.' >&2; exit 1 ;;
esac
case "$STORE_MANAGER_WEBHOOK_PORT" in
  *[!0-9]*|'') printf '%s\n' 'Error: Store Manager webhook port is invalid.' >&2; exit 1 ;;
esac
case "$STORE_MANAGER_WEBHOOK_SECRET" in
  *[!0-9a-f]*|'') printf '%s\n' 'Error: Store Manager webhook secret is invalid.' >&2; exit 1 ;;
esac
if [ "${#STORE_MANAGER_WEBHOOK_SECRET}" -ne 64 ]; then
  printf '%s\n' 'Error: Store Manager webhook secret is invalid.' >&2
  exit 1
fi

case "$STORE_MANAGER_HERMES_CHAT_ENABLED" in
  0|1) ;;
  *) printf '%s\n' 'Error: STORE_MANAGER_HERMES_CHAT_ENABLED must be 0 or 1.' >&2; exit 1 ;;
esac
case "$STORE_MANAGER_TELEGRAM_ENABLED" in
  0|1) ;;
  *) printf '%s\n' 'Error: STORE_MANAGER_TELEGRAM_ENABLED must be 0 or 1.' >&2; exit 1 ;;
esac
HERMES_API_SERVER_KEY="$(read_state hermes-api-key)"
case "$HERMES_API_SERVER_KEY" in
  *[![:graph:]]*|'') printf '%s\n' 'Error: Hermes API credential is invalid.' >&2; exit 1 ;;
esac
if [ "${#HERMES_API_SERVER_KEY}" -lt 32 ] || [ "${#HERMES_API_SERVER_KEY}" -gt 512 ]; then
  printf '%s\n' 'Error: Hermes API credential is invalid.' >&2
  exit 1
fi

export STORE_MANAGER_STORE_ID STORE_MANAGER_BUSINESS_DATE
export STORE_MANAGER_WEBHOOK_PORT STORE_MANAGER_WEBHOOK_SECRET
export STORE_MANAGER_HERMES_CHAT_ENABLED STORE_MANAGER_TELEGRAM_ENABLED HERMES_API_SERVER_KEY

exec node server.js
