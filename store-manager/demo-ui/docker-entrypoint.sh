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

export STORE_MANAGER_STORE_ID STORE_MANAGER_BUSINESS_DATE
export STORE_MANAGER_WEBHOOK_PORT STORE_MANAGER_WEBHOOK_SECRET

exec node server.js
