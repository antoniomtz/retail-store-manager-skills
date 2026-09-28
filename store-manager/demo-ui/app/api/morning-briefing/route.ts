import {
  projectMorningBriefingPresentation,
  unavailableMorningBriefingPresentation,
} from "../../morning-briefing-model.mjs";
import {
  camelMutation,
  noStoreJson as json,
  operatingState,
  runtimeIdentity,
  sameOrigin,
} from "../store-manager-runtime";

export const dynamic = "force-dynamic";

const PRESENTATION_PATH = "/v1/store-morning-briefing-presentation";
const SNAPSHOT_PATH = "/v1/store-morning-snapshot";

function projected(raw: Record<string, unknown>, snapshot?: Record<string, unknown>) {
  return projectMorningBriefingPresentation(raw, runtimeIdentity(), snapshot);
}
export async function GET() {
  try {
    const presentation = await operatingState(PRESENTATION_PATH);
    if (presentation.status === "empty") return json(projected(presentation));
    const snapshot = await operatingState(SNAPSHOT_PATH);
    return json(projected(presentation, snapshot));
  } catch {
    return json(unavailableMorningBriefingPresentation());
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return json(
      { error: "cross_origin_request", message: "Use the controls from this demo page." },
      403,
    );
  }

  try {
    const identity = runtimeIdentity();
    return json(projected(await camelMutation(PRESENTATION_PATH, "DELETE", identity)));
  } catch {
    return json(
      { error: "morning_briefing_reset_failed", message: "The morning priorities could not be cleared." },
      503,
    );
  }
}
