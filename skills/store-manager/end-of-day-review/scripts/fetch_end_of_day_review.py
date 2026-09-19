#!/usr/bin/env python3
"""Fetch one completed synthetic Store Manager end-of-day review."""

from __future__ import annotations

import argparse
from datetime import date
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


MAX_RESPONSE_BYTES = 262_144
STORE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch the completed independent Store Manager end-of-day simulation."
    )
    parser.add_argument("--store-id")
    parser.add_argument("--business-date")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    return parser.parse_args()


def validate_business_date(business_date: str) -> None:
    try:
        parsed_date = date.fromisoformat(business_date)
    except ValueError as error:
        raise ValueError("business_date must use YYYY-MM-DD") from error
    if parsed_date.isoformat() != business_date:
        raise ValueError("business_date must use YYYY-MM-DD")


def load_config(config_path: Path) -> tuple[str, str, str]:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("the installed end-of-day endpoint configuration is invalid") from error

    endpoint = config.get("endpoint") if isinstance(config, dict) else None
    store_id = config.get("store_id") if isinstance(config, dict) else None
    business_date = config.get("business_date") if isinstance(config, dict) else None
    if not isinstance(endpoint, str):
        raise ValueError("the installed end-of-day endpoint is missing")
    if not isinstance(store_id, str) or not STORE_ID_PATTERN.fullmatch(store_id):
        raise ValueError("the installed Store Manager store ID is invalid")
    if not isinstance(business_date, str):
        raise ValueError("the installed Store Manager business date is invalid")
    validate_business_date(business_date)

    parsed = urlsplit(endpoint)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path != "/v1/store-end-of-day-review"
    ):
        raise ValueError("the installed end-of-day endpoint is outside the supported path")
    return endpoint, store_id, business_date


def resolve_store_id(requested_store_id: str | None, configured_store_id: str) -> str:
    if requested_store_id is None:
        return configured_store_id
    if requested_store_id != configured_store_id:
        raise ValueError(
            f"this Store Manager deployment is assigned to store {configured_store_id}"
        )
    return requested_store_id


def validate_inputs(store_id: str, business_date: str) -> None:
    if not STORE_ID_PATTERN.fullmatch(store_id):
        raise ValueError("store_id must contain 1-64 letters, digits, underscores, or hyphens")
    validate_business_date(business_date)


def fetch_review(endpoint: str, store_id: str, business_date: str) -> dict:
    query = urlencode({"store_id": store_id, "business_date": business_date})
    request = Request(f"{endpoint}?{query}", headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=10) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        raise RuntimeError(f"Camel returned HTTP {error.code}") from error
    except (URLError, TimeoutError) as error:
        raise RuntimeError("the private Camel end-of-day API is unavailable") from error

    if len(payload) > MAX_RESPONSE_BYTES:
        raise RuntimeError("the Camel end-of-day response exceeded the response-size limit")
    try:
        review = json.loads(payload)
    except json.JSONDecodeError as error:
        raise RuntimeError("Camel returned invalid JSON") from error
    if not isinstance(review, dict):
        raise RuntimeError("Camel returned an invalid end-of-day response object")
    if review.get("store_id") != store_id or review.get("business_date") != business_date:
        raise RuntimeError("Camel returned an end-of-day review for a different store or date")
    return review


def validate_completed_review(review: dict) -> None:
    if review.get("contract_version") != "0.3.0":
        raise RuntimeError("the generated store day uses an unsupported contract version")
    if review.get("simulation_status") != "completed":
        raise RuntimeError(
            "the independent synthetic store day has not been generated; "
            "run use-cases/store-manager/scripts/simulate-store-day.sh run on the repository host"
        )

    period = review.get("simulated_period")
    quality = review.get("data_quality")
    if (
        not isinstance(period, dict)
        or period.get("duration_minutes") != 480
        or not isinstance(period.get("sample_count"), int)
        or period.get("sample_count") != period.get("expected_sample_count")
        or not isinstance(quality, dict)
        or quality.get("status") != "complete"
        or quality.get("missing_samples") != 0
    ):
        raise RuntimeError("the generated store day is incomplete")

    required_objects = (
        "store",
        "sales",
        "checkout",
        "opd",
        "workforce",
        "inventory",
        "incident_summary",
        "observed_service_impact",
        "agent_assisted_impact",
        "estimated_opportunity_cost",
        "tomorrow_context",
        "freshness",
    )
    if any(not isinstance(review.get(field), dict) for field in required_objects):
        raise RuntimeError("the generated store day is missing a required operating section")
    impact = review["agent_assisted_impact"]
    if (
        impact.get("status") != "simulated_attributed"
        or not isinstance(impact.get("actions"), list)
        or len(impact["actions"]) != 3
        or not isinstance(impact.get("summary"), dict)
    ):
        raise RuntimeError("the generated store day is missing agent-assisted impact evidence")
    inventory_actions = [
        action
        for action in impact["actions"]
        if isinstance(action, dict) and action.get("domain") == "inventory"
    ]
    if len(inventory_actions) != 1:
        raise RuntimeError("the generated store day has invalid product-availability evidence")
    measured = inventory_actions[0].get("measured")
    if not isinstance(measured, dict):
        raise RuntimeError("the generated store day has invalid product-availability evidence")
    records = measured.get("evidence_records")
    linked_receipts = measured.get("linked_purchase_receipt_ids")
    if not isinstance(records, list) or not records or not isinstance(linked_receipts, list):
        raise RuntimeError("the generated store day has invalid alternative-offer evidence")
    offer_ids = [record.get("offer_id") for record in records if isinstance(record, dict)]
    completed = [
        record
        for record in records
        if isinstance(record, dict) and record.get("outcome") == "completed_purchase"
    ]
    completed_receipts = [record.get("purchase_receipt_id") for record in completed]
    try:
        linked_sales = sum(Decimal(str(record["net_sales"])) for record in completed)
        reported_sales = Decimal(str(measured.get("sales_from_linked_purchases")))
        reported_rate = Decimal(str(measured.get("offer_to_purchase_rate_percent")))
        expected_rate = (
            Decimal(len(completed)) / Decimal(len(records)) * Decimal("100")
        ).quantize(Decimal("0.1"))
    except (InvalidOperation, KeyError, TypeError, ZeroDivisionError) as error:
        raise RuntimeError("the generated store day has invalid linked POS sales evidence") from error
    if (
        len(offer_ids) != len(records)
        or any(not isinstance(offer_id, str) or not offer_id for offer_id in offer_ids)
        or len(set(offer_ids)) != len(offer_ids)
        or any(not isinstance(receipt_id, str) or not receipt_id for receipt_id in completed_receipts)
        or len(set(completed_receipts)) != len(completed_receipts)
        or linked_receipts != completed_receipts
        or measured.get("alternative_offers_recorded") != len(records)
        or measured.get("linked_completed_purchases") != len(completed)
        or reported_sales != linked_sales
        or reported_rate != expected_rate
    ):
        raise RuntimeError("the generated store day has inconsistent alternative-offer evidence")
    if not isinstance(review.get("timeline"), list) or len(review["timeline"]) != 32:
        raise RuntimeError("the generated store day does not contain its full evidence timeline")


def main() -> int:
    args = parse_args()
    try:
        endpoint, configured_store_id, configured_business_date = load_config(args.config)
        store_id = resolve_store_id(args.store_id, configured_store_id)
        business_date = args.business_date or configured_business_date
        validate_inputs(store_id, business_date)
        review = fetch_review(endpoint, store_id, business_date)
        if not args.probe:
            validate_completed_review(review)
    except (ValueError, RuntimeError) as error:
        print(f"Store Manager end-of-day review unavailable: {error}", file=sys.stderr)
        return 1

    json.dump(review, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
