#!/usr/bin/env python3
"""Deterministic contract regression tests for the synthetic Store Manager APIs."""

from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta
from decimal import Decimal
from http.client import HTTPResponse
import ipaddress
import json
import re
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


MAX_RESPONSE_BYTES = 1_048_576
STORE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
OPD_DECISION_PATTERN = re.compile(r"^OPD-DEC-([A-Z0-9]{8})-[0-9]{3,}$")
OPD_CANDIDATE_PATTERN = re.compile(r"^OPD-CAND-([A-Z0-9]{8})-[0-9]{3,}$")
CHECKOUT_DECISION_PATTERN = re.compile(r"^CHK-DEC-([A-Z0-9]{8})-[0-9]{3,}$")
CHECKOUT_CANDIDATE_PATTERN = re.compile(r"^CHK-CAND-([A-Z0-9]{8})-[0-9]{3,}$")


class ContractFailure(AssertionError):
    """Raised when an API response violates the deterministic demo contract."""


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise ContractFailure(message)


def validate_base_url(base_url: str) -> str:
    parsed = urlsplit(base_url)
    expect(parsed.scheme == "http", "the test base URL must use http")
    expect(parsed.hostname is not None, "the test base URL must include a host")
    expect(parsed.username is None and parsed.password is None, "credentials are not allowed in the test base URL")
    expect(parsed.path in {"", "/"}, "the test base URL must not include a path")
    expect(not parsed.query and not parsed.fragment, "the test base URL must not include a query or fragment")

    hostname = parsed.hostname
    if hostname != "localhost":
        try:
            address = ipaddress.ip_address(hostname)
        except ValueError as error:
            raise ContractFailure("the test host must be localhost or a private IP address") from error
        expect(address.is_loopback or address.is_private, "the test host must be loopback or private")
    return base_url.rstrip("/")


class StoreManagerClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = validate_base_url(base_url)

    def request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, str] | None = None,
        payload: Any | None = None,
        raw_payload: bytes | None = None,
        expected_status: int = 200,
    ) -> dict[str, Any]:
        expect(path.startswith("/") and "?" not in path, "test paths must be absolute and query-free")
        expect(not (payload is not None and raw_payload is not None), "a request cannot have two payload forms")
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urlencode(query)}"

        body = raw_payload
        headers = {"Accept": "application/json"}
        if payload is not None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(url, data=body, headers=headers, method=method)

        status: int
        response: HTTPResponse | HTTPError
        try:
            response = urlopen(request, timeout=15)
            status = response.status
        except HTTPError as error:
            response = error
            status = error.code
        except (URLError, TimeoutError) as error:
            raise ContractFailure(f"Camel is unavailable at {self.base_url}") from error

        with response:
            raw_response = response.read(MAX_RESPONSE_BYTES + 1)
        expect(len(raw_response) <= MAX_RESPONSE_BYTES, f"{method} {path} exceeded the response-size limit")
        try:
            decoded = json.loads(raw_response)
        except json.JSONDecodeError as error:
            raise ContractFailure(f"{method} {path} returned invalid JSON") from error
        expect(isinstance(decoded, dict), f"{method} {path} did not return a JSON object")
        expect(status == expected_status, f"{method} {path} returned HTTP {status}, expected {expected_status}: {decoded}")
        return decoded


class ContractSuite:
    def __init__(self, client: StoreManagerClient, store_id: str, business_date: str) -> None:
        self.client = client
        self.store_id = store_id
        self.business_date = business_date
        self.scope = {"store_id": store_id, "business_date": business_date}

    def get(self, path: str, *, expected_status: int = 200) -> dict[str, Any]:
        return self.client.request(
            "GET",
            path,
            query=self.scope,
            expected_status=expected_status,
        )

    def post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        expected_status: int = 200,
    ) -> dict[str, Any]:
        return self.client.request("POST", path, payload=payload, expected_status=expected_status)

    def scoped(self, **values: Any) -> dict[str, Any]:
        return {**self.scope, **values}

    def run(self) -> None:
        self.test_health_and_snapshots()
        self.test_error_contracts()
        self.test_opd_operating_flow()
        self.test_checkout_operating_flow()
        self.test_checkout_replan()
        self.test_end_of_day_flow()
        self.test_incident_response_planning()

    def test_health_and_snapshots(self) -> None:
        health = self.client.request("GET", "/health")
        expect(health == {"status": "ok"}, "health response changed")

        morning = self.get("/v1/store-morning-snapshot")
        expect(morning.get("contract_version") == "0.3.0", "morning contract version changed")
        expect(morning.get("store_id") == self.store_id, "morning store identity changed")
        expect(morning.get("business_date") == self.business_date, "morning business date changed")
        for field in (
            "store", "freshness", "yesterday_trade", "today", "fulfillment", "safety",
            "store_condition", "not_in_location", "opd", "customer_waits", "traffic",
        ):
            expect(isinstance(morning.get(field), dict), f"morning snapshot is missing {field}")
        for field in (
            "inventory_exceptions", "staffing_gaps", "opening_leadership", "overnight_carryover",
        ):
            expect(isinstance(morning.get(field), list), f"morning snapshot is missing {field}")

        expect(isinstance(morning["freshness"].get("safety"), str), "morning safety freshness is missing")
        for field in ("opd_operations", "opening_conditions", "service_performance"):
            expect(isinstance(morning["freshness"].get(field), str), f"morning {field} freshness is missing")

        leadership = morning["opening_leadership"]
        covered_departments = {
            department
            for leader in leadership
            for department in leader.get("departments", [])
        }
        expect(
            {
                "Storewide", "Fulfillment", "Checkout", "Outdoor", "Home", "Kitchen",
                "Seasonal", "Receiving",
            }.issubset(covered_departments),
            "opening leadership does not cover the expected departments",
        )
        expect(
            all(leader.get("display_name") and leader.get("role") and leader.get("shift") for leader in leadership),
            "an opening leader is missing a display name, role, or shift",
        )

        store_condition = morning["store_condition"]
        expect(store_condition.get("overall_status") == "attention_needed", "store condition changed")
        expect(len(store_condition.get("major_issues", [])) == 2, "opening major-issue count changed")
        expect(len(morning["overnight_carryover"]) == 2, "overnight carryover count changed")

        nil = morning["not_in_location"]
        expect(nil.get("unresolved") == 22, "not-in-location unresolved count changed")
        expect(nil.get("detection_rate_percent") == 4.4, "not-in-location current rate changed")
        expect(nil.get("prior_7_day_average_rate_percent") == 2.9, "not-in-location baseline changed")

        opd = morning["opd"]
        expect(opd.get("opening_backlog", {}).get("items_in_pick_queue") == 940, "OPD backlog changed")
        expect(opd.get("first_pick", {}).get("late_start_minutes") == 15, "OPD opening delay changed")
        dispensing = opd.get("dispensing_waits", {})
        expect(
            dispensing.get("customer_pickup", {}).get("peak_wait_minutes") == 12.6,
            "customer pickup dispensing wait changed",
        )
        expect(
            dispensing.get("delivery_driver", {}).get("peak_wait_minutes") == 15.4,
            "delivery-driver dispensing wait changed",
        )

        checkout_wait = morning["customer_waits"].get("checkout", {})
        expect(checkout_wait.get("peak_wait_minutes") == 11.2, "peak checkout wait changed")
        traffic = morning["traffic"]
        expect(traffic.get("transactions") == 612, "hourly traffic total changed")
        expect(
            sum(hour.get("transactions", 0) for hour in traffic.get("hourly_transactions", [])) == 612,
            "hourly transactions do not reconcile to daily transactions",
        )
        expect(traffic.get("peak_hour", {}).get("transactions") == 78, "peak transaction hour changed")

        safety = morning["safety"]
        expect(isinstance(safety.get("reporting_window"), dict), "safety reporting window is missing")
        expect(safety.get("privacy") == {
            "contains_images": False,
            "contains_person_identifiers": False,
        }, "safety privacy boundary changed")
        safety_summary = safety.get("summary", {})
        expect(safety_summary.get("events_since_previous_close") == 4, "safety event count changed")
        expect(safety_summary.get("events_needing_attention") == 2, "active safety count changed")
        expect(safety_summary.get("active_hazards") == 2, "active hazard count changed")
        expect(safety_summary.get("active_incidents") == 0, "active incident count changed")
        expect(safety_summary.get("awaiting_verification") == 1, "unverified safety count changed")
        expect(safety_summary.get("incidents_since_previous_close") == 1, "incident count changed")
        expect(safety_summary.get("cleared_events") == 2, "cleared safety count changed")
        events = safety.get("events", [])
        expect(len(events) == 4, "normalized safety event count changed")
        expect(events[0].get("severity") == "critical", "safety severity ordering changed")
        expect(events[0].get("status") == "response_dispatched", "active safety ordering changed")
        expect(events[1].get("verification", {}).get("status") == "unverified", "unverified observation changed")
        for event in events:
            for field in (
                "event_id", "classification", "event_type", "description", "location",
                "severity", "status", "detected_at", "last_observed_at",
                "verification", "observation", "response",
            ):
                expect(field in event, f"normalized safety event is missing {field}")

        recovery = self.get("/v1/store-opd-recovery")
        expect(recovery.get("contract_version") == "0.1.0", "OPD recovery contract version changed")
        expect(recovery.get("store_id") == self.store_id, "OPD recovery store identity changed")
        expect(recovery.get("business_date") == self.business_date, "OPD recovery date changed")
        expect(isinstance(recovery.get("opd_status"), dict), "OPD recovery status is missing")
        expect(isinstance(recovery.get("execution_constraints"), dict), "OPD constraints are missing")
        expect(isinstance(recovery.get("recovery"), dict), "OPD recovery forecast is missing")
        print("PASS expanded morning operating snapshot and read-only OPD recovery contracts")

    def test_error_contracts(self) -> None:
        missing = self.client.request(
            "GET",
            "/v1/store-morning-snapshot",
            expected_status=400,
        )
        expect(missing.get("error") == "invalid_request", "missing snapshot identity error changed")

        invalid_date = self.client.request(
            "GET",
            "/v1/store-morning-snapshot",
            query={"store_id": self.store_id, "business_date": "not-a-date"},
            expected_status=400,
        )
        expect(invalid_date.get("error") == "invalid_request", "invalid-date error changed")

        unknown_store = self.client.request(
            "GET",
            "/v1/store-morning-snapshot",
            query={"store_id": "UNKNOWN", "business_date": self.business_date},
            expected_status=404,
        )
        expect(unknown_store.get("error") == "store_not_found", "unknown-store error changed")

        invalid_json = self.client.request(
            "POST",
            "/v1/store-opd-recovery-plans",
            raw_payload=b"not-json",
            expected_status=400,
        )
        expect(invalid_json.get("error") == "invalid_request", "invalid JSON error changed")

        invalid_shape = self.client.request(
            "POST",
            "/v1/store-checkout-recovery-plans",
            payload=[],
            expected_status=400,
        )
        expect(invalid_shape.get("error") == "invalid_request", "invalid JSON shape error changed")

        self.post("/v1/demo/events", self.scoped(operation="reset"))
        no_intervention = self.post(
            "/v1/store-opd-recovery-plans",
            self.scope,
            expected_status=409,
        )
        expect(no_intervention.get("error") == "no_intervention_required", "baseline OPD error changed")
        print("PASS HTTP validation and error contracts")

    def test_opd_operating_flow(self) -> None:
        reset = self.post("/v1/demo/events", self.scoped(operation="reset"))
        expect(reset.get("event_result") == "reset", "OPD reset result changed")
        expect(reset["operating_state"].get("state_version") == 1, "OPD reset state version changed")

        incident = self.post("/v1/demo/events", self.scoped(operation="incident"))
        expect(incident.get("event_result") == "incident_injected", "OPD incident result changed")
        expect(len(incident["operating_state"].get("active_events", [])) == 2, "OPD incident events changed")

        plan = self.post("/v1/store-opd-recovery-plans", self.scope)
        candidates = plan.get("candidate_set", {})
        candidate_set_id = candidates.get("candidate_set_id")
        candidate_match = OPD_CANDIDATE_PATTERN.fullmatch(candidate_set_id) if isinstance(candidate_set_id, str) else None
        expect(plan.get("new_candidate_set") is True, "OPD did not create a candidate set")
        expect(candidate_match is not None, "OPD candidate-set ID changed")
        run_id = candidate_match.group(1)
        event_ids = [event.get("event_id") for event in incident["operating_state"].get("active_events", [])]
        expect(all(isinstance(event_id, str) and event_id.startswith(f"OPD-EVT-{run_id}-") for event_id in event_ids), "OPD event and candidate namespaces differ")
        candidate_plans = candidates.get("candidate_plans", [])
        expect(len(candidate_plans) == 2, "OPD candidate count changed")
        expect("recommended_plan_id" not in candidates, "Camel preselected the OPD recommendation")
        expect(plan.get("operating_state", {}).get("operating_status") == "agent_planning", "OPD did not expose agent planning")
        expect(plan.get("operating_state", {}).get("decision") is None, "OPD exposed a decision before Hermes committed one")

        recommended_plan = next(candidate for candidate in candidate_plans if candidate.get("plan_id") == "FLEX-2")
        alternate_plan = next(candidate for candidate in candidate_plans if candidate.get("plan_id") == "FLEX-1")
        expected_version = candidates.get("based_on_state_version")
        commit_payload = self.scoped(
            candidate_set_id=candidate_set_id,
            expected_state_version=expected_version,
            recommended_plan_id=recommended_plan["plan_id"],
            alternate_plan_ids=[alternate_plan["plan_id"]],
            recommendation_reason="Two associates restore pick rate to target and reduce the projected backlog below the follow-up limit.",
            tradeoff_summary="This uses both available cross-trained associates during the recovery window.",
            idempotency_key=f"{candidate_set_id}-contract-commit",
        )
        committed = self.post("/v1/store-opd-decisions", commit_payload)
        repeated_commit = self.post("/v1/store-opd-decisions", commit_payload)
        expect(committed == repeated_commit, "OPD recommendation commit is not idempotent")
        decision = committed.get("decision", {})
        decision_id = decision.get("decision_id")
        decision_match = OPD_DECISION_PATTERN.fullmatch(decision_id) if isinstance(decision_id, str) else None
        expect(decision_match is not None and decision_match.group(1) == run_id, "OPD decision namespace changed")
        expect(decision.get("status") == "pending_manager_approval", "OPD decision status changed")
        expect(decision.get("decision_author") == "hermes", "OPD decision author changed")
        expect(decision.get("decision_method") == "agent_reasoned_candidate_ranking", "OPD decision method changed")
        expect(decision.get("manager_message_status") == "preparing", "OPD exposed the choices before the manager response was ready")
        expect(decision.get("recommended_plan_id") == "FLEX-2", "Camel overrode Hermes's OPD recommendation")

        message_ready_payload = self.scoped(
            decision_id=decision_id,
            expected_state_version=expected_version,
            idempotency_key=f"{decision_id}-manager-message-ready",
        )
        message_ready = self.post("/v1/store-opd-manager-message", message_ready_payload)
        repeated_message_ready = self.post("/v1/store-opd-manager-message", message_ready_payload)
        expect(message_ready == repeated_message_ready, "OPD manager-message acknowledgement is not idempotent")
        expect(message_ready.get("manager_message_ready") is True, "OPD manager message was not marked ready")
        expect(message_ready.get("decision", {}).get("manager_message_status") == "ready", "OPD choices remained hidden after the manager response completed")

        approval_payload = self.scoped(
            disposition="approve",
            decision_id=decision_id,
            plan_id=recommended_plan["plan_id"],
            expected_state_version=expected_version,
            idempotency_key="opd-contract-approve",
        )
        approval = self.post("/v1/store-opd-actions", approval_payload)
        repeated = self.post("/v1/store-opd-actions", approval_payload)
        expect(approval == repeated, "OPD idempotent approval response changed")
        expect(approval.get("external_action_executed") is True, "OPD approval did not execute")
        expect(approval.get("action_receipt", {}).get("status") == "accepted", "OPD receipt is not accepted")

        progress = self.post("/v1/demo/events", self.scoped(operation="advance_time", minutes=30))
        progress_state = progress.get("operating_state", {})
        progress_checkpoint = progress_state.get("checkpoint", {})
        expect(progress_checkpoint.get("stage") == "progress", "OPD early checkpoint stage changed")
        expect(progress_checkpoint.get("status") == "met", "OPD early checkpoint result changed")
        expect(progress_checkpoint.get("next_measurement_after_minutes") == 60, "OPD final checkpoint timing changed")
        expect(progress_state.get("operating_status") == "recovering_on_track", "OPD claimed recovery at the early checkpoint")
        expect(progress_state.get("monitor", {}).get("action") == "report_checkpoint", "OPD early checkpoint was not reportable")

        progress_id = progress_checkpoint.get("checkpoint_id")
        acknowledged = self.post(
            "/v1/store-opd-actions",
            self.scoped(
                disposition="acknowledge_checkpoint",
                checkpoint_id=progress_id,
                idempotency_key=f"{progress_id}-contract-reported",
            ),
        )
        expect(acknowledged.get("checkpoint_acknowledged") is True, "OPD early checkpoint was not acknowledged")

        final = self.post("/v1/demo/events", self.scoped(operation="advance_time", minutes=60))
        final_state = final.get("operating_state", {})
        final_checkpoint = final_state.get("checkpoint", {})
        expect(final_checkpoint.get("checkpoint_id") != progress_id, "OPD final checkpoint reused the early checkpoint ID")
        expect(final_checkpoint.get("stage") == "final", "OPD final checkpoint stage changed")
        expect(final_checkpoint.get("status") == "met", "OPD final checkpoint result changed")
        expect(final_state.get("operating_status") == "recovered", "OPD did not recover after the full assignment")
        expect(final_state.get("monitor", {}).get("action") == "report_checkpoint", "OPD final checkpoint was not reportable")
        expect(final_state.get("metrics", {}).get("current_pickers") == 3, "temporary OPD associates were not released")
        expect(
            final_state.get("last_action_receipt", {}).get("applied_change", {}).get("assignment_status") == "completed",
            "OPD assignment did not complete",
        )
        print("PASS OPD incident, Hermes ranking, response-ready gate, approval, idempotency, progress, and final checkpoint flow")

    def test_checkout_operating_flow(self) -> None:
        reset = self.post("/v1/demo/checkout-events", self.scoped(operation="reset"))
        reset_state = reset.get("operating_state", {})
        expect(reset.get("event_result") == "reset", "checkout reset result changed")
        expect(reset_state.get("state_version") == 1, "checkout reset state version changed")

        incident = self.post("/v1/demo/checkout-events", self.scoped(operation="queue_surge"))
        expect(incident.get("event_result") == "queue_surge_injected", "checkout incident result changed")
        expect(incident.get("operating_state", {}).get("monitor", {}).get("action") == "request_recovery_plan", "checkout monitor action changed")
        active_events = incident.get("operating_state", {}).get("active_events", [])
        expect(len(active_events) == 1, "checkout active-event count changed")
        event_id = active_events[0].get("event_id")

        plan = self.post("/v1/store-checkout-recovery-plans", self.scope)
        candidates = plan.get("candidate_set", {})
        candidate_set_id = candidates.get("candidate_set_id")
        candidate_match = CHECKOUT_CANDIDATE_PATTERN.fullmatch(candidate_set_id) if isinstance(candidate_set_id, str) else None
        expect(plan.get("new_candidate_set") is True, "checkout did not create a candidate set")
        expect(candidate_match is not None, "checkout candidate-set ID changed")
        run_id = candidate_match.group(1)
        expect(isinstance(event_id, str) and event_id.startswith(f"CHK-EVT-{run_id}-"), "checkout event and candidate namespaces differ")
        candidate_plans = candidates.get("candidate_plans", [])
        expect(len(candidate_plans) >= 2, "checkout has too few safe candidates for agent ranking")
        expect("recommended_plan_id" not in candidates, "Camel preselected the checkout recommendation")
        planning_state = plan.get("operating_state", {})
        expect("decision" not in planning_state, "checkout exposed a manager decision before Hermes committed one")
        expect(planning_state.get("operating_status") == "agent_planning", "checkout planning status changed")
        expect(planning_state.get("monitor", {}).get("action") == "await_agent_recommendation", "checkout agent-planning action changed")

        recommended_plan = candidate_plans[0].get("plan_id")
        alternate_plan = candidate_plans[1].get("plan_id")
        expected_version = candidates.get("based_on_state_version")
        decision_response = self.post(
            "/v1/store-checkout-decisions",
            self.scoped(
                candidate_set_id=candidate_set_id,
                expected_state_version=expected_version,
                recommended_plan_id=recommended_plan,
                alternate_plan_ids=[alternate_plan],
                recommendation_reason="This action restores both checkout targets while preserving the protected online-order recovery assignment.",
                tradeoff_summary="Outdoor replenishment pauses for twenty minutes while the line recovers.",
                idempotency_key="checkout-contract-agent-decision",
            ),
        )
        repeated_decision = self.post(
            "/v1/store-checkout-decisions",
            self.scoped(
                candidate_set_id=candidate_set_id,
                expected_state_version=expected_version,
                recommended_plan_id=recommended_plan,
                alternate_plan_ids=[alternate_plan],
                recommendation_reason="This action restores both checkout targets while preserving the protected online-order recovery assignment.",
                tradeoff_summary="Outdoor replenishment pauses for twenty minutes while the line recovers.",
                idempotency_key="checkout-contract-agent-decision",
            ),
        )
        expect(decision_response == repeated_decision, "checkout agent decision is not idempotent")
        decision = decision_response.get("decision", {})
        decision_id = decision.get("decision_id")
        decision_match = CHECKOUT_DECISION_PATTERN.fullmatch(decision_id) if isinstance(decision_id, str) else None
        expect(decision_match is not None, "checkout decision ID changed")
        expect(decision_match.group(1) == run_id, "checkout candidate and decision namespaces differ")
        expect(decision.get("status") == "pending_manager_approval", "checkout decision status changed")
        expect(decision.get("decision_author") == "hermes", "checkout decision author changed")
        expect(decision.get("decision_method") == "agent_reasoned_candidate_ranking", "checkout decision method changed")
        expect(decision.get("candidate_set_id") == candidate_set_id, "checkout decision lost its candidate set")
        expect(len(decision.get("feasible_plans", [])) == 2, "checkout decision did not preserve the agent ranking")
        expect(decision.get("recommended_plan_id") == recommended_plan, "checkout changed Hermes's recommendation")
        expect(isinstance(expected_version, int), "checkout state version is missing")
        expect(isinstance(recommended_plan, str), "checkout recommendation is missing")

        approval_payload = self.scoped(
            disposition="approve",
            decision_id=decision_id,
            plan_id=recommended_plan,
            expected_state_version=expected_version,
            idempotency_key="checkout-contract-approve",
        )
        approval = self.post("/v1/store-checkout-actions", approval_payload)
        repeated = self.post("/v1/store-checkout-actions", approval_payload)
        expect(approval == repeated, "checkout idempotent approval response changed")
        expect(approval.get("external_action_executed") is True, "checkout approval did not execute")
        expect(approval.get("action_receipt", {}).get("status") == "accepted", "checkout receipt is not accepted")
        expect(approval.get("action_receipt", {}).get("receipt_id", "").startswith(f"CHK-ACT-{run_id}-"), "checkout receipt namespace changed")

        advanced = self.post("/v1/demo/checkout-events", self.scoped(operation="advance_time", minutes=10))
        expect(advanced.get("operating_state", {}).get("checkpoint", {}).get("status") == "met", "checkout checkpoint changed")
        expect(advanced.get("operating_state", {}).get("checkpoint", {}).get("checkpoint_id", "").startswith(f"CHK-CHK-{run_id}-"), "checkout checkpoint namespace changed")
        status = self.get("/v1/store-checkout-operating-state")
        expect(status.get("operating_status") == "recovered", "checkout did not recover")
        expect(status.get("monitor", {}).get("action") == "report_checkpoint", "checkout monitor action changed")
        print("PASS checkout incident, planning, approval, idempotency, and checkpoint flow")

    def test_checkout_replan(self) -> None:
        self.post("/v1/demo/checkout-events", self.scoped(operation="reset"))
        self.post("/v1/demo/checkout-events", self.scoped(operation="queue_surge"))
        original = self.post("/v1/store-checkout-recovery-plans", self.scope)
        original_candidates = original.get("candidate_set", {})
        original_plans = original_candidates.get("candidate_plans", [])
        original_decision = self.post(
            "/v1/store-checkout-decisions",
            self.scoped(
                candidate_set_id=original_candidates.get("candidate_set_id"),
                expected_state_version=original_candidates.get("based_on_state_version"),
                recommended_plan_id=original_plans[0].get("plan_id"),
                alternate_plan_ids=[original_plans[1].get("plan_id")],
                recommendation_reason="This action is projected to restore both queue targets without moving protected fulfillment coverage.",
                tradeoff_summary="Outdoor replenishment pauses briefly during checkout recovery.",
                idempotency_key="checkout-contract-original-agent-decision",
            ),
        )
        decision = original_decision.get("decision", {})
        decision_id = decision.get("decision_id")
        expected_version = decision.get("based_on_state_version")
        expect(isinstance(decision_id, str), "checkout replan has no original decision")
        expect(isinstance(expected_version, int), "checkout replan has no state version")

        replacement = self.post(
            "/v1/store-checkout-recovery-plans",
            self.scoped(
                decision_id=decision_id,
                expected_state_version=expected_version,
                idempotency_key="checkout-contract-replan",
                manager_constraints={"preferred_action_type": "self_checkout"},
            ),
        )
        replacement_candidates = replacement.get("candidate_set", {})
        expect(replacement.get("replanned") is True, "checkout replan flag changed")
        expect(replacement.get("previous_decision_id") == decision_id, "checkout replan lost its prior decision")
        expect(replacement_candidates.get("supersedes_decision_id") == decision_id, "checkout replacement candidates lost the prior decision")
        expect(replacement_candidates.get("manager_constraints", {}).get("preferred_action_type") == "self_checkout", "manager instruction was not preserved")
        replacement_plans = replacement_candidates.get("candidate_plans", [])
        self_checkout = next((plan for plan in replacement_plans if plan.get("action_type") == "self_checkout"), None)
        other = next((plan for plan in replacement_plans if plan.get("action_type") != "self_checkout"), None)
        expect(isinstance(self_checkout, dict) and isinstance(other, dict), "checkout replan candidates changed")
        committed = self.post(
            "/v1/store-checkout-decisions",
            self.scoped(
                candidate_set_id=replacement_candidates.get("candidate_set_id"),
                expected_state_version=replacement_candidates.get("based_on_state_version"),
                recommended_plan_id=self_checkout.get("plan_id"),
                alternate_plan_ids=[other.get("plan_id")],
                recommendation_reason="Self-checkout support follows the manager preference and avoids interrupting a sales department during the surge.",
                tradeoff_summary="Front-end service desk customers may wait longer during the temporary assignment.",
                idempotency_key="checkout-contract-replanned-agent-decision",
            ),
        )
        new_decision = committed.get("decision", {})
        expect(new_decision.get("decision_id") != decision_id, "checkout replan reused a decision ID")
        expect(new_decision.get("supersedes_decision_id") == decision_id, "replacement decision did not supersede the original")
        expect(new_decision.get("decision_author") == "hermes", "replacement decision is not Hermes-authored")
        expect(new_decision.get("recommended_plan_id") == self_checkout.get("plan_id"), "Camel overrode the replanned Hermes recommendation")
        print("PASS checkout manager-instruction replan and new decision scope")

    def test_end_of_day_flow(self) -> None:
        opd_before = self.get("/v1/store-opd-operating-state")
        checkout_before = self.get("/v1/store-checkout-operating-state")

        reset = self.post("/v1/demo/store-day", self.scoped(operation="reset"))
        initial = self.get("/v1/store-end-of-day-review")
        generated = self.post("/v1/demo/store-day", self.scoped(operation="run"))
        repeated = self.post("/v1/demo/store-day", self.scoped(operation="run"))
        review = self.get("/v1/store-end-of-day-review")

        expect(reset.get("event_result") == "day_reset", "end-of-day reset result changed")
        expect(initial.get("simulation_status") == "not_run", "end-of-day initial state changed")
        expect(generated.get("event_result") == "day_generated", "end-of-day run result changed")
        expect(repeated.get("event_result") == "day_already_complete", "end-of-day idempotency changed")
        expect(review.get("simulation_status") == "completed", "end-of-day review is not complete")
        expect(review.get("contract_version") == "0.3.0", "end-of-day impact contract version changed")

        period = review.get("simulated_period", {})
        timeline = review.get("timeline", [])
        quality = review.get("data_quality", {})
        expect(period.get("duration_minutes") == 480, "end-of-day duration changed")
        expect(period.get("interval_minutes") == 15, "end-of-day interval changed")
        expect(period.get("sample_count") == 32, "end-of-day sample count changed")
        expect(len(timeline) == 32, "end-of-day timeline length changed")
        expect(quality.get("status") == "complete", "end-of-day quality changed")
        expect(quality.get("missing_samples") == 0, "end-of-day has missing samples")

        starts_at = datetime.fromisoformat(period["starts_at"])
        for index, sample in enumerate(timeline):
            expect(datetime.fromisoformat(sample["at"]) == starts_at + timedelta(minutes=15 * index), "end-of-day timeline spacing changed")

        sales = review.get("sales", {})
        expect(sum(sample["sales"]["transactions"] for sample in timeline) == sales.get("transactions"), "sales transaction rollup changed")
        timeline_sales = sum(Decimal(str(sample["sales"]["net_sales"])) for sample in timeline)
        expect(timeline_sales == Decimal(str(sales.get("net_sales"))), "sales amount rollup changed")
        expect(len(sales.get("hourly_results", [])) == 8, "hourly sales coverage changed")
        expect(sales.get("variance") < 0, "synthetic observed sales variance changed direction")

        checkout = review.get("checkout", {})
        checkout_thresholds = checkout.get("thresholds", {})
        checkout_breaches = sum(
            1
            for sample in timeline
            if sample["checkout"]["people_in_queue"] > checkout_thresholds["maximum_people_in_queue"]
            or sample["checkout"]["estimated_wait_minutes"] > checkout_thresholds["maximum_estimated_wait_minutes"]
        )
        expect(checkout_breaches * 15 == checkout.get("minutes_above_target"), "checkout breach rollup changed")

        opd = review.get("opd", {})
        opd_breaches = sum(
            1
            for sample in timeline
            if sample["opd"]["pick_rate_items_per_hour"] < opd["target_pick_rate_items_per_hour"]
        )
        expect(opd_breaches * 15 == opd.get("minutes_below_target"), "OPD breach rollup changed")

        workforce = review.get("workforce", {})
        workforce_gaps = sum(
            1
            for sample in timeline
            if sample["fulfillment_workforce"]["actual_headcount"]
            < sample["fulfillment_workforce"]["required_headcount"]
        )
        expect(workforce_gaps * 15 == workforce.get("fulfillment_understaffed_minutes"), "workforce gap rollup changed")

        incidents = review.get("incident_summary", {})
        expect(incidents.get("operating_incidents") == 5, "operating incident count changed")
        expect(incidents.get("workforce_callouts") == 2, "workforce call-out count changed")
        expect(incidents.get("total_recorded_events") == 7, "total event count changed")

        estimate = review.get("estimated_opportunity_cost", {})
        expect(estimate.get("status") == "estimated_not_confirmed", "estimate status changed")
        expect(
            estimate.get("combined_estimated_revenue_at_risk_low")
            < estimate.get("combined_estimated_revenue_at_risk_high"),
            "estimated opportunity-cost range changed",
        )
        expect("Do not add" in estimate.get("double_counting_warning", ""), "double-counting warning is missing")

        impact = review.get("agent_assisted_impact", {})
        provenance = impact.get("provenance", {})
        actions = impact.get("actions", [])
        summary = impact.get("summary", {})
        expect(impact.get("status") == "simulated_attributed", "agent-assisted impact status changed")
        expect(
            provenance == {
                "recommended_by": "hermes",
                "approved_by": "store_manager",
                "executed_by": "simulated_external_system",
            },
            "agent-assisted action provenance changed",
        )
        expect(len(actions) == 3, "agent-assisted action count changed")
        expect(
            {action.get("domain") for action in actions} == {"checkout", "opd", "inventory"},
            "agent-assisted action domains changed",
        )
        expect(
            all(
                action.get("manager_approved") is True
                and action.get("execution_status") == "completed"
                and action.get("action_receipt_ids")
                for action in actions
            ),
            "agent-assisted action receipts are incomplete",
        )
        expect(summary.get("approved_actions_executed") == 3, "executed action rollup changed")
        expect(summary.get("checkout_incidents_recovered") == 2, "checkout recovery impact changed")
        expect(Decimal(str(summary.get("checkout_wait_reduction_minutes"))) == Decimal("7.2"), "checkout wait impact changed")
        expect(summary.get("estimated_customers_avoiding_excess_wait") == 55, "checkout customer impact changed")
        expect(Decimal(str(summary.get("estimated_retained_transactions_low"))) == Decimal("2.2"), "retained transaction low estimate changed")
        expect(Decimal(str(summary.get("estimated_retained_transactions_high"))) == Decimal("5.0"), "retained transaction high estimate changed")
        expect(Decimal(str(summary.get("estimated_checkout_revenue_retained_low"))) == Decimal("147.07"), "retained revenue low estimate changed")
        expect(Decimal(str(summary.get("estimated_checkout_revenue_retained_high"))) == Decimal("330.91"), "retained revenue high estimate changed")
        expect(summary.get("opd_pick_rate_increase_items_per_hour") == 400, "OPD productivity impact changed")
        expect(summary.get("estimated_late_orders_avoided") == 4, "OPD service impact changed")
        inventory_action = next(action for action in actions if action.get("domain") == "inventory")
        inventory_measured = inventory_action.get("measured", {})
        offer_records = inventory_measured.get("evidence_records", [])
        completed_offers = [
            record for record in offer_records if record.get("outcome") == "completed_purchase"
        ]
        expect(len(offer_records) == 18, "alternative-offer evidence count changed")
        expect(len({record.get("offer_id") for record in offer_records}) == 18, "alternative-offer IDs are not unique")
        expect(len(completed_offers) == 11, "linked POS purchase count changed")
        expect(
            all(
                datetime.fromisoformat(record["purchased_at"])
                > datetime.fromisoformat(record["offered_at"])
                for record in completed_offers
            ),
            "linked POS purchases must occur after their alternative offers",
        )
        expect(
            inventory_measured.get("linked_purchase_receipt_ids")
            == [record.get("purchase_receipt_id") for record in completed_offers],
            "linked POS receipt IDs do not match the offer evidence",
        )
        expect(
            Decimal(str(inventory_measured.get("sales_from_linked_purchases")))
            == sum(Decimal(str(record["net_sales"])) for record in completed_offers)
            == Decimal("460.93"),
            "linked alternative-purchase sales changed",
        )
        expect(summary.get("alternative_offers_recorded") == 18, "offer rollup changed")
        expect(summary.get("linked_completed_purchases") == 11, "linked purchase rollup changed")
        expect(Decimal(str(summary.get("offer_to_purchase_rate_percent"))) == Decimal("61.1"), "offer-to-purchase rate changed")
        expect(Decimal(str(summary.get("sales_from_linked_purchases"))) == Decimal("460.93"), "linked sales rollup changed")
        expect(summary.get("linked_purchase_sales_included_in_net_sales") is True, "linked sales inclusion changed")

        tomorrow = review.get("tomorrow_context", {})
        expected_tomorrow = date.fromisoformat(self.business_date) + timedelta(days=1)
        expect(tomorrow.get("business_date") == expected_tomorrow.isoformat(), "tomorrow context date changed")
        expect(tomorrow.get("weather", {}).get("precipitation_probability_percent") == 85, "tomorrow weather signal changed")

        expect(self.get("/v1/store-opd-operating-state") == opd_before, "end-of-day run mutated OPD state")
        expect(self.get("/v1/store-checkout-operating-state") == checkout_before, "end-of-day run mutated checkout state")
        print("PASS independent eight-hour end-of-day generation, attributed impact, estimates, and isolation")

    def test_incident_response_planning(self) -> None:
        spill = self.post(
            "/v1/store-incident-response-plans",
            self.scoped(
                hazard_class="spill",
                severity="medium",
                zone="checkout",
                customer_exposure="present",
                access_impact="partially_blocked",
                confidence="high",
            ),
        )
        expect(spill.get("contract_version") == "0.1.0", "incident response contract version changed")
        expect(spill.get("store_id") == self.store_id, "incident response store identity changed")
        expect(spill.get("business_date") == self.business_date, "incident response date changed")
        expect(spill.get("visual_assessment", {}).get("hazard_class") == "spill", "incident assessment echo changed")
        guardrails = spill.get("planning_guardrails", {})
        expect(guardrails.get("image_received_by_camel") is False, "Camel unexpectedly accepted incident pixels")
        expect(guardrails.get("person_identification_permitted") is False, "incident identity guardrail changed")
        expect(guardrails.get("external_action_authorized") is False, "incident planner authorized an action")
        expect("recommended_plan_id" not in spill, "Camel preselected the agent's incident recommendation")

        available = spill.get("associate_availability", {}).get("available", [])
        protected = spill.get("associate_availability", {}).get("protected", [])
        available_refs = {item.get("associate_reference") for item in available}
        protected_refs = {item.get("associate_reference") for item in protected}
        expect(bool(available_refs), "incident planner returned no available associates")
        expect(bool(protected_refs), "incident planner returned no protected commitments")
        expect(available_refs.isdisjoint(protected_refs), "associate availability states overlap")

        plans = spill.get("feasible_plans", [])
        expect(len(plans) == 2, "spill incident feasible-plan count changed")
        for plan in plans:
            team = plan.get("response_team", [])
            team_refs = [member.get("associate_reference") for member in team]
            expect(len(team) == 3, "customer-exposed spill must include three response assignments")
            expect(len(team_refs) == len(set(team_refs)), "an incident plan assigns an associate twice")
            expect(set(team_refs).issubset(available_refs), "an incident plan uses an unavailable associate")
            expect(set(team_refs).isdisjoint(protected_refs), "an incident plan violates a protected commitment")
            expect(plan.get("response_ready_in_minutes", -1) >= 0, "incident readiness is invalid")
            expect(bool(plan.get("coverage_tradeoffs")), "incident coverage tradeoffs are missing")

        uncertain = self.post(
            "/v1/store-incident-response-plans",
            self.scoped(
                hazard_class="unknown",
                severity="medium",
                zone="unknown",
                customer_exposure="possible",
                access_impact="partially_blocked",
                confidence="low",
            ),
        )
        expect(
            uncertain.get("incident_policy", {}).get("response_priority") == "control_and_verify",
            "uncertain incident posture changed",
        )

        fire = self.post(
            "/v1/store-incident-response-plans",
            self.scoped(
                hazard_class="smoke_or_fire",
                severity="critical",
                zone="stockroom",
                customer_exposure="possible",
                access_impact="blocked",
                confidence="medium",
            ),
        )
        expect(
            fire.get("incident_policy", {}).get("response_priority") == "life_safety_first",
            "critical incident posture changed",
        )
        expect(
            any("emergency services" in condition for condition in fire.get("incident_policy", {}).get("escalation_conditions", [])),
            "critical incident escalation conditions changed",
        )

        invalid = self.post(
            "/v1/store-incident-response-plans",
            self.scoped(
                hazard_class="made_up_hazard",
                severity="medium",
                zone="checkout",
                customer_exposure="none",
                access_impact="clear",
                confidence="high",
            ),
            expected_status=400,
        )
        expect(invalid.get("error") == "invalid_request", "incident enum validation changed")
        serialized = json.dumps(spill)
        expect("image_url" not in serialized and "data:image" not in serialized, "incident response leaked image content")
        print("PASS image-bounded incident planning, associate constraints, judgment inputs, and safety postures")

    def cleanup(self) -> None:
        cleanup_requests = (
            ("/v1/demo/events", self.scoped(operation="reset")),
            ("/v1/demo/checkout-events", self.scoped(operation="reset")),
            ("/v1/demo/store-day", self.scoped(operation="reset")),
        )
        for path, payload in cleanup_requests:
            try:
                self.post(path, payload)
            except Exception as error:  # Cleanup must not hide the original regression.
                print(f"Warning: cleanup failed for {path}: {error}", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run deterministic Store Manager Camel contract regressions against a disposable private service."
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:18080")
    parser.add_argument("--store-id", default="SEA-014")
    parser.add_argument("--business-date", default="2026-08-03")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        expect(STORE_ID_PATTERN.fullmatch(args.store_id) is not None, "store ID format is invalid")
        expect(date.fromisoformat(args.business_date).isoformat() == args.business_date, "business date must use YYYY-MM-DD")
        suite = ContractSuite(StoreManagerClient(args.base_url), args.store_id, args.business_date)
        try:
            suite.run()
        finally:
            suite.cleanup()
    except (ContractFailure, ValueError, KeyError, TypeError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        return 1

    print("All deterministic Store Manager Camel contract regressions passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
