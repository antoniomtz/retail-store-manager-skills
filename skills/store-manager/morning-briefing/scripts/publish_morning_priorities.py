#!/usr/bin/env python3
"""Publish one bounded morning-priority presentation to the private Camel API."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.json"
EXPECTED_PAYLOAD = Path("/tmp/store-manager-morning-briefing-priorities.json")
MAX_PAYLOAD_BYTES = 8_192
MAX_RESPONSE_BYTES = 16_384
STORE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
BUSINESS_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Publish the current morning briefing priorities for the demo UI."
    )
    parser.add_argument("--payload-file", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    return parser.parse_args()


def load_config(config_path: Path) -> tuple[str, str, str]:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("the installed Store Manager presentation configuration is invalid") from error

    endpoint = config.get("presentation_endpoint") if isinstance(config, dict) else None
    store_id = config.get("store_id") if isinstance(config, dict) else None
    business_date = config.get("business_date") if isinstance(config, dict) else None
    if not isinstance(endpoint, str):
        raise ValueError("the installed presentation endpoint is missing")
    if not isinstance(store_id, str) or not STORE_ID_PATTERN.fullmatch(store_id):
        raise ValueError("the installed Store Manager store ID is invalid")
    if not isinstance(business_date, str) or not BUSINESS_DATE_PATTERN.fullmatch(business_date):
        raise ValueError("the installed Store Manager business date is invalid")

    parsed = urlsplit(endpoint)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path != "/v1/store-morning-briefing-presentation"
    ):
        raise ValueError("the installed presentation endpoint is outside the supported path")
    return endpoint, store_id, business_date


def bounded_text(value: object, field: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"priority {field} must be text")
    normalized = value.strip()
    if not normalized or len(normalized) > maximum or any(ord(character) < 32 for character in normalized):
        raise ValueError(f"priority {field} is invalid")
    return normalized


def read_payload(payload_path: Path, store_id: str, business_date: str) -> dict:
    if payload_path != EXPECTED_PAYLOAD or payload_path.is_symlink():
        raise ValueError("the priority payload must use the managed temporary path")
    try:
        raw = payload_path.read_bytes()
    except OSError as error:
        raise ValueError("the morning priority payload is unavailable") from error
    if not raw or len(raw) > MAX_PAYLOAD_BYTES or b"\x00" in raw:
        raise ValueError("the morning priority payload is invalid")
    try:
        source = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("the morning priority payload must be valid UTF-8 JSON") from error
    if not isinstance(source, dict):
        raise ValueError("the morning priority payload must be a JSON object")
    if source.get("store_id") != store_id or source.get("business_date") != business_date:
        raise ValueError("the morning priority payload does not match the configured store and date")

    source_priorities = source.get("priorities")
    if not isinstance(source_priorities, list) or not 1 <= len(source_priorities) <= 4:
        raise ValueError("the morning priority payload must contain one to four priorities")
    priorities = []
    for expected_rank, value in enumerate(source_priorities, start=1):
        if not isinstance(value, dict) or value.get("rank") != expected_rank:
            raise ValueError("morning priority ranks must be ordered sequentially starting at one")
        priorities.append(
            {
                "rank": expected_rank,
                "title": bounded_text(value.get("title"), "title", 140),
                "evidence": bounded_text(value.get("evidence"), "evidence", 280),
            }
        )
    return {"store_id": store_id, "business_date": business_date, "priorities": priorities}


def publish(endpoint: str, payload: dict) -> dict:
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = Request(
        endpoint,
        data=body,
        method="POST",
        headers={"Accept": "application/json", "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=10) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        raise RuntimeError(f"Camel returned HTTP {error.code}") from error
    except (URLError, TimeoutError) as error:
        raise RuntimeError("the private Camel presentation API is unavailable") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("the Camel presentation response exceeded the size limit")
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("Camel returned an invalid presentation response") from error
    presentation = result.get("presentation") if isinstance(result, dict) else None
    if (
        result.get("status") != "ready"
        or not isinstance(presentation, dict)
        or presentation.get("store_id") != payload["store_id"]
        or presentation.get("business_date") != payload["business_date"]
        or presentation.get("priorities") != payload["priorities"]
    ):
        raise RuntimeError("Camel did not confirm the published morning priorities")
    return result


def main() -> int:
    args = parse_args()
    try:
        endpoint, store_id, business_date = load_config(args.config)
        payload = read_payload(args.payload_file, store_id, business_date)
        publish(endpoint, payload)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Morning priority publication failed: {error}", file=sys.stderr)
        return 1
    finally:
        if args.payload_file == EXPECTED_PAYLOAD and not args.payload_file.is_symlink():
            args.payload_file.unlink(missing_ok=True)

    print("Morning priority display updated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
