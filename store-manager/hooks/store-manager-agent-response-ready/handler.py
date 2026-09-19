"""Mark an OPD recommendation ready after Hermes finishes its webhook turn."""

from __future__ import annotations

import ipaddress
import json
import logging
from pathlib import Path
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


LOGGER = logging.getLogger("hooks.store-manager-agent-response-ready")
CONFIG_PATH = Path(__file__).with_name("config.json")
MAX_RESPONSE_BYTES = 131_072
DECISION_ID_PATTERN = re.compile(r"^OPD-DEC-[A-Z0-9]{8}-[0-9]{3,}$")
STORE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _load_config() -> dict:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise ValueError("hook configuration must be an object")
    store_id = config.get("store_id")
    business_date = config.get("business_date")
    if not isinstance(store_id, str) or not STORE_ID_PATTERN.fullmatch(store_id):
        raise ValueError("hook store_id is invalid")
    if not isinstance(business_date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", business_date):
        raise ValueError("hook business_date is invalid")

    origins: set[tuple[str, str, int | None]] = set()
    expected_paths = {
        "status_endpoint": "/v1/store-opd-operating-state",
        "message_ready_endpoint": "/v1/store-opd-manager-message",
    }
    for key, expected_path in expected_paths.items():
        value = config.get(key)
        if not isinstance(value, str):
            raise ValueError(f"hook {key} is missing")
        parsed = urlsplit(value)
        if (
            parsed.scheme != "http"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path != expected_path
        ):
            raise ValueError(f"hook {key} is outside the supported private path")
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError as error:
            raise ValueError(f"hook {key} must use a private IP address") from error
        if not (address.is_private or address.is_loopback):
            raise ValueError(f"hook {key} must use a private IP address")
        origins.add((parsed.scheme, parsed.hostname, parsed.port))
    if len(origins) != 1:
        raise ValueError("hook endpoints must share one private origin")
    return config


def _request_json(endpoint: str, method: str, payload: dict | None = None) -> dict:
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    response = urlopen(
        Request(
            endpoint,
            data=body,
            headers={
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if body is not None else {}),
            },
            method=method,
        ),
        timeout=5,
    )
    with response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("Camel hook response exceeded the size limit")
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise RuntimeError("Camel hook response was not an object")
    return result


def _mark_current_opd_message_ready(config: dict) -> None:
    query = urlencode({"store_id": config["store_id"], "business_date": config["business_date"]})
    state = _request_json(f"{config['status_endpoint']}?{query}", "GET")
    decision = state.get("decision")
    if not isinstance(decision, dict):
        return
    decision_id = decision.get("decision_id")
    state_version = decision.get("based_on_state_version")
    if (
        decision.get("status") != "pending_manager_approval"
        or decision.get("decision_author") != "hermes"
        or decision.get("manager_message_status") != "preparing"
        or not isinstance(decision_id, str)
        or not DECISION_ID_PATTERN.fullmatch(decision_id)
        or not isinstance(state_version, int)
        or state_version < 1
    ):
        return

    result = _request_json(
        config["message_ready_endpoint"],
        "POST",
        {
            "store_id": config["store_id"],
            "business_date": config["business_date"],
            "decision_id": decision_id,
            "expected_state_version": state_version,
            "idempotency_key": f"{decision_id}-manager-message-ready",
        },
    )
    ready = result.get("decision")
    if (
        result.get("manager_message_ready") is not True
        or not isinstance(ready, dict)
        or ready.get("decision_id") != decision_id
        or ready.get("manager_message_status") != "ready"
    ):
        raise RuntimeError("Camel did not confirm the completed OPD manager message")
    LOGGER.info("OPD manager message is ready for decision %s", decision_id)


async def handle(event_type: str, context: dict) -> None:
    if (
        event_type != "agent:end"
        or context.get("platform") != "webhook"
        or context.get("user_id") != "webhook:opd-surge"
        or not str(context.get("response") or "").strip()
    ):
        return
    try:
        _mark_current_opd_message_ready(_load_config())
    except (OSError, ValueError, RuntimeError, HTTPError, URLError, json.JSONDecodeError) as error:
        LOGGER.warning("Could not publish the completed OPD manager message: %s", error)
