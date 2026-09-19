#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
USER_HOME="${HOME:?HOME must be set}"
HERMES_HOME="${HERMES_HOME:-${USER_HOME}/.hermes}"
DATA_DIR="${RETAIL_STORE_MANAGER_DATA_DIR:-${USER_HOME}/.local/share/retail-store-manager-skills}"
STATE_DIR="${DATA_DIR}/use-cases/store-manager"
RUNTIME_ENV="${STATE_DIR}/runtime.env"
STORE_ID="${STORE_MANAGER_STORE_ID:-SEA-014}"
BUSINESS_DATE="${STORE_MANAGER_BUSINESS_DATE:-2026-08-03}"
TELEGRAM_USER_ID="${TELEGRAM_USER_ID:-}"
CAMEL_PORT="${STORE_MANAGER_CAMEL_PORT:-18080}"
UI_PORT="${STORE_MANAGER_UI_PORT:-3000}"
PHOENIX_PORT="${PHOENIX_PORT:-6006}"
WEBHOOK_PORT="${STORE_MANAGER_WEBHOOK_PORT:-8644}"
VISION_PROVIDER=""
VISION_MODEL=""
VISION_BASE_URL=""
VERIFY_ONLY=0

usage() {
  cat <<'EOF'
Usage: ./install.sh --telegram-user-id ID [options]
       ./install.sh --verify

Installs the synthetic Store Manager package into an existing vanilla Hermes.
It does not install Hermes, NemoClaw, OpenShell, or a model server.

Options:
  --telegram-user-id ID    Numeric Telegram user/chat ID (required for install)
  --store-id ID            Synthetic store ID (default: SEA-014)
  --business-date DATE     Synthetic fixture date (default: 2026-08-03)
  --vision-provider NAME   Configure Hermes auxiliary vision provider
  --vision-model MODEL     Configure Hermes auxiliary vision model
  --vision-base-url URL    Configure Hermes auxiliary vision API base
  --verify                 Run read-only deployment checks
  -h, --help               Show this help

The Telegram bot token must already be configured through Hermes's masked local
setup. Never pass a bot token or model credential to this script.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

say() {
  printf '\n==> %s\n' "$*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --telegram-user-id) [[ $# -ge 2 ]] || die "$1 requires a value"; TELEGRAM_USER_ID="$2"; shift 2 ;;
    --store-id) [[ $# -ge 2 ]] || die "$1 requires a value"; STORE_ID="$2"; shift 2 ;;
    --business-date) [[ $# -ge 2 ]] || die "$1 requires a value"; BUSINESS_DATE="$2"; shift 2 ;;
    --vision-provider) [[ $# -ge 2 ]] || die "$1 requires a value"; VISION_PROVIDER="$2"; shift 2 ;;
    --vision-model) [[ $# -ge 2 ]] || die "$1 requires a value"; VISION_MODEL="$2"; shift 2 ;;
    --vision-base-url) [[ $# -ge 2 ]] || die "$1 requires a value"; VISION_BASE_URL="$2"; shift 2 ;;
    --verify) VERIFY_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$STORE_ID" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "store ID contains unsupported characters"
[[ "$BUSINESS_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "business date must use YYYY-MM-DD"
for port in "$CAMEL_PORT" "$UI_PORT" "$PHOENIX_PORT" "$WEBHOOK_PORT"; do
  [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1024 && port <= 65535)) || die "ports must be between 1024 and 65535"
done

for command in bash curl docker hermes jq openssl python3 sha256sum systemctl; do
  command -v "$command" >/dev/null || die "required command is unavailable: $command"
done
docker info >/dev/null 2>&1 || die "Docker is not available to the current user"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
[[ -d "$HERMES_HOME" && -f "$HERMES_HOME/config.yaml" ]] || die "vanilla Hermes is not configured at $HERMES_HOME"
HERMES_PYTHON="${HERMES_HOME}/hermes-agent/venv/bin/python"
[[ -x "$HERMES_PYTHON" ]] || die "the Hermes Python runtime was not found at $HERMES_PYTHON"
"$HERMES_PYTHON" -c 'from hermes_cli.config import set_config_value; from hermes_constants import get_hermes_home; from nemo_relay.plugin import validate' \
  || die "this Hermes installation does not include the required webhook and native NeMo Relay APIs"

compose() {
  docker compose --project-name retail-store-manager --env-file "$RUNTIME_ENV" -f "$REPO_DIR/compose.yaml" "$@"
}

read_state() {
  [[ -r "$STATE_DIR/$1" ]] || return 1
  cat "$STATE_DIR/$1"
}

wait_http() {
  local url="$1"
  local attempts="${2:-60}"
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

verify_deployment() {
  local expected_user telegram_rich telemetry vision_model
  [[ -r "$RUNTIME_ENV" ]] || die "runtime state is missing; run ./install.sh first"
  expected_user="$(read_state telegram-user-id)" || die "Telegram target state is missing"
  [[ "$expected_user" =~ ^-?[0-9]+$ ]] || die "recorded Telegram target is invalid"

  say "Checking containers and loopback services"
  [[ "$(compose ps --status running -q camel | wc -l)" -eq 1 ]] || die "Camel is not running"
  [[ "$(compose ps --status running -q phoenix | wc -l)" -eq 1 ]] || die "Phoenix is not running"
  [[ "$(compose ps --status running -q ui | wc -l)" -eq 1 ]] || die "the Store Manager UI is not running"
  wait_http "http://127.0.0.1:${CAMEL_PORT}/health" || die "Camel health check failed"
  wait_http "http://127.0.0.1:${PHOENIX_PORT}/" || die "Phoenix is unavailable"
  wait_http "http://127.0.0.1:${UI_PORT}/" || die "the Store Manager UI is unavailable"
  telemetry="$(curl -fsS --max-time 10 "http://127.0.0.1:${UI_PORT}/api/platform-telemetry")" || die "the UI telemetry adapter is unavailable"
  jq -e '.source.status == "connected"' <<<"$telemetry" >/dev/null || die "the UI is not connected to Phoenix"

  say "Checking the vanilla Hermes installation"
  for skill in morning-briefing opd-recovery opd-surge-response checkout-queue-recovery end-of-day-review store-incident-response; do
    [[ -f "$HERMES_HOME/skills/store-manager/$skill/SKILL.md" ]] || die "missing installed skill: $skill"
    [[ -f "$HERMES_HOME/skills/store-manager/$skill/config.json" ]] || die "missing installed skill configuration: $skill"
  done
  [[ -f "$HERMES_HOME/memories/USER.md" ]] || die "the Store Manager USER profile is missing"
  [[ -f "$HERMES_HOME/hooks/store-manager-agent-response-ready/HOOK.yaml" ]] || die "the response lifecycle hook is missing"
  python3 - "$HERMES_HOME/.env" "$expected_user" "$STATE_DIR/observability/plugins.toml" <<'PY'
from pathlib import Path
import sys
values = {}
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        values[key] = value.strip().strip("'\"")
if values.get("TELEGRAM_ALLOWED_USERS") != sys.argv[2]:
    raise SystemExit("Hermes Telegram authorization does not match the Store Manager target")
if values.get("TELEGRAM_HOME_CHANNEL") != sys.argv[2]:
    raise SystemExit("Hermes Telegram home channel does not match the Store Manager target")
if values.get("HERMES_NEMO_RELAY_PLUGINS_TOML") != sys.argv[3]:
    raise SystemExit("Hermes does not point to the Store Manager Relay plugin configuration")
PY
  telegram_rich="$(hermes config get platforms.telegram.extra.rich_messages 2>/dev/null || true)"
  [[ "${telegram_rich,,}" == "true" ]] || die "Telegram rich final messages are not enabled"
  vision_model="$(hermes config get auxiliary.vision.model 2>/dev/null || true)"
  [[ -n "$vision_model" ]] || die "Hermes auxiliary vision is not configured"
  "$HERMES_PYTHON" - "$HERMES_HOME/config.yaml" "$WEBHOOK_PORT" <<'PY'
import sys, yaml
from pathlib import Path
config = yaml.safe_load(Path(sys.argv[1]).read_text(encoding="utf-8")) or {}
webhook = config.get("platforms", {}).get("webhook", {})
extra = webhook.get("extra", {}) if isinstance(webhook, dict) else {}
if webhook.get("enabled") is not True or extra.get("host") != "127.0.0.1" or int(extra.get("port", 0)) != int(sys.argv[2]):
    raise SystemExit("Hermes webhook listener does not match the loopback Store Manager configuration")
webhook_tools = set(config.get("platform_toolsets", {}).get("webhook", []))
if not {"terminal", "skills", "vision"}.issubset(webhook_tools):
    raise SystemExit("Hermes webhook toolsets are incomplete")
if "clarify" not in set(config.get("platform_toolsets", {}).get("telegram", [])):
    raise SystemExit("Telegram clarify buttons are not enabled")
PY
  "$HERMES_PYTHON" - "$HERMES_HOME/webhook_subscriptions.json" "$expected_user" <<'PY'
import json, sys
from pathlib import Path
routes = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
for name in ("opd-surge", "checkout-queue", "store-incident"):
    route = routes.get(name, {})
    if route.get("deliver") != "telegram" or route.get("deliver_extra", {}).get("chat_id") != sys.argv[2]:
        raise SystemExit(f"invalid webhook delivery target for {name}")
PY
  systemctl --user is-active --quiet hermes-gateway.service || die "the Hermes gateway user service is not active"

  say "Checking signed webhook authentication"
  for route in opd-surge checkout-queue store-incident; do
    python3 "$REPO_DIR/store-manager/scripts/post-store-manager-webhook.py" \
      --route "$route" --secret-file "$STATE_DIR/webhook-secret" --port "$WEBHOOK_PORT" --probe >/dev/null
  done

  say "Checking NeMo Relay configuration"
  "$HERMES_PYTHON" - "$STATE_DIR/observability/plugins.toml" <<'PY'
import sys, tomllib
from nemo_relay.plugin import validate
with open(sys.argv[1], "rb") as stream:
    report = validate(tomllib.load(stream))
if report.get("diagnostics"):
    raise SystemExit(report["diagnostics"])
PY
  printf '\nStore Manager verification passed.\nUI: http://127.0.0.1:%s\nPhoenix: http://127.0.0.1:%s\n' "$UI_PORT" "$PHOENIX_PORT"
}

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  verify_deployment
  exit 0
fi

[[ "$TELEGRAM_USER_ID" =~ ^-?[0-9]+$ ]] || die "--telegram-user-id must be one numeric Telegram user ID"
[[ -f "$HERMES_HOME/.env" ]] || die "Hermes .env is missing; run 'hermes gateway setup' locally first"
grep -Eq '^TELEGRAM_BOT_TOKEN=.+$' "$HERMES_HOME/.env" || die "Telegram is not configured; run 'hermes gateway setup' and enter the bot token in its masked prompt"
if [[ -n "$VISION_PROVIDER$VISION_MODEL$VISION_BASE_URL" ]]; then
  [[ -n "$VISION_PROVIDER" && -n "$VISION_MODEL" && -n "$VISION_BASE_URL" ]] || die "all three --vision-* options must be supplied together"
  [[ "$VISION_BASE_URL" =~ ^https?:// ]] || die "the vision base URL must be HTTP or HTTPS"
fi

say "Preparing private runtime state"
install -d -m 700 "$STATE_DIR" "$STATE_DIR/phoenix" "$STATE_DIR/observability"
printf '%s\n' "$STORE_ID" >"$STATE_DIR/store-id"
printf '%s\n' "$BUSINESS_DATE" >"$STATE_DIR/business-date"
printf '%s\n' 127.0.0.1 >"$STATE_DIR/service-host"
printf '%s\n' "$WEBHOOK_PORT" >"$STATE_DIR/webhook-port"
printf '%s\n' "$TELEGRAM_USER_ID" >"$STATE_DIR/telegram-user-id"
if [[ ! -s "$STATE_DIR/webhook-secret" ]]; then
  openssl rand -hex 32 >"$STATE_DIR/webhook-secret"
fi
chmod 600 "$STATE_DIR/webhook-secret" "$STATE_DIR/telegram-user-id"
UI_SOURCE_HASH="$(find "$REPO_DIR/store-manager/demo-ui" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
VISION_MODEL_EFFECTIVE="$VISION_MODEL"
if [[ -z "$VISION_MODEL_EFFECTIVE" ]]; then
  VISION_MODEL_EFFECTIVE="$(hermes config get auxiliary.vision.model 2>/dev/null || true)"
fi
cat >"$RUNTIME_ENV" <<EOF
STORE_MANAGER_STATE_DIR=${STATE_DIR}
STORE_MANAGER_HOST_UID=$(id -u)
STORE_MANAGER_HOST_GID=$(id -g)
STORE_MANAGER_CAMEL_PORT=${CAMEL_PORT}
STORE_MANAGER_UI_BIND=127.0.0.1
STORE_MANAGER_UI_PORT=${UI_PORT}
PHOENIX_PORT=${PHOENIX_PORT}
STORE_MANAGER_UI_SOURCE_HASH=${UI_SOURCE_HASH}
HERMES_AUXILIARY_VISION_MODEL=${VISION_MODEL_EFFECTIVE}
DEMO_ALLOW_SIMULATED_APPROVAL=0
EOF
chmod 600 "$RUNTIME_ENV"

say "Starting Apache Camel, Phoenix, and the Store Manager UI"
compose up -d --build

say "Installing the Store Manager skills and profile"
SKILLS_DEST="$HERMES_HOME/skills/store-manager"
HOOK_DEST="$HERMES_HOME/hooks/store-manager-agent-response-ready"
install -d -m 755 "$SKILLS_DEST" "$HOOK_DEST" "$HERMES_HOME/memories"
cp -a "$REPO_DIR/skills/store-manager/." "$SKILLS_DEST/"
cp -a "$REPO_DIR/store-manager/hooks/store-manager-agent-response-ready/." "$HOOK_DEST/"
cp "$REPO_DIR/store-manager/USER.md" "$HERMES_HOME/memories/USER.md"
install -d -m 755 "$SKILLS_DEST/store-incident-response/assets"
cp "$REPO_DIR/store-manager/demo-ui/public/incident.jpg" "$SKILLS_DEST/store-incident-response/assets/incident.jpg"
python3 - "$SKILLS_DEST" "$HOOK_DEST" "$HERMES_HOME" <<'PY'
from pathlib import Path
import sys
roots = [Path(sys.argv[1]), Path(sys.argv[2])]
replacement = sys.argv[3].encode()
for root in roots:
    for path in root.rglob("*"):
        if path.is_file() and not path.is_symlink():
            data = path.read_bytes()
            if b"__HERMES_HOME__" in data:
                path.write_bytes(data.replace(b"__HERMES_HOME__", replacement))
PY

BASE_URL="http://127.0.0.1:${CAMEL_PORT}"
jq -n --arg endpoint "$BASE_URL/v1/store-morning-snapshot" --arg store_id "$STORE_ID" --arg business_date "$BUSINESS_DATE" --arg telegram_chat_id "$TELEGRAM_USER_ID" '{endpoint:$endpoint,store_id:$store_id,business_date:$business_date,telegram_chat_id:$telegram_chat_id}' >"$SKILLS_DEST/morning-briefing/config.json"
jq -n --arg endpoint "$BASE_URL/v1/store-opd-recovery" --arg store_id "$STORE_ID" --arg business_date "$BUSINESS_DATE" '{endpoint:$endpoint,store_id:$store_id,business_date:$business_date}' >"$SKILLS_DEST/opd-recovery/config.json"
jq -n --arg status_endpoint "$BASE_URL/v1/store-opd-operating-state" --arg plans_endpoint "$BASE_URL/v1/store-opd-recovery-plans" --arg decisions_endpoint "$BASE_URL/v1/store-opd-decisions" --arg actions_endpoint "$BASE_URL/v1/store-opd-actions" --arg store_id "$STORE_ID" --arg business_date "$BUSINESS_DATE" '{status_endpoint:$status_endpoint,plans_endpoint:$plans_endpoint,decisions_endpoint:$decisions_endpoint,actions_endpoint:$actions_endpoint,store_id:$store_id,business_date:$business_date}' >"$SKILLS_DEST/opd-surge-response/config.json"
jq -n --arg status_endpoint "$BASE_URL/v1/store-checkout-operating-state" --arg plans_endpoint "$BASE_URL/v1/store-checkout-recovery-plans" --arg decisions_endpoint "$BASE_URL/v1/store-checkout-decisions" --arg actions_endpoint "$BASE_URL/v1/store-checkout-actions" --arg store_id "$STORE_ID" --arg business_date "$BUSINESS_DATE" '{status_endpoint:$status_endpoint,plans_endpoint:$plans_endpoint,decisions_endpoint:$decisions_endpoint,actions_endpoint:$actions_endpoint,store_id:$store_id,business_date:$business_date}' >"$SKILLS_DEST/checkout-queue-recovery/config.json"
jq -n --arg endpoint "$BASE_URL/v1/store-end-of-day-review" --arg store_id "$STORE_ID" --arg business_date "$BUSINESS_DATE" '{endpoint:$endpoint,store_id:$store_id,business_date:$business_date}' >"$SKILLS_DEST/end-of-day-review/config.json"
jq -n --arg endpoint "$BASE_URL/v1/store-incident-response-plans" --arg store_id "$STORE_ID" --arg business_date "$BUSINESS_DATE" '{endpoint:$endpoint,store_id:$store_id,business_date:$business_date}' >"$SKILLS_DEST/store-incident-response/config.json"
jq -n --arg status_endpoint "$BASE_URL/v1/store-opd-operating-state" --arg message_ready_endpoint "$BASE_URL/v1/store-opd-manager-message" --arg store_id "$STORE_ID" --arg business_date "$BUSINESS_DATE" '{status_endpoint:$status_endpoint,message_ready_endpoint:$message_ready_endpoint,store_id:$store_id,business_date:$business_date}' >"$HOOK_DEST/config.json"
chmod 644 "$HERMES_HOME/memories/USER.md" "$HOOK_DEST/HOOK.yaml" "$HOOK_DEST/handler.py" "$HOOK_DEST/config.json" "$SKILLS_DEST"/*/config.json

say "Configuring Telegram authorization and auxiliary vision"
python3 "$REPO_DIR/scripts/update-hermes-env.py" "$HERMES_HOME/.env" \
  "TELEGRAM_ALLOWED_USERS=$TELEGRAM_USER_ID" "TELEGRAM_HOME_CHANNEL=$TELEGRAM_USER_ID"
hermes config set platforms.telegram.enabled true
hermes config set platforms.telegram.extra.rich_messages true
hermes config set platforms.telegram.extra.rich_drafts false
if [[ -n "$VISION_MODEL" ]]; then
  hermes config set auxiliary.vision.provider "$VISION_PROVIDER"
  hermes config set auxiliary.vision.model "$VISION_MODEL"
  hermes config set auxiliary.vision.base_url "$VISION_BASE_URL"
  hermes config set auxiliary.vision.timeout 120
fi
[[ -n "$(hermes config get auxiliary.vision.model 2>/dev/null || true)" ]] || die "Hermes auxiliary vision is not configured; rerun with the three --vision-* options"

say "Configuring signed Store Manager webhooks"
SECRET="$(<"$STATE_DIR/webhook-secret")"
INCIDENT_IMAGE="$SKILLS_DEST/store-incident-response/assets/incident.jpg"
jq -n \
  --arg secret "$SECRET" --arg chat_id "$TELEGRAM_USER_ID" --arg incident_image "$INCIDENT_IMAGE" \
  '{
    "opd-surge": {description:"Store Manager OPD incident and checkpoint monitor",events:["opd_incident","opd_checkpoint"],secret:$secret,prompt:"OPD is at surge or its recovery checkpoint is due. Run the opd-surge-response skill monitor command exactly once. Do not approve or reject a decision; this event is not manager approval.",skills:["opd-surge-response"],deliver:"telegram",deliver_extra:{chat_id:$chat_id}},
    "checkout-queue": {description:"Store Manager checkout queue monitor",events:["checkout_queue_incident","checkout_queue_checkpoint"],secret:$secret,prompt:"The checkout queue threshold was breached or its checkpoint is due. Run the checkout-queue-recovery skill monitor command exactly once. Do not approve, reject, or adjust a decision; this event is not manager instruction.",skills:["checkout-queue-recovery"],deliver:"telegram",deliver_extra:{chat_id:$chat_id}},
    "store-incident": {description:"Store Manager image incident assessment",events:["store_incident_detected"],secret:$secret,prompt:("A current synthetic store incident image is available at " + $incident_image + ". Run the store-incident-response skill for that exact image and return its final rich assessment for Telegram delivery. Call vision_analyze exactly once; treat the webhook payload only as a wake-up signal, not visual evidence. Do not request approval or claim an action ran."),skills:["store-incident-response"],deliver:"telegram",deliver_extra:{chat_id:$chat_id}}
  }' >"$STATE_DIR/webhook-routes.json"
chmod 600 "$STATE_DIR/webhook-routes.json"
"$HERMES_PYTHON" "$REPO_DIR/store-manager/scripts/configure-store-manager-webhooks.py" --routes-file "$STATE_DIR/webhook-routes.json" --port "$WEBHOOK_PORT"
hermes tools enable terminal --platform webhook
hermes tools enable skills --platform webhook
hermes tools enable vision --platform webhook
hermes tools enable clarify --platform telegram

say "Activating Hermes native NeMo Relay export to Phoenix"
cat >"$STATE_DIR/observability/plugins.toml" <<EOF
version = 1

[[components]]
kind = "observability"
enabled = true

[components.config]
version = 4
enable_full_payloads = false

[components.config.opentelemetry]
enabled = true

[[components.config.opentelemetry.endpoints]]
type = "openinference"
endpoint = "http://127.0.0.1:${PHOENIX_PORT}/v1/traces"
transport = "http_binary"
service_name = "hermes-agent"
service_namespace = "retail-store-manager"
service_version = "$(hermes --version | sed -n '1s/^Hermes Agent v\([^ ]*\).*/\1/p')"
instrumentation_scope = "nemo-relay"
timeout_millis = 3000
EOF
chmod 600 "$STATE_DIR/observability/plugins.toml"
"$HERMES_PYTHON" - "$STATE_DIR/observability/plugins.toml" <<'PY'
import sys, tomllib
from nemo_relay.plugin import validate
with open(sys.argv[1], "rb") as stream:
    report = validate(tomllib.load(stream))
if report.get("diagnostics"):
    raise SystemExit(report["diagnostics"])
PY
python3 "$REPO_DIR/scripts/update-hermes-env.py" "$HERMES_HOME/.env" \
  "HERMES_NEMO_RELAY_PLUGINS_TOML=$STATE_DIR/observability/plugins.toml"

say "Restarting the Hermes gateway"
if systemctl --user cat hermes-gateway.service >/dev/null 2>&1; then
  hermes gateway restart
else
  hermes gateway install
  hermes gateway start
fi

verify_deployment
printf '\nSend /reset once in the Telegram conversation before testing approval flows.\n'
