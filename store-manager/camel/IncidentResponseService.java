import java.io.IOException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

final class IncidentResponseService {
    private static final Set<String> HAZARD_CLASSES = Set.of(
        "spill", "obstruction", "damaged_fixture", "smoke_or_fire",
        "possible_injury", "security", "unknown"
    );
    private static final Set<String> SEVERITIES = Set.of("low", "medium", "high", "critical");
    private static final Set<String> CUSTOMER_EXPOSURES = Set.of("none", "possible", "present");
    private static final Set<String> ACCESS_IMPACTS = Set.of("clear", "partially_blocked", "blocked");
    private static final Set<String> CONFIDENCE_LEVELS = Set.of("low", "medium", "high");

    private final StoreDataRepository data;
    private final ObjectMapper json;

    IncidentResponseService(StoreDataRepository data) {
        this.data = data;
        this.json = data.mapper();
    }

    ObjectNode plan(ObjectNode request) throws IOException, SimulationException {
        JsonNode fixture = data.source("incident-response.json");
        JsonNode storeSource = data.source("store.json");

        String storeId = requiredText(request, "store_id");
        String businessDate = requiredText(request, "business_date");
        validateDate(businessDate);
        if (!storeId.equals(fixture.path("store_id").asText())
            || !storeId.equals(storeSource.path("store").path("store_id").asText())) {
            throw new SimulationException(404, "store_not_found", "no fixture data exists for this store_id");
        }
        if (!businessDate.equals(fixture.path("business_date").asText())) {
            throw new SimulationException(404, "business_date_not_found", "no fixture data exists for this business_date");
        }

        String hazardClass = enumValue(request, "hazard_class", HAZARD_CLASSES);
        String severity = enumValue(request, "severity", SEVERITIES);
        String zone = enumValue(request, "zone", textValues(fixture.path("zones")));
        String customerExposure = enumValue(request, "customer_exposure", CUSTOMER_EXPOSURES);
        String accessImpact = enumValue(request, "access_impact", ACCESS_IMPACTS);
        String confidence = enumValue(request, "confidence", CONFIDENCE_LEVELS);

        JsonNode playbook = fixture.path("response_playbooks").path(hazardClass);
        if (!playbook.isObject()) {
            throw new SimulationException(500, "connector_error", "the incident response playbook is unavailable");
        }

        ObjectNode response = json.createObjectNode();
        response.put("contract_version", "0.1.0");
        response.put("store_id", storeId);
        response.put("business_date", businessDate);
        response.set("store", storeSource.path("store").deepCopy());
        response.putObject("freshness")
            .put("workforce_and_safety", fixture.path("data_as_of").asText());

        ObjectNode assessment = response.putObject("visual_assessment");
        assessment.put("hazard_class", hazardClass);
        assessment.put("severity", severity);
        assessment.put("zone", zone);
        assessment.put("customer_exposure", customerExposure);
        assessment.put("access_impact", accessImpact);
        assessment.put("confidence", confidence);

        ObjectNode guardrails = response.putObject("planning_guardrails");
        guardrails.put("image_received_by_camel", false);
        guardrails.put("person_identification_permitted", false);
        guardrails.put("protected_attribute_inference_permitted", false);
        guardrails.put("medical_diagnosis_permitted", false);
        guardrails.put("external_action_authorized", false);

        ObjectNode policy = response.putObject("incident_policy");
        policy.put("response_priority", responsePriority(hazardClass, severity, confidence));
        policy.put("resource", playbook.path("resource").asText());
        policy.set("immediate_controls", playbook.path("immediate_controls").deepCopy());
        policy.set("escalation_conditions", playbook.path("escalation_conditions").deepCopy());

        List<JsonNode> available = associatesWithStatus(fixture, "available");
        List<JsonNode> protectedAssociates = associatesWithStatus(fixture, "protected");
        ObjectNode availability = response.putObject("associate_availability");
        availability.set("available", associateSummary(available));
        availability.set("protected", associateSummary(protectedAssociates));

        boolean needsCustomerFlow = !"none".equals(customerExposure)
            || !"clear".equals(accessImpact)
            || Set.of("high", "critical").contains(severity);
        String responseCapability = playbook.path("response_capability").asText();

        ArrayNode feasiblePlans = response.putArray("feasible_plans");
        ArrayNode blockedOptions = response.putArray("blocked_options");
        buildPlan(
            feasiblePlans, blockedOptions, "IR-FAST-01", "Fastest qualified response",
            "fastest_response", available, protectedAssociates, responseCapability,
            needsCustomerFlow, playbook, Comparator
                .comparingInt((JsonNode associate) -> associate.path("response_eta_minutes").asInt())
                .thenComparingInt(associate -> associate.path("impact_score").asInt())
        );
        buildPlan(
            feasiblePlans, blockedOptions, "IR-LOW-IMPACT-02", "Lowest operational disruption",
            "lowest_operational_disruption", available, protectedAssociates, responseCapability,
            needsCustomerFlow, playbook, Comparator
                .comparingInt((JsonNode associate) -> associate.path("impact_score").asInt())
                .thenComparingInt(associate -> associate.path("response_eta_minutes").asInt())
        );

        if (feasiblePlans.isEmpty()) {
            throw new SimulationException(
                409,
                "no_feasible_response",
                "no synthetic associate team can satisfy the incident response capabilities"
            );
        }
        removeDuplicatePlans(feasiblePlans);

        ArrayNode factors = response.putArray("selection_factors");
        factors.add("Choose only from the returned feasible plans; protected commitments are not available for reassignment");
        factors.add(selectionFactorForSeverity(severity));
        factors.add(selectionFactorForConfidence(confidence));
        if (needsCustomerFlow) {
            factors.add("Customer exposure or access impact requires a dedicated customer-flow assignment");
        }
        factors.add("Compare response readiness with the returned coverage impact before recommending a plan");
        return response;
    }

    private void buildPlan(
        ArrayNode feasiblePlans,
        ArrayNode blockedOptions,
        String planId,
        String title,
        String strategy,
        List<JsonNode> available,
        List<JsonNode> protectedAssociates,
        String responseCapability,
        boolean needsCustomerFlow,
        JsonNode playbook,
        Comparator<JsonNode> ordering
    ) {
        List<JsonNode> ordered = available.stream().sorted(ordering).toList();
        List<JsonNode> team = new ArrayList<>();
        List<String> assignments = new ArrayList<>();

        JsonNode lead = select(ordered, "incident_lead", Set.of());
        if (lead != null) {
            team.add(lead);
            assignments.add("Lead the incident response and verify escalation conditions");
        }
        JsonNode responder = select(ordered, responseCapability, references(team));
        if (responder != null) {
            team.add(responder);
            assignments.add("Apply the returned immediate controls using " + playbook.path("resource").asText());
        }
        if (needsCustomerFlow) {
            JsonNode flow = select(ordered, "customer_flow", references(team));
            if (flow != null) {
                team.add(flow);
                assignments.add("Keep customers outside the controlled area and maintain a safe route");
            }
        }

        int expectedTeamSize = needsCustomerFlow ? 3 : 2;
        if (team.size() != expectedTeamSize) {
            ObjectNode blocked = blockedOptions.addObject();
            blocked.put("plan_id", planId);
            blocked.put("title", title);
            ArrayNode reasons = blocked.putArray("blocked_reasons");
            if (lead == null) {
                reasons.add("No available associate can fill the incident-lead assignment");
            }
            if (responder == null) {
                reasons.add("No available associate has the required " + responseCapability + " capability");
            }
            if (needsCustomerFlow && team.size() < expectedTeamSize) {
                reasons.add("No additional available associate can maintain customer flow");
            }
            appendProtectedCapabilityReason(reasons, protectedAssociates, responseCapability);
            return;
        }

        ObjectNode plan = feasiblePlans.addObject();
        plan.put("plan_id", planId);
        plan.put("title", title);
        plan.put("strategy", strategy);
        int readinessMinutes = team.stream()
            .mapToInt(associate -> associate.path("response_eta_minutes").asInt())
            .max()
            .orElse(0);
        plan.put("response_ready_in_minutes", readinessMinutes);
        ArrayNode responseTeam = plan.putArray("response_team");
        for (int index = 0; index < team.size(); index++) {
            JsonNode associate = team.get(index);
            ObjectNode member = responseTeam.addObject();
            member.put("associate_reference", associate.path("associate_reference").asText());
            member.put("role", associate.path("role").asText());
            member.put("department", associate.path("department").asText());
            member.put("assignment", assignments.get(index));
            member.put("response_eta_minutes", associate.path("response_eta_minutes").asInt());
        }
        plan.set("immediate_actions", playbook.path("immediate_controls").deepCopy());
        ArrayNode impacts = plan.putArray("coverage_tradeoffs");
        team.stream()
            .map(associate -> associate.path("reassignment_impact").asText())
            .distinct()
            .forEach(impacts::add);
        ArrayNode preserved = plan.putArray("protected_commitments_preserved");
        protectedAssociates.forEach(associate -> preserved.add(associate.path("current_commitment").asText()));
    }

    private JsonNode select(List<JsonNode> associates, String capability, Set<String> excludedReferences) {
        for (JsonNode associate : associates) {
            String reference = associate.path("associate_reference").asText();
            if (!excludedReferences.contains(reference) && hasCapability(associate, capability)) {
                return associate;
            }
        }
        return null;
    }

    private boolean hasCapability(JsonNode associate, String capability) {
        for (JsonNode value : associate.path("capabilities")) {
            if (capability.equals(value.asText())) {
                return true;
            }
        }
        return false;
    }

    private Set<String> references(List<JsonNode> associates) {
        Set<String> values = new HashSet<>();
        associates.forEach(associate -> values.add(associate.path("associate_reference").asText()));
        return values;
    }

    private void appendProtectedCapabilityReason(ArrayNode reasons, List<JsonNode> protectedAssociates, String capability) {
        if (protectedAssociates.stream().anyMatch(associate -> hasCapability(associate, capability))) {
            reasons.add("A capable associate exists but is protected by another active commitment");
        }
    }

    private void removeDuplicatePlans(ArrayNode plans) {
        if (plans.size() < 2) {
            return;
        }
        JsonNode firstTeam = plans.get(0).path("response_team");
        JsonNode secondTeam = plans.get(1).path("response_team");
        if (firstTeam.equals(secondTeam)) {
            plans.remove(1);
        }
    }

    private ArrayNode associateSummary(List<JsonNode> associates) {
        ArrayNode summary = json.createArrayNode();
        for (JsonNode associate : associates) {
            ObjectNode item = summary.addObject();
            item.put("associate_reference", associate.path("associate_reference").asText());
            item.put("role", associate.path("role").asText());
            item.put("department", associate.path("department").asText());
            item.put("status", associate.path("status").asText());
            item.put("response_eta_minutes", associate.path("response_eta_minutes").asInt());
            item.set("capabilities", associate.path("capabilities").deepCopy());
            item.put("current_commitment", associate.path("current_commitment").asText());
            item.put("reassignment_impact", associate.path("reassignment_impact").asText());
        }
        return summary;
    }

    private List<JsonNode> associatesWithStatus(JsonNode fixture, String status) {
        List<JsonNode> associates = new ArrayList<>();
        fixture.path("associates").forEach(associate -> {
            if (status.equals(associate.path("status").asText())) {
                associates.add(associate);
            }
        });
        return associates;
    }

    private Set<String> textValues(JsonNode values) {
        Set<String> result = new HashSet<>();
        values.forEach(value -> result.add(value.asText()));
        return result;
    }

    private String requiredText(ObjectNode request, String field) throws SimulationException {
        JsonNode value = request.get(field);
        if (value == null || !value.isTextual() || value.asText().isBlank()) {
            throw new SimulationException(400, "invalid_request", field + " is required");
        }
        return value.asText();
    }

    private String enumValue(ObjectNode request, String field, Set<String> allowed) throws SimulationException {
        String value = requiredText(request, field);
        if (!allowed.contains(value)) {
            throw new SimulationException(400, "invalid_request", field + " is outside the supported values");
        }
        return value;
    }

    private void validateDate(String value) throws SimulationException {
        try {
            if (!LocalDate.parse(value).toString().equals(value)) {
                throw new IllegalArgumentException();
            }
        } catch (Exception exception) {
            throw new SimulationException(400, "invalid_request", "business_date must use YYYY-MM-DD");
        }
    }

    private String responsePriority(String hazardClass, String severity, String confidence) {
        if (Set.of("smoke_or_fire", "possible_injury", "security").contains(hazardClass)
            || "critical".equals(severity)) {
            return "life_safety_first";
        }
        if ("low".equals(confidence) || "unknown".equals(hazardClass)) {
            return "control_and_verify";
        }
        return "contain_and_restore";
    }

    private String selectionFactorForSeverity(String severity) {
        return switch (severity) {
            case "critical", "high" -> "The assessed severity favors response readiness over lower operational disruption";
            case "medium" -> "Balance response readiness with the returned coverage tradeoffs";
            default -> "The assessed severity permits the lower-disruption plan when its readiness is adequate";
        };
    }

    private String selectionFactorForConfidence(String confidence) {
        return switch (confidence) {
            case "low" -> "Low visual confidence requires conservative area control and in-person verification";
            case "medium" -> "Medium visual confidence requires the on-scene lead to verify the classification";
            default -> "High visual confidence supports planning, but the on-scene lead still verifies conditions";
        };
    }
}
