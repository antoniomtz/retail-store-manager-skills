import java.io.IOException;
import java.time.Duration;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

final class OpdOperatingSimulation {
    private final StoreDataRepository data;
    private final ObjectMapper json;
    private ObjectNode state;
    private ObjectNode pendingCandidateSet;
    private ObjectNode pendingDecision;
    private ObjectNode lastActionReceipt;
    private ObjectNode checkpoint;
    private final Map<String, ObjectNode> idempotentResponses = new LinkedHashMap<>();
    private int stateVersion;
    private int eventSequence;
    private int candidateSequence;
    private int decisionSequence;
    private int receiptSequence;
    private int checkpointSequence;
    private String simulationRunId;

    OpdOperatingSimulation(StoreDataRepository data) {
        this.data = data;
        this.json = data.mapper();
        try {
            reset();
        } catch (IOException exception) {
            throw new IllegalStateException("synthetic OPD fixture is unavailable", exception);
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
            case "incident" -> injectIncident();
            case "demand_surge" -> injectDemandSurge();
            case "associate_callout" -> injectAssociateCallout();
            case "advance_time" -> advanceTime(requiredPositiveInt(request, "minutes"));
            default -> throw new SimulationException(
                400,
                "invalid_request",
                "operation must be reset, incident, demand_surge, associate_callout, or advance_time"
            );
        };
    }

    synchronized ObjectNode plan(ObjectNode request)
        throws IOException, SimulationException {
        validateIdentity(request.path("store_id").asText(null), request.path("business_date").asText(null));
        if (!hasActiveIncident()) {
            throw new SimulationException(409, "no_intervention_required", "the simulated OPD operation is within plan");
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
            response.set("candidate_set", pendingCandidateSet.deepCopy());
            response.set("operating_state", statusResponse());
            return response;
        }

        JsonNode workforceOption = workforceRecoveryOption();
        int available = workforceOption.path("available_cross_trained_associates").asInt();
        int ratePerAssociate = workforceOption.path("incremental_pick_rate_items_per_hour").asInt();
        int durationMinutes = workforceOption.path("assignment_duration_minutes").asInt();
        if (available < 1 || ratePerAssociate < 1 || durationMinutes < 1) {
            throw new SimulationException(500, "simulation_error", "no feasible workforce recovery option is configured");
        }

        pendingCandidateSet = json.createObjectNode();
        pendingCandidateSet.put(
            "candidate_set_id",
            String.format("OPD-CAND-%s-%03d", simulationRunId, ++candidateSequence)
        );
        pendingCandidateSet.put("status", "awaiting_agent_recommendation");
        pendingCandidateSet.put("created_at", state.path("simulated_at").asText());
        pendingCandidateSet.put("based_on_state_version", stateVersion);
        ArrayNode triggerEvents = pendingCandidateSet.putArray("trigger_event_ids");
        state.path("active_events").forEach(event -> triggerEvents.add(event.path("event_id").asText()));

        ArrayNode plans = pendingCandidateSet.putArray("candidate_plans");
        for (int associateCount = 1; associateCount <= available; associateCount++) {
            ObjectNode candidate = recoveryPlan(
                associateCount,
                available,
                ratePerAssociate,
                durationMinutes,
                workforceOption.path("source_department").asText("cross-trained flex pool")
            );
            plans.add(candidate);
        }
        ObjectNode requirements = pendingCandidateSet.putObject("decision_requirements");
        requirements.put("recommendation_required", true);
        requirements.put("maximum_presented_plans", 2);
        requirements.put("recommendation_reason_max_characters", 500);
        requirements.put("tradeoff_summary_max_characters", 300);

        ObjectNode response = json.createObjectNode();
        response.put("new_candidate_set", true);
        response.set("candidate_set", pendingCandidateSet.deepCopy());
        response.set("operating_state", statusResponse());
        return response;
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
                "there is no OPD candidate set awaiting an agent recommendation"
            );
        }
        String candidateSetId = requiredText(request, "candidate_set_id");
        if (!candidateSetId.equals(pendingCandidateSet.path("candidate_set_id").asText())) {
            throw new SimulationException(404, "candidate_set_not_found", "the OPD candidate_set_id was not found");
        }
        int expectedVersion = requiredPositiveInt(request, "expected_state_version");
        if (expectedVersion != stateVersion
            || expectedVersion != pendingCandidateSet.path("based_on_state_version").asInt()) {
            throw new SimulationException(409, "stale_candidate_set", "OPD state changed after these candidates were created");
        }

        String recommendedPlanId = requiredText(request, "recommended_plan_id");
        ObjectNode recommendedPlan = findCandidatePlan(recommendedPlanId);
        JsonNode alternateIds = request.path("alternate_plan_ids");
        if (!alternateIds.isArray() || alternateIds.size() != 1) {
            throw new SimulationException(400, "invalid_request", "alternate_plan_ids must contain exactly one plan ID");
        }
        String alternatePlanId = alternateIds.path(0).asText(null);
        if (alternatePlanId == null || alternatePlanId.equals(recommendedPlanId)) {
            throw new SimulationException(400, "invalid_request", "the alternate plan must differ from the recommendation");
        }
        ObjectNode alternatePlan = findCandidatePlan(alternatePlanId);
        String recommendationReason = boundedAgentText(request, "recommendation_reason", 40, 500);
        String tradeoffSummary = boundedAgentText(request, "tradeoff_summary", 20, 300);

        pendingDecision = json.createObjectNode();
        pendingDecision.put(
            "decision_id",
            String.format("OPD-DEC-%s-%03d", simulationRunId, ++decisionSequence)
        );
        pendingDecision.put("status", "pending_manager_approval");
        pendingDecision.put("created_at", state.path("simulated_at").asText());
        pendingDecision.put("based_on_state_version", stateVersion);
        pendingDecision.put("candidate_set_id", candidateSetId);
        pendingDecision.put("decision_author", "hermes");
        pendingDecision.put("decision_method", "agent_reasoned_candidate_ranking");
        pendingDecision.put("manager_message_status", "preparing");
        pendingDecision.put("evaluated_candidate_count", pendingCandidateSet.path("candidate_plans").size());
        pendingDecision.put("recommended_plan_id", recommendedPlanId);
        pendingDecision.put("recommendation_reason", recommendationReason);
        pendingDecision.put("tradeoff_summary", tradeoffSummary);
        pendingDecision.set("trigger_event_ids", pendingCandidateSet.path("trigger_event_ids").deepCopy());
        ArrayNode plans = pendingDecision.putArray("feasible_plans");
        plans.add(recommendedPlan);
        plans.add(alternatePlan);
        pendingDecision.put(
            "manager_instruction",
            "Approve or reject this decision_id. Approval executes only its selected feasible plan."
        );
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
        throw new SimulationException(400, "invalid_plan", "the selected OPD plan_id is not in the current candidate set");
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

    synchronized ObjectNode markManagerMessageReady(ObjectNode request)
        throws IOException, SimulationException {
        validateIdentity(request.path("store_id").asText(null), request.path("business_date").asText(null));
        String idempotencyKey = requiredText(request, "idempotency_key");
        ObjectNode previous = idempotentResponses.get(idempotencyKey);
        if (previous != null) {
            return previous.deepCopy();
        }
        if (pendingDecision == null
            || !"pending_manager_approval".equals(pendingDecision.path("status").asText())) {
            throw new SimulationException(409, "decision_not_found", "there is no pending OPD decision to present");
        }
        String decisionId = requiredText(request, "decision_id");
        if (!decisionId.equals(pendingDecision.path("decision_id").asText())) {
            throw new SimulationException(404, "decision_not_found", "the OPD decision_id was not found");
        }
        int expectedVersion = requiredPositiveInt(request, "expected_state_version");
        if (expectedVersion != stateVersion
            || expectedVersion != pendingDecision.path("based_on_state_version").asInt()) {
            throw new SimulationException(409, "stale_decision", "OPD state changed before the manager message was ready");
        }

        pendingDecision.put("manager_message_status", "ready");
        pendingDecision.put("manager_message_ready_at", state.path("simulated_at").asText());
        ObjectNode response = json.createObjectNode();
        response.put("manager_message_ready", true);
        response.set("decision", pendingDecision.deepCopy());
        response.set("operating_state", statusResponse());
        remember(idempotencyKey, response);
        return response;
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
        if (!"approve".equals(disposition) && !"reject".equals(disposition)) {
            throw new SimulationException(400, "invalid_request", "disposition must be approve or reject");
        }
        if (pendingDecision == null) {
            throw new SimulationException(409, "decision_not_found", "there is no pending OPD decision");
        }
        String decisionId = requiredText(request, "decision_id");
        if (!decisionId.equals(pendingDecision.path("decision_id").asText())) {
            throw new SimulationException(404, "decision_not_found", "the OPD decision_id was not found");
        }
        if (!"pending_manager_approval".equals(pendingDecision.path("status").asText())) {
            throw new SimulationException(409, "decision_already_resolved", "the OPD decision is already resolved");
        }
        if (!"ready".equals(pendingDecision.path("manager_message_status").asText())) {
            throw new SimulationException(409, "manager_message_not_ready", "the OPD manager response is not ready for a decision");
        }
        int expectedVersion = requiredPositiveInt(request, "expected_state_version");
        if (expectedVersion != stateVersion
            || expectedVersion != pendingDecision.path("based_on_state_version").asInt()) {
            throw new SimulationException(409, "stale_decision", "the OPD state changed after this decision was created");
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
        int addedAssociates = selectedPlan.path("additional_associates").asInt();
        int addedRate = selectedPlan.path("incremental_pick_rate_items_per_hour").asInt();
        state.put("current_pickers", state.path("current_pickers").asInt() + addedAssociates);
        state.put(
            "current_pick_rate_items_per_hour",
            state.path("current_pick_rate_items_per_hour").asInt() + addedRate
        );
        stateVersion++;
        pendingDecision.put("status", "approved_and_executed");
        pendingDecision.put("selected_plan_id", planId);
        pendingDecision.put("resolved_at", state.path("simulated_at").asText());

        JsonNode simulation = opdSource().path("simulation");
        int checkpointMinutes = simulation.path("checkpoint").path("after_minutes").asInt();
        int assignmentDurationMinutes = selectedPlan.path("assignment_duration_minutes").asInt();
        OffsetDateTime assignmentStartedAt = OffsetDateTime.parse(state.path("simulated_at").asText());
        checkpoint = json.createObjectNode();
        checkpoint.put("checkpoint_id", nextCheckpointId());
        checkpoint.put("stage", "progress");
        checkpoint.put("status", "scheduled");
        checkpoint.put("due_at", assignmentStartedAt.plusMinutes(checkpointMinutes).toString());
        checkpoint.put("assignment_started_at", assignmentStartedAt.toString());
        checkpoint.put("assignment_ends_at", assignmentStartedAt.plusMinutes(assignmentDurationMinutes).toString());
        checkpoint.put("after_minutes", checkpointMinutes);
        checkpoint.put("elapsed_assignment_minutes", 0);
        checkpoint.put("next_measurement_after_minutes", checkpointMinutes);
        checkpoint.put("assignment_duration_minutes", assignmentDurationMinutes);
        checkpoint.put("minimum_pick_rate_items_per_hour", simulation.path("checkpoint").path("minimum_pick_rate_items_per_hour").asInt());
        checkpoint.put("maximum_remaining_pick_queue_items", simulation.path("checkpoint").path("maximum_remaining_pick_queue_items").asInt());
        checkpoint.put("reported", false);

        lastActionReceipt = json.createObjectNode();
        lastActionReceipt.put("receipt_id", String.format("OPD-ACT-%s-%03d", simulationRunId, ++receiptSequence));
        lastActionReceipt.put("external_system", workforceRecoveryOption().path("external_system").asText());
        lastActionReceipt.put("status", "accepted");
        lastActionReceipt.put("accepted_at", state.path("simulated_at").asText());
        lastActionReceipt.put("decision_id", decisionId);
        lastActionReceipt.put("plan_id", planId);
        lastActionReceipt.put("state_version", stateVersion);
        ObjectNode appliedChange = lastActionReceipt.putObject("applied_change");
        appliedChange.put("temporary_associates_assigned", addedAssociates);
        appliedChange.put("incremental_pick_rate_items_per_hour", addedRate);
        appliedChange.put("assignment_duration_minutes", assignmentDurationMinutes);
        appliedChange.put("assignment_status", "active");

        response.put("external_action_executed", true);
        response.set("decision", pendingDecision.deepCopy());
        response.set("action_receipt", lastActionReceipt.deepCopy());
        response.set("operating_state", statusResponse());
        remember(idempotencyKey, response);
        return response;
    }

    private void reset() throws IOException {
        JsonNode source = opdSource();
        JsonNode baseline = source.path("simulation").path("baseline");
        state = json.createObjectNode();
        state.put("store_id", source.path("store_id").asText());
        state.put("business_date", source.path("business_date").asText());
        state.put("simulated_at", source.path("simulation").path("simulated_at").asText());
        state.put("items_due_in_window", baseline.path("items_due_in_window").asInt());
        state.put("orders_due_in_window", baseline.path("orders_due_in_window").asInt());
        state.put("items_in_pick_queue", baseline.path("items_in_pick_queue").asInt());
        state.put("current_pickers", baseline.path("current_pickers").asInt());
        state.put("current_pick_rate_items_per_hour", baseline.path("current_pick_rate_items_per_hour").asInt());
        state.put("target_pick_rate_items_per_hour", baseline.path("target_pick_rate_items_per_hour").asInt());
        state.putArray("active_events");
        pendingCandidateSet = null;
        pendingDecision = null;
        lastActionReceipt = null;
        checkpoint = null;
        idempotentResponses.clear();
        stateVersion = 1;
        eventSequence = 0;
        candidateSequence = 0;
        decisionSequence = 0;
        receiptSequence = 0;
        checkpointSequence = 0;
        simulationRunId = UUID.randomUUID().toString().substring(0, 8).toUpperCase();
    }

    private ObjectNode injectIncident() throws IOException, SimulationException {
        boolean demandAdded = addDemandSurge();
        boolean calloutAdded = addAssociateCallout();
        if (demandAdded || calloutAdded) {
            operationalStateChanged();
        }
        return eventResponse(demandAdded || calloutAdded ? "incident_injected" : "incident_already_active");
    }

    private ObjectNode injectDemandSurge() throws IOException, SimulationException {
        boolean added = addDemandSurge();
        if (added) {
            operationalStateChanged();
        }
        return eventResponse(added ? "demand_surge_injected" : "demand_surge_already_active");
    }

    private ObjectNode injectAssociateCallout() throws IOException, SimulationException {
        boolean added = addAssociateCallout();
        if (added) {
            operationalStateChanged();
        }
        return eventResponse(added ? "associate_callout_injected" : "associate_callout_already_active");
    }

    private boolean addDemandSurge() throws IOException {
        if (hasEventType("demand_surge")) {
            return false;
        }
        JsonNode eventData = opdSource().path("simulation").path("demand_surge");
        ObjectNode event = newEvent("demand_surge", eventData.path("label").asText());
        event.put("additional_items_due_in_window", eventData.path("additional_items_due_in_window").asInt());
        event.put("additional_orders_due_in_window", eventData.path("additional_orders_due_in_window").asInt());
        event.put("additional_items_in_pick_queue", eventData.path("additional_items_in_pick_queue").asInt());
        state.withArray("active_events").add(event);
        state.put("items_due_in_window", state.path("items_due_in_window").asInt() + event.path("additional_items_due_in_window").asInt());
        state.put("orders_due_in_window", state.path("orders_due_in_window").asInt() + event.path("additional_orders_due_in_window").asInt());
        state.put("items_in_pick_queue", state.path("items_in_pick_queue").asInt() + event.path("additional_items_in_pick_queue").asInt());
        return true;
    }

    private boolean addAssociateCallout() throws IOException {
        if (hasEventType("associate_callout")) {
            return false;
        }
        JsonNode eventData = opdSource().path("simulation").path("associate_callout");
        ObjectNode event = newEvent("associate_callout", eventData.path("label").asText());
        event.put("associate_reference", eventData.path("associate_reference").asText());
        event.put("role", eventData.path("role").asText());
        event.put("picker_reduction", eventData.path("picker_reduction").asInt());
        event.put("pick_rate_reduction_items_per_hour", eventData.path("pick_rate_reduction_items_per_hour").asInt());
        state.withArray("active_events").add(event);
        state.put("current_pickers", Math.max(0, state.path("current_pickers").asInt() - event.path("picker_reduction").asInt()));
        state.put(
            "current_pick_rate_items_per_hour",
            Math.max(0, state.path("current_pick_rate_items_per_hour").asInt() - event.path("pick_rate_reduction_items_per_hour").asInt())
        );
        return true;
    }

    private ObjectNode advanceTime(int minutes) throws IOException, SimulationException {
        if (minutes > 240) {
            throw new SimulationException(400, "invalid_request", "minutes must be between 1 and 240");
        }
        OffsetDateTime currentTime = OffsetDateTime.parse(state.path("simulated_at").asText());
        OffsetDateTime advanced = currentTime.plusMinutes(minutes);
        int currentRate = state.path("current_pick_rate_items_per_hour").asInt();
        int processedItems = projectedCapacity(currentRate, minutes);
        if (assignmentIsActive() && checkpoint != null) {
            OffsetDateTime assignmentEndsAt = OffsetDateTime.parse(checkpoint.path("assignment_ends_at").asText());
            if (advanced.isAfter(assignmentEndsAt)) {
                int activeMinutes = Math.max(0, (int) Duration.between(currentTime, assignmentEndsAt).toMinutes());
                int postAssignmentMinutes = minutes - activeMinutes;
                int postAssignmentRate = Math.max(
                    0,
                    currentRate - lastActionReceipt.path("applied_change").path("incremental_pick_rate_items_per_hour").asInt()
                );
                processedItems = projectedCapacity(currentRate, activeMinutes)
                    + projectedCapacity(postAssignmentRate, postAssignmentMinutes);
            }
        }
        state.put("items_in_pick_queue", Math.max(0, state.path("items_in_pick_queue").asInt() - processedItems));
        state.put("simulated_at", advanced.toString());
        stateVersion++;

        if (checkpoint != null) {
            OffsetDateTime assignmentEndsAt = OffsetDateTime.parse(checkpoint.path("assignment_ends_at").asText());
            if (!"final".equals(checkpoint.path("stage").asText()) && !advanced.isBefore(assignmentEndsAt)) {
                completeFinalCheckpoint(advanced);
            } else if (
                "progress".equals(checkpoint.path("stage").asText())
                && "scheduled".equals(checkpoint.path("status").asText())
                && !advanced.isBefore(OffsetDateTime.parse(checkpoint.path("due_at").asText()))
            ) {
                measureProgressCheckpoint(advanced);
            } else if ("scheduled".equals(checkpoint.path("status").asText())) {
                checkpoint.put(
                    "next_measurement_after_minutes",
                    Math.max(1, (int) Duration.between(advanced, OffsetDateTime.parse(checkpoint.path("due_at").asText())).toMinutes())
                );
            } else if ("progress".equals(checkpoint.path("stage").asText())) {
                checkpoint.put(
                    "next_measurement_after_minutes",
                    Math.max(1, (int) Duration.between(advanced, assignmentEndsAt).toMinutes())
                );
            }
        }
        ObjectNode response = json.createObjectNode();
        response.put("event_result", "time_advanced");
        response.put("minutes_advanced", minutes);
        response.put("items_processed", processedItems);
        response.set("operating_state", statusResponse());
        return response;
    }

    private void measureProgressCheckpoint(OffsetDateTime measuredAt) {
        setMeasuredCheckpointFields(checkpoint, measuredAt);
        boolean met = "met".equals(checkpoint.path("status").asText());
        int remainingMinutes = Math.max(
            1,
            (int) Duration.between(measuredAt, OffsetDateTime.parse(checkpoint.path("assignment_ends_at").asText())).toMinutes()
        );
        checkpoint.put("next_measurement_after_minutes", remainingMinutes);
        checkpoint.put(
            "guidance",
            met
                ? "Recovery is on track at the early check. Keep the temporary associates in OPD until the assignment ends, then measure the final outcome."
                : "The early recovery check missed a target. Keep the temporary associates in OPD and review whether more support is needed before the final measurement."
        );
    }

    private void completeFinalCheckpoint(OffsetDateTime measuredAt) {
        ObjectNode progressCheckpoint = checkpoint.deepCopy();
        checkpoint = json.createObjectNode();
        checkpoint.put("checkpoint_id", nextCheckpointId());
        checkpoint.put("stage", "final");
        checkpoint.put("status", "scheduled");
        checkpoint.put("due_at", progressCheckpoint.path("assignment_ends_at").asText());
        checkpoint.put("assignment_started_at", progressCheckpoint.path("assignment_started_at").asText());
        checkpoint.put("assignment_ends_at", progressCheckpoint.path("assignment_ends_at").asText());
        checkpoint.put("after_minutes", progressCheckpoint.path("assignment_duration_minutes").asInt());
        checkpoint.put("elapsed_assignment_minutes", progressCheckpoint.path("assignment_duration_minutes").asInt());
        checkpoint.put("next_measurement_after_minutes", 0);
        checkpoint.put("assignment_duration_minutes", progressCheckpoint.path("assignment_duration_minutes").asInt());
        checkpoint.put("progress_checkpoint_status", progressCheckpoint.path("status").asText());
        checkpoint.put("minimum_pick_rate_items_per_hour", progressCheckpoint.path("minimum_pick_rate_items_per_hour").asInt());
        checkpoint.put("maximum_remaining_pick_queue_items", progressCheckpoint.path("maximum_remaining_pick_queue_items").asInt());
        setMeasuredCheckpointFields(checkpoint, measuredAt);
        boolean met = "met".equals(checkpoint.path("status").asText());
        checkpoint.put(
            "guidance",
            met
                ? "The 90-minute recovery assignment is complete. Return the temporary associates to their previous work and continue normal OPD monitoring."
                : "The recovery assignment ended without meeting both final conditions. Keep the incident open and ask the manager to review another recovery plan."
        );
        releaseTemporaryAssociates(measuredAt);
    }

    private void setMeasuredCheckpointFields(ObjectNode measuredCheckpoint, OffsetDateTime measuredAt) {
        int pickRate = state.path("current_pick_rate_items_per_hour").asInt();
        int queue = state.path("items_in_pick_queue").asInt();
        boolean met = pickRate >= measuredCheckpoint.path("minimum_pick_rate_items_per_hour").asInt()
            && queue <= measuredCheckpoint.path("maximum_remaining_pick_queue_items").asInt();
        measuredCheckpoint.put("status", met ? "met" : "missed");
        measuredCheckpoint.put("measured_at", measuredAt.toString());
        measuredCheckpoint.put("measured_pick_rate_items_per_hour", pickRate);
        measuredCheckpoint.put("measured_remaining_pick_queue_items", queue);
        measuredCheckpoint.put(
            "elapsed_assignment_minutes",
            Math.max(
                0,
                (int) Duration.between(
                    OffsetDateTime.parse(measuredCheckpoint.path("assignment_started_at").asText()),
                    measuredAt
                ).toMinutes()
            )
        );
        measuredCheckpoint.put("reported", false);
    }

    private boolean assignmentIsActive() {
        return lastActionReceipt != null
            && "active".equals(lastActionReceipt.path("applied_change").path("assignment_status").asText());
    }

    private void releaseTemporaryAssociates(OffsetDateTime completedAt) {
        if (!assignmentIsActive()) {
            return;
        }
        ObjectNode appliedChange = (ObjectNode) lastActionReceipt.path("applied_change");
        state.put(
            "current_pickers",
            Math.max(0, state.path("current_pickers").asInt() - appliedChange.path("temporary_associates_assigned").asInt())
        );
        state.put(
            "current_pick_rate_items_per_hour",
            Math.max(0, state.path("current_pick_rate_items_per_hour").asInt() - appliedChange.path("incremental_pick_rate_items_per_hour").asInt())
        );
        appliedChange.put("assignment_status", "completed");
        appliedChange.put("assignment_completed_at", completedAt.toString());
    }

    private String nextCheckpointId() {
        return String.format("OPD-CHK-%s-%03d", simulationRunId, ++checkpointSequence);
    }

    private ObjectNode acknowledgeCheckpoint(ObjectNode request) throws SimulationException, IOException {
        if (checkpoint == null || !("met".equals(checkpoint.path("status").asText())
            || "missed".equals(checkpoint.path("status").asText()))) {
            throw new SimulationException(409, "checkpoint_not_ready", "there is no measured OPD checkpoint to acknowledge");
        }
        String checkpointId = requiredText(request, "checkpoint_id");
        if (!checkpointId.equals(checkpoint.path("checkpoint_id").asText())) {
            throw new SimulationException(404, "checkpoint_not_found", "the OPD checkpoint_id was not found");
        }
        checkpoint.put("reported", true);
        ObjectNode response = json.createObjectNode();
        response.put("checkpoint_acknowledged", true);
        response.set("checkpoint", checkpoint.deepCopy());
        response.set("operating_state", statusResponse());
        return response;
    }

    private ObjectNode statusResponse() throws IOException, SimulationException {
        ObjectNode response = json.createObjectNode();
        response.put("contract_version", "0.3.0");
        response.put("store_id", state.path("store_id").asText());
        response.put("business_date", state.path("business_date").asText());
        response.put("simulated_at", state.path("simulated_at").asText());
        response.put("state_version", stateVersion);
        response.put("operating_status", operatingStatus());
        response.set("store", sourceFile("store.json").path("store").deepCopy());
        response.set("active_events", state.path("active_events").deepCopy());

        ObjectNode metrics = response.putObject("metrics");
        metrics.put("items_due_in_window", state.path("items_due_in_window").asInt());
        metrics.put("orders_due_in_window", state.path("orders_due_in_window").asInt());
        metrics.put("items_in_pick_queue", state.path("items_in_pick_queue").asInt());
        metrics.put("current_pickers", state.path("current_pickers").asInt());
        metrics.put("current_pick_rate_items_per_hour", state.path("current_pick_rate_items_per_hour").asInt());
        metrics.put("target_pick_rate_items_per_hour", state.path("target_pick_rate_items_per_hour").asInt());

        ObjectNode recoveryContext = response.putObject("recovery_context");
        ObjectNode workforceOption = workforceRecoveryOption();
        recoveryContext.put(
            "available_cross_trained_associates",
            workforceOption.path("available_cross_trained_associates").asInt()
        );
        recoveryContext.put("source_department", workforceOption.path("source_department").asText());
        recoveryContext.put(
            "assignment_duration_minutes",
            workforceOption.path("assignment_duration_minutes").asInt()
        );
        recoveryContext.put(
            "checkpoint_after_minutes",
            opdSource().path("simulation").path("checkpoint").path("after_minutes").asInt()
        );
        recoveryContext.put(
            "minimum_pick_rate_items_per_hour",
            opdSource().path("simulation").path("checkpoint").path("minimum_pick_rate_items_per_hour").asInt()
        );
        recoveryContext.put(
            "maximum_remaining_pick_queue_items",
            opdSource().path("simulation").path("checkpoint").path("maximum_remaining_pick_queue_items").asInt()
        );

        ObjectNode monitor = response.putObject("monitor");
        monitor.put("action", monitorAction());
        monitor.put("intervention_required", hasActiveIncident());
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

    private ObjectNode recoveryPlan(
        int associateCount,
        int available,
        int ratePerAssociate,
        int durationMinutes,
        String sourceDepartment
    ) throws IOException {
        int currentRate = state.path("current_pick_rate_items_per_hour").asInt();
        int increment = associateCount * ratePerAssociate;
        int projectedRate = currentRate + increment;
        JsonNode simulation = opdSource().path("simulation");
        int checkpointMinutes = simulation.path("checkpoint").path("after_minutes").asInt();
        int projectedQueue = Math.max(
            0,
            state.path("items_in_pick_queue").asInt() - projectedCapacity(projectedRate, checkpointMinutes)
        );
        int minRate = simulation.path("checkpoint").path("minimum_pick_rate_items_per_hour").asInt();
        int maxQueue = simulation.path("checkpoint").path("maximum_remaining_pick_queue_items").asInt();
        boolean meetsCheckpoint = projectedRate >= minRate && projectedQueue <= maxQueue;
        int windowMinutes = simulation.path("recovery_window_minutes").asInt();
        int windowCapacity = projectedCapacity(projectedRate, windowMinutes);

        ObjectNode plan = json.createObjectNode();
        plan.put("plan_id", String.format("FLEX-%d", associateCount));
        plan.put("title", "Add " + associateCount + " associate"
            + (associateCount == 1 ? "" : "s") + " to OPD picking");
        plan.put("action", "Move " + associateCount + " available cross-trained store associate"
            + (associateCount == 1 ? "" : "s") + " to OPD picking.");
        plan.put("source_department", sourceDepartment);
        plan.put("additional_associates", associateCount);
        plan.put("assignment_duration_minutes", durationMinutes);
        plan.put("incremental_pick_rate_items_per_hour", increment);
        plan.put("projection_horizon_minutes", checkpointMinutes);
        plan.put("projected_pick_rate_items_per_hour", projectedRate);
        plan.put("projected_queue_at_checkpoint_items", projectedQueue);
        plan.put("projected_window_capacity_items", windowCapacity);
        plan.put("projected_window_buffer_items", windowCapacity - state.path("items_due_in_window").asInt());
        plan.put("meets_checkpoint", meetsCheckpoint);
        ArrayNode tradeoffs = plan.putArray("tradeoffs");
        if (associateCount == available) {
            tradeoffs.add("This uses every available cross-trained associate, so no additional associate remains available for another urgent task during the assignment.");
        } else {
            tradeoffs.add("This keeps " + (available - associateCount) + " cross-trained associate"
                + (available - associateCount == 1 ? "" : "s") + " available for another urgent task.");
        }
        if (!meetsCheckpoint) {
            tradeoffs.add("Based on the supplied forecast, this plan is not expected to meet both follow-up targets.");
        }
        return plan;
    }

    private ObjectNode findPlan(String planId) throws SimulationException {
        for (JsonNode plan : pendingDecision.path("feasible_plans")) {
            if (planId.equals(plan.path("plan_id").asText())) {
                return plan.deepCopy();
            }
        }
        throw new SimulationException(400, "invalid_plan", "the selected plan_id is not feasible for this decision");
    }

    private ObjectNode eventResponse(String result) throws IOException, SimulationException {
        ObjectNode response = json.createObjectNode();
        response.put("event_result", result);
        response.set("operating_state", statusResponse());
        return response;
    }

    private ObjectNode newEvent(String type, String label) {
        ObjectNode event = json.createObjectNode();
        event.put("event_id", String.format("OPD-EVT-%s-%03d", simulationRunId, ++eventSequence));
        event.put("type", type);
        event.put("label", label);
        event.put("detected_at", state.path("simulated_at").asText());
        return event;
    }

    private void operationalStateChanged() {
        stateVersion++;
        pendingCandidateSet = null;
        pendingDecision = null;
        lastActionReceipt = null;
        checkpoint = null;
    }

    private boolean hasActiveIncident() {
        return state.path("active_events").size() > 0;
    }

    private boolean hasEventType(String type) {
        for (JsonNode event : state.path("active_events")) {
            if (type.equals(event.path("type").asText())) {
                return true;
            }
        }
        return false;
    }

    private String operatingStatus() {
        if (checkpoint != null
            && "final".equals(checkpoint.path("stage").asText())
            && "met".equals(checkpoint.path("status").asText())) {
            return "recovered";
        }
        if (checkpoint != null
            && "final".equals(checkpoint.path("stage").asText())
            && "missed".equals(checkpoint.path("status").asText())) {
            return "recovery_off_track";
        }
        if (checkpoint != null
            && "progress".equals(checkpoint.path("stage").asText())
            && "met".equals(checkpoint.path("status").asText())) {
            return "recovering_on_track";
        }
        if (checkpoint != null
            && "progress".equals(checkpoint.path("stage").asText())
            && "missed".equals(checkpoint.path("status").asText())) {
            return "recovering_off_track";
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
        return hasActiveIncident() ? "at_risk" : "within_plan";
    }

    private String monitorAction() {
        if (checkpoint != null
            && ("met".equals(checkpoint.path("status").asText()) || "missed".equals(checkpoint.path("status").asText()))) {
            if (!checkpoint.path("reported").asBoolean()) {
                return "report_checkpoint";
            }
            return "final".equals(checkpoint.path("stage").asText()) ? "none" : "monitor_checkpoint";
        }
        if (pendingCandidateSet != null) {
            return "await_agent_recommendation";
        }
        if (pendingDecision == null && hasActiveIncident()) {
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
            throw new SimulationException(404, "store_not_found", "no simulation exists for this store_id");
        }
        if (!businessDate.equals(state.path("business_date").asText())) {
            throw new SimulationException(404, "business_date_not_found", "no simulation exists for this business_date");
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

    private JsonNode opdSource() throws IOException {
        return sourceFile("opd-operations.json");
    }

    private ObjectNode workforceRecoveryOption() throws IOException, SimulationException {
        JsonNode workforce = sourceFile("workforce.json");
        for (JsonNode option : workforce.path("recovery_options")) {
            if ("Fulfillment".equals(option.path("target_department").asText())) {
                return option.deepCopy();
            }
        }
        throw new SimulationException(500, "simulation_error", "the workforce recovery option is unavailable");
    }

    private JsonNode sourceFile(String filename) throws IOException {
        return data.source(filename);
    }

    private int projectedCapacity(int hourlyRate, int windowMinutes) {
        return (int) Math.round(hourlyRate * (windowMinutes / 60.0));
    }

    private void remember(String key, ObjectNode response) {
        if (idempotentResponses.size() >= 100) {
            String oldest = idempotentResponses.keySet().iterator().next();
            idempotentResponses.remove(oldest);
        }
        idempotentResponses.put(key, response.deepCopy());
    }
}
