import {
  projectCheckoutState,
  unavailableCheckoutState,
} from "../../checkout-demo-model.mjs";
import {
  camelRequest,
  noStoreJson as json,
  notifyHermes,
  operatingState,
  runtimeIdentity,
  sameOrigin,
  simulatedApprovalEnabled,
} from "../store-manager-runtime";

export const dynamic = "force-dynamic";

const PLAN_ID_PATTERN = /^[A-Z0-9-]{1,64}$/;
const OPERATING_STATE_PATH = "/v1/store-checkout-operating-state";

type DemoAction = "reset" | "trigger" | "approve" | "advance";

async function checkoutOperatingState() {
  return operatingState(OPERATING_STATE_PATH);
}

async function publishCheckoutEvent(
  eventType: "checkout_queue_incident" | "checkout_queue_checkpoint",
  eventResponse: Record<string, unknown>,
) {
  const identity = runtimeIdentity();
  const state = eventResponse.operating_state as Record<string, unknown>;
  if (!state || typeof state !== "object") {
    throw new Error("event response did not include checkout state");
  }
  const stateVersion = Number(state.state_version);
  await notifyHermes("checkout-queue", {
    business_date: identity.business_date,
    event_result: String(eventResponse.event_result || ""),
    event_type: eventType,
    notification_id: `${eventType}-${stateVersion}-${crypto.randomUUID()}`,
    simulated_at: String(state.simulated_at || ""),
    source: "synthetic-checkout-vision",
    state_version: stateVersion,
    store_id: identity.store_id,
  });
}

function projected(state: Record<string, unknown>) {
  const identity = runtimeIdentity();
  if (
    state.store_id !== identity.store_id
    || state.business_date !== identity.business_date
    || !state.metrics
    || typeof state.metrics !== "object"
    || Array.isArray(state.metrics)
  ) {
    throw new Error("Camel checkout state did not match the installed demo identity");
  }
  return projectCheckoutState(state, {
    simulatedApproval: simulatedApprovalEnabled(),
  });
}

export async function GET() {
  try {
    return json(projected(await checkoutOperatingState()));
  } catch {
    return json(unavailableCheckoutState());
  }
}

async function parseAction(request: Request) {
  const body = await request.json() as { action?: unknown; planId?: unknown };
  const action = typeof body?.action === "string" ? body.action as DemoAction : null;
  if (!action || !["reset", "trigger", "approve", "advance"].includes(action)) {
    throw new Error("unsupported demo action");
  }
  const planId = typeof body.planId === "string" && PLAN_ID_PATTERN.test(body.planId)
    ? body.planId
    : null;
  return { action, planId };
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return json(
      { error: "cross_origin_request", message: "Use the controls from this demo page." },
      403,
    );
  }

  try {
    const { action, planId } = await parseAction(request);
    const identity = runtimeIdentity();

    if (action === "reset" || action === "trigger") {
      const eventResponse = await camelRequest("/v1/demo/checkout-events", {
        ...identity,
        operation: action === "reset" ? "reset" : "queue_surge",
      });
      if (action === "trigger") {
        await publishCheckoutEvent("checkout_queue_incident", eventResponse);
      }
      return json(projected(eventResponse.operating_state as Record<string, unknown>));
    }

    if (action === "approve") {
      if (!simulatedApprovalEnabled()) {
        return json(
          { error: "simulated_approval_disabled", message: "Approve this decision in Telegram." },
          403,
        );
      }
      const current = await checkoutOperatingState();
      const decision = current.decision as Record<string, unknown> | undefined;
      if (
        !decision
        || decision.status !== "pending_manager_approval"
        || decision.decision_author !== "hermes"
      ) {
        return json(
          { error: "no_pending_decision", message: "Hermes has not produced a current checkout decision yet." },
          409,
        );
      }

      const feasiblePlans = Array.isArray(decision.feasible_plans)
        ? decision.feasible_plans
        : [];
      const selectedPlanId = planId || String(decision.recommended_plan_id || "");
      const selectedPlanExists = PLAN_ID_PATTERN.test(selectedPlanId)
        && feasiblePlans.some((value) => {
          return value
            && typeof value === "object"
            && (value as Record<string, unknown>).plan_id === selectedPlanId;
        });
      if (!selectedPlanExists) {
        return json(
          { error: "invalid_plan", message: "That checkout plan is no longer available." },
          409,
        );
      }

      await camelRequest("/v1/store-checkout-actions", {
        ...identity,
        disposition: "approve",
        decision_id: decision.decision_id,
        expected_state_version: decision.based_on_state_version,
        plan_id: selectedPlanId,
        idempotency_key: `${decision.decision_id}-approve-${selectedPlanId}`,
      });
      return json(projected(await checkoutOperatingState()));
    }

    const current = await checkoutOperatingState();
    const checkpoint = current.checkpoint as Record<string, unknown> | undefined;
    const afterMinutes = Math.max(
      1,
      Math.min(60, Math.round(Number(checkpoint?.after_minutes) || 10)),
    );
    const eventResponse = await camelRequest("/v1/demo/checkout-events", {
      ...identity,
      operation: "advance_time",
      minutes: afterMinutes,
    });
    await publishCheckoutEvent("checkout_queue_checkpoint", eventResponse);
    return json(projected(eventResponse.operating_state as Record<string, unknown>));
  } catch (error) {
    const message = error instanceof Error && /unsupported demo action/.test(error.message)
      ? "Choose a supported checkout demo action."
      : "The checkout demo could not reach the deployed Store Manager workflow.";
    return json({ error: "checkout_demo_unavailable", message }, 503);
  }
}
