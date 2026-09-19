#!/usr/bin/env bash
# Start an isolated Camel service, run deterministic contracts, and clean up.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
REPOSITORY_DIR="$(cd -- "${PACKAGE_DIR}/.." && pwd)"
COMPOSE_FILE="${REPOSITORY_DIR}/compose.yaml"
PROJECT_NAME="retail-store-manager-contract-${BASHPID}"
CONTRACT_STATE_DIR="$(mktemp -d)"

command -v docker >/dev/null || {
  printf '%s\n' "Error: docker is required." >&2
  exit 1
}
docker compose version >/dev/null || {
  printf '%s\n' "Error: Docker Compose is required." >&2
  exit 1
}
command -v python3 >/dev/null || {
  printf '%s\n' "Error: python3 is required." >&2
  exit 1
}

export SERVICE_BIND_HOST="127.0.0.1"
export STORE_MANAGER_CAMEL_PORT="0"
export STORE_MANAGER_STATE_DIR="$CONTRACT_STATE_DIR"
export STORE_MANAGER_HOST_UID="$(id -u)"
export STORE_MANAGER_HOST_GID="$(id -g)"

compose() {
  docker compose --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

cleanup() {
  local status="$?"
  trap - EXIT
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rmdir "$CONTRACT_STATE_DIR" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

printf '%s\n' "Starting isolated Store Manager Camel contract service"
compose up --detach --wait --wait-timeout 240 camel

published="$(compose port camel 8080)"
port="${published##*:}"
[[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || {
  printf '%s\n' "Error: could not resolve the isolated Camel port." >&2
  exit 1
}

python3 "${SCRIPT_DIR}/test_camel_contracts.py" \
  --base-url "http://127.0.0.1:${port}"
