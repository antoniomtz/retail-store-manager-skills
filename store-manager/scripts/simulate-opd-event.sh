#!/usr/bin/env bash
# Trigger the synthetic Store Manager OPD scenario from the host.

set -Eeuo pipefail

USER_HOME="${HOME:?HOME must be set}"
DATA_DIR="${RETAIL_STORE_MANAGER_DATA_DIR:-${USER_HOME}/.local/share/retail-store-manager-skills}"
NOTIFY_HERMES="${STORE_MANAGER_NOTIFY_HERMES:-1}"
COMMAND="${1:-incident}"
NOTIFY_AFTER_EVENT=0
WEBHOOK_EVENT_TYPE=""

usage() {
  cat <<'EOF'
Usage: store-manager/scripts/simulate-opd-event.sh [command]

Commands:
  incident                 Inject the incident and notify Hermes (default)
  demand-surge             Inject only the demand surge
  associate-callout        Inject only the associate call-out
  advance-time MINUTES     Advance the clock, measure any due progress/final checkpoint, and notify Hermes
  reset                    Restore the normal starting state
  status                   Read the current synthetic operating state
EOF
}

if [[ "$COMMAND" == "-h" || "$COMMAND" == "--help" ]]; then
  usage
  exit 0
fi

STATE_DIR="${DATA_DIR}/use-cases/store-manager"
STORE_ID="${STORE_MANAGER_STORE_ID:-$(<"${STATE_DIR}/store-id")}"
BUSINESS_DATE="${STORE_MANAGER_BUSINESS_DATE:-$(<"${STATE_DIR}/business-date")}"
SERVICE_HOST="${STORE_MANAGER_SERVICE_HOST:-$(<"${STATE_DIR}/service-host")}"
CAMEL_PORT="${STORE_MANAGER_CAMEL_PORT:-18080}"
WEBHOOK_PORT="${STORE_MANAGER_WEBHOOK_PORT:-$(<"${STATE_DIR}/webhook-port")}"
WEBHOOK_SECRET_FILE="${STATE_DIR}/webhook-secret"
WEBHOOK_PUBLISHER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/post-store-manager-webhook.py"

[[ "$NOTIFY_HERMES" =~ ^[01]$ ]] || {
  printf '%s\n' "Error: STORE_MANAGER_NOTIFY_HERMES must be 0 or 1." >&2
  exit 2
}

notify_hermes() {
  local event_response="$1"
  local notification_id
  local webhook_payload

  [[ -r "$WEBHOOK_SECRET_FILE" ]] || {
    printf '%s\n' "Error: the Store Manager webhook secret is unavailable; rerun ./install.sh." >&2
    return 1
  }
  [[ -f "$WEBHOOK_PUBLISHER" ]] || {
    printf '%s\n' "Error: the Store Manager webhook publisher is unavailable in this checkout." >&2
    return 1
  }
  notification_id="${WEBHOOK_EVENT_TYPE}-$(jq -r '.operating_state.state_version' <<<"$event_response")-$(date +%s%N)"
  webhook_payload="$(jq -nc \
    --arg event_type "$WEBHOOK_EVENT_TYPE" \
    --arg notification_id "$notification_id" \
    --arg source "store-manager-simulator" \
    --arg store_id "$STORE_ID" \
    --arg business_date "$BUSINESS_DATE" \
    --arg event_result "$(jq -r '.event_result' <<<"$event_response")" \
    --arg simulated_at "$(jq -r '.operating_state.simulated_at' <<<"$event_response")" \
    --argjson state_version "$(jq '.operating_state.state_version' <<<"$event_response")" \
    '{event_type: $event_type, notification_id: $notification_id, source: $source, store_id: $store_id, business_date: $business_date, event_result: $event_result, simulated_at: $simulated_at, state_version: $state_version}')"

  printf '\n%s\n' "==> Posting the OPD event to Hermes at 127.0.0.1:${WEBHOOK_PORT}"
  python3 "$WEBHOOK_PUBLISHER" \
    --route opd-surge \
    --secret-file "$WEBHOOK_SECRET_FILE" \
    --port "$WEBHOOK_PORT" <<<"$webhook_payload"
  printf '%s\n' "Hermes accepted the event. Its recommendation will be delivered to the configured Telegram user."
}

case "$COMMAND" in
  incident|demand-surge|associate-callout|reset)
    [[ $# -eq 1 || ( $# -eq 0 && "$COMMAND" == "incident" ) ]] || {
      usage >&2
      exit 2
    }
    operation="${COMMAND//-/_}"
    payload="$(jq -nc \
      --arg operation "$operation" \
      --arg store_id "$STORE_ID" \
      --arg business_date "$BUSINESS_DATE" \
      '{operation: $operation, store_id: $store_id, business_date: $business_date}')"
    if [[ "$COMMAND" == "incident" ]]; then
      NOTIFY_AFTER_EVENT=1
      WEBHOOK_EVENT_TYPE="opd_incident"
    fi
    ;;
  advance-time)
    [[ $# -eq 2 && "$2" =~ ^[1-9][0-9]*$ ]] || {
      usage >&2
      exit 2
    }
    payload="$(jq -nc \
      --arg store_id "$STORE_ID" \
      --arg business_date "$BUSINESS_DATE" \
      --argjson minutes "$2" \
      '{operation: "advance_time", store_id: $store_id, business_date: $business_date, minutes: $minutes}')"
    NOTIFY_AFTER_EVENT=1
    WEBHOOK_EVENT_TYPE="opd_checkpoint"
    ;;
  status)
    [[ $# -eq 1 ]] || {
      usage >&2
      exit 2
    }
    curl --fail --silent --show-error --max-time 10 \
      --get \
      --data-urlencode "store_id=${STORE_ID}" \
      --data-urlencode "business_date=${BUSINESS_DATE}" \
      "http://${SERVICE_HOST}:${CAMEL_PORT}/v1/store-opd-operating-state" | jq .
    exit 0
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

response="$(curl --fail --silent --show-error --max-time 10 \
  --request POST \
  --header 'Content-Type: application/json' \
  --data "$payload" \
  "http://${SERVICE_HOST}:${CAMEL_PORT}/v1/demo/events")"
jq '{
  event_result,
  minutes_advanced,
  items_processed,
  operating_state: {
    simulated_at: .operating_state.simulated_at,
    operating_status: .operating_state.operating_status,
    active_events: [
      .operating_state.active_events[] |
      {"event_id": .event_id, "type": .type, "label": .label}
    ],
    metrics: .operating_state.metrics,
    checkpoint: .operating_state.checkpoint
  }
} | del(.. | nulls)' <<<"$response"

if [[ "$NOTIFY_AFTER_EVENT" -eq 1 && "$NOTIFY_HERMES" -eq 1 ]]; then
  notify_hermes "$response"
fi
