#!/usr/bin/env python3
"""Request bounded synthetic response plans for one visual store incident."""

from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


MAX_RESPONSE_BYTES = 131_072
STORE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ASSOCIATE_REFERENCE_PATTERN = re.compile(r"^SYNTH-[A-Z0-9-]{1,48}$")
PLAN_ID_PATTERN = re.compile(r"^IR-[A-Z0-9-]{1,48}$")
DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.json"
HAZARD_CLASSES = (
    "spill",
    "obstruction",
    "damaged_fixture",
    "smoke_or_fire",
    "possible_injury",
    "security",
    "unknown",
)
SEVERITIES = ("low", "medium", "high", "critical")
ZONES = (
    "front_entrance",
    "checkout",
    "sales_floor",
    "stockroom",
    "parking_lot",
    "unknown",
)
CUSTOMER_EXPOSURES = ("none", "possible", "present")
ACCESS_IMPACTS = ("clear", "partially_blocked", "blocked")
CONFIDENCE_LEVELS = ("low", "medium", "high")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Request response options for a bounded visual incident assessment."
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--hazard-class", required=True, choices=HAZARD_CLASSES)
    parser.add_argument("--severity", required=True, choices=SEVERITIES)
    parser.add_argument("--zone", required=True, choices=ZONES)
    parser.add_argument(
        "--customer-exposure", required=True, choices=CUSTOMER_EXPOSURES
    )
    parser.add_argument("--access-impact", required=True, choices=ACCESS_IMPACTS)
    parser.add_argument("--confidence", required=True, choices=CONFIDENCE_LEVELS)
    return parser.parse_args()


def validate_business_date(value: str) -> None:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise ValueError("the installed business date must use YYYY-MM-DD") from error
    if parsed.isoformat() != value:
        raise ValueError("the installed business date must use YYYY-MM-DD")


def load_config(path: Path) -> tuple[str, str, str]:
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("the installed incident response configuration is invalid") from error
    if not isinstance(config, dict):
        raise ValueError("the installed incident response configuration is invalid")

    endpoint = config.get("endpoint")
    store_id = config.get("store_id")
    business_date = config.get("business_date")
    if not isinstance(endpoint, str):
        raise ValueError("the installed incident response endpoint is missing")
    if not isinstance(store_id, str) or not STORE_ID_PATTERN.fullmatch(store_id):
        raise ValueError("the installed incident response store ID is invalid")
    if not isinstance(business_date, str):
        raise ValueError("the installed incident response business date is missing")
    validate_business_date(business_date)

    parsed = urlsplit(endpoint)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path != "/v1/store-incident-response-plans"
    ):
        raise ValueError("the installed incident response endpoint is outside the supported path")
    return endpoint, store_id, business_date


def request_plan(endpoint: str, payload: dict) -> dict:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = Request(
        endpoint,
        data=body,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=10) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        raw_error = error.read(MAX_RESPONSE_BYTES)
        try:
            detail = json.loads(raw_error).get("message")
        except (json.JSONDecodeError, AttributeError):
            detail = None
        suffix = f": {detail}" if isinstance(detail, str) else ""
        raise RuntimeError(f"Camel returned HTTP {error.code}{suffix}") from error
    except (URLError, TimeoutError) as error:
        raise RuntimeError("the private Camel incident response API is unavailable") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("the Camel incident response exceeded the response-size limit")
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("Camel returned invalid JSON") from error
    if not isinstance(result, dict):
        raise RuntimeError("Camel returned an invalid incident response object")
    return result


def require_string(value: object, message: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(message)
    return value


def validate_plan_response(result: dict, expected: dict) -> None:
    if result.get("contract_version") != "0.1.0":
        raise RuntimeError("Camel returned an unsupported incident response contract")
    if (
        result.get("store_id") != expected["store_id"]
        or result.get("business_date") != expected["business_date"]
    ):
        raise RuntimeError("Camel returned incident plans for a different store or date")
    assessment = result.get("visual_assessment")
    if not isinstance(assessment, dict):
        raise RuntimeError("Camel omitted the bounded visual assessment")
    for field in (
        "hazard_class",
        "severity",
        "zone",
        "customer_exposure",
        "access_impact",
        "confidence",
    ):
        if assessment.get(field) != expected[field]:
            raise RuntimeError("Camel changed the submitted visual assessment")

    guardrails = result.get("planning_guardrails")
    if not isinstance(guardrails, dict) or guardrails.get("image_received_by_camel") is not False:
        raise RuntimeError("Camel did not confirm the image boundary")
    if guardrails.get("external_action_authorized") is not False:
        raise RuntimeError("the incident plan unexpectedly authorized an external action")

    plans = result.get("feasible_plans")
    if not isinstance(plans, list) or not 1 <= len(plans) <= 2:
        raise RuntimeError("Camel did not return one or two feasible incident plans")
    seen_plan_ids: set[str] = set()
    for plan in plans:
        if not isinstance(plan, dict):
            raise RuntimeError("an incident plan is not an object")
        plan_id = plan.get("plan_id")
        if not isinstance(plan_id, str) or not PLAN_ID_PATTERN.fullmatch(plan_id):
            raise RuntimeError("an incident plan has an invalid plan ID")
        if plan_id in seen_plan_ids:
            raise RuntimeError("the incident response contains duplicate plan IDs")
        seen_plan_ids.add(plan_id)
        require_string(plan.get("title"), "an incident plan is missing its title")
        readiness = plan.get("response_ready_in_minutes")
        if not isinstance(readiness, int) or readiness < 0:
            raise RuntimeError("an incident plan has invalid readiness")
        team = plan.get("response_team")
        if not isinstance(team, list) or not 2 <= len(team) <= 3:
            raise RuntimeError("an incident plan has an invalid response team")
        seen_associates: set[str] = set()
        for member in team:
            if not isinstance(member, dict):
                raise RuntimeError("an incident response team member is invalid")
            reference = member.get("associate_reference")
            if not isinstance(reference, str) or not ASSOCIATE_REFERENCE_PATTERN.fullmatch(reference):
                raise RuntimeError("an incident response team has an invalid associate reference")
            if reference in seen_associates:
                raise RuntimeError("an incident plan assigns one associate twice")
            seen_associates.add(reference)
            for field in ("role", "department", "assignment"):
                require_string(member.get(field), f"an incident team member is missing {field}")
        for field in (
            "immediate_actions",
            "coverage_tradeoffs",
            "protected_commitments_preserved",
        ):
            values = plan.get(field)
            if not isinstance(values, list) or not values or not all(
                isinstance(item, str) and item.strip() for item in values
            ):
                raise RuntimeError(f"an incident plan has invalid {field}")

    policy = result.get("incident_policy")
    if not isinstance(policy, dict):
        raise RuntimeError("Camel omitted the incident policy")
    for field in ("immediate_controls", "escalation_conditions"):
        values = policy.get(field)
        if not isinstance(values, list) or not values:
            raise RuntimeError(f"Camel omitted incident policy {field}")
    factors = result.get("selection_factors")
    if not isinstance(factors, list) or not factors:
        raise RuntimeError("Camel omitted incident selection factors")


def main() -> int:
    args = parse_args()
    try:
        endpoint, store_id, business_date = load_config(args.config)
        payload = {
            "store_id": store_id,
            "business_date": business_date,
            "hazard_class": args.hazard_class,
            "severity": args.severity,
            "zone": args.zone,
            "customer_exposure": args.customer_exposure,
            "access_impact": args.access_impact,
            "confidence": args.confidence,
        }
        result = request_plan(endpoint, payload)
        validate_plan_response(result, payload)
    except (ValueError, RuntimeError) as error:
        print(f"Store incident response unavailable: {error}", file=sys.stderr)
        return 1

    json.dump(result, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
