import {
  boundedJson,
  hermesApiFetch,
  hermesChatEnabled,
  noStoreJson,
  sameOrigin,
} from "../store-manager-runtime";
import {
  createHermesSession,
  filteredHermesEventStream,
  hermesSessionPath,
  hermesStreamResponse,
  validHermesSessionId,
} from "../hermes-sse";

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_HISTORY_MESSAGES = 100;
const encoder = new TextEncoder();

function validSessionId(value: unknown): value is string {
  return validHermesSessionId(value, "ui");
}

function responseMessage(status: number, message: string) {
  return noStoreJson({ error: "hermes_chat_error", message }, status);
}

async function requestBody(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  const text = await request.text();
  if (encoder.encode(text).byteLength > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_request");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "request_too_large") throw error;
    throw new Error("invalid_request");
  }
}

function safeText(value: unknown, limit: number) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function safeHistory(payload: Record<string, unknown>) {
  const source = Array.isArray(payload.data) ? payload.data : [];
  return source
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .filter((item) => item.role === "user" || item.role === "assistant")
    .map((item, index) => ({
      id: typeof item.id === "string" ? item.id.slice(0, 128) : `history-${index}`,
      role: item.role as "user" | "assistant",
      content: safeText(item.content, 256 * 1024),
    }))
    .filter((item) => item.content)
    .slice(-MAX_HISTORY_MESSAGES);
}

export async function GET(request: Request) {
  if (!hermesChatEnabled()) return noStoreJson({ enabled: false, connected: false });

  try {
    const sessionId = new URL(request.url).searchParams.get("session_id");
    if (!sessionId) {
      const response = await hermesApiFetch("/v1/capabilities");
      if (!response.ok) throw new Error("health_failed");
      await boundedJson(response, 64 * 1024);
      return noStoreJson({ enabled: true, connected: true, session_id: null, messages: [] });
    }
    if (!validSessionId(sessionId)) return responseMessage(400, "The chat session is invalid.");
    const response = await hermesApiFetch(hermesSessionPath(sessionId, "/messages"));
    if (response.status === 404) {
      return noStoreJson({ enabled: true, connected: true, session_id: null, messages: [] });
    }
    const payload = await boundedJson(response);
    return noStoreJson({
      enabled: true,
      connected: true,
      session_id: sessionId,
      messages: safeHistory(payload),
    });
  } catch {
    return noStoreJson({ enabled: true, connected: false, session_id: null, messages: [] }, 503);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return responseMessage(403, "Cross-origin chat requests are not allowed.");
  if (!hermesChatEnabled()) return responseMessage(503, "Hermes chat is not enabled.");

  let body: Record<string, unknown>;
  try {
    body = await requestBody(request);
  } catch (error) {
    return responseMessage(error instanceof Error && error.message === "request_too_large" ? 413 : 400, "The chat request is invalid.");
  }

  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (!input || input.length > MAX_MESSAGE_LENGTH) {
    return responseMessage(400, `Messages must contain 1-${MAX_MESSAGE_LENGTH} characters.`);
  }
  if (body.session_id !== null && body.session_id !== undefined && !validSessionId(body.session_id)) {
    return responseMessage(400, "The chat session is invalid.");
  }

  try {
    const sessionId = validSessionId(body.session_id) ? body.session_id : await createHermesSession("ui");
    const upstream = await hermesApiFetch(hermesSessionPath(sessionId, "/chat/stream"), {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ input }),
    }, 10 * 60_000);
    if (!upstream.ok || !upstream.body) {
      return responseMessage(upstream.status === 409 ? 409 : 502, upstream.status === 409
        ? "This Hermes conversation already has an active turn."
        : "Hermes could not start this turn.");
    }

    return hermesStreamResponse(filteredHermesEventStream(upstream.body, sessionId));
  } catch {
    return responseMessage(503, "Hermes chat is unavailable.");
  }
}
