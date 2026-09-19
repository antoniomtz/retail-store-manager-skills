const MAX_VISIBLE_CUSTOMERS = 12;

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

function projectPlan(value, recommendedPlanId) {
  const plan = record(value);
  const planId = text(plan.plan_id);
  if (!planId) return null;

  return {
    planId,
    title: text(plan.title) || "Checkout recovery option",
    action: text(plan.action) || "Apply the selected checkout recovery option.",
    recommended: planId === recommendedPlanId,
    registersToOpen: integer(plan.registers_to_open),
    selfCheckoutHostsToReposition: integer(plan.self_checkout_hosts_to_reposition),
    associatesReassigned: integer(plan.associates_reassigned),
    assignmentDurationMinutes: integer(plan.assignment_duration_minutes),
    projectedPeopleInQueue: integer(plan.projected_people_in_queue_at_checkpoint),
    projectedWaitMinutes: number(plan.projected_wait_minutes_at_checkpoint),
    tradeoffs: list(plan.tradeoffs).filter((item) => typeof item === "string" && item.trim()).slice(0, 3),
  };
}

function inferPhase(operatingStatus, decision, receipt, checkpoint) {
  const checkpointStatus = text(record(checkpoint).status);
  if (checkpointStatus === "met" || checkpointStatus === "measured" && record(checkpoint).target_met === true) return "recovered";
  if (checkpointStatus === "missed" || checkpointStatus === "measured") return "follow_up";
  if (text(record(decision).status) === "pending_manager_approval") return "awaiting_approval";
  if (text(record(receipt).status) === "accepted") return "action_executed";
  if (["at_risk", "agent_planning"].includes(operatingStatus)) return "hermes_analyzing";
  return "normal";
}

export function projectCheckoutState(raw, options = {}) {
  const source = record(raw);
  const metrics = record(source.metrics);
  const thresholds = record(source.thresholds);
  const decision = record(source.decision);
  const decisionAuthor = text(decision.decision_author);
  const agentDecision = decisionAuthor === "hermes" ? decision : {};
  const receipt = record(source.last_action_receipt);
  const checkpoint = record(source.checkpoint);
  const appliedChange = record(receipt.applied_change);
  const recommendedPlanId = text(decision.recommended_plan_id);
  const operatingStatus = text(source.operating_status) || "unknown";
  const peopleInQueue = integer(metrics.people_in_queue);

  return {
    connected: true,
    store: {
      id: text(source.store_id),
      name: text(record(source.store).store_name),
      businessDate: text(source.business_date),
      zone: text(source.zone_name),
    },
    stateVersion: integer(source.state_version),
    simulatedAt: text(source.simulated_at),
    operatingStatus,
    phase: inferPhase(operatingStatus, agentDecision, receipt, checkpoint),
    queue: {
      people: peopleInQueue,
      visiblePeople: Math.min(MAX_VISIBLE_CUSTOMERS, peopleInQueue),
      waitMinutes: number(metrics.estimated_wait_minutes),
      maximumPeople: integer(thresholds.maximum_people_in_queue),
      maximumWaitMinutes: number(thresholds.maximum_estimated_wait_minutes),
      activeStaffedLanes: integer(metrics.active_staffed_lanes),
      baselineStaffedLanes: integer(options.baselineStaffedLanes, 1),
      visionConfidence: number(metrics.vision_confidence),
    },
    event: list(source.active_events).map((item) => {
      const event = record(item);
      return {
        id: text(event.event_id),
        type: text(event.type),
        label: text(event.label),
      };
    }).find((item) => item.type === "queue_threshold_breach") || null,
    decision: text(decision.decision_id) && decisionAuthor === "hermes" ? {
      id: text(decision.decision_id),
      status: text(decision.status),
      author: decisionAuthor,
      method: text(decision.decision_method),
      candidateSetId: text(decision.candidate_set_id),
      recommendationReason: text(decision.recommendation_reason),
      tradeoffSummary: text(decision.tradeoff_summary),
      evaluatedCandidateCount: integer(decision.evaluated_candidate_count),
      recommendedPlanId,
      basedOnStateVersion: integer(decision.based_on_state_version),
      plans: list(decision.feasible_plans)
        .map((plan) => projectPlan(plan, recommendedPlanId))
        .filter(Boolean),
    } : null,
    receipt: text(receipt.receipt_id) ? {
      id: text(receipt.receipt_id),
      status: text(receipt.status),
      planId: text(receipt.plan_id),
      externalSystem: text(receipt.external_system),
      staffedRegistersOpened: integer(appliedChange.staffed_registers_opened),
      selfCheckoutHostsRepositioned: integer(appliedChange.self_checkout_hosts_repositioned),
      associatesReassigned: integer(appliedChange.associates_reassigned),
      assignmentDurationMinutes: integer(appliedChange.assignment_duration_minutes),
    } : null,
    checkpoint: text(checkpoint.checkpoint_id) ? {
      id: text(checkpoint.checkpoint_id),
      status: text(checkpoint.status),
      dueAt: text(checkpoint.due_at),
      targetMet: checkpoint.status === "met"
        ? true
        : checkpoint.status === "missed"
          ? false
          : typeof checkpoint.target_met === "boolean" ? checkpoint.target_met : null,
      afterMinutes: integer(checkpoint.after_minutes, 10),
    } : null,
    capabilities: {
      simulatedApproval: options.simulatedApproval === true,
    },
  };
}

export function unavailableCheckoutState() {
  return {
    connected: false,
    store: { id: null, name: null, businessDate: null, zone: null },
    stateVersion: 0,
    simulatedAt: null,
    operatingStatus: "unavailable",
    phase: "unavailable",
    queue: {
      people: 0,
      visiblePeople: 0,
      waitMinutes: 0,
      maximumPeople: 0,
      maximumWaitMinutes: 0,
      activeStaffedLanes: 0,
      baselineStaffedLanes: 1,
      visionConfidence: 0,
    },
    event: null,
    decision: null,
    receipt: null,
    checkpoint: null,
    capabilities: { simulatedApproval: false },
  };
}
