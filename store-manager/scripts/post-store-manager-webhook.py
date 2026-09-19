#!/usr/bin/env python3
"""Send one authenticated Store Manager event to the loopback Hermes webhook."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


LOOPBACK_HOST = "127.0.0.1"
MAX_RESPONSE_BYTES = 16_384
ROUTE_EVENTS = {
    "opd-surge": {"opd_incident", "opd_checkpoint"},
    "checkout-queue": {"checkout_queue_incident", "checkout_queue_checkpoint"},
    "store-incident": {"store_incident_detected"},
}
VERIFY_EVENT = "store_manager_verify"
SECRET_PATTERN = re.compile(r"^[0-9a-f]{64}$")
NOTIFICATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Post one signed Store Manager event to Hermes on 127.0.0.1."
    )
    parser.add_argument("--route", choices=tuple(ROUTE_EVENTS), required=True)
    parser.add_argument("--secret-file", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--probe",
        action="store_true",
        help="Verify authentication and routing without starting an agent run.",
    )
    return parser.parse_args()


def read_secret(path: Path) -> str:
    try:
        secret = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ValueError("the Store Manager webhook secret is unavailable") from error
    if not SECRET_PATTERN.fullmatch(secret):
        raise ValueError("the Store Manager webhook secret is invalid")
    return secret


def read_payload(probe: bool) -> dict:
    if probe:
        return {
            "event_type": VERIFY_EVENT,
            "notification_id": f"store-manager-verify-{time.time_ns()}",
            "source": "retail-store-manager-verifier",
        }
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        raise ValueError("the Store Manager webhook payload is invalid JSON") from error
    if not isinstance(payload, dict):
        raise ValueError("the Store Manager webhook payload must be an object")
    return payload


def validate_payload(route: str, payload: dict, probe: bool) -> None:
    event_type = payload.get("event_type")
    notification_id = payload.get("notification_id")
    allowed = ROUTE_EVENTS[route]
    if event_type not in allowed | {VERIFY_EVENT}:
        raise ValueError("the Store Manager webhook event type is unsupported for this route")
    if probe != (event_type == VERIFY_EVENT):
        raise ValueError("the Store Manager webhook probe mode does not match its event type")
    if not isinstance(notification_id, str) or not NOTIFICATION_ID_PATTERN.fullmatch(notification_id):
        raise ValueError("the Store Manager webhook notification ID is invalid")


def post(route: str, payload: dict, secret: str, port: int) -> tuple[int, dict]:
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    timestamp = str(int(time.time()))
    signature = hmac.new(
        secret.encode("utf-8"), timestamp.encode("ascii") + b"." + body, hashlib.sha256
    ).hexdigest()
    request = Request(
        f"http://{LOOPBACK_HOST}:{port}/webhooks/{route}",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Webhook-Signature-V2": signature,
            "X-Webhook-Timestamp": timestamp,
            "X-Request-ID": payload["notification_id"],
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=10) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            status = response.status
    except HTTPError as error:
        raw = error.read(MAX_RESPONSE_BYTES)
        detail = raw.decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Hermes webhook returned HTTP {error.code}: {detail}") from error
    except (URLError, TimeoutError) as error:
        raise RuntimeError(f"Hermes webhook is unavailable at http://{LOOPBACK_HOST}:{port}") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("Hermes webhook response exceeded the size limit")
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("Hermes webhook returned invalid JSON") from error
    if not isinstance(result, dict):
        raise RuntimeError("Hermes webhook returned an invalid response object")
    return status, result


def main() -> int:
    args = parse_args()
    if not 1024 <= args.port <= 65535:
        print("Error: webhook port must be between 1024 and 65535", file=sys.stderr)
        return 2
    try:
        secret = read_secret(args.secret_file)
        payload = read_payload(args.probe)
        validate_payload(args.route, payload, args.probe)
        status, result = post(args.route, payload, secret, args.port)
        if args.probe:
            if status != 200 or result.get("status") != "ignored":
                raise RuntimeError("Hermes did not reject the non-agent verification event as expected")
            print(f"Hermes {args.route} webhook authentication probe passed.")
            return 0
        if status != 202 or result.get("status") != "accepted":
            raise RuntimeError("Hermes did not accept the Store Manager event")
    except (ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "status": result.get("status"),
                "route": result.get("route"),
                "event": result.get("event"),
                "delivery_id": result.get("delivery_id"),
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
