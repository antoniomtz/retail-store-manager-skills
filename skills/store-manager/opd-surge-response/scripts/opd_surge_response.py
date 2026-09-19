#!/usr/bin/env python3
"""Operate the bounded synthetic Store Manager OPD recovery loop."""

from __future__ import annotations

import argparse
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


MAX_RESPONSE_BYTES = 131_072
STORE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DECISION_ID_PATTERN = re.compile(r"^OPD-DEC-[A-Z0-9]{8}-[0-9]{3,}$")
CANDIDATE_SET_ID_PATTERN = re.compile(r"^OPD-CAND-[A-Z0-9]{8}-[0-9]{3,}$")
PLAN_ID_PATTERN = re.compile(r"^[A-Z0-9-]{1,64}$")
UNSAFE_AGENT_TEXT_PATTERN = re.compile(r"['\"`$\\;&|<>\r\n]")
DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.json"
SUPPORTED_PATHS = {
    "status_endpoint": "/v1/store-opd-operating-state",
    "plans_endpoint": "/v1/store-opd-recovery-plans",
    "decisions_endpoint": "/v1/store-opd-decisions",
    "actions_endpoint": "/v1/store-opd-actions",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Operate the synthetic OPD surge-response workflow.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("monitor")
    subparsers.add_parser("review")
    subparsers.add_parser("status")
    commit_parser = subparsers.add_parser("commit")
    commit_parser.add_argument("--candidate-set-id", required=True)
    commit_parser.add_argument("--expected-state-version", required=True, type=int)
    commit_parser.add_argument("--recommended-plan-id", required=True)
    commit_parser.add_argument("--reason", required=True)
    commit_parser.add_argument("--tradeoff", required=True)
    choice_parser = subparsers.add_parser("choose")
    choice_parser.add_argument("--decision-id", required=True)
    choice_parser.add_argument("--choice", required=True, type=int, choices=(1, 2, 3))
    for command in ("approve", "reject"):
        action_parser = subparsers.add_parser(command)
        action_parser.add_argument("--decision-id", required=True)
        if command == "approve":
            action_parser.add_argument("--plan-id")
    return parser.parse_args()


def validate_business_date(value: str) -> None:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise ValueError("the installed business date must use YYYY-MM-DD") from error
    if parsed.isoformat() != value:
        raise ValueError("the installed business date must use YYYY-MM-DD")


def load_config(path: Path) -> dict:
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("the installed OPD surge-response configuration is invalid") from error
    if not isinstance(config, dict):
        raise ValueError("the installed OPD surge-response configuration is invalid")

    store_id = config.get("store_id")
    business_date = config.get("business_date")
    if not isinstance(store_id, str) or not STORE_ID_PATTERN.fullmatch(store_id):
        raise ValueError("the installed store ID is invalid")
    if not isinstance(business_date, str):
        raise ValueError("the installed business date is missing")
    validate_business_date(business_date)

    origins: set[tuple[str, str, int | None]] = set()
    for key, expected_path in SUPPORTED_PATHS.items():
        endpoint = config.get(key)
        if not isinstance(endpoint, str):
            raise ValueError(f"the installed {key} is missing")
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path != expected_path
        ):
            raise ValueError(f"the installed {key} is outside the supported path")
        origins.add((parsed.scheme, parsed.hostname, parsed.port))
    if len(origins) != 1:
        raise ValueError("the installed OPD endpoints must share one origin")
    return config


def request_json(endpoint: str, method: str, payload: dict | None = None) -> dict:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(endpoint, data=data, headers=headers, method=method)
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
        raise RuntimeError("the private Camel OPD operating API is unavailable") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("the Camel OPD response exceeded the response-size limit")
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("Camel returned invalid JSON") from error
    if not isinstance(result, dict):
        raise RuntimeError("Camel returned an invalid OPD response object")
    return result


def status(config: dict) -> dict:
    query = urlencode({"store_id": config["store_id"], "business_date": config["business_date"]})
    result = request_json(f"{config['status_endpoint']}?{query}", "GET")
    if result.get("store_id") != config["store_id"] or result.get("business_date") != config["business_date"]:
        raise RuntimeError("Camel returned OPD state for a different store or business date")
    return result


def scoped_payload(config: dict) -> dict:
    return {"store_id": config["store_id"], "business_date": config["business_date"]}


def validated_plan(value: object, context: str) -> dict:
    plan = value if isinstance(value, dict) else {}
    plan_id = plan.get("plan_id")
    title = plan.get("title")
    action = plan.get("action")
    additional_associates = plan.get("additional_associates")
    assignment_duration = plan.get("assignment_duration_minutes")
    incremental_rate = plan.get("incremental_pick_rate_items_per_hour")
    projection_horizon = plan.get("projection_horizon_minutes")
    projected_rate = plan.get("projected_pick_rate_items_per_hour")
    projected_queue = plan.get("projected_queue_at_checkpoint_items")
    projected_capacity = plan.get("projected_window_capacity_items")
    projected_buffer = plan.get("projected_window_buffer_items")
    meets_checkpoint = plan.get("meets_checkpoint")
    tradeoffs = plan.get("tradeoffs")
    if (
        not isinstance(plan_id, str)
        or not PLAN_ID_PATTERN.fullmatch(plan_id)
        or not isinstance(title, str)
        or not title.strip()
        or not isinstance(action, str)
        or not action.strip()
        or not isinstance(additional_associates, int)
        or additional_associates < 1
        or not isinstance(assignment_duration, int)
        or assignment_duration < 1
        or not isinstance(incremental_rate, int)
        or incremental_rate < 1
        or not isinstance(projection_horizon, int)
        or projection_horizon < 1
        or not isinstance(projected_rate, int)
        or projected_rate < 1
        or not isinstance(projected_queue, int)
        or projected_queue < 0
        or not isinstance(projected_capacity, int)
        or projected_capacity < 0
        or not isinstance(projected_buffer, int)
        or not isinstance(meets_checkpoint, bool)
        or not isinstance(tradeoffs, list)
        or not all(isinstance(item, str) and item.strip() for item in tradeoffs)
    ):
        raise RuntimeError(f"{context} contains incomplete or inconsistent plan details")
    return plan


def manager_choices(decision: dict) -> list[dict]:
    decision_id = decision.get("decision_id")
    plans = decision.get("feasible_plans")
    recommended_plan_id = decision.get("recommended_plan_id")
    if not isinstance(decision_id, str) or not DECISION_ID_PATTERN.fullmatch(decision_id):
        raise RuntimeError("the pending OPD decision has no valid decision ID")
    if decision.get("decision_author") != "hermes":
        raise RuntimeError("the pending OPD decision was not authored by Hermes")
    if not isinstance(plans, list) or len(plans) != 2:
        raise RuntimeError("the pending OPD decision does not provide exactly two feasible plans")

    plans_by_id: dict[str, dict] = {}
    for value in plans:
        plan = validated_plan(value, "the pending OPD decision")
        plan_id = plan["plan_id"]
        if plan_id in plans_by_id:
            raise RuntimeError("the pending OPD decision contains duplicate plan IDs")
        plans_by_id[plan_id] = plan
    if (
        not isinstance(recommended_plan_id, str)
        or not PLAN_ID_PATTERN.fullmatch(recommended_plan_id)
        or recommended_plan_id not in plans_by_id
    ):
        raise RuntimeError("the pending OPD decision recommendation is not feasible")

    alternate_plan_id = next(plan_id for plan_id in plans_by_id if plan_id != recommended_plan_id)
    recommended_plan = plans_by_id[recommended_plan_id]
    alternate_plan = plans_by_id[alternate_plan_id]
    return [
        {
            "choice": 1,
            "disposition": "approve",
            "decision_id": decision_id,
            "plan_id": recommended_plan_id,
            "recommended": True,
            "label": f"Approve recommended: {recommended_plan['title']}",
        },
        {
            "choice": 2,
            "disposition": "approve",
            "decision_id": decision_id,
            "plan_id": alternate_plan_id,
            "recommended": False,
            "label": f"Approve alternate: {alternate_plan['title']}",
        },
        {
            "choice": 3,
            "disposition": "reject",
            "decision_id": decision_id,
            "label": "Reject this decision",
        },
    ]


def recommended_plan(decision: dict) -> dict:
    manager_choices(decision)
    recommended_plan_id = decision["recommended_plan_id"]
    return next(
        plan
        for plan in decision["feasible_plans"]
        if plan["plan_id"] == recommended_plan_id
    )


def validated_candidate_set(value: object) -> dict:
    if not isinstance(value, dict):
        raise RuntimeError("Camel returned no OPD candidate set")
    candidate_set = value
    candidate_set_id = candidate_set.get("candidate_set_id")
    state_version = candidate_set.get("based_on_state_version")
    plans = candidate_set.get("candidate_plans")
    if (
        not isinstance(candidate_set_id, str)
        or not CANDIDATE_SET_ID_PATTERN.fullmatch(candidate_set_id)
        or candidate_set.get("status") != "awaiting_agent_recommendation"
        or not isinstance(state_version, int)
        or state_version < 1
        or not isinstance(plans, list)
        or len(plans) != 2
    ):
        raise RuntimeError("Camel returned an invalid OPD candidate set")
    seen: set[str] = set()
    for plan_value in plans:
        plan = validated_plan(plan_value, "the OPD candidate set")
        plan_id = plan["plan_id"]
        if plan_id in seen:
            raise RuntimeError("the OPD candidate set contains an invalid or duplicate plan ID")
        seen.add(plan_id)
    return candidate_set


def bounded_agent_text(value: str, field: str, minimum: int, maximum: int) -> str:
    normalized = value.strip()
    if (
        len(normalized) < minimum
        or len(normalized) > maximum
        or any(not character.isprintable() for character in normalized)
        or UNSAFE_AGENT_TEXT_PATTERN.search(normalized)
    ):
        raise ValueError(
            f"{field} must be one shell-safe line containing {minimum} to {maximum} printable characters"
        )
    return normalized


def commit_recommendation(config: dict, args: argparse.Namespace) -> dict:
    candidate_set_id = args.candidate_set_id
    expected_state_version = args.expected_state_version
    recommended_plan_id = args.recommended_plan_id
    if not isinstance(candidate_set_id, str) or not CANDIDATE_SET_ID_PATTERN.fullmatch(candidate_set_id):
        raise ValueError("candidate_set_id must use the exact returned OPD-CAND identifier")
    if not isinstance(expected_state_version, int) or expected_state_version < 1:
        raise ValueError("expected_state_version must be a positive integer")
    if not isinstance(recommended_plan_id, str) or not PLAN_ID_PATTERN.fullmatch(recommended_plan_id):
        raise ValueError("recommended_plan_id is invalid")

    # Re-read the exact current candidate set and derive the alternate. Hermes
    # owns the recommendation and prose; it should not have to duplicate a
    # second plan identifier that Camel already owns and can validate.
    planned = request_json(config["plans_endpoint"], "POST", scoped_payload(config))
    candidate_set = validated_candidate_set(planned.get("candidate_set"))
    if (
        candidate_set["candidate_set_id"] != candidate_set_id
        or candidate_set["based_on_state_version"] != expected_state_version
    ):
        raise RuntimeError("the OPD candidate set changed before the Hermes recommendation was committed")
    candidate_ids = [plan["plan_id"] for plan in candidate_set["candidate_plans"]]
    if recommended_plan_id not in candidate_ids:
        raise ValueError("recommended_plan_id must be an exact returned candidate ID")
    alternate_plan_id = next(plan_id for plan_id in candidate_ids if plan_id != recommended_plan_id)
    reason_value = args.reason
    tradeoff_value = args.tradeoff
    if not isinstance(reason_value, str) or not isinstance(tradeoff_value, str):
        raise ValueError("reason and tradeoff must be strings")
    reason = bounded_agent_text(reason_value, "reason", 40, 500)
    tradeoff = bounded_agent_text(tradeoff_value, "tradeoff", 20, 300)
    canonical = json.dumps(
        {
            "alternate": alternate_plan_id,
            "candidate_set": candidate_set_id,
            "reason": reason,
            "recommended": recommended_plan_id,
            "tradeoff": tradeoff,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    payload = scoped_payload(config)
    payload.update(
        {
            "candidate_set_id": candidate_set_id,
            "expected_state_version": expected_state_version,
            "recommended_plan_id": recommended_plan_id,
            "alternate_plan_ids": [alternate_plan_id],
            "recommendation_reason": reason,
            "tradeoff_summary": tradeoff,
            "idempotency_key": (
                f"{candidate_set_id}-commit-"
                f"{hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:16]}"
            ),
        }
    )
    result = request_json(config["decisions_endpoint"], "POST", payload)
    decision = result.get("decision")
    if (
        result.get("new_decision") is not True
        or not isinstance(decision, dict)
        or decision.get("candidate_set_id") != candidate_set_id
        or decision.get("decision_author") != "hermes"
        or decision.get("decision_method") != "agent_reasoned_candidate_ranking"
        or decision.get("recommended_plan_id") != recommended_plan_id
        or decision.get("recommendation_reason") != reason
        or decision.get("tradeoff_summary") != tradeoff
    ):
        raise RuntimeError("Camel did not persist the Hermes OPD recommendation")
    return {
        "outcome": "manager_decision_required",
        "decision": decision,
        "recommended_plan": recommended_plan(decision),
        "manager_choices": manager_choices(decision),
        "operating_state": result.get("operating_state"),
    }


def monitor(config: dict) -> dict:
    observed = status(config)
    action = observed.get("monitor", {}).get("action")
    if action in {"request_recovery_plan", "await_agent_recommendation"}:
        planned = request_json(config["plans_endpoint"], "POST", scoped_payload(config))
        candidate_set = validated_candidate_set(planned.get("candidate_set"))
        return {
            "outcome": "agent_recommendation_required",
            "candidate_set": candidate_set,
            "operating_state": planned.get("operating_state"),
        }
    if action == "report_checkpoint":
        checkpoint = observed.get("checkpoint")
        checkpoint_id = checkpoint.get("checkpoint_id") if isinstance(checkpoint, dict) else None
        if not isinstance(checkpoint_id, str):
            raise RuntimeError("Camel requested a checkpoint report without a checkpoint ID")
        payload = scoped_payload(config)
        payload.update(
            {
                "disposition": "acknowledge_checkpoint",
                "checkpoint_id": checkpoint_id,
                "idempotency_key": f"{checkpoint_id}-reported",
            }
        )
        acknowledged = request_json(config["actions_endpoint"], "POST", payload)
        acknowledged_checkpoint = acknowledged.get("checkpoint")
        if (
            acknowledged.get("checkpoint_acknowledged") is not True
            or not isinstance(acknowledged_checkpoint, dict)
            or acknowledged_checkpoint.get("checkpoint_id") != checkpoint_id
        ):
            raise RuntimeError("Camel did not acknowledge the measured OPD checkpoint")
        return {
            "outcome": "checkpoint_result",
            "checkpoint": acknowledged_checkpoint,
            "operating_state": observed,
        }
    return {"outcome": "no_alert", "operating_state": observed}


def review(config: dict) -> dict:
    observed = status(config)
    decision = observed.get("decision")
    if not isinstance(decision, dict) or decision.get("status") != "pending_manager_approval":
        return {"outcome": "no_pending_decision", "operating_state": observed}
    return {
        "outcome": "manager_decision_available",
        "decision": decision,
        "recommended_plan": recommended_plan(decision),
        "manager_choices": manager_choices(decision),
        "operating_state": observed,
    }


def decide(config: dict, command: str, decision_id: str, plan_id: str | None = None) -> dict:
    if not DECISION_ID_PATTERN.fullmatch(decision_id):
        raise ValueError("decision_id must use the exact returned OPD-DEC identifier")
    if plan_id is not None and not PLAN_ID_PATTERN.fullmatch(plan_id):
        raise ValueError("plan_id is invalid")
    observed = status(config)
    decision = observed.get("decision")
    if not isinstance(decision, dict) or decision.get("decision_id") != decision_id:
        raise RuntimeError("the requested OPD decision is not the current pending decision")
    if decision.get("status") != "pending_manager_approval":
        raise RuntimeError("the requested OPD decision is not awaiting manager approval")
    manager_choices(decision)
    selected_plan = None
    if command == "approve":
        selected_plan_id = plan_id or decision["recommended_plan_id"]
        selected_plan = next(
            (
                candidate
                for candidate in decision["feasible_plans"]
                if candidate["plan_id"] == selected_plan_id
            ),
            None,
        )
        if not isinstance(selected_plan, dict):
            raise RuntimeError("the selected OPD plan is no longer available")
    expected_version = decision.get("based_on_state_version")
    if not isinstance(expected_version, int) or expected_version < 1:
        raise RuntimeError("the pending OPD decision has no valid state version")

    payload = scoped_payload(config)
    payload.update(
        {
            "disposition": command,
            "decision_id": decision_id,
            "expected_state_version": expected_version,
            "idempotency_key": f"{decision_id}-{command}-{plan_id or 'recommended'}",
        }
    )
    if plan_id is not None:
        payload["plan_id"] = plan_id
    result = request_json(config["actions_endpoint"], "POST", payload)
    verification_state = status(config)
    if command == "approve":
        receipt = result.get("action_receipt")
        verified_receipt = verification_state.get("last_action_receipt")
        verified_checkpoint = verification_state.get("checkpoint")
        if (
            result.get("external_action_executed") is not True
            or not isinstance(receipt, dict)
            or receipt.get("status") != "accepted"
            or not isinstance(receipt.get("receipt_id"), str)
            or not isinstance(verified_receipt, dict)
            or verified_receipt.get("receipt_id") != receipt.get("receipt_id")
            or verified_receipt.get("status") != "accepted"
            or not isinstance(verified_checkpoint, dict)
            or verified_checkpoint.get("status") != "scheduled"
            or not isinstance(verified_checkpoint.get("due_at"), str)
        ):
            raise RuntimeError("the simulated external-system action receipt could not be verified")
        result["receipt_verified"] = True
        result["selected_plan"] = selected_plan
        result["checkpoint"] = verified_checkpoint
    elif result.get("external_action_executed") is not False:
        raise RuntimeError("the rejected decision unexpectedly executed an external action")
    result["verification_state"] = verification_state
    return result


def choose(config: dict, choice: int, decision_id: str) -> dict:
    if not DECISION_ID_PATTERN.fullmatch(decision_id):
        raise ValueError("decision_id must use the exact returned OPD-DEC identifier")
    observed = status(config)
    decision = observed.get("decision")
    if not isinstance(decision, dict) or decision.get("status") != "pending_manager_approval":
        raise RuntimeError("there is no current OPD decision awaiting manager approval")
    current_decision_id = decision.get("decision_id")
    if not isinstance(current_decision_id, str) or not DECISION_ID_PATTERN.fullmatch(current_decision_id):
        raise RuntimeError("the pending OPD decision has no valid decision ID")
    if current_decision_id != decision_id:
        raise RuntimeError("the displayed OPD decision is no longer the current pending decision")

    selected = next(item for item in manager_choices(decision) if item["choice"] == choice)
    result = decide(
        config,
        selected["disposition"],
        current_decision_id,
        selected.get("plan_id"),
    )
    result["selected_manager_choice"] = selected
    return result


def main() -> int:
    args = parse_args()
    try:
        config = load_config(args.config)
        if args.command == "monitor":
            result = monitor(config)
        elif args.command == "review":
            result = review(config)
        elif args.command == "status":
            result = status(config)
        elif args.command == "commit":
            result = commit_recommendation(config, args)
        elif args.command == "choose":
            result = choose(config, args.choice, args.decision_id)
        else:
            result = decide(
                config,
                args.command,
                args.decision_id,
                getattr(args, "plan_id", None),
            )
    except (ValueError, RuntimeError) as error:
        print(f"Store Manager OPD surge response unavailable: {error}", file=sys.stderr)
        return 1

    json.dump(result, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
