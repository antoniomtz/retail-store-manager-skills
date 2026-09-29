import {
  readyIncidentState,
  sentIncidentState,
  unavailableIncidentState,
} from "../../incident-demo-model.mjs";
import {
  incidentImagePath,
  noStoreJson as json,
  notifyHermes,
  requireHermesApiRuntime,
  requireWebhookRuntime,
  runtimeIdentity,
  sameOrigin,
  telegramDeliveryEnabled,
} from "../store-manager-runtime";

export const dynamic = "force-dynamic";

async function publishIncidentEvent() {
  const identity = runtimeIdentity();
  const notificationId = `store-incident-${crypto.randomUUID()}`;
  return notifyHermes("store-incident", {
    ...identity,
    event_type: "store_incident_detected",
    notification_id: notificationId,
    source: "synthetic-store-vision",
  });
}

export async function GET() {
  try {
    runtimeIdentity();
    requireHermesApiRuntime();
    incidentImagePath();
    return json(readyIncidentState(telegramDeliveryEnabled()));
  } catch {
    return json(unavailableIncidentState());
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return json(
      { error: "cross_origin_request", message: "Use the controls from this demo page." },
      403,
    );
  }

  try {
    const body = await request.json() as { action?: unknown; delivery?: unknown };
    if (body.action === "reset") {
      runtimeIdentity();
      requireHermesApiRuntime();
      incidentImagePath();
      return json(readyIncidentState(telegramDeliveryEnabled()));
    }
    if (body.action !== "trigger") {
      return json(
        { error: "unsupported_action", message: "Choose a supported incident demo action." },
        400,
      );
    }
    if (body.delivery !== "telegram" || !telegramDeliveryEnabled()) {
      return json(
        { error: "telegram_unavailable", message: "Telegram delivery is not configured for this Store Manager package." },
        409,
      );
    }
    requireWebhookRuntime();
    return json(sentIncidentState(await publishIncidentEvent(), true));
  } catch {
    return json(
      {
        error: "incident_demo_unavailable",
        message: "The incident was displayed, but Hermes could not accept the notification.",
      },
      503,
    );
  }
}
