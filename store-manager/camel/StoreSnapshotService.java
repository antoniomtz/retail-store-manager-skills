import java.io.IOException;
import java.time.Duration;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.camel.Exchange;

final class StoreSnapshotService {
    private final StoreDataRepository data;
    private final ObjectMapper json;
    private final SafetySnapshotService safetySnapshots;

    StoreSnapshotService(StoreDataRepository data) {
        this.data = data;
        this.json = data.mapper();
        this.safetySnapshots = new SafetySnapshotService(json);
    }

    void buildSnapshot(Exchange exchange) throws Exception {
        String storeId = exchange.getMessage().getHeader("store_id", String.class);
        String businessDate = exchange.getMessage().getHeader("business_date", String.class);

        if (isBlank(storeId) || isBlank(businessDate)) {
            error(exchange, 400, "invalid_request", "store_id and business_date are required");
            return;
        }

        LocalDate requestedDate;
        try {
            requestedDate = LocalDate.parse(businessDate);
        } catch (Exception ignored) {
            error(exchange, 400, "invalid_request", "business_date must use YYYY-MM-DD");
            return;
        }

        try {
            JsonNode storeSource = source("store.json");
            JsonNode posSource = source("pos.json");
            JsonNode inventorySource = source("inventory.json");
            JsonNode ordersSource = source("orders.json");
            JsonNode workforceSource = source("workforce.json");
            JsonNode safetySource = source("safety-events.json");
            JsonNode opdSource = source("opd-operations.json");
            JsonNode openingSource = source("opening-conditions.json");
            JsonNode serviceSource = source("service-performance.json");

            if (!storeId.equals(storeSource.path("store").path("store_id").asText())
                || !sourcesMatchStore(
                    storeId,
                    posSource,
                    inventorySource,
                    ordersSource,
                    workforceSource,
                    safetySource,
                    opdSource,
                    openingSource,
                    serviceSource
                )) {
                error(exchange, 404, "store_not_found", "no fixture data exists for this store_id");
                return;
            }

            JsonNode todayPlan = planFor(storeSource, businessDate);
            JsonNode yesterdayPlan = planFor(storeSource, requestedDate.minusDays(1).toString());
            if (todayPlan == null || yesterdayPlan == null) {
                error(exchange, 404, "business_date_not_found", "no fixture data exists for this business_date");
                return;
            }
            String previousBusinessDate = requestedDate.minusDays(1).toString();
            if (!businessDate.equals(ordersSource.path("business_date").asText())
                || !businessDate.equals(workforceSource.path("business_date").asText())
                || !businessDate.equals(safetySource.path("business_date").asText())
                || !businessDate.equals(opdSource.path("business_date").asText())
                || !businessDate.equals(openingSource.path("business_date").asText())
                || !previousBusinessDate.equals(posSource.path("business_date").asText())
                || !previousBusinessDate.equals(serviceSource.path("business_date").asText())) {
                error(exchange, 404, "business_date_not_found", "no fixture data exists for this business_date");
                return;
            }
            requireMorningSections(
                posSource,
                inventorySource,
                workforceSource,
                opdSource,
                openingSource,
                serviceSource
            );

            ObjectNode snapshot = json.createObjectNode();
            snapshot.put("contract_version", "0.3.0");
            snapshot.put("store_id", storeId);
            snapshot.put("business_date", businessDate);
            snapshot.set("store", storeSource.path("store").deepCopy());

            ObjectNode freshness = snapshot.putObject("freshness");
            freshness.put("store_and_planning", storeSource.path("data_as_of").asText());
            freshness.put("pos", posSource.path("data_as_of").asText());
            freshness.put("inventory", inventorySource.path("data_as_of").asText());
            freshness.put("orders", ordersSource.path("data_as_of").asText());
            freshness.put("workforce", workforceSource.path("data_as_of").asText());
            freshness.put("safety", safetySource.path("data_as_of").asText());
            freshness.put("opd_operations", opdSource.path("data_as_of").asText());
            freshness.put("opening_conditions", openingSource.path("data_as_of").asText());
            freshness.put("service_performance", serviceSource.path("data_as_of").asText());

            ObjectNode trade = snapshot.putObject("yesterday_trade");
            JsonNode posSummary = posSource.path("daily_summary");
            double netSales = posSummary.path("net_sales").asDouble();
            double salesPlan = yesterdayPlan.path("sales_plan").asDouble();
            double variance = netSales - salesPlan;
            trade.put("business_date", posSource.path("business_date").asText());
            trade.put("net_sales", netSales);
            trade.put("sales_plan", salesPlan);
            trade.put("sales_variance", variance);
            trade.put("sales_variance_percent", roundOneDecimal(variance / salesPlan * 100));
            trade.put("transactions", posSummary.path("transactions").asInt());
            trade.put("average_basket", posSummary.path("average_basket").asDouble());

            ObjectNode today = snapshot.putObject("today");
            today.put("sales_plan", todayPlan.path("sales_plan").asDouble());
            if (todayPlan.has("promotion")) {
                today.set("promotion", todayPlan.path("promotion").deepCopy());
            }

            snapshot.set("opening_leadership", workforceSource.path("opening_leadership").deepCopy());
            snapshot.set("store_condition", openingSource.path("store_condition").deepCopy());
            snapshot.set("overnight_carryover", openingSource.path("overnight_carryover").deepCopy());

            ArrayNode inventoryExceptions = snapshot.putArray("inventory_exceptions");
            priorityProducts(inventorySource).forEach(product -> inventoryExceptions.add(product.deepCopy()));
            snapshot.set("not_in_location", inventorySource.path("not_in_location").deepCopy());

            ObjectNode fulfillment = snapshot.putObject("fulfillment");
            List<JsonNode> orders = matchingOrders(ordersSource, businessDate);
            List<JsonNode> atRiskOrders = orders.stream()
                .filter(order -> "at_risk".equals(order.path("risk_status").asText()))
                .limit(3)
                .toList();
            fulfillment.put("orders_due_today", orders.size());
            fulfillment.put("orders_at_risk", atRiskOrders.size());
            ArrayNode fulfillmentExceptions = fulfillment.putArray("exceptions");
            atRiskOrders.forEach(order -> fulfillmentExceptions.add(order.deepCopy()));

            ObjectNode opd = snapshot.putObject("opd");
            opd.put("status", opdSource.path("status").asText());
            ObjectNode openingBacklog = opd.putObject("opening_backlog");
            openingBacklog.put(
                "items_in_pick_queue",
                opdSource.path("demand").path("items_in_pick_queue").asInt()
            );
            openingBacklog.put(
                "items_due_in_window",
                opdSource.path("demand").path("items_due_in_window").asInt()
            );
            openingBacklog.put(
                "orders_due_in_window",
                opdSource.path("demand").path("orders_due_in_window").asInt()
            );
            opd.set("first_pick", opdSource.path("first_pick").deepCopy());
            opd.put("orders_at_risk", atRiskOrders.size());
            opd.set("dispensing_waits", serviceSource.path("opd_dispensing").deepCopy());

            ObjectNode customerWaits = snapshot.putObject("customer_waits");
            customerWaits.put("business_date", serviceSource.path("business_date").asText());
            customerWaits.set("checkout", serviceSource.path("checkout_wait").deepCopy());

            snapshot.set("traffic", transactionTraffic(posSource));

            ArrayNode staffingGaps = snapshot.putArray("staffing_gaps");
            staffingGaps(workforceSource, businessDate).forEach(gap -> staffingGaps.add(gap));

            snapshot.set("safety", safetySnapshots.summarize(safetySource));

            exchange.getMessage().setBody(json.writeValueAsString(snapshot));
        } catch (IOException | RuntimeException exception) {
            error(exchange, 500, "connector_error", "the source data could not be read");
        }
    }

    void buildOpdRecovery(Exchange exchange) throws Exception {
        String storeId = exchange.getMessage().getHeader("store_id", String.class);
        String businessDate = exchange.getMessage().getHeader("business_date", String.class);

        if (isBlank(storeId) || isBlank(businessDate)) {
            error(exchange, 400, "invalid_request", "store_id and business_date are required");
            return;
        }

        try {
            LocalDate.parse(businessDate);
        } catch (Exception ignored) {
            error(exchange, 400, "invalid_request", "business_date must use YYYY-MM-DD");
            return;
        }

        try {
            JsonNode storeSource = source("store.json");
            JsonNode opdSource = source("opd-operations.json");
            JsonNode ordersSource = source("orders.json");
            JsonNode workforceSource = source("workforce.json");
            JsonNode inventorySource = source("inventory.json");

            if (!storeId.equals(storeSource.path("store").path("store_id").asText())
                || !storeId.equals(opdSource.path("store_id").asText())) {
                error(exchange, 404, "store_not_found", "no fixture data exists for this store_id");
                return;
            }
            if (!businessDate.equals(opdSource.path("business_date").asText())) {
                error(exchange, 404, "business_date_not_found", "no fixture data exists for this business_date");
                return;
            }

            ObjectNode snapshot = json.createObjectNode();
            snapshot.put("contract_version", "0.1.0");
            snapshot.put("store_id", storeId);
            snapshot.put("business_date", businessDate);
            snapshot.set("store", storeSource.path("store").deepCopy());

            ObjectNode freshness = snapshot.putObject("freshness");
            freshness.put("opd_operations", opdSource.path("data_as_of").asText());
            freshness.put("orders", ordersSource.path("data_as_of").asText());
            freshness.put("workforce", workforceSource.path("data_as_of").asText());
            freshness.put("inventory", inventorySource.path("data_as_of").asText());

            ObjectNode opdStatus = snapshot.putObject("opd_status");
            opdStatus.put("status", opdSource.path("status").asText());
            opdStatus.set("operating_window", opdSource.path("operating_window").deepCopy());
            opdStatus.set("first_pick", opdSource.path("first_pick").deepCopy());
            opdStatus.set("demand", opdSource.path("demand").deepCopy());

            ObjectNode picking = opdStatus.putObject("picking");
            int currentPickRate = opdSource.path("picking").path("current_pick_rate_items_per_hour").asInt();
            int targetPickRate = opdSource.path("picking").path("target_pick_rate_items_per_hour").asInt();
            picking.put("current_pick_rate_items_per_hour", currentPickRate);
            picking.put("target_pick_rate_items_per_hour", targetPickRate);
            picking.put("pick_rate_gap_items_per_hour", targetPickRate - currentPickRate);
            picking.put("current_pickers", opdSource.path("picking").path("current_pickers").asInt());

            List<JsonNode> atRiskOrders = matchingOrders(ordersSource, businessDate).stream()
                .filter(order -> "at_risk".equals(order.path("risk_status").asText()))
                .limit(3)
                .toList();

            ObjectNode constraints = snapshot.putObject("execution_constraints");
            ArrayNode orderRisks = constraints.putArray("at_risk_orders");
            atRiskOrders.forEach(order -> orderRisks.add(order.deepCopy()));
            ObjectNode fulfillmentCoverage = fulfillmentCoverage(workforceSource, businessDate);
            if (fulfillmentCoverage != null) {
                constraints.set("fulfillment_coverage", fulfillmentCoverage);
            }
            ArrayNode inventoryBlockers = constraints.putArray("inventory_blockers");
            inventoryBlockers(inventorySource, atRiskOrders)
                .forEach(product -> inventoryBlockers.add(product.deepCopy()));

            JsonNode recoverySource = opdSource.path("recovery");
            ObjectNode workforceRecoveryOption = workforceRecoveryOption(workforceSource, businessDate);
            if (workforceRecoveryOption == null) {
                error(exchange, 500, "connector_error", "the workforce recovery option is unavailable");
                return;
            }
            int additionalAssociates = workforceRecoveryOption.path("available_cross_trained_associates").asInt();
            int addedAssociateRate = workforceRecoveryOption.path("incremental_pick_rate_items_per_hour").asInt();
            int itemsDue = opdSource.path("demand").path("items_due_in_window").asInt();
            int windowMinutes = recoveryWindowMinutes(opdSource.path("operating_window"));
            int currentCapacity = projectedCapacity(currentPickRate, windowMinutes);
            int recoveredPickRate = currentPickRate + additionalAssociates * addedAssociateRate;
            int recoveredCapacity = projectedCapacity(recoveredPickRate, windowMinutes);

            ObjectNode recovery = snapshot.putObject("recovery");
            recovery.put("owner_role", recoverySource.path("owner_role").asText());
            recovery.put("recommended_action", recoverySource.path("recommended_action").asText());
            recovery.put("additional_cross_trained_associates", additionalAssociates);
            recovery.put("additional_associate_pick_rate_items_per_hour", addedAssociateRate);
            recovery.set("workforce_recovery_option", workforceRecoveryOption);

            ObjectNode forecast = recovery.putObject("forecast");
            forecast.put("window_minutes", windowMinutes);
            forecast.put("items_due_in_window", itemsDue);
            forecast.put("without_redeployment_pick_rate_items_per_hour", currentPickRate);
            forecast.put("without_redeployment_projected_capacity_items", currentCapacity);
            forecast.put("without_redeployment_projected_shortfall_items", Math.max(0, itemsDue - currentCapacity));
            forecast.put("with_recommended_redeployment_pick_rate_items_per_hour", recoveredPickRate);
            forecast.put("with_recommended_redeployment_projected_capacity_items", recoveredCapacity);
            forecast.put("with_recommended_redeployment_projected_buffer_items", Math.max(0, recoveredCapacity - itemsDue));

            ObjectNode checkpoint = recovery.putObject("checkpoint");
            checkpoint.put("at", recoverySource.path("checkpoint_at").asText());
            checkpoint.put("minimum_pick_rate_items_per_hour", recoverySource.path("minimum_pick_rate_items_per_hour").asInt());
            checkpoint.put("maximum_remaining_pick_queue_items", recoverySource.path("maximum_remaining_pick_queue_items").asInt());

            exchange.getMessage().setBody(json.writeValueAsString(snapshot));
        } catch (IOException | RuntimeException exception) {
            error(exchange, 500, "connector_error", "the source data could not be read");
        }
    }

    private JsonNode source(String filename) throws IOException {
        return data.source(filename);
    }

    private boolean sourcesMatchStore(String storeId, JsonNode... sources) {
        for (JsonNode source : sources) {
            if (!storeId.equals(source.path("store_id").asText())) {
                return false;
            }
        }
        return true;
    }

    private void requireMorningSections(
        JsonNode posSource,
        JsonNode inventorySource,
        JsonNode workforceSource,
        JsonNode opdSource,
        JsonNode openingSource,
        JsonNode serviceSource
    ) throws IOException {
        if (!posSource.path("hourly_transactions").isArray()
            || !inventorySource.path("not_in_location").isObject()
            || !workforceSource.path("opening_leadership").isArray()
            || !opdSource.path("demand").isObject()
            || !opdSource.path("first_pick").isObject()
            || !openingSource.path("store_condition").isObject()
            || !openingSource.path("overnight_carryover").isArray()
            || !serviceSource.path("checkout_wait").isObject()
            || !serviceSource.path("opd_dispensing").isObject()) {
            throw new IOException("a required morning source section is missing");
        }
    }

    private ObjectNode transactionTraffic(JsonNode posSource) {
        ObjectNode traffic = json.createObjectNode();
        traffic.put("business_date", posSource.path("business_date").asText());
        ArrayNode hourly = posSource.path("hourly_transactions").deepCopy();
        int transactionTotal = 0;
        JsonNode peakHour = null;
        for (JsonNode hour : hourly) {
            int transactions = hour.path("transactions").asInt(-1);
            if (transactions < 0
                || isBlank(hour.path("starts_at").asText())
                || isBlank(hour.path("ends_at").asText())) {
                throw new IllegalArgumentException("invalid hourly transaction data");
            }
            transactionTotal += transactions;
            if (peakHour == null || transactions > peakHour.path("transactions").asInt()) {
                peakHour = hour;
            }
        }
        if (hourly.isEmpty()
            || transactionTotal != posSource.path("daily_summary").path("transactions").asInt()) {
            throw new IllegalArgumentException("hourly transactions do not reconcile to the daily total");
        }
        traffic.put("transactions", transactionTotal);
        traffic.set("hourly_transactions", hourly);
        traffic.set("peak_hour", peakHour.deepCopy());
        return traffic;
    }

    private JsonNode planFor(JsonNode storeSource, String businessDate) {
        for (JsonNode plan : storeSource.path("daily_plans")) {
            if (businessDate.equals(plan.path("business_date").asText())) {
                return plan;
            }
        }
        return null;
    }

    private List<JsonNode> priorityProducts(JsonNode inventorySource) {
        List<JsonNode> exceptions = new ArrayList<>();
        for (JsonNode product : inventorySource.path("products")) {
            if (!"healthy".equals(product.path("stock_status").asText())) {
                exceptions.add(product);
            }
        }
        exceptions.sort(
            Comparator.comparingInt(this::priorityRank)
                .thenComparingInt(product -> product.path("on_hand").asInt())
        );
        return exceptions.stream().limit(3).toList();
    }

    private int priorityRank(JsonNode product) {
        return switch (product.path("priority").asText()) {
            case "high" -> 0;
            case "medium" -> 1;
            default -> 2;
        };
    }

    private List<JsonNode> matchingOrders(JsonNode ordersSource, String businessDate) {
        List<JsonNode> orders = new ArrayList<>();
        for (JsonNode order : ordersSource.path("orders")) {
            if (order.path("promise_by").asText().startsWith(businessDate)) {
                orders.add(order);
            }
        }
        return orders;
    }

    private List<ObjectNode> staffingGaps(JsonNode workforceSource, String businessDate) {
        List<ObjectNode> gaps = new ArrayList<>();
        if (!businessDate.equals(workforceSource.path("business_date").asText())) {
            return gaps;
        }
        for (JsonNode coverage : workforceSource.path("coverage")) {
            int scheduled = coverage.path("scheduled_headcount").asInt();
            int required = coverage.path("required_headcount").asInt();
            if (scheduled < required) {
                ObjectNode gap = coverage.deepCopy();
                gap.put("coverage_gap", required - scheduled);
                gaps.add(gap);
            }
        }
        gaps.sort(Comparator.comparingInt(gap -> -gap.path("coverage_gap").asInt()));
        return gaps.stream().limit(2).toList();
    }

    private ObjectNode fulfillmentCoverage(JsonNode workforceSource, String businessDate) {
        if (!businessDate.equals(workforceSource.path("business_date").asText())) {
            return null;
        }
        for (JsonNode coverage : workforceSource.path("coverage")) {
            if ("Fulfillment".equals(coverage.path("department").asText())) {
                ObjectNode result = coverage.deepCopy();
                int scheduled = result.path("scheduled_headcount").asInt();
                int required = result.path("required_headcount").asInt();
                result.put("coverage_gap", Math.max(0, required - scheduled));
                return result;
            }
        }
        return null;
    }

    private ObjectNode workforceRecoveryOption(JsonNode workforceSource, String businessDate) {
        if (!businessDate.equals(workforceSource.path("business_date").asText())) {
            return null;
        }
        for (JsonNode option : workforceSource.path("recovery_options")) {
            if ("Fulfillment".equals(option.path("target_department").asText())) {
                return option.deepCopy();
            }
        }
        return null;
    }

    private List<JsonNode> inventoryBlockers(JsonNode inventorySource, List<JsonNode> atRiskOrders) {
        List<JsonNode> blockers = new ArrayList<>();
        for (JsonNode product : inventorySource.path("products")) {
            if ("healthy".equals(product.path("stock_status").asText())) {
                continue;
            }
            String productName = product.path("product_name").asText();
            boolean linkedToOrderRisk = atRiskOrders.stream().anyMatch(order ->
                order.path("risk_reason").asText().contains(productName)
            );
            if (linkedToOrderRisk) {
                blockers.add(product);
            }
        }
        blockers.sort(Comparator.comparingInt(this::priorityRank));
        return blockers.stream().limit(3).toList();
    }

    private int recoveryWindowMinutes(JsonNode operatingWindow) {
        OffsetDateTime startsAt = OffsetDateTime.parse(operatingWindow.path("starts_at").asText());
        OffsetDateTime endsAt = OffsetDateTime.parse(operatingWindow.path("ends_at").asText());
        long minutes = Duration.between(startsAt, endsAt).toMinutes();
        if (minutes <= 0 || minutes > 720) {
            throw new IllegalArgumentException("invalid recovery window");
        }
        return (int) minutes;
    }

    private int projectedCapacity(int hourlyRate, int windowMinutes) {
        return (int) Math.round(hourlyRate * (windowMinutes / 60.0));
    }

    private void error(Exchange exchange, int status, String code, String message) throws IOException {
        ObjectNode error = json.createObjectNode();
        error.put("error", code);
        error.put("message", message);
        exchange.getMessage().setHeader(Exchange.HTTP_RESPONSE_CODE, status);
        exchange.getMessage().setBody(json.writeValueAsString(error));
    }

    private double roundOneDecimal(double value) {
        return Math.round(value * 10.0) / 10.0;
    }

    private boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

}
