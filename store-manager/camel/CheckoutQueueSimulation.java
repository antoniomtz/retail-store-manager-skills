import java.io.IOException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

final class CheckoutQueueSimulation {
    private final StoreDataRepository data;
    private final ObjectMapper json;
    private ObjectNode state;
    private ObjectNode pendingCandidateSet;
    private ObjectNode pendingDecision;
    private ObjectNode lastActionReceipt;
    private ObjectNode checkpoint;
    private ObjectNode activePlan;
    private final Map<String, ObjectNode> idempotentResponses = new LinkedHashMap<>();
    private int stateVersion;
    private int eventSequence;
    private int candidateSequence;
    private int decisionSequence;
    private int receiptSequence;
    private String simulationRunId;

    CheckoutQueueSimulation(StoreDataRepository data) {
        this.data = data;
        this.json = data.mapper();
        try {
            reset();
        } catch (IOException exception) {
            throw new IllegalStateException("synthetic checkout fixture is unavailable", exception);
        }
    }

    synchronized ObjectNode status(String storeId, String businessDate)
        throws IOException, SimulationException {
        validateIdentity(storeId, businessDate);
        return statusResponse();
    }

    synchronized ObjectNode event(ObjectNode request)
        throws IOException, SimulationException {
        String operation = requiredText(request, "operation");
        if ("reset".equals(operation)) {
            reset();
            ObjectNode response = json.createObjectNode();
            response.put("event_result", "reset");
            response.set("operating_state", statusResponse());
            return response;
        }

        validateIdentity(request.path("store_id").asText(null), request.path("business_date").asText(null));
        return switch (operation) {
            case "queue_surge" -> injectQueueSurge();
            case "advance_time" -> advanceTime(requiredPositiveInt(request, "minutes"));
            default -> throw new SimulationException(
                400,
                "invalid_request",
                "operation must be reset, queue_surge, or advance_time"
            );
        };
    }

    synchronized ObjectNode plan(ObjectNode request)
        throws IOException, SimulationException {
        validateIdentity(request.path("store_id").asText(null), request.path("business_date").asText(null));
        if (!interventionRequired()) {
            throw new SimulationException(409, "no_intervention_required", "the checkout queue is within plan");
        }

        if (request.has("decision_id") || request.has("manager_constraints")) {
            return replan(request);
        }
        if (pendingDecision != null) {
            ObjectNode response = json.createObjectNode();
            response.put("new_candidate_set", false);
            response.put("decision_exists", true);
            response.set("decision", pendingDecision.deepCopy());
            response.set("operating_state", statusResponse());
            return response;
        }
        if (pendingCandidateSet != null) {
            ObjectNode response = json.createObjectNode();
            response.put("new_candidate_set", false);
            response.put("replanned", pendingCandidateSet.has("supersedes_decision_id"));
            response.set("candidate_set", pendingCandidateSet.deepCopy());
            response.set("operating_state", statusResponse());
            return response;
        }

        ObjectNode candidateSet = createCandidateSet(json.createObjectNode(), null);
        ObjectNode response = json.createObjectNode();
        response.put("new_candidate_set", true);
        response.put("replanned", false);
        response.set("candidate_set", candidateSet.deepCopy());
        response.set("operating_state", statusResponse());
        return response;
    }

    private ObjectNode replan(ObjectNode request) throws IOException, SimulationException {
        String idempotencyKey = requiredText(request, "idempotency_key");
        ObjectNode previous = idempotentResponses.get(idempotencyKey);
        if (previous != null) {
            return previous.deepCopy();
        }
        if (pendingDecision == null
            || !"pending_manager_approval".equals(pendingDecision.path("status").asText())) {
            throw new SimulationException(409, "decision_not_found", "there is no checkout decision available to replan");
        }
        String decisionId = requiredText(request, "decision_id");
        if (!decisionId.equals(pendingDecision.path("decision_id").asText())) {
            throw new SimulationException(404, "decision_not_found", "the checkout decision_id was not found");
        }
        int expectedVersion = requiredPositiveInt(request, "expected_state_version");
        if (expectedVersion != stateVersion
            || expectedVersion != pendingDecision.path("based_on_state_version").asInt()) {
            throw new SimulationException(409, "stale_decision", "checkout state changed after this decision was created");
        }
        JsonNode constraintsNode = request.path("manager_constraints");
        if (!constraintsNode.isObject() || constraintsNode.isEmpty()) {
            throw new SimulationException(400, "invalid_request", "manager_constraints must be a non-empty object");
        }
        ObjectNode managerConstraints = validateManagerConstraints((ObjectNode) constraintsNode);
        ObjectNode candidateSet = createCandidateSet(managerConstraints, decisionId);
        pendingDecision.put("status", "superseded_pending_agent_recommendation");
        pendingDecision.put("superseded_by_candidate_set_id", candidateSet.path("candidate_set_id").asText());

        ObjectNode response = json.createObjectNode();
        response.put("new_candidate_set", true);
        response.put("replanned", true);
        response.put("previous_decision_id", decisionId);
        response.set("candidate_set", candidateSet.deepCopy());
        response.set("operating_state", statusResponse());
        remember(idempotencyKey, response);
        return response;
    }

    private ObjectNode createCandidateSet(ObjectNode managerConstraints, String supersededDecisionId)
        throws IOException, SimulationException {
        ObjectNode effectiveConstraints = effectiveConstraints(managerConstraints);
        ObjectNode candidateSet = json.createObjectNode();
        candidateSet.put(
            "candidate_set_id",
            String.format("CHK-CAND-%s-%03d", simulationRunId, ++candidateSequence)
        );
        candidateSet.put("status", "awaiting_agent_recommendation");
        candidateSet.put("created_at", state.path("simulated_at").asText());
        candidateSet.put("based_on_state_version", stateVersion);
        if (supersededDecisionId != null) {
            candidateSet.put("supersedes_decision_id", supersededDecisionId);
        }
        ArrayNode triggerEvents = candidateSet.putArray("trigger_event_ids");
        state.path("active_events").forEach(event -> triggerEvents.add(event.path("event_id").asText()));
        candidateSet.set("manager_constraints", managerConstraints.deepCopy());
        candidateSet.set("effective_constraints", effectiveConstraints.deepCopy());

        ArrayNode candidatePlans = candidateSet.putArray("candidate_plans");
        ArrayNode blockedOptions = candidateSet.putArray("blocked_options");
        for (JsonNode option : checkoutSource().path("simulation").path("recovery_options")) {
            ArrayNode blockedReasons = blockedReasons(option, effectiveConstraints);
            if (!blockedReasons.isEmpty()) {
                ObjectNode blocked = json.createObjectNode();
                blocked.put("plan_id", option.path("plan_id").asText());
                blocked.put("action", option.path("action").asText());
                blocked.set("blocked_reasons", blockedReasons);
                blockedOptions.add(blocked);
                continue;
            }
            candidatePlans.add(feasiblePlan(option, effectiveConstraints));
        }
        if (candidatePlans.isEmpty()) {
            throw new SimulationException(
                409,
                "no_feasible_plan",
                "the confirmed manager constraints leave no feasible checkout recovery plan"
            );
        }

        ObjectNode requirements = candidateSet.putObject("decision_requirements");
        requirements.put("recommendation_required", true);
        requirements.put("maximum_presented_plans", 2);
        requirements.put("recommendation_reason_max_characters", 500);
        requirements.put("tradeoff_summary_max_characters", 300);
        pendingCandidateSet = candidateSet;
        return pendingCandidateSet;
    }

    private ObjectNode validateManagerConstraints(ObjectNode constraints)
        throws IOException, SimulationException {
        var fields = constraints.fieldNames();
        while (fields.hasNext()) {
            String field = fields.next();
            if (!("protected_departments".equals(field)
                || "target_wait_minutes".equals(field)
                || "max_associates_reassigned".equals(field)
                || "max_assignment_minutes".equals(field)
                || "preferred_action_type".equals(field))) {
                throw new SimulationException(400, "invalid_constraint", "unsupported manager constraint: " + field);
            }
        }

        ObjectNode schema = instructionSchema();
        ObjectNode normalized = json.createObjectNode();
        if (constraints.has("protected_departments")) {
            JsonNode departments = constraints.path("protected_departments");
            if (!departments.isArray() || departments.isEmpty() || departments.size() > 3) {
                throw new SimulationException(400, "invalid_constraint", "protected_departments must contain one to three departments");
            }
            ArrayNode normalizedDepartments = normalized.putArray("protected_departments");
            for (JsonNode departmentNode : departments) {
                String department = departmentNode.asText(null);
                if (department == null || !knownDepartment(department)) {
                    throw new SimulationException(400, "invalid_constraint", "a protected department is not available in this store context");
                }
                if (!containsText(normalizedDepartments, department)) {
                    normalizedDepartments.add(department);
                }
            }
        }
        if (constraints.has("target_wait_minutes")) {
            JsonNode value = constraints.path("target_wait_minutes");
            double minimum = schema.path("minimum_target_wait_minutes").asDouble();
            double maximum = schema.path("maximum_target_wait_minutes").asDouble();
            if (!value.isNumber() || value.asDouble() < minimum || value.asDouble() > maximum) {
                throw new SimulationException(400, "invalid_constraint", "target_wait_minutes is outside the allowed range");
            }
            normalized.put("target_wait_minutes", value.asDouble());
        }
        if (constraints.has("max_associates_reassigned")) {
            JsonNode value = constraints.path("max_associates_reassigned");
            int maximum = schema.path("maximum_associates_reassigned").asInt();
            if (!value.canConvertToInt() || value.asInt() < 0 || value.asInt() > maximum) {
                throw new SimulationException(400, "invalid_constraint", "max_associates_reassigned is outside the allowed range");
            }
            normalized.put("max_associates_reassigned", value.asInt());
        }
        if (constraints.has("max_assignment_minutes")) {
            JsonNode value = constraints.path("max_assignment_minutes");
            int minimum = schema.path("minimum_assignment_minutes").asInt();
            int maximum = schema.path("maximum_assignment_minutes").asInt();
            if (!value.canConvertToInt() || value.asInt() < minimum || value.asInt() > maximum) {
                throw new SimulationException(400, "invalid_constraint", "max_assignment_minutes is outside the allowed range");
            }
            normalized.put("max_assignment_minutes", value.asInt());
        }
        if (constraints.has("preferred_action_type")) {
            String preference = constraints.path("preferred_action_type").asText(null);
            if (preference == null
                || !containsText(schema.withArray("allowed_action_preferences"), preference)) {
                throw new SimulationException(400, "invalid_constraint", "preferred_action_type is unsupported");
            }
            normalized.put("preferred_action_type", preference);
        }
        return normalized;
    }

    private ObjectNode effectiveConstraints(ObjectNode managerConstraints) throws IOException {
        ObjectNode effective = checkoutSource().path("simulation")
            .path("default_manager_constraints").deepCopy();
        managerConstraints.fields().forEachRemaining(entry -> effective.set(entry.getKey(), entry.getValue().deepCopy()));
        if (!effective.has("protected_departments")) {
            effective.putArray("protected_departments");
        }
        return effective;
    }

    private ArrayNode blockedReasons(JsonNode option, ObjectNode constraints) throws IOException {
        ArrayNode reasons = json.createArrayNode();
        int associatesReassigned = option.path("associates_reassigned").asInt();
        if (associatesReassigned > constraints.path("max_associates_reassigned").asInt()) {
            reasons.add("This plan reassigns more associates than the manager allowed.");
        }
        for (JsonNode departmentNode : option.path("source_departments")) {
            if (containsText(constraints.withArray("protected_departments"), departmentNode.asText())) {
                reasons.add("The manager asked not to move anyone from the " + departmentNode.asText() + " department.");
            }
        }
        for (JsonNode associateNode : option.path("associate_references")) {
            JsonNode associate = workforceAssociate(associateNode.asText());
            if (associate == null) {
                reasons.add("The staffing system has no current record for a required associate.");
            } else if (associate.path("protected").asBoolean()) {
                String restrictionReason = associate.path("movement_restriction_reason").asText("");
                reasons.add(restrictionReason.isBlank()
                    ? "A required associate cannot be moved from their current assignment."
                    : restrictionReason);
            } else if (!"available".equals(associate.path("availability").asText())) {
                reasons.add("A required associate is currently busy and cannot be moved to checkout.");
            } else if (!associate.path("checkout_trained").asBoolean()) {
                reasons.add("A required associate has not completed checkout training.");
            } else if (!associate.path("minimum_coverage_preserved_if_redeployed").asBoolean()) {
                reasons.add("Moving this associate would leave their current department without enough coverage.");
            }
        }
        return reasons;
    }

    private ObjectNode feasiblePlan(JsonNode option, ObjectNode constraints) {
        ObjectNode plan = option.deepCopy();
        plan.put(
            "projection_horizon_minutes",
            checkoutSourceUnchecked().path("simulation").path("checkpoint").path("after_minutes").asInt()
        );
        int configuredDuration = plan.path("assignment_duration_minutes").asInt();
        int maxDuration = constraints.path("max_assignment_minutes").asInt();
        if (configuredDuration > maxDuration) {
            plan.put("assignment_duration_minutes", maxDuration);
            plan.withArray("tradeoffs").add(
                "The assignment will use the shorter time limit requested by the manager."
            );
        }
        double targetWait = constraints.path("target_wait_minutes").asDouble();
        int targetQueue = checkoutSourceUnchecked().path("simulation").path("thresholds")
            .path("maximum_people_in_queue").asInt();
        plan.put("target_wait_minutes", targetWait);
        plan.put("target_people_in_queue", targetQueue);
        boolean meetsTarget = plan.path("projected_wait_minutes_at_checkpoint").asDouble() <= targetWait
            && plan.path("projected_people_in_queue_at_checkpoint").asInt() <= targetQueue;
        plan.put("meets_target", meetsTarget);
        if (!meetsTarget) {
            plan.withArray("tradeoffs").add(
                "Based on the supplied forecast, this plan is not expected to bring both the queue and wait time within the manager's targets by the checkpoint."
            );
        }
        return plan;
    }

    synchronized ObjectNode commitDecision(ObjectNode request)
        throws IOException, SimulationException {
        validateIdentity(request.path("store_id").asText(null), request.path("business_date").asText(null));
        String idempotencyKey = requiredText(request, "idempotency_key");
        ObjectNode previous = idempotentResponses.get(idempotencyKey);
        if (previous != null) {
            return previous.deepCopy();
        }
        if (pendingCandidateSet == null) {
            throw new SimulationException(
                409,
                "candidate_set_not_found",
                "there is no checkout candidate set awaiting an agent recommendation"
            );
        }
        String candidateSetId = requiredText(request, "candidate_set_id");
        if (!candidateSetId.equals(pendingCandidateSet.path("candidate_set_id").asText())) {
            throw new SimulationException(404, "candidate_set_not_found", "the checkout candidate_set_id was not found");
        }
        int expectedVersion = requiredPositiveInt(request, "expected_state_version");
        if (expectedVersion != stateVersion
            || expectedVersion != pendingCandidateSet.path("based_on_state_version").asInt()) {
            throw new SimulationException(409, "stale_candidate_set", "checkout state changed after these candidates were created");
        }

        String recommendedPlanId = requiredText(request, "recommended_plan_id");
        ObjectNode recommendedPlan = findCandidatePlan(recommendedPlanId);
        JsonNode alternateIds = request.path("alternate_plan_ids");
        if (!alternateIds.isArray() || alternateIds.size() > 1) {
            throw new SimulationException(400, "invalid_request", "alternate_plan_ids must be an array with at most one plan ID");
        }
        int candidateCount = pendingCandidateSet.path("candidate_plans").size();
        if (candidateCount > 1 && alternateIds.size() != 1) {
            throw new SimulationException(400, "invalid_request", "one alternate plan is required when multiple candidates are available");
        }
        if (candidateCount == 1 && !alternateIds.isEmpty()) {
            throw new SimulationException(400, "invalid_request", "an alternate plan is unavailable for this candidate set");
        }
        ObjectNode alternatePlan = null;
        if (!alternateIds.isEmpty()) {
            String alternatePlanId = alternateIds.path(0).asText(null);
            if (alternatePlanId == null || alternatePlanId.equals(recommendedPlanId)) {
                throw new SimulationException(400, "invalid_request", "the alternate plan must differ from the recommendation");
            }
            alternatePlan = findCandidatePlan(alternatePlanId);
        }

        String recommendationReason = boundedAgentText(request, "recommendation_reason", 40, 500);
        String tradeoffSummary = boundedAgentText(request, "tradeoff_summary", 20, 300);
        ObjectNode nextDecision = json.createObjectNode();
        nextDecision.put(
            "decision_id",
            String.format("CHK-DEC-%s-%03d", simulationRunId, ++decisionSequence)
        );
        nextDecision.put("status", "pending_manager_approval");
        nextDecision.put("created_at", state.path("simulated_at").asText());
        nextDecision.put("based_on_state_version", stateVersion);
        nextDecision.put("candidate_set_id", candidateSetId);
        nextDecision.put("decision_author", "hermes");
        nextDecision.put("decision_method", "agent_reasoned_candidate_ranking");
        nextDecision.put("evaluated_candidate_count", candidateCount);
        nextDecision.put("recommended_plan_id", recommendedPlanId);
        nextDecision.put("recommendation_reason", recommendationReason);
        nextDecision.put("tradeoff_summary", tradeoffSummary);
        if (pendingCandidateSet.has("supersedes_decision_id")) {
            nextDecision.put(
                "supersedes_decision_id",
                pendingCandidateSet.path("supersedes_decision_id").asText()
            );
        }
        nextDecision.set("trigger_event_ids", pendingCandidateSet.path("trigger_event_ids").deepCopy());
        nextDecision.set("manager_constraints", pendingCandidateSet.path("manager_constraints").deepCopy());
        nextDecision.set("effective_constraints", pendingCandidateSet.path("effective_constraints").deepCopy());
        nextDecision.set("blocked_options", pendingCandidateSet.path("blocked_options").deepCopy());
        ArrayNode presentedPlans = nextDecision.putArray("feasible_plans");
        presentedPlans.add(recommendedPlan);
        if (alternatePlan != null) {
            presentedPlans.add(alternatePlan);
        }

        pendingDecision = nextDecision;
        pendingCandidateSet = null;
        ObjectNode response = json.createObjectNode();
        response.put("new_decision", true);
        response.set("decision", pendingDecision.deepCopy());
        response.set("operating_state", statusResponse());
        remember(idempotencyKey, response);
        return response;
    }

    private ObjectNode findCandidatePlan(String planId) throws SimulationException {
        for (JsonNode plan : pendingCandidateSet.path("candidate_plans")) {
            if (planId.equals(plan.path("plan_id").asText())) {
                return plan.deepCopy();
            }
        }
        throw new SimulationException(400, "invalid_plan", "the selected checkout plan_id is not in the current candidate set");
    }

    private String boundedAgentText(ObjectNode request, String field, int minimum, int maximum)
        throws SimulationException {
        String value = requiredText(request, field).trim();
        if (value.length() < minimum || value.length() > maximum) {
            throw new SimulationException(
                400,
                "invalid_request",
                field + " must contain between " + minimum + " and " + maximum + " characters"
            );
        }
        for (int index = 0; index < value.length(); index++) {
            if (Character.isISOControl(value.charAt(index))) {
                throw new SimulationException(400, "invalid_request", field + " must be one line of plain text");
            }
        }
        return value;
    }

    synchronized ObjectNode decide(ObjectNode request)
        throws IOException, SimulationException {
        validateIdentity(request.path("store_id").asText(null), request.path("business_date").asText(null));
        String disposition = requiredText(request, "disposition");
        String idempotencyKey = requiredText(request, "idempotency_key");
        ObjectNode previous = idempotentResponses.get(idempotencyKey);
        if (previous != null) {
            return previous.deepCopy();
        }
        if ("acknowledge_checkpoint".equals(disposition)) {
            ObjectNode response = acknowledgeCheckpoint(request);
            remember(idempotencyKey, response);
            return response;
        }
        if (!("approve".equals(disposition) || "reject".equals(disposition))) {
            throw new SimulationException(400, "invalid_request", "disposition must be approve or reject");
        }
        if (pendingDecision == null) {
            throw new SimulationException(409, "decision_not_found", "there is no pending checkout decision");
        }
        String decisionId = requiredText(request, "decision_id");
        if (!decisionId.equals(pendingDecision.path("decision_id").asText())) {
            throw new SimulationException(404, "decision_not_found", "the checkout decision_id was not found");
        }
        if (!"pending_manager_approval".equals(pendingDecision.path("status").asText())) {
            throw new SimulationException(409, "decision_already_resolved", "the checkout decision is already resolved");
        }
        int expectedVersion = requiredPositiveInt(request, "expected_state_version");
        if (expectedVersion != stateVersion
            || expectedVersion != pendingDecision.path("based_on_state_version").asInt()) {
            throw new SimulationException(409, "stale_decision", "checkout state changed after this decision was created");
        }

        ObjectNode response = json.createObjectNode();
        if ("reject".equals(disposition)) {
            pendingDecision.put("status", "rejected");
            pendingDecision.put("resolved_at", state.path("simulated_at").asText());
            response.put("external_action_executed", false);
            response.set("decision", pendingDecision.deepCopy());
            response.set("operating_state", statusResponse());
            remember(idempotencyKey, response);
            return response;
        }

        String planId = request.path("plan_id").asText(pendingDecision.path("recommended_plan_id").asText());
        ObjectNode selectedPlan = findPlan(planId);
        state.put(
            "active_staffed_lanes",
            state.path("active_staffed_lanes").asInt() + selectedPlan.path("registers_to_open").asInt()
        );
        state.put(
            "current_throughput_customers_per_hour",
            state.path("current_throughput_customers_per_hour").asInt()
                + selectedPlan.path("incremental_throughput_customers_per_hour").asInt()
        );
        activePlan = selectedPlan.deepCopy();
        stateVersion++;
        pendingDecision.put("status", "approved_and_executed");
        pendingDecision.put("selected_plan_id", planId);
        pendingDecision.put("resolved_at", state.path("simulated_at").asText());

        JsonNode simulation = checkoutSource().path("simulation");
        int checkpointMinutes = simulation.path("checkpoint").path("after_minutes").asInt();
        checkpoint = json.createObjectNode();
        checkpoint.put(
            "checkpoint_id",
            String.format("CHK-CHK-%s-%03d", simulationRunId, receiptSequence + 1)
        );
        checkpoint.put("status", "scheduled");
        checkpoint.put(
            "due_at",
            OffsetDateTime.parse(state.path("simulated_at").asText()).plusMinutes(checkpointMinutes).toString()
        );
        checkpoint.put(
            "maximum_people_in_queue",
            simulation.path("thresholds").path("maximum_people_in_queue").asInt()
        );
        checkpoint.put(
            "maximum_estimated_wait_minutes",
            pendingDecision.path("effective_constraints").path("target_wait_minutes").asDouble()
        );
        checkpoint.put("reported", false);

        lastActionReceipt = json.createObjectNode();
        lastActionReceipt.put(
            "receipt_id",
            String.format("CHK-ACT-%s-%03d", simulationRunId, ++receiptSequence)
        );
        lastActionReceipt.put("external_system", simulation.path("external_system").asText());
        lastActionReceipt.put("status", "accepted");
        lastActionReceipt.put("accepted_at", state.path("simulated_at").asText());
        lastActionReceipt.put("decision_id", decisionId);
        lastActionReceipt.put("plan_id", planId);
        lastActionReceipt.put("state_version", stateVersion);
        ObjectNode appliedChange = lastActionReceipt.putObject("applied_change");
        appliedChange.set("associate_references", selectedPlan.path("associate_references").deepCopy());
        appliedChange.put("associates_reassigned", selectedPlan.path("associates_reassigned").asInt());
        appliedChange.put("staffed_registers_opened", selectedPlan.path("registers_to_open").asInt());
        appliedChange.put(
            "self_checkout_hosts_repositioned",
            selectedPlan.path("self_checkout_hosts_to_reposition").asInt()
        );
        appliedChange.put("assignment_duration_minutes", selectedPlan.path("assignment_duration_minutes").asInt());

        response.put("external_action_executed", true);
        response.set("decision", pendingDecision.deepCopy());
        response.set("action_receipt", lastActionReceipt.deepCopy());
        response.set("operating_state", statusResponse());
        remember(idempotencyKey, response);
        return response;
    }

    private void reset() throws IOException {
        JsonNode source = checkoutSource();
        JsonNode simulation = source.path("simulation");
        JsonNode baseline = simulation.path("baseline");
        state = json.createObjectNode();
        state.put("store_id", source.path("store_id").asText());
        state.put("business_date", source.path("business_date").asText());
        state.put("zone_id", simulation.path("zone_id").asText());
        state.put("simulated_at", simulation.path("simulated_at").asText());
        copyMetric(baseline, state, "people_in_queue");
        state.put("estimated_wait_minutes", baseline.path("estimated_wait_minutes").asDouble());
        copyMetric(baseline, state, "arrival_rate_customers_per_15_minutes");
        copyMetric(baseline, state, "current_throughput_customers_per_hour");
        copyMetric(baseline, state, "active_staffed_lanes");
        copyMetric(baseline, state, "active_self_checkout_stations");
        state.put("vision_confidence", baseline.path("vision_confidence").asDouble());
        state.putArray("active_events");
        pendingCandidateSet = null;
        pendingDecision = null;
        lastActionReceipt = null;
        checkpoint = null;
        activePlan = null;
        idempotentResponses.clear();
        stateVersion = 1;
        eventSequence = 0;
        candidateSequence = 0;
        decisionSequence = 0;
        receiptSequence = 0;
        simulationRunId = UUID.randomUUID().toString().substring(0, 8).toUpperCase();
    }

    private ObjectNode injectQueueSurge() throws IOException {
        if (hasEventType("queue_threshold_breach")) {
            return eventResponse("queue_surge_already_active");
        }
        JsonNode surge = checkoutSource().path("simulation").path("queue_surge");
        ObjectNode event = json.createObjectNode();
        event.put(
            "event_id",
            String.format("CHK-EVT-%s-%03d", simulationRunId, ++eventSequence)
        );
        event.put("type", "queue_threshold_breach");
        event.put("label", surge.path("label").asText());
        event.put("detected_at", state.path("simulated_at").asText());
        event.put("source", "Simulated checkout camera system");
        state.withArray("active_events").add(event);
        copyMetric(surge, state, "people_in_queue");
        state.put("estimated_wait_minutes", surge.path("estimated_wait_minutes").asDouble());
        copyMetric(surge, state, "arrival_rate_customers_per_15_minutes");
        state.put("vision_confidence", surge.path("vision_confidence").asDouble());
        operationalStateChanged();
        return eventResponse("queue_surge_injected");
    }

    private ObjectNode advanceTime(int minutes) throws IOException, SimulationException {
        if (minutes > 120) {
            throw new SimulationException(400, "invalid_request", "minutes must be between 1 and 120");
        }
        OffsetDateTime advanced = OffsetDateTime.parse(state.path("simulated_at").asText()).plusMinutes(minutes);
        state.put("simulated_at", advanced.toString());
        stateVersion++;

        if (checkpoint != null && activePlan != null
            && "scheduled".equals(checkpoint.path("status").asText())
            && !advanced.isBefore(OffsetDateTime.parse(checkpoint.path("due_at").asText()))) {
            state.put("people_in_queue", activePlan.path("projected_people_in_queue_at_checkpoint").asInt());
            state.put("estimated_wait_minutes", activePlan.path("projected_wait_minutes_at_checkpoint").asDouble());
            boolean met = state.path("people_in_queue").asInt() <= checkpoint.path("maximum_people_in_queue").asInt()
                && state.path("estimated_wait_minutes").asDouble()
                    <= checkpoint.path("maximum_estimated_wait_minutes").asDouble();
            checkpoint.put("status", met ? "met" : "missed");
            checkpoint.put("measured_at", advanced.toString());
            checkpoint.put("measured_people_in_queue", state.path("people_in_queue").asInt());
            checkpoint.put("measured_estimated_wait_minutes", state.path("estimated_wait_minutes").asDouble());
            checkpoint.put(
                "guidance",
                met
                    ? "If the line remains within target, return the associate to their previous work when the temporary assignment ends."
                    : "Keep the associate at checkout for now and ask the manager to review another plan."
            );
            checkpoint.put("reported", false);
        }
        ObjectNode response = json.createObjectNode();
        response.put("event_result", "time_advanced");
        response.put("minutes_advanced", minutes);
        response.set("operating_state", statusResponse());
        return response;
    }

    private ObjectNode acknowledgeCheckpoint(ObjectNode request)
        throws IOException, SimulationException {
        if (checkpoint == null || !("met".equals(checkpoint.path("status").asText())
            || "missed".equals(checkpoint.path("status").asText()))) {
            throw new SimulationException(409, "checkpoint_not_ready", "there is no measured checkout checkpoint");
        }
        String checkpointId = requiredText(request, "checkpoint_id");
        if (!checkpointId.equals(checkpoint.path("checkpoint_id").asText())) {
            throw new SimulationException(404, "checkpoint_not_found", "the checkout checkpoint_id was not found");
        }
        checkpoint.put("reported", true);
        ObjectNode response = json.createObjectNode();
        response.put("checkpoint_acknowledged", true);
        response.set("checkpoint", checkpoint.deepCopy());
        response.set("operating_state", statusResponse());
        return response;
    }

    private ObjectNode statusResponse() throws IOException {
        JsonNode simulation = checkoutSource().path("simulation");
        ObjectNode response = json.createObjectNode();
        response.put("contract_version", "0.2.0");
        response.put("store_id", state.path("store_id").asText());
        response.put("business_date", state.path("business_date").asText());
        response.put("zone_id", state.path("zone_id").asText());
        response.put("zone_name", simulation.path("zone_name").asText());
        response.put("simulated_at", state.path("simulated_at").asText());
        response.put("state_version", stateVersion);
        response.put("operating_status", operatingStatus());
        response.set("store", sourceFile("store.json").path("store").deepCopy());
        response.set("active_events", state.path("active_events").deepCopy());

        ObjectNode metrics = response.putObject("metrics");
        copyMetric(state, metrics, "people_in_queue");
        metrics.put("estimated_wait_minutes", state.path("estimated_wait_minutes").asDouble());
        copyMetric(state, metrics, "arrival_rate_customers_per_15_minutes");
        copyMetric(state, metrics, "current_throughput_customers_per_hour");
        copyMetric(state, metrics, "active_staffed_lanes");
        copyMetric(state, metrics, "active_self_checkout_stations");
        metrics.put("vision_confidence", state.path("vision_confidence").asDouble());

        response.set("thresholds", simulation.path("thresholds").deepCopy());
        response.set("forecast", simulation.path("forecast").deepCopy());
        response.set("hard_constraints", simulation.path("hard_constraints").deepCopy());
        response.set("workforce_context", simulation.path("workforce_context").deepCopy());
        response.set("instruction_schema", instructionSchema());
        ObjectNode monitor = response.putObject("monitor");
        monitor.put("action", monitorAction());
        monitor.put("intervention_required", interventionRequired());
        monitor.put("threshold_breached", thresholdBreached());
        if (pendingCandidateSet != null) {
            ObjectNode planning = response.putObject("planning");
            planning.put("candidate_set_id", pendingCandidateSet.path("candidate_set_id").asText());
            planning.put("status", pendingCandidateSet.path("status").asText());
            planning.put("based_on_state_version", pendingCandidateSet.path("based_on_state_version").asInt());
            planning.put("agent_decision_pending", true);
        }
        if (pendingDecision != null) {
            response.set("decision", pendingDecision.deepCopy());
        }
        if (lastActionReceipt != null) {
            response.set("last_action_receipt", lastActionReceipt.deepCopy());
        }
        if (checkpoint != null) {
            response.set("checkpoint", checkpoint.deepCopy());
        }
        return response;
    }

    private ObjectNode instructionSchema() throws IOException {
        ObjectNode schema = checkoutSource().path("simulation").path("instruction_schema").deepCopy();
        ArrayNode departments = schema.putArray("allowed_protected_departments");
        for (JsonNode associate : checkoutSource().path("simulation").path("workforce_context")) {
            String department = associate.path("department").asText();
            if (!containsText(departments, department)) {
                departments.add(department);
            }
        }
        schema.set("hard_constraints", checkoutSource().path("simulation").path("hard_constraints").deepCopy());
        return schema;
    }

    private ObjectNode findPlan(String planId) throws SimulationException {
        for (JsonNode plan : pendingDecision.path("feasible_plans")) {
            if (planId.equals(plan.path("plan_id").asText())) {
                return plan.deepCopy();
            }
        }
        throw new SimulationException(400, "invalid_plan", "the selected checkout plan_id is not feasible");
    }

    private JsonNode workforceAssociate(String associateReference) throws IOException {
        for (JsonNode associate : checkoutSource().path("simulation").path("workforce_context")) {
            if (associateReference.equals(associate.path("associate_reference").asText())) {
                return associate;
            }
        }
        return null;
    }

    private boolean knownDepartment(String department) throws IOException {
        for (JsonNode associate : checkoutSource().path("simulation").path("workforce_context")) {
            if (department.equals(associate.path("department").asText())) {
                return true;
            }
        }
        return false;
    }

    private ObjectNode eventResponse(String result) throws IOException {
        ObjectNode response = json.createObjectNode();
        response.put("event_result", result);
        response.set("operating_state", statusResponse());
        return response;
    }

    private void operationalStateChanged() {
        stateVersion++;
        pendingCandidateSet = null;
        pendingDecision = null;
        lastActionReceipt = null;
        checkpoint = null;
        activePlan = null;
    }

    private boolean interventionRequired() throws IOException {
        return hasEventType("queue_threshold_breach") && thresholdBreached();
    }

    private boolean thresholdBreached() throws IOException {
        JsonNode thresholds = checkoutSource().path("simulation").path("thresholds");
        boolean confident = state.path("vision_confidence").asDouble()
            >= thresholds.path("minimum_vision_confidence").asDouble();
        return confident && (
            state.path("people_in_queue").asInt() > thresholds.path("maximum_people_in_queue").asInt()
                || state.path("estimated_wait_minutes").asDouble()
                    > thresholds.path("maximum_estimated_wait_minutes").asDouble()
        );
    }

    private boolean hasEventType(String type) {
        for (JsonNode event : state.path("active_events")) {
            if (type.equals(event.path("type").asText())) {
                return true;
            }
        }
        return false;
    }

    private String operatingStatus() throws IOException {
        if (checkpoint != null && "met".equals(checkpoint.path("status").asText())) {
            return "recovered";
        }
        if (checkpoint != null && "missed".equals(checkpoint.path("status").asText())) {
            return "recovery_off_track";
        }
        if (pendingDecision != null && "approved_and_executed".equals(pendingDecision.path("status").asText())) {
            return "recovering";
        }
        if (pendingDecision != null && "pending_manager_approval".equals(pendingDecision.path("status").asText())) {
            return "awaiting_manager";
        }
        if (pendingCandidateSet != null) {
            return "agent_planning";
        }
        return interventionRequired() ? "at_risk" : "within_plan";
    }

    private String monitorAction() throws IOException {
        if (checkpoint != null
            && ("met".equals(checkpoint.path("status").asText()) || "missed".equals(checkpoint.path("status").asText()))) {
            return checkpoint.path("reported").asBoolean() ? "none" : "report_checkpoint";
        }
        if (pendingCandidateSet != null) {
            return "await_agent_recommendation";
        }
        if (pendingDecision == null && interventionRequired()) {
            return "request_recovery_plan";
        }
        if (pendingDecision != null && "pending_manager_approval".equals(pendingDecision.path("status").asText())) {
            return "await_manager_decision";
        }
        if (pendingDecision != null && "approved_and_executed".equals(pendingDecision.path("status").asText())) {
            return "monitor_checkpoint";
        }
        if (pendingDecision != null && "rejected".equals(pendingDecision.path("status").asText())) {
            return "manager_rejected";
        }
        return "none";
    }

    private void validateIdentity(String storeId, String businessDate)
        throws SimulationException {
        if (storeId == null || businessDate == null || storeId.isBlank() || businessDate.isBlank()) {
            throw new SimulationException(400, "invalid_request", "store_id and business_date are required");
        }
        try {
            LocalDate.parse(businessDate);
        } catch (Exception ignored) {
            throw new SimulationException(400, "invalid_request", "business_date must use YYYY-MM-DD");
        }
        if (!storeId.equals(state.path("store_id").asText())) {
            throw new SimulationException(404, "store_not_found", "no checkout simulation exists for this store_id");
        }
        if (!businessDate.equals(state.path("business_date").asText())) {
            throw new SimulationException(404, "business_date_not_found", "no checkout simulation exists for this date");
        }
    }

    private String requiredText(ObjectNode request, String field) throws SimulationException {
        String value = request.path(field).asText(null);
        if (value == null || value.isBlank()) {
            throw new SimulationException(400, "invalid_request", field + " is required");
        }
        return value;
    }

    private int requiredPositiveInt(ObjectNode request, String field) throws SimulationException {
        if (!request.path(field).canConvertToInt() || request.path(field).asInt() < 1) {
            throw new SimulationException(400, "invalid_request", field + " must be a positive integer");
        }
        return request.path(field).asInt();
    }

    private JsonNode checkoutSource() throws IOException {
        return sourceFile("checkout-operations.json");
    }

    private JsonNode checkoutSourceUnchecked() {
        try {
            return checkoutSource();
        } catch (IOException exception) {
            throw new IllegalStateException("synthetic checkout fixture is unavailable", exception);
        }
    }

    private JsonNode sourceFile(String filename) throws IOException {
        return data.source(filename);
    }

    private boolean containsText(ArrayNode values, String expected) {
        for (JsonNode value : values) {
            if (expected.equals(value.asText())) {
                return true;
            }
        }
        return false;
    }

    private void copyMetric(JsonNode source, ObjectNode destination, String field) {
        destination.put(field, source.path(field).asInt());
    }

    private void remember(String key, ObjectNode response) {
        if (idempotentResponses.size() >= 100) {
            String oldest = idempotentResponses.keySet().iterator().next();
            idempotentResponses.remove(oldest);
        }
        idempotentResponses.put(key, response.deepCopy());
    }
}
