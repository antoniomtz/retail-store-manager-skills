import {
  projectOpdState,
  unavailableOpdState,
} from "../../opd-demo-model.mjs";
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
const OPERATING_STATE_PATH = "/v1/store-opd-operating-state";

type DemoAction = "reset" | "trigger" | "approve" | "advance";

async function opdOperatingState() {
  return operatingState(OPERATING_STATE_PATH);
}

async function publishOpdEvent(
  eventType: "opd_incident" | "opd_checkpoint",
  eventResponse: Record<string, unknown>,
) {
  const identity = runtimeIdentity();
  const state = eventResponse.operating_state as Record<string, unknown>;
  if (!state || typeof state !== "object") {
    throw new Error("event response did not include OPD state");
  }
  const stateVersion = Number(state.state_version);
  await notifyHermes("opd-surge", {
    business_date: identity.business_date,
    event_result: String(eventResponse.event_result || ""),
    event_type: eventType,
    notification_id: `${eventType}-${stateVersion}-${crypto.randomUUID()}`,
    simulated_at: String(state.simulated_at || ""),
    source: "synthetic-opd-operations",
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
    throw new Error("Camel OPD state did not match the installed demo identity");
  }
  return projectOpdState(state, {
    simulatedApproval: simulatedApprovalEnabled(),
  });
}

export async function GET() {
  try {
    return json(projected(await opdOperatingState()));
  } catch {
    return json(unavailableOpdState());
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
      const eventResponse = await camelRequest("/v1/demo/events", {
        ...identity,
        operation: action === "reset" ? "reset" : "incident",
      });
      if (action === "trigger") {
        await publishOpdEvent("opd_incident", eventResponse);
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
      const current = await opdOperatingState();
      const decision = current.decision as Record<string, unknown> | undefined;
      if (
        !decision
        || decision.status !== "pending_manager_approval"
        || decision.decision_author !== "hermes"
        || decision.manager_message_status !== "ready"
      ) {
        return json(
          { error: "no_pending_decision", message: "Hermes has not produced a current OPD decision yet." },
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
          { error: "invalid_plan", message: "That OPD plan is no longer available." },
          409,
        );
      }

      await camelRequest("/v1/store-opd-actions", {
        ...identity,
        disposition: "approve",
        decision_id: decision.decision_id,
        expected_state_version: decision.based_on_state_version,
        plan_id: selectedPlanId,
        idempotency_key: `${decision.decision_id}-approve-${selectedPlanId}`,
      });
      return json(projected(await opdOperatingState()));
    }

    const current = await opdOperatingState();
    const checkpoint = current.checkpoint as Record<string, unknown> | undefined;
    const recoveryContext = current.recovery_context as Record<string, unknown> | undefined;
    const checkpointStage = String(checkpoint?.stage || "");
    const checkpointStatus = String(checkpoint?.status || "");
    const checkpointCanAdvance = checkpointStatus === "scheduled"
      || (checkpointStage === "progress" && ["met", "missed"].includes(checkpointStatus));
    if (!checkpoint || !checkpointCanAdvance) {
      return json(
        { error: "checkpoint_not_scheduled", message: "No OPD recovery checkpoint is ready to measure." },
        409,
      );
    }
    const afterMinutes = Math.max(
      1,
      Math.min(
        240,
        Math.round(
          Number(checkpoint.next_measurement_after_minutes)
          || Number(recoveryContext?.checkpoint_after_minutes)
          || 30,
        ),
      ),
    );
    const eventResponse = await camelRequest("/v1/demo/events", {
      ...identity,
      operation: "advance_time",
      minutes: afterMinutes,
    });
    await publishOpdEvent("opd_checkpoint", eventResponse);
    return json(projected(eventResponse.operating_state as Record<string, unknown>));
  } catch (error) {
    const message = error instanceof Error && /unsupported demo action/.test(error.message)
      ? "Choose a supported OPD demo action."
      : "The OPD demo could not reach the deployed Store Manager workflow.";
    return json({ error: "opd_demo_unavailable", message }, 503);
  }
}
