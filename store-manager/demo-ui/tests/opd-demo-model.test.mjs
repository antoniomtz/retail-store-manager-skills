import assert from "node:assert/strict";
import test from "node:test";

import {
  OPD_ARTWORK_PICKERS,
  opdPickerVisualCounts,
  projectOpdState,
  unavailableOpdState,
} from "../app/opd-demo-model.mjs";

function incidentState() {
  return {
    store_id: "SEA-014",
    business_date: "2026-08-03",
    simulated_at: "2026-08-03T06:00:00-07:00",
    state_version: 3,
    operating_status: "at_risk",
    store: { store_name: "Northgate Home & Living" },
    active_events: [
      {
        event_id: "OPD-EVT-AB12CD34-001",
        type: "demand_surge",
        label: "OPD demand surge",
        additional_items_due_in_window: 720,
        additional_orders_due_in_window: 42,
        additional_items_in_pick_queue: 640,
      },
      {
        event_id: "OPD-EVT-AB12CD34-002",
        type: "associate_callout",
        label: "OPD associate call-out",
        picker_reduction: 1,
        pick_rate_reduction_items_per_hour: 200,
      },
    ],
    metrics: {
      items_due_in_window: 1200,
      orders_due_in_window: 72,
      items_in_pick_queue: 940,
      current_pickers: 3,
      current_pick_rate_items_per_hour: 600,
      target_pick_rate_items_per_hour: 800,
    },
    recovery_context: {
      available_cross_trained_associates: 2,
      source_department: "Available cross-trained store associates",
      assignment_duration_minutes: 90,
      checkpoint_after_minutes: 30,
      minimum_pick_rate_items_per_hour: 900,
      maximum_remaining_pick_queue_items: 490,
    },
    monitor: { action: "request_recovery_plan", intervention_required: true },
  };
}

function hermesDecision() {
  return {
    decision_id: "OPD-DEC-AB12CD34-001",
    status: "pending_manager_approval",
    decision_author: "hermes",
    decision_method: "agent_reasoned_candidate_ranking",
    manager_message_status: "ready",
    manager_message_ready_at: "2026-08-03T06:00:00-07:00",
    candidate_set_id: "OPD-CAND-AB12CD34-001",
    based_on_state_version: 3,
    evaluated_candidate_count: 2,
    recommended_plan_id: "FLEX-2",
    recommendation_reason: "Two associates are required because the one-associate option remains below the pick-rate target and above the maximum backlog.",
    tradeoff_summary: "This uses both available cross-trained associates for the 90-minute recovery window.",
    feasible_plans: [
      {
        plan_id: "FLEX-2",
        title: "Add 2 associates to OPD picking",
        action: "Move 2 available cross-trained store associates to OPD picking.",
        source_department: "Available cross-trained store associates",
        additional_associates: 2,
        assignment_duration_minutes: 90,
        incremental_pick_rate_items_per_hour: 400,
        projection_horizon_minutes: 30,
        projected_pick_rate_items_per_hour: 1000,
        projected_queue_at_checkpoint_items: 440,
        meets_checkpoint: true,
        tradeoffs: ["This uses every available cross-trained associate."],
      },
      {
        plan_id: "FLEX-1",
        title: "Add 1 associate to OPD picking",
        action: "Move 1 available cross-trained store associate to OPD picking.",
        source_department: "Available cross-trained store associates",
        additional_associates: 1,
        assignment_duration_minutes: 90,
        incremental_pick_rate_items_per_hour: 200,
        projection_horizon_minutes: 30,
        projected_pick_rate_items_per_hour: 800,
        projected_queue_at_checkpoint_items: 540,
        meets_checkpoint: false,
        tradeoffs: ["This keeps one associate available."],
      },
    ],
  };
}

test("projects the observed OPD surge and call-out while Hermes is analyzing", () => {
  const projected = projectOpdState(incidentState());
  assert.equal(projected.phase, "hermes_analyzing");
  assert.equal(projected.operations.backlog, 940);
  assert.equal(projected.operations.backlogVisualUnits, 16);
  assert.equal(projected.operations.currentPickRate, 600);
  assert.equal(projected.operations.normalPickRate, 800);
  assert.equal(projected.operations.recoveryMinimumPickRate, 900);
  assert.equal(projected.operations.recoveryMaximumBacklog, 490);
  assert.equal(projected.events[0].additionalOrdersDue, 42);
  assert.equal(projected.events[1].pickerReduction, 1);
  assert.equal(projected.decision, null);
});

test("reconciles the room artwork and rendered associates to the reported picker count", () => {
  assert.equal(OPD_ARTWORK_PICKERS, 2);
  assert.deepEqual(opdPickerVisualCounts(4), {
    reported: 4,
    artwork: 2,
    supplemental: 2,
    assigned: 0,
    represented: 4,
  });
  assert.deepEqual(opdPickerVisualCounts(3), {
    reported: 3,
    artwork: 2,
    supplemental: 1,
    assigned: 0,
    represented: 3,
  });
  assert.deepEqual(opdPickerVisualCounts(5, 2), {
    reported: 5,
    artwork: 2,
    supplemental: 1,
    assigned: 2,
    represented: 5,
  });
});

test("exposes only a Hermes-authored OPD recommendation", () => {
  const source = { ...incidentState(), operating_status: "awaiting_manager", decision: hermesDecision() };
  const projected = projectOpdState(source, { simulatedApproval: true });
  assert.equal(projected.phase, "awaiting_approval");
  assert.equal(projected.capabilities.simulatedApproval, true);
  assert.equal(projected.decision.author, "hermes");
  assert.equal(projected.decision.managerMessageStatus, "ready");
  assert.equal(projected.decision.recommendedPlanId, "FLEX-2");
  assert.equal(projected.decision.plans[0].recommended, true);
  assert.equal(projected.decision.plans[0].meetsCheckpoint, true);
  assert.equal(projected.decision.plans[1].meetsCheckpoint, false);

  const untrusted = projectOpdState({ ...source, decision: { ...hermesDecision(), decision_author: "camel" } });
  assert.equal(untrusted.phase, "hermes_analyzing");
  assert.equal(untrusted.decision, null);
});

test("keeps OPD choices hidden until Hermes finishes the manager response", () => {
  const source = {
    ...incidentState(),
    operating_status: "awaiting_manager",
    decision: {
      ...hermesDecision(),
      manager_message_status: "preparing",
      manager_message_ready_at: null,
    },
  };
  const projected = projectOpdState(source, { simulatedApproval: true });
  assert.equal(projected.phase, "hermes_analyzing");
  assert.equal(projected.decision, null);
});

test("keeps current OPD conditions distinct from projected and measured recovery", () => {
  const source = {
    ...incidentState(),
    operating_status: "recovering",
    metrics: {
      ...incidentState().metrics,
      current_pickers: 5,
      current_pick_rate_items_per_hour: 1000,
    },
    decision: { ...hermesDecision(), status: "approved_and_executed", selected_plan_id: "FLEX-2" },
    last_action_receipt: {
      receipt_id: "OPD-ACT-AB12CD34-001",
      status: "accepted",
      plan_id: "FLEX-2",
      external_system: "Simulated workforce management system",
      applied_change: {
        temporary_associates_assigned: 2,
        incremental_pick_rate_items_per_hour: 400,
        assignment_duration_minutes: 90,
        assignment_status: "active",
      },
    },
    checkpoint: {
      checkpoint_id: "OPD-CHK-AB12CD34-001",
      stage: "progress",
      status: "scheduled",
      due_at: "2026-08-03T06:30:00-07:00",
      after_minutes: 30,
      elapsed_assignment_minutes: 0,
      next_measurement_after_minutes: 30,
      assignment_duration_minutes: 90,
      minimum_pick_rate_items_per_hour: 900,
      maximum_remaining_pick_queue_items: 490,
    },
  };
  const action = projectOpdState(source);
  assert.equal(action.phase, "action_executed");
  assert.equal(action.operations.backlog, 940);
  assert.equal(action.receipt.associatesAssigned, 2);
  assert.equal(action.receipt.assignmentStatus, "active");
  assert.equal(action.decision.plans[0].projectedBacklog, 440);

  const progress = projectOpdState({
    ...source,
    operating_status: "recovering_on_track",
    metrics: { ...source.metrics, items_in_pick_queue: 440 },
    checkpoint: {
      ...source.checkpoint,
      status: "met",
      elapsed_assignment_minutes: 30,
      next_measurement_after_minutes: 60,
      measured_pick_rate_items_per_hour: 1000,
      measured_remaining_pick_queue_items: 440,
    },
  });
  assert.equal(progress.phase, "progress_on_track");
  assert.equal(progress.checkpoint.stage, "progress");
  assert.equal(progress.checkpoint.nextMeasurementAfterMinutes, 60);
  assert.equal(progress.checkpoint.targetMet, true);

  const recovered = projectOpdState({
    ...source,
    operating_status: "recovered",
    metrics: {
      ...source.metrics,
      items_in_pick_queue: 0,
      current_pickers: 3,
      current_pick_rate_items_per_hour: 600,
    },
    last_action_receipt: {
      ...source.last_action_receipt,
      applied_change: {
        ...source.last_action_receipt.applied_change,
        assignment_status: "completed",
      },
    },
    checkpoint: {
      ...source.checkpoint,
      checkpoint_id: "OPD-CHK-AB12CD34-002",
      stage: "final",
      status: "met",
      after_minutes: 90,
      elapsed_assignment_minutes: 90,
      next_measurement_after_minutes: 0,
      measured_pick_rate_items_per_hour: 1000,
      measured_remaining_pick_queue_items: 0,
    },
  });
  assert.equal(recovered.phase, "recovered");
  assert.equal(recovered.receipt.assignmentStatus, "completed");
  assert.equal(recovered.checkpoint.stage, "final");
  assert.equal(recovered.checkpoint.targetMet, true);
  assert.equal(recovered.checkpoint.measuredBacklog, 0);
});

test("returns a bounded unavailable OPD contract", () => {
  const unavailable = unavailableOpdState();
  assert.equal(unavailable.connected, false);
  assert.equal(unavailable.phase, "unavailable");
  assert.equal(unavailable.operations.backlogVisualUnits, 0);
  assert.deepEqual(unavailable.events, []);
});
