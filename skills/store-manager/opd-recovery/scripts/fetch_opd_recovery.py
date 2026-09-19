#!/usr/bin/env python3
"""Fetch one bounded Store Manager OPD recovery snapshot from Camel."""

from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


MAX_RESPONSE_BYTES = 131_072
STORE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch one normalized Store Manager OPD recovery snapshot."
    )
    parser.add_argument("--store-id")
    parser.add_argument("--business-date")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    return parser.parse_args()


def load_config(config_path: Path) -> tuple[str, str, str]:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("the installed OPD recovery endpoint configuration is invalid") from error

    endpoint = config.get("endpoint") if isinstance(config, dict) else None
    store_id = config.get("store_id") if isinstance(config, dict) else None
    business_date = config.get("business_date") if isinstance(config, dict) else None
    if not isinstance(endpoint, str):
        raise ValueError("the installed OPD recovery endpoint is missing")
    if not isinstance(store_id, str) or not STORE_ID_PATTERN.fullmatch(store_id):
        raise ValueError("the installed OPD recovery store ID is invalid")
    if not isinstance(business_date, str):
        raise ValueError("the installed OPD recovery business date is invalid")
    validate_business_date(business_date)

    parsed = urlsplit(endpoint)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path != "/v1/store-opd-recovery"
    ):
        raise ValueError("the installed OPD recovery endpoint is outside the supported path")
    return endpoint, store_id, business_date


def resolve_store_id(requested_store_id: str | None, configured_store_id: str) -> str:
    if requested_store_id is None:
        return configured_store_id
    if requested_store_id != configured_store_id:
        raise ValueError(
            f"this Store Manager deployment is assigned to store {configured_store_id}"
        )
    return requested_store_id


def validate_business_date(business_date: str) -> None:
    try:
        parsed_date = date.fromisoformat(business_date)
    except ValueError as error:
        raise ValueError("business_date must use YYYY-MM-DD") from error
    if parsed_date.isoformat() != business_date:
        raise ValueError("business_date must use YYYY-MM-DD")


def validate_inputs(store_id: str, business_date: str) -> None:
    if not STORE_ID_PATTERN.fullmatch(store_id):
        raise ValueError("store_id must contain 1-64 letters, digits, underscores, or hyphens")
    validate_business_date(business_date)


def fetch_snapshot(endpoint: str, store_id: str, business_date: str) -> dict:
    query = urlencode({"store_id": store_id, "business_date": business_date})
    request = Request(f"{endpoint}?{query}", headers={"Accept": "application/json"})

    try:
        with urlopen(request, timeout=10) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        raise RuntimeError(f"Camel returned HTTP {error.code}") from error
    except (URLError, TimeoutError) as error:
        raise RuntimeError("the private Camel OPD recovery API is unavailable") from error

    if len(payload) > MAX_RESPONSE_BYTES:
        raise RuntimeError("the Camel OPD recovery snapshot exceeded the response-size limit")

    try:
        snapshot = json.loads(payload)
    except json.JSONDecodeError as error:
        raise RuntimeError("Camel returned invalid JSON") from error
    if not isinstance(snapshot, dict):
        raise RuntimeError("Camel returned an invalid OPD recovery snapshot object")
    if snapshot.get("store_id") != store_id or snapshot.get("business_date") != business_date:
        raise RuntimeError("Camel returned an OPD recovery snapshot for a different store or business date")
    return snapshot


def main() -> int:
    args = parse_args()
    try:
        endpoint, configured_store_id, configured_business_date = load_config(args.config)
        store_id = resolve_store_id(args.store_id, configured_store_id)
        business_date = args.business_date or configured_business_date
        validate_inputs(store_id, business_date)
        snapshot = fetch_snapshot(endpoint, store_id, business_date)
    except (ValueError, RuntimeError) as error:
        print(f"Store Manager OPD recovery unavailable: {error}", file=sys.stderr)
        return 1

    json.dump(snapshot, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
