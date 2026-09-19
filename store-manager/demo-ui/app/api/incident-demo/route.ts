import {
  readyIncidentState,
  sentIncidentState,
  unavailableIncidentState,
} from "../../incident-demo-model.mjs";
import {
  noStoreJson as json,
  notifyHermes,
  requireWebhookRuntime,
  runtimeIdentity,
  sameOrigin,
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
    requireWebhookRuntime();
    return json(readyIncidentState());
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
    const body = await request.json() as { action?: unknown };
    if (body.action === "reset") {
      runtimeIdentity();
      requireWebhookRuntime();
      return json(readyIncidentState());
    }
    if (body.action !== "trigger") {
      return json(
        { error: "unsupported_action", message: "Choose a supported incident demo action." },
        400,
      );
    }
    return json(sentIncidentState(await publishIncidentEvent()));
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
