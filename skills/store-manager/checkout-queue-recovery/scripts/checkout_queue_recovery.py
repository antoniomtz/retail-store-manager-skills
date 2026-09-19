#!/usr/bin/env python3
"""Operate the bounded synthetic checkout queue recovery loop."""

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
DECISION_ID_PATTERN = re.compile(r"^CHK-DEC-[A-Z0-9]{8}-[0-9]{3,}$")
CANDIDATE_SET_ID_PATTERN = re.compile(r"^CHK-CAND-[A-Z0-9]{8}-[0-9]{3,}$")
PLAN_ID_PATTERN = re.compile(r"^[A-Z0-9-]{1,64}$")
DEPARTMENT_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9 &-]{0,63}$")
UNSAFE_AGENT_TEXT_PATTERN = re.compile(r"['\"`$\\;&|<>\r\n]")
DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.json"
SUPPORTED_PATHS = {
    "status_endpoint": "/v1/store-checkout-operating-state",
    "plans_endpoint": "/v1/store-checkout-recovery-plans",
    "decisions_endpoint": "/v1/store-checkout-decisions",
    "actions_endpoint": "/v1/store-checkout-actions",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Operate the synthetic checkout queue recovery workflow."
    )
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
    choice_parser.add_argument("--choice", required=True, type=int, choices=range(1, 5))

    replan_parser = subparsers.add_parser("replan")
    replan_parser.add_argument("--decision-id", required=True)
    replan_parser.add_argument("--protect-department", action="append", default=[])
    replan_parser.add_argument("--target-wait-minutes", type=float)
    replan_parser.add_argument("--max-associates", type=int)
    replan_parser.add_argument("--max-assignment-minutes", type=int)
    replan_parser.add_argument(
        "--prefer-action", choices=("staffed_lane", "self_checkout")
    )
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
        raise ValueError(
            "the installed checkout queue recovery configuration is invalid"
        ) from error
    if not isinstance(config, dict):
        raise ValueError("the installed checkout queue recovery configuration is invalid")

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
        raise ValueError("the installed checkout endpoints must share one origin")
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
        raise RuntimeError("the private Camel checkout operating API is unavailable") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("the Camel checkout response exceeded the response-size limit")
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("Camel returned invalid JSON") from error
    if not isinstance(result, dict):
        raise RuntimeError("Camel returned an invalid checkout response object")
    return result


def scoped_payload(config: dict) -> dict:
    return {"store_id": config["store_id"], "business_date": config["business_date"]}


def status(config: dict) -> dict:
    query = urlencode(scoped_payload(config))
    result = request_json(f"{config['status_endpoint']}?{query}", "GET")
    if (
        result.get("store_id") != config["store_id"]
        or result.get("business_date") != config["business_date"]
    ):
        raise RuntimeError("Camel returned checkout state for a different store or date")
    return result


def pending_decision(observed: dict, decision_id: str | None = None) -> dict:
    decision = observed.get("decision")
    if not isinstance(decision, dict) or decision.get("status") != "pending_manager_approval":
        raise RuntimeError("there is no current checkout decision awaiting manager approval")
    current_id = decision.get("decision_id")
    if not isinstance(current_id, str) or not DECISION_ID_PATTERN.fullmatch(current_id):
        raise RuntimeError("the pending checkout decision has no valid decision ID")
    if decision_id is not None and current_id != decision_id:
        raise RuntimeError("the displayed checkout decision is no longer current")
    return decision


def manager_choices(decision: dict) -> list[dict]:
    decision_id = decision.get("decision_id")
    plans = decision.get("feasible_plans")
    recommended_plan_id = decision.get("recommended_plan_id")
    if not isinstance(decision_id, str) or not DECISION_ID_PATTERN.fullmatch(decision_id):
        raise RuntimeError("the pending checkout decision has no valid decision ID")
    if not isinstance(plans, list) or not 1 <= len(plans) <= 2:
        raise RuntimeError("the checkout decision must provide one or two feasible plans")

    plans_by_id: dict[str, dict] = {}
    for plan in plans:
        plan_id = plan.get("plan_id") if isinstance(plan, dict) else None
        if not isinstance(plan_id, str) or not PLAN_ID_PATTERN.fullmatch(plan_id):
            raise RuntimeError("the checkout decision contains an invalid plan ID")
        if plan_id in plans_by_id:
            raise RuntimeError("the checkout decision contains duplicate plan IDs")
        title = plan.get("title")
        action = plan.get("action")
        associate_references = plan.get("associate_references")
        associates_reassigned = plan.get("associates_reassigned")
        assignment_duration = plan.get("assignment_duration_minutes")
        extra_capacity = plan.get("incremental_throughput_customers_per_hour")
        projection_horizon = plan.get("projection_horizon_minutes")
        projected_queue = plan.get("projected_people_in_queue_at_checkpoint")
        projected_wait = plan.get("projected_wait_minutes_at_checkpoint")
        tradeoffs = plan.get("tradeoffs")
        if (
            not isinstance(title, str)
            or not title.strip()
            or not isinstance(action, str)
            or not action.strip()
            or not isinstance(associate_references, list)
            or not all(isinstance(reference, str) for reference in associate_references)
            or not isinstance(associates_reassigned, int)
            or associates_reassigned < 1
            or associates_reassigned != len(associate_references)
            or not isinstance(assignment_duration, int)
            or assignment_duration < 1
            or not isinstance(extra_capacity, int)
            or extra_capacity < 0
            or not isinstance(projection_horizon, int)
            or projection_horizon < 1
            or not isinstance(projected_queue, int)
            or projected_queue < 0
            or not isinstance(projected_wait, (int, float))
            or projected_wait < 0
            or not isinstance(tradeoffs, list)
            or not all(isinstance(item, str) and item.strip() for item in tradeoffs)
        ):
            raise RuntimeError("a checkout plan contains incomplete or inconsistent presentation details")
        plans_by_id[plan_id] = plan
    if (
        not isinstance(recommended_plan_id, str)
        or not PLAN_ID_PATTERN.fullmatch(recommended_plan_id)
        or recommended_plan_id not in plans_by_id
    ):
        raise RuntimeError("the checkout recommendation is not feasible")

    ordered_plan_ids = [recommended_plan_id]
    ordered_plan_ids.extend(
        plan_id for plan_id in plans_by_id if plan_id != recommended_plan_id
    )
    choices: list[dict] = []
    for index, plan_id in enumerate(ordered_plan_ids, start=1):
        recommended = plan_id == recommended_plan_id
        selected_plan = plans_by_id[plan_id]
        choices.append(
            {
                "choice": index,
                "disposition": "approve",
                "decision_id": decision_id,
                "plan_id": plan_id,
                "recommended": recommended,
                "label": (
                    f"Approve recommended: {selected_plan['title']}"
                    if recommended
                    else f"Approve alternate: {selected_plan['title']}"
                ),
            }
        )
    choices.append(
        {
            "choice": len(choices) + 1,
            "disposition": "adjust",
            "decision_id": decision_id,
            "label": "Adjust plan with instructions",
        }
    )
    choices.append(
        {
            "choice": len(choices) + 1,
            "disposition": "reject",
            "decision_id": decision_id,
            "label": "Reject this decision",
        }
    )
    return choices


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
        raise RuntimeError("Camel returned no checkout candidate set")
    candidate_set_id = value.get("candidate_set_id")
    state_version = value.get("based_on_state_version")
    plans = value.get("candidate_plans")
    if (
        not isinstance(candidate_set_id, str)
        or not CANDIDATE_SET_ID_PATTERN.fullmatch(candidate_set_id)
        or value.get("status") != "awaiting_agent_recommendation"
        or not isinstance(state_version, int)
        or state_version < 1
        or not isinstance(plans, list)
        or not 1 <= len(plans) <= 2
    ):
        raise RuntimeError("Camel returned an invalid checkout candidate set")
    seen: set[str] = set()
    for plan in plans:
        plan_id = plan.get("plan_id") if isinstance(plan, dict) else None
        if not isinstance(plan_id, str) or not PLAN_ID_PATTERN.fullmatch(plan_id) or plan_id in seen:
            raise RuntimeError("the checkout candidate set contains an invalid or duplicate plan ID")
        manager_choices({
            "decision_id": "CHK-DEC-AAAAAAAA-001",
            "recommended_plan_id": plan_id,
            "feasible_plans": [plan],
        })
        seen.add(plan_id)
    return value


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
        raise ValueError("candidate_set_id must use the exact returned CHK-CAND identifier")
    if not isinstance(expected_state_version, int) or expected_state_version < 1:
        raise ValueError("expected_state_version must be a positive integer")
    if not isinstance(recommended_plan_id, str) or not PLAN_ID_PATTERN.fullmatch(recommended_plan_id):
        raise ValueError("recommended_plan_id is invalid")
    planned = request_json(config["plans_endpoint"], "POST", scoped_payload(config))
    candidate_set = validated_candidate_set(planned.get("candidate_set"))
    if (
        candidate_set["candidate_set_id"] != candidate_set_id
        or candidate_set["based_on_state_version"] != expected_state_version
    ):
        raise RuntimeError("the checkout candidate set changed before the Hermes recommendation was committed")
    candidate_ids = [plan["plan_id"] for plan in candidate_set["candidate_plans"]]
    if recommended_plan_id not in candidate_ids:
        raise ValueError("recommended_plan_id must be an exact returned candidate ID")
    alternate_plan_id = next(
        (plan_id for plan_id in candidate_ids if plan_id != recommended_plan_id),
        None,
    )
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
            "alternate_plan_ids": [alternate_plan_id] if alternate_plan_id else [],
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
        raise RuntimeError("Camel did not persist the Hermes checkout recommendation")
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
        result = {
            "outcome": "agent_recommendation_required",
            "candidate_set": candidate_set,
            "operating_state": planned.get("operating_state"),
        }
        return result
    if action == "report_checkpoint":
        checkpoint = observed.get("checkpoint")
        checkpoint_id = checkpoint.get("checkpoint_id") if isinstance(checkpoint, dict) else None
        if not isinstance(checkpoint_id, str):
            raise RuntimeError("Camel requested a checkout checkpoint without an ID")
        payload = scoped_payload(config)
        payload.update(
            {
                "disposition": "acknowledge_checkpoint",
                "checkpoint_id": checkpoint_id,
                "idempotency_key": f"{checkpoint_id}-reported",
            }
        )
        acknowledged = request_json(config["actions_endpoint"], "POST", payload)
        returned_checkpoint = acknowledged.get("checkpoint")
        if (
            acknowledged.get("checkpoint_acknowledged") is not True
            or not isinstance(returned_checkpoint, dict)
            or returned_checkpoint.get("checkpoint_id") != checkpoint_id
        ):
            raise RuntimeError("Camel did not acknowledge the checkout checkpoint")
        return {
            "outcome": "checkpoint_result",
            "checkpoint": returned_checkpoint,
            "operating_state": observed,
        }
    return {"outcome": "no_alert", "operating_state": observed}


def review(config: dict) -> dict:
    observed = status(config)
    try:
        decision = pending_decision(observed)
    except RuntimeError:
        return {"outcome": "no_pending_decision", "operating_state": observed}
    return {
        "outcome": "manager_decision_available",
        "decision": decision,
        "recommended_plan": recommended_plan(decision),
        "manager_choices": manager_choices(decision),
        "instruction_schema": observed.get("instruction_schema"),
        "operating_state": observed,
    }


def decide(config: dict, disposition: str, decision_id: str, plan_id: str | None = None) -> dict:
    if not DECISION_ID_PATTERN.fullmatch(decision_id):
        raise ValueError("decision_id must use the exact returned CHK-DEC identifier")
    if plan_id is not None and not PLAN_ID_PATTERN.fullmatch(plan_id):
        raise ValueError("plan_id is invalid")
    observed = status(config)
    decision = pending_decision(observed, decision_id)
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
        raise RuntimeError("the selected checkout plan is no longer available")
    expected_version = decision.get("based_on_state_version")
    if not isinstance(expected_version, int) or expected_version < 1:
        raise RuntimeError("the pending checkout decision has no valid state version")

    payload = scoped_payload(config)
    payload.update(
        {
            "disposition": disposition,
            "decision_id": decision_id,
            "expected_state_version": expected_version,
            "idempotency_key": f"{decision_id}-{disposition}-{plan_id or 'recommended'}",
        }
    )
    if plan_id is not None:
        payload["plan_id"] = plan_id
    result = request_json(config["actions_endpoint"], "POST", payload)
    verification_state = status(config)
    if disposition == "approve":
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
            raise RuntimeError("the checkout action receipt could not be verified")
        result["receipt_verified"] = True
        result["checkpoint"] = verified_checkpoint
    elif result.get("external_action_executed") is not False:
        raise RuntimeError("the rejected checkout decision executed an external action")
    if disposition == "approve":
        result["selected_plan"] = selected_plan
    result["verification_state"] = verification_state
    return result


def choose(config: dict, choice: int, decision_id: str) -> dict:
    if not DECISION_ID_PATTERN.fullmatch(decision_id):
        raise ValueError("decision_id must use the exact returned CHK-DEC identifier")
    observed = status(config)
    decision = pending_decision(observed, decision_id)
    selected = next(
        (item for item in manager_choices(decision) if item["choice"] == choice), None
    )
    if selected is None:
        raise ValueError("choice is not available for the current checkout decision")
    if selected["disposition"] == "adjust":
        return {
            "outcome": "manager_instruction_required",
            "external_action_executed": False,
            "decision": decision,
            "instruction_schema": observed.get("instruction_schema"),
            "selected_manager_choice": selected,
        }
    result = decide(
        config,
        selected["disposition"],
        decision_id,
        selected.get("plan_id"),
    )
    result["selected_manager_choice"] = selected
    return result


def normalized_constraints(args: argparse.Namespace) -> dict:
    constraints: dict = {}
    protected_departments: list[str] = []
    for department in args.protect_department:
        if not DEPARTMENT_PATTERN.fullmatch(department):
            raise ValueError("protect_department is invalid")
        if department not in protected_departments:
            protected_departments.append(department)
    if protected_departments:
        constraints["protected_departments"] = protected_departments
    if args.target_wait_minutes is not None:
        if not 3.0 <= args.target_wait_minutes <= 8.0:
            raise ValueError("target_wait_minutes must be between 3 and 8")
        constraints["target_wait_minutes"] = args.target_wait_minutes
    if args.max_associates is not None:
        if not 0 <= args.max_associates <= 2:
            raise ValueError("max_associates must be between 0 and 2")
        constraints["max_associates_reassigned"] = args.max_associates
    if args.max_assignment_minutes is not None:
        if not 10 <= args.max_assignment_minutes <= 30:
            raise ValueError("max_assignment_minutes must be between 10 and 30")
        constraints["max_assignment_minutes"] = args.max_assignment_minutes
    if args.prefer_action is not None:
        constraints["preferred_action_type"] = args.prefer_action
    if not constraints:
        raise ValueError("at least one supported manager constraint is required")
    return constraints


def replan(config: dict, args: argparse.Namespace) -> dict:
    decision_id = args.decision_id
    if not DECISION_ID_PATTERN.fullmatch(decision_id):
        raise ValueError("decision_id must use the exact returned CHK-DEC identifier")
    constraints = normalized_constraints(args)
    observed = status(config)
    decision = pending_decision(observed, decision_id)
    expected_version = decision.get("based_on_state_version")
    if not isinstance(expected_version, int) or expected_version < 1:
        raise RuntimeError("the pending checkout decision has no valid state version")

    canonical = json.dumps(constraints, separators=(",", ":"), sort_keys=True)
    payload = scoped_payload(config)
    payload.update(
        {
            "decision_id": decision_id,
            "expected_state_version": expected_version,
            "manager_constraints": constraints,
            "idempotency_key": (
                f"{decision_id}-replan-"
                f"{hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:16]}"
            ),
        }
    )
    result = request_json(config["plans_endpoint"], "POST", payload)
    candidate_set = validated_candidate_set(result.get("candidate_set"))
    if (
        result.get("new_candidate_set") is not True
        or result.get("replanned") is not True
        or result.get("previous_decision_id") != decision_id
        or candidate_set.get("supersedes_decision_id") != decision_id
    ):
        raise RuntimeError("Camel did not create replacement checkout candidates")
    return {
        "outcome": "agent_recommendation_required",
        "previous_decision_id": decision_id,
        "candidate_set": candidate_set,
        "operating_state": result.get("operating_state"),
    }


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
            result = replan(config, args)
    except (ValueError, RuntimeError) as error:
        print(f"Store Manager checkout queue recovery unavailable: {error}", file=sys.stderr)
        return 1

    json.dump(result, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
