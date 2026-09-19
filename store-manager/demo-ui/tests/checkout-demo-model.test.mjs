import assert from "node:assert/strict";
import test from "node:test";

import {
  projectCheckoutState,
  unavailableCheckoutState,
} from "../app/checkout-demo-model.mjs";
import { stableJson } from "../app/stable-json.mjs";

function state(overrides = {}) {
  return {
    store_id: "SEA-014",
    business_date: "2026-08-03",
    state_version: 2,
    simulated_at: "2026-08-03T16:00:00-07:00",
    operating_status: "at_risk",
    store: { store_name: "Northgate Home & Living" },
    zone_name: "Main checkout area",
    active_events: [{ event_id: "CHECKOUT-QUEUE-001", type: "queue_threshold_breach", label: "Checkout line is longer than the store's limit" }],
    metrics: {
      people_in_queue: 12,
      estimated_wait_minutes: 8.4,
      active_staffed_lanes: 1,
      vision_confidence: 0.97,
    },
    thresholds: { maximum_people_in_queue: 6, maximum_estimated_wait_minutes: 5 },
    ...overrides,
  };
}

test("projects the Camel queue surge while Hermes is analyzing", () => {
  const projected = projectCheckoutState(state({
    operating_status: "agent_planning",
    planning: {
      candidate_set_id: "CHK-CAND-AB12CD34-001",
      status: "awaiting_agent_recommendation",
      agent_decision_pending: true,
    },
  }), { simulatedApproval: true });
  assert.equal(projected.connected, true);
  assert.equal(projected.phase, "hermes_analyzing");
  assert.equal(projected.decision, null);
  assert.equal(projected.queue.people, 12);
  assert.equal(projected.queue.visiblePeople, 12);
  assert.equal(projected.queue.waitMinutes, 8.4);
  assert.equal(projected.event.type, "queue_threshold_breach");
  assert.equal(projected.capabilities.simulatedApproval, true);
});

test("projects only the decision that Camel says is pending", () => {
  const projected = projectCheckoutState(state({
    operating_status: "awaiting_manager",
    decision: {
      decision_id: "CHK-DEC-AB12CD34-001",
      status: "pending_manager_approval",
      candidate_set_id: "CHK-CAND-AB12CD34-001",
      decision_author: "hermes",
      decision_method: "agent_reasoned_candidate_ranking",
      recommendation_reason: "This option restores both queue targets while preserving the protected online-order recovery assignment.",
      tradeoff_summary: "Outdoor replenishment pauses for twenty minutes.",
      evaluated_candidate_count: 2,
      based_on_state_version: 2,
      recommended_plan_id: "OPEN-REG-1",
      feasible_plans: [{
        plan_id: "OPEN-REG-1",
        title: "Open staffed register 6",
        action: "Move one trained associate to staffed register 6.",
        associates_reassigned: 1,
        registers_to_open: 1,
        self_checkout_hosts_to_reposition: 0,
        assignment_duration_minutes: 20,
        projected_people_in_queue_at_checkpoint: 5,
        projected_wait_minutes_at_checkpoint: 3.6,
        tradeoffs: ["Restocking pauses briefly."],
      }],
    },
  }));
  assert.equal(projected.phase, "awaiting_approval");
  assert.equal(projected.decision.id, "CHK-DEC-AB12CD34-001");
  assert.equal(projected.decision.author, "hermes");
  assert.match(projected.decision.recommendationReason, /restores both queue targets/);
  assert.equal(projected.decision.plans[0].recommended, true);
  assert.equal(projected.decision.plans[0].registersToOpen, 1);
});

test("projects an accepted register action and measured recovery", () => {
  const action = projectCheckoutState(state({
    operating_status: "recovering",
    last_action_receipt: {
      receipt_id: "CHK-RCPT-001",
      status: "accepted",
      plan_id: "OPEN-REG-1",
      external_system: "Simulated store staffing system",
      applied_change: {
        staffed_registers_opened: 1,
        self_checkout_hosts_repositioned: 0,
        associates_reassigned: 1,
        assignment_duration_minutes: 20,
      },
    },
    checkpoint: { checkpoint_id: "CHK-CP-001", status: "scheduled", after_minutes: 10 },
    metrics: { people_in_queue: 12, estimated_wait_minutes: 8.4, active_staffed_lanes: 2 },
  }));
  assert.equal(action.phase, "action_executed");
  assert.equal(action.receipt.staffedRegistersOpened, 1);
  assert.equal(action.queue.activeStaffedLanes, 2);

  const recovered = projectCheckoutState(state({
    operating_status: "recovered",
    checkpoint: { checkpoint_id: "CHK-CP-001", status: "met", after_minutes: 10 },
    metrics: { people_in_queue: 5, estimated_wait_minutes: 3.6, active_staffed_lanes: 2 },
  }));
  assert.equal(recovered.phase, "recovered");
  assert.equal(recovered.queue.people, 5);
});

test("uses canonical JSON for webhook signatures and a bounded unavailable contract", () => {
  assert.equal(stableJson({ z: 2, a: { y: 1, x: [3, 2] } }), '{"a":{"x":[3,2],"y":1},"z":2}');
  assert.throws(() => stableJson(undefined), /does not support undefined/);
  assert.deepEqual(unavailableCheckoutState().queue.visiblePeople, 0);
});
