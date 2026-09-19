#!/usr/bin/env bash
# Generate the independent eight-hour Store Manager end-of-day simulation.

set -Eeuo pipefail

USER_HOME="${HOME:?HOME must be set}"
DATA_DIR="${RETAIL_STORE_MANAGER_DATA_DIR:-${USER_HOME}/.local/share/retail-store-manager-skills}"
COMMAND="${1:-run}"
STATE_DIR="${DATA_DIR}/use-cases/store-manager"

usage() {
  cat <<'EOF'
Usage: store-manager/scripts/simulate-store-day.sh [command]

Commands:
  run       Generate the independent eight-hour synthetic store day (default)
  reset     Remove the generated day and return the simulation to not-run state
  status    Show whether the synthetic day is ready for an end-of-day review

This simulator does not start Hermes, create a webhook event, or configure a
cron job. After `run`, ask Hermes for the end-of-day operating review.
EOF
}

if [[ "$COMMAND" == "-h" || "$COMMAND" == "--help" ]]; then
  usage
  exit 0
fi

[[ -r "${STATE_DIR}/store-id" && -r "${STATE_DIR}/business-date" && -r "${STATE_DIR}/service-host" ]] || {
  printf '%s\n' "Error: Store Manager runtime state is unavailable; run ./install.sh first." >&2
  exit 1
}

STORE_ID="${STORE_MANAGER_STORE_ID:-$(<"${STATE_DIR}/store-id")}"
BUSINESS_DATE="${STORE_MANAGER_BUSINESS_DATE:-$(<"${STATE_DIR}/business-date")}"
SERVICE_HOST="${STORE_MANAGER_SERVICE_HOST:-$(<"${STATE_DIR}/service-host")}"
CAMEL_PORT="${STORE_MANAGER_CAMEL_PORT:-18080}"
BASE_URL="http://${SERVICE_HOST}:${CAMEL_PORT}"

status() {
  curl --fail --silent --show-error --max-time 10 \
    --get \
    --data-urlencode "store_id=${STORE_ID}" \
    --data-urlencode "business_date=${BUSINESS_DATE}" \
    "${BASE_URL}/v1/store-end-of-day-review"
}

case "$COMMAND" in
  status)
    [[ $# -eq 1 ]] || {
      usage >&2
      exit 2
    }
    status | jq '{
      simulation_status,
      simulation_run_id,
      store_id,
      business_date,
      simulated_period,
      data_quality
    } | del(.. | nulls)'
    ;;
  reset|run)
    [[ $# -eq 1 || ( $# -eq 0 && "$COMMAND" == "run" ) ]] || {
      usage >&2
      exit 2
    }
    payload="$(jq -nc \
      --arg operation "$COMMAND" \
      --arg store_id "$STORE_ID" \
      --arg business_date "$BUSINESS_DATE" \
      '{operation: $operation, store_id: $store_id, business_date: $business_date}')"
    response="$(curl --fail --silent --show-error --max-time 30 \
      --request POST \
      --header 'Content-Type: application/json' \
      --data "$payload" \
      "${BASE_URL}/v1/demo/store-day")"
    jq '{
      event_result,
      simulation_status: .review.simulation_status,
      simulation_run_id: .review.simulation_run_id,
      store_id: .review.store_id,
      business_date: .review.business_date,
      simulated_period: .review.simulated_period,
      sales: .review.sales,
      checkout: (
        .review.checkout |
        if type == "object" then {
          incident_count,
          minutes_above_target,
          average_response_minutes,
          maximum_response_minutes
        } else null end
      ),
      opd: (
        .review.opd |
        if type == "object" then {
          incident_count,
          minutes_below_target,
          late_orders_at_close
        } else null end
      ),
      inventory: (
        .review.inventory |
        if type == "object" then {
          stockout_count,
          unserved_customer_requests
        } else null end
      )
    } | del(.. | nulls)' <<<"$response"
    if [[ "$COMMAND" == "run" ]]; then
      printf '\n%s\n' "The synthetic store day is ready. In Hermes, ask: Give me the end-of-day operating review."
    fi
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
