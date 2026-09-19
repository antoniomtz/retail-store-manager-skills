import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

final class SafetySnapshotService {
    private final ObjectMapper json;

    SafetySnapshotService(ObjectMapper json) {
        this.json = json;
    }

    ObjectNode summarize(JsonNode source) {
        if (!source.path("events").isArray()) {
            throw new IllegalArgumentException("safety events must be an array");
        }

        ObjectNode safety = json.createObjectNode();
        safety.set("reporting_window", source.path("reporting_window").deepCopy());
        safety.set("privacy", source.path("privacy").deepCopy());

        int activeHazards = 0;
        int activeIncidents = 0;
        int awaitingVerification = 0;
        int incidentsSincePreviousClose = 0;
        int clearedEvents = 0;
        int falsePositiveEvents = 0;
        List<ObjectNode> normalizedEvents = new ArrayList<>();

        for (JsonNode event : source.path("events")) {
            ObjectNode normalized = normalize(event);
            normalizedEvents.add(normalized);

            String classification = normalized.path("classification").asText();
            String status = normalized.path("status").asText();
            boolean closed = isClosed(status);
            if (!closed && "hazard".equals(classification)) {
                activeHazards++;
            }
            if (!closed && "incident".equals(classification)) {
                activeIncidents++;
            }
            if (!closed && "unverified".equals(normalized.path("verification").path("status").asText())) {
                awaitingVerification++;
            }
            if ("incident".equals(classification)) {
                incidentsSincePreviousClose++;
            }
            if ("cleared".equals(status)) {
                clearedEvents++;
            }
            if ("false_positive".equals(status)) {
                falsePositiveEvents++;
            }
        }

        normalizedEvents.sort(
            Comparator.comparingInt(this::attentionRank)
                .thenComparingInt(this::severityRank)
                .thenComparing(
                    event -> event.path("detected_at").asText(),
                    Comparator.reverseOrder()
                )
        );

        ObjectNode summary = safety.putObject("summary");
        summary.put("events_since_previous_close", normalizedEvents.size());
        summary.put("events_needing_attention", activeHazards + activeIncidents);
        summary.put("active_hazards", activeHazards);
        summary.put("active_incidents", activeIncidents);
        summary.put("awaiting_verification", awaitingVerification);
        summary.put("incidents_since_previous_close", incidentsSincePreviousClose);
        summary.put("cleared_events", clearedEvents);
        summary.put("false_positive_events", falsePositiveEvents);

        ArrayNode events = safety.putArray("events");
        normalizedEvents.stream().limit(6).forEach(events::add);
        return safety;
    }

    private ObjectNode normalize(JsonNode event) {
        ObjectNode normalized = json.createObjectNode();
        normalized.put("event_id", event.path("event_id").asText());
        normalized.put("classification", event.path("classification").asText());
        normalized.put("event_type", event.path("event_type").asText());
        normalized.put("description", event.path("description").asText());
        normalized.set("location", event.path("location").deepCopy());
        normalized.put("severity", event.path("severity").asText());
        normalized.put("status", event.path("status").asText());
        normalized.put("detected_at", event.path("detected_at").asText());
        normalized.put("last_observed_at", event.path("last_observed_at").asText());
        normalized.set("verification", event.path("verification").deepCopy());
        normalized.set("observation", event.path("observation").deepCopy());
        normalized.set("response", event.path("response").deepCopy());
        if (event.path("resolution").isObject()) {
            normalized.set("resolution", event.path("resolution").deepCopy());
        }
        return normalized;
    }

    private int attentionRank(JsonNode event) {
        return isClosed(event.path("status").asText()) ? 1 : 0;
    }

    private int severityRank(JsonNode event) {
        return switch (event.path("severity").asText()) {
            case "critical" -> 0;
            case "high" -> 1;
            case "medium" -> 2;
            case "low" -> 3;
            default -> 4;
        };
    }

    private boolean isClosed(String status) {
        return "cleared".equals(status) || "false_positive".equals(status);
    }
}
