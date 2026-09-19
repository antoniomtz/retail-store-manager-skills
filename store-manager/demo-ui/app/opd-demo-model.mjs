const MAX_VISIBLE_BACKLOG_UNITS = 18;
const ITEMS_PER_BACKLOG_UNIT = 60;
export const OPD_ARTWORK_PICKERS = 2;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function integer(value, fallback = 0) {
  return Math.max(0, Math.round(number(value, fallback)));
}

export function opdPickerVisualCounts(currentPickers, assignedAssociates = 0) {
  const reported = integer(currentPickers);
  const artwork = Math.min(OPD_ARTWORK_PICKERS, reported);
  const assigned = Math.min(integer(assignedAssociates), Math.max(0, reported - artwork));
  const supplemental = Math.max(0, reported - artwork - assigned);
  return {
    reported,
    artwork,
    supplemental,
    assigned,
    represented: artwork + supplemental + assigned,
  };
}

function projectPlan(value, recommendedPlanId) {
  const plan = record(value);
  const planId = text(plan.plan_id);
  if (!planId) return null;

  return {
    planId,
    title: text(plan.title) || "OPD recovery option",
    action: text(plan.action) || "Apply the selected OPD recovery option.",
    recommended: planId === recommendedPlanId,
    sourceDepartment: text(plan.source_department),
    additionalAssociates: integer(plan.additional_associates),
    assignmentDurationMinutes: integer(plan.assignment_duration_minutes),
    incrementalPickRate: integer(plan.incremental_pick_rate_items_per_hour),
    projectionHorizonMinutes: integer(plan.projection_horizon_minutes),
    projectedPickRate: integer(plan.projected_pick_rate_items_per_hour),
    projectedBacklog: integer(plan.projected_queue_at_checkpoint_items),
    meetsCheckpoint: plan.meets_checkpoint === true,
    tradeoffs: list(plan.tradeoffs)
      .filter((item) => typeof item === "string" && item.trim())
      .slice(0, 3),
  };
}

function inferPhase(operatingStatus, decision, receipt, checkpoint) {
  const checkpointStatus = text(record(checkpoint).status);
  const checkpointStage = text(record(checkpoint).stage);
  if (checkpointStage === "final" && checkpointStatus === "met") return "recovered";
  if (checkpointStage === "final" && checkpointStatus === "missed") return "follow_up";
  if (checkpointStage === "progress" && checkpointStatus === "met") return "progress_on_track";
  if (checkpointStage === "progress" && checkpointStatus === "missed") return "progress_off_track";
  if (text(record(decision).status) === "pending_manager_approval") return "awaiting_approval";
  if (text(record(receipt).status) === "accepted") return "action_executed";
  if (["at_risk", "agent_planning", "awaiting_manager"].includes(operatingStatus)) return "hermes_analyzing";
  return "normal";
}

function projectEvent(value) {
  const event = record(value);
  const type = text(event.type);
  if (!type) return null;
  return {
    id: text(event.event_id),
    type,
    label: text(event.label),
    additionalItemsDue: integer(event.additional_items_due_in_window),
    additionalOrdersDue: integer(event.additional_orders_due_in_window),
    additionalBacklog: integer(event.additional_items_in_pick_queue),
    pickerReduction: integer(event.picker_reduction),
    pickRateReduction: integer(event.pick_rate_reduction_items_per_hour),
  };
}

export function projectOpdState(raw, options = {}) {
  const source = record(raw);
  const metrics = record(source.metrics);
  const recoveryContext = record(source.recovery_context);
  const decision = record(source.decision);
  const decisionAuthor = text(decision.decision_author);
  const managerMessageStatus = text(decision.manager_message_status);
  const agentDecision = decisionAuthor === "hermes" && managerMessageStatus === "ready" ? decision : {};
  const receipt = record(source.last_action_receipt);
  const appliedChange = record(receipt.applied_change);
  const checkpoint = record(source.checkpoint);
  const recommendedPlanId = text(agentDecision.recommended_plan_id);
  const backlog = integer(metrics.items_in_pick_queue);
  const checkpointMinimumRate = integer(checkpoint.minimum_pick_rate_items_per_hour);
  const checkpointMaximumBacklog = integer(checkpoint.maximum_remaining_pick_queue_items);
  const contextMinimumRate = integer(recoveryContext.minimum_pick_rate_items_per_hour);
  const contextMaximumBacklog = integer(recoveryContext.maximum_remaining_pick_queue_items);
  const operatingStatus = text(source.operating_status) || "unknown";

  return {
    connected: true,
    store: {
      id: text(source.store_id),
      name: text(record(source.store).store_name),
      businessDate: text(source.business_date),
    },
    stateVersion: integer(source.state_version),
    simulatedAt: text(source.simulated_at),
    operatingStatus,
    phase: inferPhase(operatingStatus, agentDecision, receipt, checkpoint),
    operations: {
      itemsDue: integer(metrics.items_due_in_window),
      ordersDue: integer(metrics.orders_due_in_window),
      backlog,
      backlogVisualUnits: Math.min(MAX_VISIBLE_BACKLOG_UNITS, Math.ceil(backlog / ITEMS_PER_BACKLOG_UNIT)),
      currentPickers: integer(metrics.current_pickers),
      currentPickRate: integer(metrics.current_pick_rate_items_per_hour),
      normalPickRate: integer(metrics.target_pick_rate_items_per_hour),
      recoveryMinimumPickRate: checkpointMinimumRate || contextMinimumRate,
      recoveryMaximumBacklog: checkpointMaximumBacklog || contextMaximumBacklog,
    },
    recoveryContext: {
      availableAssociates: integer(recoveryContext.available_cross_trained_associates),
      sourceDepartment: text(recoveryContext.source_department),
      assignmentDurationMinutes: integer(recoveryContext.assignment_duration_minutes),
      checkpointAfterMinutes: integer(recoveryContext.checkpoint_after_minutes, 30),
    },
    events: list(source.active_events).map(projectEvent).filter(Boolean),
    decision: text(agentDecision.decision_id) ? {
      id: text(agentDecision.decision_id),
      status: text(agentDecision.status),
      author: decisionAuthor,
      method: text(agentDecision.decision_method),
      managerMessageStatus: text(agentDecision.manager_message_status),
      managerMessageReadyAt: text(agentDecision.manager_message_ready_at),
      candidateSetId: text(agentDecision.candidate_set_id),
      recommendationReason: text(agentDecision.recommendation_reason),
      tradeoffSummary: text(agentDecision.tradeoff_summary),
      evaluatedCandidateCount: integer(agentDecision.evaluated_candidate_count),
      recommendedPlanId,
      basedOnStateVersion: integer(agentDecision.based_on_state_version),
      plans: list(agentDecision.feasible_plans)
        .map((plan) => projectPlan(plan, recommendedPlanId))
        .filter(Boolean),
    } : null,
    receipt: text(receipt.receipt_id) ? {
      id: text(receipt.receipt_id),
      status: text(receipt.status),
      planId: text(receipt.plan_id),
      externalSystem: text(receipt.external_system),
      associatesAssigned: integer(appliedChange.temporary_associates_assigned),
      incrementalPickRate: integer(appliedChange.incremental_pick_rate_items_per_hour),
      assignmentDurationMinutes: integer(appliedChange.assignment_duration_minutes),
      assignmentStatus: text(appliedChange.assignment_status) || "active",
    } : null,
    checkpoint: text(checkpoint.checkpoint_id) ? {
      id: text(checkpoint.checkpoint_id),
      stage: text(checkpoint.stage) || "progress",
      status: text(checkpoint.status),
      dueAt: text(checkpoint.due_at),
      targetMet: checkpoint.status === "met" ? true : checkpoint.status === "missed" ? false : null,
      afterMinutes: integer(checkpoint.after_minutes, integer(recoveryContext.checkpoint_after_minutes, 30)),
      elapsedAssignmentMinutes: integer(checkpoint.elapsed_assignment_minutes),
      nextMeasurementAfterMinutes: integer(
        checkpoint.next_measurement_after_minutes,
        integer(recoveryContext.checkpoint_after_minutes, 30),
      ),
      assignmentDurationMinutes: integer(
        checkpoint.assignment_duration_minutes,
        integer(recoveryContext.assignment_duration_minutes),
      ),
      measuredPickRate: integer(checkpoint.measured_pick_rate_items_per_hour),
      measuredBacklog: integer(checkpoint.measured_remaining_pick_queue_items),
      minimumPickRate: checkpointMinimumRate || contextMinimumRate,
      maximumBacklog: checkpointMaximumBacklog || contextMaximumBacklog,
      guidance: text(checkpoint.guidance),
    } : null,
    capabilities: { simulatedApproval: options.simulatedApproval === true },
  };
}

export function unavailableOpdState() {
  return {
    connected: false,
    store: { id: null, name: null, businessDate: null },
    stateVersion: 0,
    simulatedAt: null,
    operatingStatus: "unavailable",
    phase: "unavailable",
    operations: {
      itemsDue: 0,
      ordersDue: 0,
      backlog: 0,
      backlogVisualUnits: 0,
      currentPickers: 0,
      currentPickRate: 0,
      normalPickRate: 0,
      recoveryMinimumPickRate: 0,
      recoveryMaximumBacklog: 0,
    },
    recoveryContext: {
      availableAssociates: 0,
      sourceDepartment: null,
      assignmentDurationMinutes: 0,
      checkpointAfterMinutes: 30,
    },
    events: [],
    decision: null,
    receipt: null,
    checkpoint: null,
    capabilities: { simulatedApproval: false },
  };
}
