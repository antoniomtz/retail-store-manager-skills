import {
  boundedJson,
  hermesApiFetch,
  hermesChatEnabled,
  noStoreJson,
  sameOrigin,
} from "../store-manager-runtime";

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_HISTORY_MESSAGES = 100;
const SESSION_PATTERN = /^retail_ui_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

type SafeEvent = {
  type: string;
  session_id?: string;
  content?: string;
  tool_name?: string;
};

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_PATTERN.test(value);
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

function sessionPath(sessionId: string, suffix = "") {
  if (!validSessionId(sessionId)) throw new Error("invalid_session");
  return `/api/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

async function createSession() {
  const sessionId = `retail_ui_${crypto.randomUUID()}`;
  const response = await hermesApiFetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: sessionId }),
  });
  if (!response.ok) throw new Error("session_create_failed");
  await boundedJson(response, 32 * 1024);
  return sessionId;
}

function safeText(value: unknown, limit: number) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function safeUpstreamEvent(eventName: string, payload: unknown, sessionId: string): SafeEvent | null {
  const data = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  if (eventName === "assistant.delta") {
    const content = safeText(data.delta, 32 * 1024);
    return content ? { type: eventName, session_id: sessionId, content } : null;
  }
  if (eventName === "assistant.completed") {
    return {
      type: eventName,
      session_id: sessionId,
      content: safeText(data.content, 256 * 1024),
    };
  }
  if (["tool.started", "tool.completed", "tool.failed"].includes(eventName)) {
    const toolName = safeText(data.tool_name, 80);
    return toolName && /^[A-Za-z0-9_.:-]+$/.test(toolName)
      ? { type: eventName, session_id: sessionId, tool_name: toolName }
      : null;
  }
  if (eventName === "run.started" || eventName === "run.completed" || eventName === "done") {
    return { type: eventName, session_id: sessionId };
  }
  if (eventName === "run.failed" || eventName === "run.cancelled") {
    return { type: "error", session_id: sessionId, content: "Hermes could not complete this turn." };
  }
  if (eventName === "error") {
    return { type: "error", session_id: sessionId, content: "Hermes could not complete this turn." };
  }
  return null;
}

function encodeEvent(event: SafeEvent) {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function parseBlock(block: string) {
  let eventName = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    return { eventName, payload: JSON.parse(data.join("\n")) as unknown };
  } catch {
    return null;
  }
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
    const response = await hermesApiFetch(sessionPath(sessionId, "/messages"));
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
    const sessionId = validSessionId(body.session_id) ? body.session_id : await createSession();
    const upstream = await hermesApiFetch(sessionPath(sessionId, "/chat/stream"), {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ input }),
    }, 10 * 60_000);
    if (!upstream.ok || !upstream.body) {
      return responseMessage(upstream.status === 409 ? 409 : 502, upstream.status === 409
        ? "This Hermes conversation already has an active turn."
        : "Hermes could not start this turn.");
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replaceAll("\r\n", "\n");
            const blocks = buffer.split("\n\n");
            buffer = blocks.pop() || "";
            if (done && buffer.trim()) {
              blocks.push(buffer);
              buffer = "";
            }
            for (const block of blocks) {
              const parsed = parseBlock(block);
              if (!parsed) continue;
              const event = safeUpstreamEvent(parsed.eventName, parsed.payload, sessionId);
              if (event) controller.enqueue(encodeEvent(event));
            }
            if (done) {
              controller.close();
              return;
            }
            if (blocks.length > 0) return;
          }
        } catch {
          controller.enqueue(encodeEvent({
            type: "error",
            session_id: sessionId,
            content: "The connection to Hermes ended unexpectedly.",
          }));
          controller.close();
        }
      },
      cancel() {
        void reader.cancel();
      },
    });

    return new Response(stream, {
      headers: {
        "cache-control": "no-store, max-age=0",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return responseMessage(503, "Hermes chat is unavailable.");
  }
}
