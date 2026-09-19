import java.io.IOException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

final class EndOfDaySimulation {
    private final StoreDataRepository data;
    private final ObjectMapper json;
    private ObjectNode completedReview;
    private String simulationRunId;

    EndOfDaySimulation(StoreDataRepository data) {
        this.data = data;
        this.json = data.mapper();
        reset();
    }

    synchronized ObjectNode review(String storeId, String businessDate)
        throws IOException, SimulationException {
        validateIdentity(storeId, businessDate);
        return statusResponse();
    }

    synchronized ObjectNode event(ObjectNode request)
        throws IOException, SimulationException {
        validateIdentity(
            request.path("store_id").asText(null),
            request.path("business_date").asText(null)
        );
        String operation = requiredText(request, "operation");
        return switch (operation) {
            case "reset" -> {
                reset();
                yield eventResponse("day_reset");
            }
            case "run" -> {
                if (completedReview == null) {
                    completedReview = generateReview();
                    yield eventResponse("day_generated");
                }
                yield eventResponse("day_already_complete");
            }
            default -> throw new SimulationException(
                400,
                "invalid_request",
                "operation must be reset or run"
            );
        };
    }

    private void reset() {
        simulationRunId = UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        completedReview = null;
    }

    private ObjectNode eventResponse(String eventResult) throws IOException, SimulationException {
        ObjectNode response = json.createObjectNode();
        response.put("event_result", eventResult);
        response.set("review", statusResponse());
        return response;
    }

    private ObjectNode statusResponse() throws IOException, SimulationException {
        if (completedReview != null) {
            return completedReview.deepCopy();
        }

        JsonNode source = simulationSource();
        JsonNode simulation = source.path("simulation");
        OffsetDateTime startsAt = OffsetDateTime.parse(simulation.path("start_at").asText());
        int intervalMinutes = simulation.path("interval_minutes").asInt();
        int intervalCount = simulation.path("interval_count").asInt();
        validatePeriod(intervalMinutes, intervalCount);

        ObjectNode status = baseResponse(source);
        status.put("simulation_status", "not_run");
        ObjectNode period = status.putObject("simulated_period");
        period.put("starts_at", startsAt.toString());
        period.put("ends_at", startsAt.plusMinutes((long) intervalMinutes * intervalCount).toString());
        period.put("duration_minutes", intervalMinutes * intervalCount);
        period.put("interval_minutes", intervalMinutes);
        period.put("sample_count", 0);
        period.put("expected_sample_count", intervalCount);
        return status;
    }

    private ObjectNode generateReview() throws IOException, SimulationException {
        JsonNode source = simulationSource();
        JsonNode simulation = source.path("simulation");
        JsonNode series = simulation.path("series");
        int intervalMinutes = simulation.path("interval_minutes").asInt();
        int intervalCount = simulation.path("interval_count").asInt();
        validatePeriod(intervalMinutes, intervalCount);
        validateSeries(series, intervalCount);

        double averageBasket = simulation.path("average_basket").asDouble();
        double salesPlan = simulation.path("sales_plan").asDouble();
        if (averageBasket <= 0 || salesPlan <= 0) {
            throw new SimulationException(500, "simulation_error", "sales assumptions must be positive");
        }

        JsonNode checkoutSource = simulation.path("checkout");
        JsonNode checkoutThresholds = checkoutSource.path("thresholds");
        int maximumQueue = checkoutThresholds.path("maximum_people_in_queue").asInt();
        double maximumWait = checkoutThresholds.path("maximum_estimated_wait_minutes").asDouble();
        int opdTargetRate = simulation.path("opd").path("target_pick_rate_items_per_hour").asInt();
        if (maximumQueue < 1 || maximumWait <= 0 || opdTargetRate < 1) {
            throw new SimulationException(500, "simulation_error", "operating thresholds are invalid");
        }

        OffsetDateTime startsAt = OffsetDateTime.parse(simulation.path("start_at").asText());
        OffsetDateTime endsAt = startsAt.plusMinutes((long) intervalMinutes * intervalCount);
        ObjectNode review = baseResponse(source);
        review.put("simulation_status", "completed");
        review.put("generated_at", endsAt.toString());
        ObjectNode period = review.putObject("simulated_period");
        period.put("starts_at", startsAt.toString());
        period.put("ends_at", endsAt.toString());
        period.put("duration_minutes", intervalMinutes * intervalCount);
        period.put("duration_hours", (intervalMinutes * intervalCount) / 60);
        period.put("interval_minutes", intervalMinutes);
        period.put("sample_count", intervalCount);
        period.put("expected_sample_count", intervalCount);

        int transactions = 0;
        int checkoutBreachIntervals = 0;
        int checkoutPeakQueue = 0;
        double checkoutWaitTotal = 0;
        double checkoutPeakWait = 0;
        int opdBelowTargetIntervals = 0;
        int opdPeakQueue = 0;
        int opdPeakOrdersAtRisk = 0;
        int workforceGapIntervals = 0;
        ArrayNode timeline = review.putArray("timeline");

        for (int index = 0; index < intervalCount; index++) {
            int intervalTransactions = seriesInt(series, "sales_transactions", index);
            int checkoutQueue = seriesInt(series, "checkout_people_in_queue", index);
            double checkoutWait = seriesDouble(series, "checkout_wait_minutes", index);
            int checkoutLanes = seriesInt(series, "checkout_staffed_lanes", index);
            int opdPickRate = seriesInt(series, "opd_pick_rate_items_per_hour", index);
            int opdQueue = seriesInt(series, "opd_items_in_pick_queue", index);
            int opdOrdersAtRisk = seriesInt(series, "opd_orders_at_risk", index);
            int actualHeadcount = seriesInt(series, "fulfillment_actual_headcount", index);
            int requiredHeadcount = seriesInt(series, "fulfillment_required_headcount", index);
            int umbrellaOnHand = seriesInt(series, "rain_umbrella_on_hand", index);

            transactions += intervalTransactions;
            checkoutWaitTotal += checkoutWait;
            checkoutPeakQueue = Math.max(checkoutPeakQueue, checkoutQueue);
            checkoutPeakWait = Math.max(checkoutPeakWait, checkoutWait);
            if (checkoutQueue > maximumQueue || checkoutWait > maximumWait) {
                checkoutBreachIntervals++;
            }
            if (opdPickRate < opdTargetRate) {
                opdBelowTargetIntervals++;
            }
            opdPeakQueue = Math.max(opdPeakQueue, opdQueue);
            opdPeakOrdersAtRisk = Math.max(opdPeakOrdersAtRisk, opdOrdersAtRisk);
            if (actualHeadcount < requiredHeadcount) {
                workforceGapIntervals++;
            }

            ObjectNode sample = timeline.addObject();
            sample.put("at", startsAt.plusMinutes((long) index * intervalMinutes).toString());
            ObjectNode sales = sample.putObject("sales");
            sales.put("transactions", intervalTransactions);
            sales.put("net_sales", roundTwo(intervalTransactions * averageBasket));
            ObjectNode checkout = sample.putObject("checkout");
            checkout.put("people_in_queue", checkoutQueue);
            checkout.put("estimated_wait_minutes", checkoutWait);
            checkout.put("staffed_lanes_open", checkoutLanes);
            ObjectNode opd = sample.putObject("opd");
            opd.put("pick_rate_items_per_hour", opdPickRate);
            opd.put("items_in_pick_queue", opdQueue);
            opd.put("orders_at_risk", opdOrdersAtRisk);
            ObjectNode workforce = sample.putObject("fulfillment_workforce");
            workforce.put("actual_headcount", actualHeadcount);
            workforce.put("required_headcount", requiredHeadcount);
            sample.putObject("inventory").put("rain_umbrella_on_hand", umbrellaOnHand);
        }

        double netSales = roundTwo(transactions * averageBasket);
        ObjectNode sales = review.putObject("sales");
        sales.put("currency", simulation.path("currency").asText());
        sales.put("sales_plan", salesPlan);
        sales.put("net_sales", netSales);
        sales.put("variance", roundTwo(netSales - salesPlan));
        sales.put("variance_percent", roundOne((netSales - salesPlan) / salesPlan * 100));
        sales.put("transactions", transactions);
        sales.put("average_basket", averageBasket);
        addHourlySales(sales, series, startsAt, intervalMinutes, intervalCount, averageBasket, salesPlan);

        ArrayNode checkoutIncidents = checkoutSource.path("incidents").deepCopy();
        int checkoutResponseTotal = sumInt(checkoutIncidents, "response_minutes");
        int customersExposed = sumInt(checkoutIncidents, "customers_exposed_to_excess_wait");
        ObjectNode checkout = review.putObject("checkout");
        checkout.set("thresholds", checkoutThresholds.deepCopy());
        checkout.put("incident_count", checkoutIncidents.size());
        checkout.put("minutes_above_target", checkoutBreachIntervals * intervalMinutes);
        checkout.put("average_wait_minutes", roundOne(checkoutWaitTotal / intervalCount));
        checkout.put("peak_wait_minutes", roundOne(checkoutPeakWait));
        checkout.put("peak_people_in_queue", checkoutPeakQueue);
        checkout.put(
            "average_response_minutes",
            checkoutIncidents.isEmpty() ? 0 : roundOne(checkoutResponseTotal / (double) checkoutIncidents.size())
        );
        checkout.put("maximum_response_minutes", maximumInt(checkoutIncidents, "response_minutes"));
        checkout.put("additional_checkouts_opened", checkoutIncidents.size());
        checkout.put("customers_exposed_to_excess_wait", customersExposed);
        checkout.set("incidents", checkoutIncidents);

        JsonNode opdSource = simulation.path("opd");
        ArrayNode opdIncidents = opdSource.path("incidents").deepCopy();
        ObjectNode opd = review.putObject("opd");
        opd.put("target_pick_rate_items_per_hour", opdTargetRate);
        opd.put("incident_count", opdIncidents.size());
        opd.put("minutes_below_target", opdBelowTargetIntervals * intervalMinutes);
        opd.put("peak_items_in_pick_queue", opdPeakQueue);
        opd.put("peak_orders_at_risk", opdPeakOrdersAtRisk);
        opd.put("late_orders_at_close", opdSource.path("late_orders").asInt());
        opd.set("incidents", opdIncidents);

        JsonNode workforceSource = simulation.path("workforce");
        ArrayNode callouts = workforceSource.path("callouts").deepCopy();
        ObjectNode workforce = review.putObject("workforce");
        workforce.put("callout_count", callouts.size());
        workforce.put("fulfillment_understaffed_minutes", workforceGapIntervals * intervalMinutes);
        workforce.set("callouts", callouts);

        JsonNode inventorySource = simulation.path("inventory");
        ArrayNode stockouts = inventorySource.path("stockouts").deepCopy();
        int unservedRequests = sumInt(stockouts, "unserved_customer_requests");
        ObjectNode inventory = review.putObject("inventory");
        inventory.put("stockout_count", stockouts.size());
        inventory.put("total_stockout_minutes", sumInt(stockouts, "stockout_minutes"));
        inventory.put("unserved_customer_requests", unservedRequests);
        inventory.set("stockouts", stockouts);

        ObjectNode incidentSummary = review.putObject("incident_summary");
        incidentSummary.put(
            "operating_incidents",
            checkoutIncidents.size() + opdIncidents.size() + stockouts.size()
        );
        incidentSummary.put("workforce_callouts", callouts.size());
        incidentSummary.put(
            "total_recorded_events",
            checkoutIncidents.size() + opdIncidents.size() + stockouts.size() + callouts.size()
        );
        ObjectNode incidentsByDomain = incidentSummary.putObject("by_domain");
        incidentsByDomain.put("checkout", checkoutIncidents.size());
        incidentsByDomain.put("opd", opdIncidents.size());
        incidentsByDomain.put("inventory", stockouts.size());
        incidentsByDomain.put("workforce", callouts.size());

        ObjectNode serviceImpact = review.putObject("observed_service_impact");
        serviceImpact.put("customers_exposed_to_excess_checkout_wait", customersExposed);
        serviceImpact.put("opd_orders_late_at_close", opdSource.path("late_orders").asInt());
        serviceImpact.put("unserved_product_requests", unservedRequests);
        addAgentAssistedImpact(
            review,
            simulation,
            checkoutIncidents,
            opdSource,
            customersExposed,
            averageBasket
        );
        addOpportunityEstimate(
            review,
            simulation,
            customersExposed,
            averageBasket,
            stockouts
        );

        review.set("tomorrow_context", simulation.path("tomorrow_context").deepCopy());
        ObjectNode freshness = review.putObject("freshness");
        freshness.put("simulated_operations", endsAt.toString());
        freshness.put(
            "tomorrow_planning",
            simulation.path("tomorrow_context").path("planning_as_of").asText()
        );
        ObjectNode quality = review.putObject("data_quality");
        quality.put("status", "complete");
        quality.put("generated_samples", intervalCount);
        quality.put("expected_samples", intervalCount);
        quality.put("missing_samples", 0);
        return review;
    }

    private void addHourlySales(
        ObjectNode sales,
        JsonNode series,
        OffsetDateTime startsAt,
        int intervalMinutes,
        int intervalCount,
        double averageBasket,
        double salesPlan
    ) throws SimulationException {
        if (60 % intervalMinutes != 0) {
            throw new SimulationException(500, "simulation_error", "the interval must divide evenly into one hour");
        }
        int intervalsPerHour = 60 / intervalMinutes;
        int hourCount = intervalCount / intervalsPerHour;
        if (hourCount * intervalsPerHour != intervalCount) {
            throw new SimulationException(500, "simulation_error", "the simulated day must contain complete hours");
        }
        double hourlyPlan = salesPlan / hourCount;
        ArrayNode hourlyResults = sales.putArray("hourly_results");
        for (int hour = 0; hour < hourCount; hour++) {
            int hourTransactions = 0;
            for (int offset = 0; offset < intervalsPerHour; offset++) {
                hourTransactions += seriesInt(
                    series,
                    "sales_transactions",
                    hour * intervalsPerHour + offset
                );
            }
            double hourSales = roundTwo(hourTransactions * averageBasket);
            ObjectNode result = hourlyResults.addObject();
            result.put("starts_at", startsAt.plusHours(hour).toString());
            result.put("ends_at", startsAt.plusHours(hour + 1L).toString());
            result.put("transactions", hourTransactions);
            result.put("sales_plan", roundTwo(hourlyPlan));
            result.put("net_sales", hourSales);
            result.put("variance", roundTwo(hourSales - hourlyPlan));
        }
    }

    private void addOpportunityEstimate(
        ObjectNode review,
        JsonNode simulation,
        int customersExposed,
        double averageBasket,
        ArrayNode stockouts
    ) {
        JsonNode assumptions = simulation.path("opportunity_cost_assumptions");
        double checkoutRateLow = assumptions.path("checkout_abandonment_rate_low").asDouble();
        double checkoutRateHigh = assumptions.path("checkout_abandonment_rate_high").asDouble();
        double inventoryRateLow = assumptions.path("inventory_request_conversion_rate_low").asDouble();
        double inventoryRateHigh = assumptions.path("inventory_request_conversion_rate_high").asDouble();

        double checkoutCustomersLow = customersExposed * checkoutRateLow;
        double checkoutCustomersHigh = customersExposed * checkoutRateHigh;
        double checkoutRevenueLow = checkoutCustomersLow * averageBasket;
        double checkoutRevenueHigh = checkoutCustomersHigh * averageBasket;
        double inventoryPurchasesLow = 0;
        double inventoryPurchasesHigh = 0;
        double inventoryRevenueLow = 0;
        double inventoryRevenueHigh = 0;
        ArrayNode inventoryProducts = json.createArrayNode();
        for (JsonNode stockout : stockouts) {
            int requests = stockout.path("unserved_customer_requests").asInt();
            double price = stockout.path("unit_retail_price").asDouble();
            double purchasesLow = requests * inventoryRateLow;
            double purchasesHigh = requests * inventoryRateHigh;
            inventoryPurchasesLow += purchasesLow;
            inventoryPurchasesHigh += purchasesHigh;
            inventoryRevenueLow += purchasesLow * price;
            inventoryRevenueHigh += purchasesHigh * price;
            ObjectNode product = inventoryProducts.addObject();
            product.put("sku", stockout.path("sku").asText());
            product.put("product_name", stockout.path("product_name").asText());
            product.put("unserved_customer_requests", requests);
            product.put("unit_retail_price", price);
            product.put("estimated_revenue_at_risk_low", roundTwo(purchasesLow * price));
            product.put("estimated_revenue_at_risk_high", roundTwo(purchasesHigh * price));
        }

        ObjectNode estimate = review.putObject("estimated_opportunity_cost");
        estimate.put("status", "estimated_not_confirmed");
        estimate.put("currency", simulation.path("currency").asText());
        ObjectNode checkout = estimate.putObject("checkout");
        checkout.put("customers_exposed_to_excess_wait", customersExposed);
        checkout.put("abandonment_rate_low", checkoutRateLow);
        checkout.put("abandonment_rate_high", checkoutRateHigh);
        checkout.put("estimated_abandoned_transactions_low", roundOne(checkoutCustomersLow));
        checkout.put("estimated_abandoned_transactions_high", roundOne(checkoutCustomersHigh));
        checkout.put("estimated_revenue_at_risk_low", roundTwo(checkoutRevenueLow));
        checkout.put("estimated_revenue_at_risk_high", roundTwo(checkoutRevenueHigh));
        ObjectNode inventory = estimate.putObject("inventory");
        inventory.put("request_conversion_rate_low", inventoryRateLow);
        inventory.put("request_conversion_rate_high", inventoryRateHigh);
        inventory.put("estimated_unserved_purchases_low", roundOne(inventoryPurchasesLow));
        inventory.put("estimated_unserved_purchases_high", roundOne(inventoryPurchasesHigh));
        inventory.put("estimated_revenue_at_risk_low", roundTwo(inventoryRevenueLow));
        inventory.put("estimated_revenue_at_risk_high", roundTwo(inventoryRevenueHigh));
        inventory.set("products", inventoryProducts);
        estimate.put(
            "combined_estimated_revenue_at_risk_low",
            roundTwo(checkoutRevenueLow + inventoryRevenueLow)
        );
        estimate.put(
            "combined_estimated_revenue_at_risk_high",
            roundTwo(checkoutRevenueHigh + inventoryRevenueHigh)
        );
        estimate.put("methodology_note", assumptions.path("methodology_note").asText());
        estimate.put(
            "double_counting_warning",
            "Do not add this estimate to the observed sales variance because the two measures can overlap."
        );
    }

    private void addAgentAssistedImpact(
        ObjectNode review,
        JsonNode simulation,
        ArrayNode checkoutIncidents,
        JsonNode opdSource,
        int customersExposed,
        double averageBasket
    ) throws SimulationException {
        JsonNode source = simulation.path("agent_assisted_actions");
        JsonNode checkoutSource = source.path("checkout");
        JsonNode opdActionSource = source.path("opd");
        JsonNode inventorySource = source.path("inventory");
        if (!source.isObject() || !checkoutSource.isObject()
            || !opdActionSource.isObject() || !inventorySource.isObject()) {
            throw new SimulationException(
                500,
                "simulation_error",
                "agent-assisted action evidence is incomplete"
            );
        }

        JsonNode assumptions = simulation.path("opportunity_cost_assumptions");
        double abandonmentLow = fixtureRate(assumptions, "checkout_abandonment_rate_low");
        double abandonmentHigh = fixtureRate(assumptions, "checkout_abandonment_rate_high");
        if (abandonmentLow > abandonmentHigh) {
            throw new SimulationException(500, "simulation_error", "checkout abandonment range is invalid");
        }

        int recoveredIncidents = 0;
        for (JsonNode incident : checkoutIncidents) {
            if ("recovered".equals(incident.path("outcome").asText())) {
                recoveredIncidents++;
            }
        }
        double waitBefore = fixtureNonNegativeDouble(
            checkoutSource,
            "peak_wait_before_minutes",
            "checkout action"
        );
        double waitAfter = fixtureNonNegativeDouble(
            checkoutSource,
            "maximum_wait_at_recovery_minutes",
            "checkout action"
        );
        if (waitAfter > waitBefore) {
            throw new SimulationException(500, "simulation_error", "checkout recovery wait is invalid");
        }
        int projectedCustomers = fixtureNonNegativeInt(
            checkoutSource,
            "projected_customers_exposed_without_action",
            "checkout action"
        );
        if (projectedCustomers < customersExposed) {
            throw new SimulationException(500, "simulation_error", "checkout counterfactual is invalid");
        }
        int estimatedCustomersAvoided = projectedCustomers - customersExposed;
        double retainedTransactionsLow = estimatedCustomersAvoided * abandonmentLow;
        double retainedTransactionsHigh = estimatedCustomersAvoided * abandonmentHigh;
        double retainedRevenueLow = retainedTransactionsLow * averageBasket;
        double retainedRevenueHigh = retainedTransactionsHigh * averageBasket;

        int pickRateBefore = fixtureNonNegativeInt(
            opdActionSource,
            "pick_rate_before_items_per_hour",
            "OPD action"
        );
        int pickRateAfter = fixtureNonNegativeInt(
            opdActionSource,
            "pick_rate_at_checkpoint_items_per_hour",
            "OPD action"
        );
        int actualLateOrders = opdSource.path("late_orders").asInt(-1);
        int projectedLateOrders = fixtureNonNegativeInt(
            opdActionSource,
            "projected_late_orders_without_action",
            "OPD action"
        );
        if (pickRateAfter < pickRateBefore || actualLateOrders < 0
            || projectedLateOrders < actualLateOrders) {
            throw new SimulationException(500, "simulation_error", "OPD action impact is invalid");
        }

        JsonNode offerRecords = inventorySource.path("alternative_offer_records");
        if (!offerRecords.isArray() || offerRecords.isEmpty()
            || !inventorySource.path("purchase_receipts_included_in_observed_net_sales").asBoolean(false)) {
            throw new SimulationException(500, "simulation_error", "inventory action evidence is invalid");
        }
        Set<String> stockoutSkus = new HashSet<>();
        for (JsonNode stockout : simulation.path("inventory").path("stockouts")) {
            stockoutSkus.add(fixtureText(stockout, "sku", "inventory stockout"));
        }
        Set<String> offerIds = new HashSet<>();
        Set<String> purchaseReceiptIds = new HashSet<>();
        ArrayNode linkedPurchaseReceiptIds = json.createArrayNode();
        OffsetDateTime simulationStartsAt = OffsetDateTime.parse(simulation.path("start_at").asText());
        OffsetDateTime simulationEndsAt = simulationStartsAt.plusHours(8);
        int linkedPurchases = 0;
        double linkedPurchaseSales = 0;
        for (JsonNode offerRecord : offerRecords) {
            if (!offerRecord.isObject()) {
                throw new SimulationException(500, "simulation_error", "alternative-offer evidence is invalid");
            }
            String offerId = fixtureText(offerRecord, "offer_id", "alternative offer");
            if (!offerIds.add(offerId)) {
                throw new SimulationException(500, "simulation_error", "alternative-offer IDs must be unique");
            }
            OffsetDateTime offeredAt;
            try {
                offeredAt = OffsetDateTime.parse(
                    fixtureText(offerRecord, "offered_at", "alternative offer")
                );
            } catch (RuntimeException error) {
                throw new SimulationException(500, "simulation_error", "alternative-offer timestamp is invalid");
            }
            if (offeredAt.isBefore(simulationStartsAt) || !offeredAt.isBefore(simulationEndsAt)) {
                throw new SimulationException(500, "simulation_error", "alternative offer is outside the simulated day");
            }
            String originalSku = fixtureText(offerRecord, "original_sku", "alternative offer");
            String alternativeSku = fixtureText(offerRecord, "alternative_sku", "alternative offer");
            fixtureText(offerRecord, "alternative_product_name", "alternative offer");
            if (!stockoutSkus.contains(originalSku) || originalSku.equals(alternativeSku)) {
                throw new SimulationException(500, "simulation_error", "alternative-offer product linkage is invalid");
            }
            String outcome = fixtureText(offerRecord, "outcome", "alternative offer");
            if ("completed_purchase".equals(outcome)) {
                OffsetDateTime purchasedAt;
                try {
                    purchasedAt = OffsetDateTime.parse(
                        fixtureText(offerRecord, "purchased_at", "completed alternative purchase")
                    );
                } catch (RuntimeException error) {
                    throw new SimulationException(500, "simulation_error", "linked POS timestamp is invalid");
                }
                String receiptId = fixtureText(
                    offerRecord,
                    "purchase_receipt_id",
                    "completed alternative purchase"
                );
                double netSales = fixtureNonNegativeDouble(
                    offerRecord,
                    "net_sales",
                    "completed alternative purchase"
                );
                if (!purchasedAt.isAfter(offeredAt) || !purchasedAt.isBefore(simulationEndsAt)
                    || netSales <= 0 || !purchaseReceiptIds.add(receiptId)) {
                    throw new SimulationException(500, "simulation_error", "linked POS receipt is invalid");
                }
                linkedPurchases++;
                linkedPurchaseSales += netSales;
                linkedPurchaseReceiptIds.add(receiptId);
            } else if ("declined".equals(outcome)) {
                if (offerRecord.hasNonNull("purchased_at")
                    || offerRecord.hasNonNull("purchase_receipt_id")
                    || offerRecord.hasNonNull("net_sales")) {
                    throw new SimulationException(500, "simulation_error", "declined offer cannot have a POS receipt");
                }
            } else {
                throw new SimulationException(500, "simulation_error", "alternative-offer outcome is invalid");
            }
        }

        ObjectNode impact = review.putObject("agent_assisted_impact");
        impact.put("status", "simulated_attributed");
        impact.put("workflow", fixtureText(source, "workflow", "agent-assisted actions"));
        impact.put(
            "attribution_note",
            fixtureText(source, "attribution_note", "agent-assisted actions")
        );
        ObjectNode provenance = impact.putObject("provenance");
        provenance.put("recommended_by", "hermes");
        provenance.put("approved_by", "store_manager");
        provenance.put("executed_by", "simulated_external_system");

        ArrayNode actions = impact.putArray("actions");
        ObjectNode checkoutAction = addAction(actions, "checkout", checkoutSource);
        ObjectNode checkoutMeasured = checkoutAction.putObject("measured");
        checkoutMeasured.put("incidents_recovered", recoveredIncidents);
        checkoutMeasured.put("peak_wait_before_minutes", waitBefore);
        checkoutMeasured.put("maximum_wait_at_recovery_minutes", waitAfter);
        checkoutMeasured.put("wait_reduction_minutes", roundOne(waitBefore - waitAfter));
        checkoutMeasured.put("customers_exposed_to_excess_wait", customersExposed);
        ObjectNode checkoutEstimated = checkoutAction.putObject("estimated_counterfactual");
        checkoutEstimated.put("projected_customers_exposed_without_action", projectedCustomers);
        checkoutEstimated.put("customers_avoiding_excess_wait", estimatedCustomersAvoided);
        checkoutEstimated.put("retained_transactions_low", roundOne(retainedTransactionsLow));
        checkoutEstimated.put("retained_transactions_high", roundOne(retainedTransactionsHigh));
        checkoutEstimated.put("revenue_retained_low", roundTwo(retainedRevenueLow));
        checkoutEstimated.put("revenue_retained_high", roundTwo(retainedRevenueHigh));

        ObjectNode opdAction = addAction(actions, "opd", opdActionSource);
        ObjectNode opdMeasured = opdAction.putObject("measured");
        opdMeasured.put("pick_rate_before_items_per_hour", pickRateBefore);
        opdMeasured.put("pick_rate_at_checkpoint_items_per_hour", pickRateAfter);
        opdMeasured.put("pick_rate_increase_items_per_hour", pickRateAfter - pickRateBefore);
        opdMeasured.put("late_orders_at_close", actualLateOrders);
        ObjectNode opdEstimated = opdAction.putObject("estimated_counterfactual");
        opdEstimated.put("projected_late_orders_without_action", projectedLateOrders);
        opdEstimated.put("late_orders_avoided", projectedLateOrders - actualLateOrders);

        ObjectNode inventoryAction = addAction(actions, "inventory", inventorySource);
        ObjectNode inventoryMeasured = inventoryAction.putObject("measured");
        inventoryMeasured.put("evidence_source", fixtureText(inventorySource, "evidence_source", "inventory action"));
        inventoryMeasured.put("link_method", fixtureText(inventorySource, "link_method", "inventory action"));
        inventoryMeasured.put("alternative_offers_recorded", offerRecords.size());
        inventoryMeasured.put("linked_completed_purchases", linkedPurchases);
        inventoryMeasured.put(
            "offer_to_purchase_rate_percent",
            roundOne(linkedPurchases / (double) offerRecords.size() * 100)
        );
        inventoryMeasured.put(
            "sales_from_linked_purchases",
            roundTwo(linkedPurchaseSales)
        );
        inventoryMeasured.put("included_in_observed_net_sales", true);
        inventoryMeasured.set("linked_purchase_receipt_ids", linkedPurchaseReceiptIds);
        inventoryMeasured.set("evidence_records", offerRecords.deepCopy());

        ObjectNode summary = impact.putObject("summary");
        summary.put("approved_actions_executed", actions.size());
        summary.put("checkout_incidents_recovered", recoveredIncidents);
        summary.put("checkout_wait_reduction_minutes", roundOne(waitBefore - waitAfter));
        summary.put("estimated_customers_avoiding_excess_wait", estimatedCustomersAvoided);
        summary.put("estimated_retained_transactions_low", roundOne(retainedTransactionsLow));
        summary.put("estimated_retained_transactions_high", roundOne(retainedTransactionsHigh));
        summary.put("estimated_checkout_revenue_retained_low", roundTwo(retainedRevenueLow));
        summary.put("estimated_checkout_revenue_retained_high", roundTwo(retainedRevenueHigh));
        summary.put("opd_pick_rate_increase_items_per_hour", pickRateAfter - pickRateBefore);
        summary.put("estimated_late_orders_avoided", projectedLateOrders - actualLateOrders);
        summary.put("alternative_offers_recorded", offerRecords.size());
        summary.put("linked_completed_purchases", linkedPurchases);
        summary.put(
            "offer_to_purchase_rate_percent",
            roundOne(linkedPurchases / (double) offerRecords.size() * 100)
        );
        summary.put("sales_from_linked_purchases", roundTwo(linkedPurchaseSales));
        summary.put("linked_purchase_sales_included_in_net_sales", true);
    }

    private ObjectNode addAction(ArrayNode actions, String domain, JsonNode source)
        throws SimulationException {
        if (!source.path("manager_approved").asBoolean(false)
            || !"completed".equals(source.path("execution_status").asText())) {
            throw new SimulationException(500, "simulation_error", domain + " action was not completed");
        }
        JsonNode receiptIds = source.path("action_receipt_ids");
        if (!receiptIds.isArray() || receiptIds.size() == 0) {
            throw new SimulationException(500, "simulation_error", domain + " action receipts are missing");
        }
        ObjectNode action = actions.addObject();
        action.put("domain", domain);
        action.put("recommendation_id", fixtureText(source, "recommendation_id", domain + " action"));
        action.put(
            "manager_approval_id",
            fixtureText(source, "manager_approval_id", domain + " action")
        );
        action.set("action_receipt_ids", receiptIds.deepCopy());
        action.put("recommendation", fixtureText(source, "recommendation", domain + " action"));
        action.put("manager_approved", true);
        action.put("execution_status", "completed");
        return action;
    }

    private String fixtureText(JsonNode source, String field, String context)
        throws SimulationException {
        String value = source.path(field).asText(null);
        if (value == null || value.isBlank()) {
            throw new SimulationException(500, "simulation_error", context + " " + field + " is missing");
        }
        return value;
    }

    private int fixtureNonNegativeInt(JsonNode source, String field, String context)
        throws SimulationException {
        JsonNode value = source.path(field);
        if (!value.canConvertToInt() || value.asInt() < 0) {
            throw new SimulationException(500, "simulation_error", context + " " + field + " is invalid");
        }
        return value.asInt();
    }

    private double fixtureNonNegativeDouble(JsonNode source, String field, String context)
        throws SimulationException {
        JsonNode value = source.path(field);
        if (!value.isNumber() || !Double.isFinite(value.asDouble()) || value.asDouble() < 0) {
            throw new SimulationException(500, "simulation_error", context + " " + field + " is invalid");
        }
        return value.asDouble();
    }

    private double fixtureRate(JsonNode source, String field) throws SimulationException {
        double value = fixtureNonNegativeDouble(source, field, "opportunity-cost assumption");
        if (value > 1) {
            throw new SimulationException(500, "simulation_error", field + " must be between zero and one");
        }
        return value;
    }

    private ObjectNode baseResponse(JsonNode source) throws IOException {
        ObjectNode response = json.createObjectNode();
        response.put("contract_version", source.path("contract_version").asText());
        response.put("store_id", source.path("store_id").asText());
        response.put("business_date", source.path("business_date").asText());
        response.put("simulation_run_id", simulationRunId);
        response.set("store", sourceFile("store.json").path("store").deepCopy());
        return response;
    }

    private void validatePeriod(int intervalMinutes, int intervalCount)
        throws SimulationException {
        if (intervalMinutes < 5 || intervalMinutes > 60 || intervalCount < 1
            || intervalMinutes * intervalCount != 480) {
            throw new SimulationException(
                500,
                "simulation_error",
                "the independent store-day fixture must describe exactly eight hours"
            );
        }
    }

    private void validateSeries(JsonNode series, int expectedCount)
        throws SimulationException {
        String[] fields = {
            "sales_transactions",
            "checkout_people_in_queue",
            "checkout_wait_minutes",
            "checkout_staffed_lanes",
            "opd_pick_rate_items_per_hour",
            "opd_items_in_pick_queue",
            "opd_orders_at_risk",
            "fulfillment_actual_headcount",
            "fulfillment_required_headcount",
            "rain_umbrella_on_hand"
        };
        for (String field : fields) {
            JsonNode values = series.path(field);
            if (!values.isArray() || values.size() != expectedCount) {
                throw new SimulationException(
                    500,
                    "simulation_error",
                    "the " + field + " series does not cover the full store day"
                );
            }
            for (JsonNode value : values) {
                if (!value.isNumber()) {
                    throw new SimulationException(
                        500,
                        "simulation_error",
                        "the " + field + " series contains a non-numeric value"
                    );
                }
            }
        }
    }

    private int seriesInt(JsonNode series, String field, int index)
        throws SimulationException {
        JsonNode value = series.path(field).path(index);
        if (!value.canConvertToInt() || value.asInt() < 0) {
            throw new SimulationException(500, "simulation_error", field + " contains an invalid value");
        }
        return value.asInt();
    }

    private double seriesDouble(JsonNode series, String field, int index)
        throws SimulationException {
        JsonNode value = series.path(field).path(index);
        if (!value.isNumber() || value.asDouble() < 0) {
            throw new SimulationException(500, "simulation_error", field + " contains an invalid value");
        }
        return value.asDouble();
    }

    private int sumInt(ArrayNode values, String field) {
        int total = 0;
        for (JsonNode value : values) {
            total += value.path(field).asInt();
        }
        return total;
    }

    private int maximumInt(ArrayNode values, String field) {
        int maximum = 0;
        for (JsonNode value : values) {
            maximum = Math.max(maximum, value.path(field).asInt());
        }
        return maximum;
    }

    private String requiredText(ObjectNode request, String field) throws SimulationException {
        String value = request.path(field).asText(null);
        if (value == null || value.isBlank()) {
            throw new SimulationException(400, "invalid_request", field + " is required");
        }
        return value;
    }

    private void validateIdentity(String storeId, String businessDate)
        throws IOException, SimulationException {
        if (storeId == null || businessDate == null || storeId.isBlank() || businessDate.isBlank()) {
            throw new SimulationException(400, "invalid_request", "store_id and business_date are required");
        }
        try {
            LocalDate.parse(businessDate);
        } catch (Exception ignored) {
            throw new SimulationException(400, "invalid_request", "business_date must use YYYY-MM-DD");
        }
        JsonNode source = simulationSource();
        if (!storeId.equals(source.path("store_id").asText())) {
            throw new SimulationException(404, "store_not_found", "no end-of-day simulation exists for this store_id");
        }
        if (!businessDate.equals(source.path("business_date").asText())) {
            throw new SimulationException(404, "business_date_not_found", "no end-of-day simulation exists for this date");
        }
    }

    private JsonNode simulationSource() throws IOException {
        return sourceFile("end-of-day-simulation.json");
    }

    private JsonNode sourceFile(String filename) throws IOException {
        return data.source(filename);
    }

    private double roundOne(double value) {
        return Math.round(value * 10.0) / 10.0;
    }

    private double roundTwo(double value) {
        return Math.round(value * 100.0) / 100.0;
    }
}
