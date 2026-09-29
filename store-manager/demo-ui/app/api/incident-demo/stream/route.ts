import {
  createHermesSession,
  filteredHermesEventStream,
  hermesSessionPath,
  hermesStreamResponse,
} from "../../hermes-sse";
import {
  hermesApiFetch,
  incidentImagePath,
  noStoreJson,
  requireHermesApiRuntime,
  sameOrigin,
} from "../../store-manager-runtime";

export const dynamic = "force-dynamic";

function incidentPrompt() {
  const imagePath = incidentImagePath();
  return `A current synthetic store incident image is available at \`${imagePath}\`. Run the store-incident-response skill for that exact image and return its final rich assessment for display in the Store Manager UI. Call vision_analyze exactly once as required by the skill. Treat this request only as a wake-up signal, not as visual evidence. Do not request approval or claim that an action ran.`;
}

function unavailable(status: number, message: string) {
  return noStoreJson({ error: "incident_assessment_unavailable", message }, status);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return unavailable(403, "Cross-origin incident requests are not allowed.");
  }

  try {
    requireHermesApiRuntime();
    const sessionId = await createHermesSession("incident");
    const upstream = await hermesApiFetch(hermesSessionPath(sessionId, "/chat/stream"), {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ input: incidentPrompt() }),
    }, 10 * 60_000);
    if (!upstream.ok || !upstream.body) {
      return unavailable(502, "Hermes could not start the incident assessment.");
    }
    return hermesStreamResponse(filteredHermesEventStream(upstream.body, sessionId, 32 * 1024));
  } catch {
    return unavailable(503, "Hermes incident assessment is unavailable.");
  }
}
