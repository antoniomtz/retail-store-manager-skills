import java.io.IOException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

final class MorningBriefingPresentationService {
    private static final int MAX_TITLE_LENGTH = 140;
    private static final int MAX_EVIDENCE_LENGTH = 280;
    private final StoreDataRepository data;
    private final ObjectMapper json;
    private final ConcurrentHashMap<String, ObjectNode> presentations = new ConcurrentHashMap<>();

    MorningBriefingPresentationService(StoreDataRepository data) {
        this.data = data;
        this.json = data.mapper();
    }

    ObjectNode publish(ObjectNode request) throws IOException, SimulationException {
        String storeId = requiredText(request, "store_id", 64);
        String businessDate = requiredDate(request);
        validateFixtureScope(storeId, businessDate);

        JsonNode requestedPriorities = request.get("priorities");
        if (requestedPriorities == null || !requestedPriorities.isArray()) {
            throw invalid("priorities must be an array");
        }
        if (requestedPriorities.size() < 1 || requestedPriorities.size() > 4) {
            throw invalid("priorities must contain between one and four items");
        }

        ArrayNode priorities = json.createArrayNode();
        for (JsonNode value : requestedPriorities) {
            if (!value.isObject()) {
                throw invalid("each priority must be a JSON object");
            }
            int rank = value.path("rank").asInt(0);
            if (rank != priorities.size() + 1) {
                throw invalid("priority ranks must be ordered sequentially starting at one");
            }
            ObjectNode priority = json.createObjectNode();
            priority.put("rank", rank);
            priority.put("title", requiredText(value, "title", MAX_TITLE_LENGTH));
            priority.put("evidence", requiredText(value, "evidence", MAX_EVIDENCE_LENGTH));
            priorities.add(priority);
        }
        ObjectNode presentation = json.createObjectNode();
        presentation.put("presentation_id", "MBR-" + UUID.randomUUID().toString().toUpperCase());
        presentation.put("store_id", storeId);
        presentation.put("business_date", businessDate);
        presentation.put("published_at", OffsetDateTime.now(ZoneOffset.UTC).toString());
        presentation.set("priorities", priorities);
        presentations.put(scopeKey(storeId, businessDate), presentation.deepCopy());
        return response(storeId, businessDate, presentation, false);
    }

    ObjectNode current(String storeId, String businessDate) throws IOException, SimulationException {
        validateRequestScope(storeId, businessDate);
        validateFixtureScope(storeId, businessDate);
        ObjectNode presentation = presentations.get(scopeKey(storeId, businessDate));
        return response(storeId, businessDate, presentation, false);
    }

    ObjectNode clear(ObjectNode request) throws IOException, SimulationException {
        String storeId = requiredText(request, "store_id", 64);
        String businessDate = requiredDate(request);
        validateFixtureScope(storeId, businessDate);
        ObjectNode removed = presentations.remove(scopeKey(storeId, businessDate));
        return response(storeId, businessDate, null, removed != null);
    }

    private ObjectNode response(
        String storeId,
        String businessDate,
        ObjectNode presentation,
        boolean cleared
    ) {
        ObjectNode result = json.createObjectNode();
        result.put("contract_version", "0.1.0");
        result.put("store_id", storeId);
        result.put("business_date", businessDate);
        result.put("status", presentation == null ? "empty" : "ready");
        if (presentation == null) {
            result.putNull("presentation");
        } else {
            result.set("presentation", presentation.deepCopy());
        }
        result.put("cleared", cleared);
        return result;
    }

    private void validateRequestScope(String storeId, String businessDate) throws SimulationException {
        if (isBlank(storeId) || isBlank(businessDate)) {
            throw invalid("store_id and business_date are required");
        }
        try {
            LocalDate parsed = LocalDate.parse(businessDate);
            if (!parsed.toString().equals(businessDate)) {
                throw invalid("business_date must use YYYY-MM-DD");
            }
        } catch (SimulationException exception) {
            throw exception;
        } catch (Exception ignored) {
            throw invalid("business_date must use YYYY-MM-DD");
        }
    }

    private void validateFixtureScope(String storeId, String businessDate) throws IOException, SimulationException {
        validateRequestScope(storeId, businessDate);
        JsonNode storeSource = data.source("store.json");
        if (!storeId.equals(storeSource.path("store").path("store_id").asText())) {
            throw new SimulationException(404, "store_not_found", "no fixture data exists for this store_id");
        }
        for (JsonNode plan : storeSource.path("daily_plans")) {
            if (businessDate.equals(plan.path("business_date").asText())) {
                return;
            }
        }
        throw new SimulationException(404, "business_date_not_found", "no fixture data exists for this business_date");
    }

    private String requiredDate(JsonNode request) throws SimulationException {
        String businessDate = requiredText(request, "business_date", 10);
        try {
            LocalDate parsed = LocalDate.parse(businessDate);
            if (!parsed.toString().equals(businessDate)) {
                throw invalid("business_date must use YYYY-MM-DD");
            }
        } catch (SimulationException exception) {
            throw exception;
        } catch (Exception ignored) {
            throw invalid("business_date must use YYYY-MM-DD");
        }
        return businessDate;
    }

    private String requiredText(JsonNode source, String field, int maximumLength) throws SimulationException {
        JsonNode value = source.get(field);
        if (value == null || !value.isTextual()) {
            throw invalid(field + " must be text");
        }
        String text = value.asText().trim();
        if (text.isEmpty() || text.length() > maximumLength || containsControlCharacter(text)) {
            throw invalid(field + " is invalid");
        }
        return text;
    }

    private boolean containsControlCharacter(String value) {
        return value.codePoints().anyMatch(Character::isISOControl);
    }

    private String scopeKey(String storeId, String businessDate) {
        return storeId + "\n" + businessDate;
    }

    private boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private SimulationException invalid(String message) {
        return new SimulationException(400, "invalid_request", message);
    }
}
