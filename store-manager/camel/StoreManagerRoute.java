import java.io.IOException;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.camel.Exchange;
import org.apache.camel.builder.RouteBuilder;

public class StoreManagerRoute extends RouteBuilder {
    private final StoreDataRepository data = new StoreDataRepository(
        System.getenv().getOrDefault(
            "STORE_MANAGER_DATA_DIR",
            System.getenv().getOrDefault("MORNING_BRIEFING_DATA_DIR", "data")
        )
    );
    private final ObjectMapper json = data.mapper();
    private final StoreSnapshotService snapshots = new StoreSnapshotService(data);
    private final OpdOperatingSimulation opdSimulation = new OpdOperatingSimulation(data);
    private final CheckoutQueueSimulation checkoutSimulation = new CheckoutQueueSimulation(data);
    private final EndOfDaySimulation endOfDaySimulation = new EndOfDaySimulation(data);
    private final IncidentResponseService incidentResponse = new IncidentResponseService(data);

    @Override
    public void configure() {
        from("platform-http:/health?httpMethodRestrict=GET")
            .routeId("morning-briefing-health")
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"))
            .setBody(constant("{\"status\":\"ok\"}"));

        from("platform-http:/v1/store-morning-snapshot?httpMethodRestrict=GET")
            .routeId("store-morning-snapshot")
            .process(snapshots::buildSnapshot)
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/store-opd-recovery?httpMethodRestrict=GET")
            .routeId("store-opd-recovery")
            .process(snapshots::buildOpdRecovery)
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/store-opd-operating-state?httpMethodRestrict=GET")
            .routeId("store-opd-operating-state")
            .process(exchange -> runOpdSimulationRequest(exchange, "status"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/store-opd-recovery-plans?httpMethodRestrict=POST")
            .routeId("store-opd-recovery-plans")
            .process(exchange -> runOpdSimulationRequest(exchange, "plan"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/store-opd-decisions?httpMethodRestrict=POST")
            .routeId("store-opd-decisions")
            .process(exchange -> runOpdSimulationRequest(exchange, "commit"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/store-opd-manager-message?httpMethodRestrict=POST")
            .routeId("store-opd-manager-message")
            .process(exchange -> runOpdSimulationRequest(exchange, "manager-message-ready"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/store-opd-actions?httpMethodRestrict=POST")
            .routeId("store-opd-actions")
            .process(exchange -> runOpdSimulationRequest(exchange, "decide"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/demo/events?httpMethodRestrict=POST")
            .routeId("store-opd-demo-events")
            .process(exchange -> runOpdSimulationRequest(exchange, "event"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/store-checkout-operating-state?httpMethodRestrict=GET")
            .routeId("store-checkout-operating-state")
            .process(exchange -> runCheckoutSimulationRequest(exchange, "status"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/store-checkout-recovery-plans?httpMethodRestrict=POST")
            .routeId("store-checkout-recovery-plans")
            .process(exchange -> runCheckoutSimulationRequest(exchange, "plan"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/store-checkout-decisions?httpMethodRestrict=POST")
            .routeId("store-checkout-decisions")
            .process(exchange -> runCheckoutSimulationRequest(exchange, "commit"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/store-checkout-actions?httpMethodRestrict=POST")
            .routeId("store-checkout-actions")
            .process(exchange -> runCheckoutSimulationRequest(exchange, "decide"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/demo/checkout-events?httpMethodRestrict=POST")
            .routeId("store-checkout-demo-events")
            .process(exchange -> runCheckoutSimulationRequest(exchange, "event"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/store-end-of-day-review?httpMethodRestrict=GET")
            .routeId("store-end-of-day-review")
            .process(exchange -> runEndOfDaySimulationRequest(exchange, "review"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/demo/store-day?httpMethodRestrict=POST")
            .routeId("store-end-of-day-demo-events")
            .process(exchange -> runEndOfDaySimulationRequest(exchange, "event"))
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));

        from("platform-http:/v1/store-incident-response-plans?httpMethodRestrict=POST")
            .routeId("store-incident-response-plans")
            .process(this::runIncidentResponseRequest)
            .setHeader(Exchange.CONTENT_TYPE, constant("application/json"));
    }

    private void runOpdSimulationRequest(Exchange exchange, String operation) throws Exception {
        try {
            ObjectNode result;
            if ("status".equals(operation)) {
                result = opdSimulation.status(
                    exchange.getMessage().getHeader("store_id", String.class),
                    exchange.getMessage().getHeader("business_date", String.class)
                );
            } else {
                ObjectNode request = requestBody(exchange);
                result = switch (operation) {
                    case "plan" -> opdSimulation.plan(request);
                    case "commit" -> opdSimulation.commitDecision(request);
                    case "manager-message-ready" -> opdSimulation.markManagerMessageReady(request);
                    case "decide" -> opdSimulation.decide(request);
                    case "event" -> opdSimulation.event(request);
                    default -> throw new IllegalArgumentException("unsupported simulation operation");
                };
            }
            exchange.getMessage().setBody(json.writeValueAsString(result));
        } catch (SimulationException exception) {
            error(exchange, exception.status, exception.code, exception.getMessage());
        } catch (IOException | RuntimeException exception) {
            error(exchange, 500, "simulation_error", "the synthetic OPD simulator could not process the request");
        }
    }

    private void runCheckoutSimulationRequest(Exchange exchange, String operation) throws Exception {
        try {
            ObjectNode result;
            if ("status".equals(operation)) {
                result = checkoutSimulation.status(
                    exchange.getMessage().getHeader("store_id", String.class),
                    exchange.getMessage().getHeader("business_date", String.class)
                );
            } else {
                ObjectNode request = requestBody(exchange);
                result = switch (operation) {
                    case "plan" -> checkoutSimulation.plan(request);
                    case "commit" -> checkoutSimulation.commitDecision(request);
                    case "decide" -> checkoutSimulation.decide(request);
                    case "event" -> checkoutSimulation.event(request);
                    default -> throw new IllegalArgumentException("unsupported checkout simulation operation");
                };
            }
            exchange.getMessage().setBody(json.writeValueAsString(result));
        } catch (SimulationException exception) {
            error(exchange, exception.status, exception.code, exception.getMessage());
        } catch (IOException | RuntimeException exception) {
            error(exchange, 500, "simulation_error", "the synthetic checkout simulator could not process the request");
        }
    }

    private void runEndOfDaySimulationRequest(Exchange exchange, String operation) throws Exception {
        try {
            ObjectNode result;
            if ("review".equals(operation)) {
                result = endOfDaySimulation.review(
                    exchange.getMessage().getHeader("store_id", String.class),
                    exchange.getMessage().getHeader("business_date", String.class)
                );
            } else {
                result = endOfDaySimulation.event(requestBody(exchange));
            }
            exchange.getMessage().setBody(json.writeValueAsString(result));
        } catch (SimulationException exception) {
            error(exchange, exception.status, exception.code, exception.getMessage());
        } catch (IOException | RuntimeException exception) {
            error(exchange, 500, "simulation_error", "the synthetic end-of-day simulator could not process the request");
        }
    }

    private void runIncidentResponseRequest(Exchange exchange) throws Exception {
        try {
            ObjectNode result = incidentResponse.plan(requestBody(exchange));
            exchange.getMessage().setBody(json.writeValueAsString(result));
        } catch (SimulationException exception) {
            error(exchange, exception.status, exception.code, exception.getMessage());
        } catch (IOException | RuntimeException exception) {
            error(exchange, 500, "connector_error", "the synthetic incident response planner could not process the request");
        }
    }

    private ObjectNode requestBody(Exchange exchange) throws IOException, SimulationException {
        String rawBody = exchange.getMessage().getBody(String.class);
        JsonNode request;
        try {
            request = json.readTree(rawBody == null || rawBody.isBlank() ? "{}" : rawBody);
        } catch (IOException exception) {
            throw new SimulationException(400, "invalid_request", "request body must be valid JSON");
        }
        if (!request.isObject()) {
            throw new SimulationException(400, "invalid_request", "request body must be a JSON object");
        }
        return (ObjectNode) request;
    }

    private void error(Exchange exchange, int status, String code, String message) throws IOException {
        ObjectNode error = json.createObjectNode();
        error.put("error", code);
        error.put("message", message);
        exchange.getMessage().setHeader(Exchange.HTTP_RESPONSE_CODE, status);
        exchange.getMessage().setBody(json.writeValueAsString(error));
    }
}
