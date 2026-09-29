import { boundedJson, hermesApiFetch } from "./store-manager-runtime";

const SESSION_PATTERN = /^retail_(?:ui|incident)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const encoder = new TextEncoder();

export type SafeHermesEvent = {
  type: string;
  session_id?: string;
  content?: string;
  tool_name?: string;
};

export function validHermesSessionId(value: unknown, prefix?: "ui" | "incident"): value is string {
  if (typeof value !== "string" || !SESSION_PATTERN.test(value)) return false;
  return prefix ? value.startsWith(`retail_${prefix}_`) : true;
}

export function hermesSessionPath(sessionId: string, suffix = "") {
  if (!validHermesSessionId(sessionId)) throw new Error("invalid_session");
  return `/api/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

export async function createHermesSession(prefix: "ui" | "incident") {
  const sessionId = `retail_${prefix}_${crypto.randomUUID()}`;
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

function safeUpstreamEvent(
  eventName: string,
  payload: unknown,
  sessionId: string,
  finalContentLimit: number,
  deltaContentLimit: number,
): SafeHermesEvent | null {
  const data = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  if (eventName === "assistant.delta") {
    const content = safeText(data.delta, Math.min(32 * 1024, deltaContentLimit));
    return content ? { type: eventName, session_id: sessionId, content } : null;
  }
  if (eventName === "assistant.completed") {
    return {
      type: eventName,
      session_id: sessionId,
      content: safeText(data.content, finalContentLimit),
    };
  }
  if (["tool.started", "tool.completed", "tool.failed"].includes(eventName)) {
    const toolName = safeText(data.tool_name, 80);
    return toolName && TOOL_NAME_PATTERN.test(toolName)
      ? { type: eventName, session_id: sessionId, tool_name: toolName }
      : null;
  }
  if (["run.started", "run.completed", "done"].includes(eventName)) {
    return { type: eventName, session_id: sessionId };
  }
  if (["run.failed", "run.cancelled", "error"].includes(eventName)) {
    return {
      type: "error",
      session_id: sessionId,
      content: "Hermes could not complete this turn.",
    };
  }
  return null;
}

function encodeEvent(event: SafeHermesEvent) {
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

export function filteredHermesEventStream(
  upstream: ReadableStream<Uint8Array>,
  sessionId: string,
  finalContentLimit = 256 * 1024,
) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let remainingDeltaCharacters = finalContentLimit;
  const maxBufferedCharacters = Math.max(64 * 1024, finalContentLimit + 16 * 1024);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replaceAll("\r\n", "\n");
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() || "";
          if (buffer.length > maxBufferedCharacters) {
            throw new Error("Hermes stream event exceeded the size limit");
          }
          if (done && buffer.trim()) {
            blocks.push(buffer);
            buffer = "";
          }
          for (const block of blocks) {
            const parsed = parseBlock(block);
            if (!parsed) continue;
            const event = safeUpstreamEvent(
              parsed.eventName,
              parsed.payload,
              sessionId,
              finalContentLimit,
              remainingDeltaCharacters,
            );
            if (event) {
              if (event.type === "assistant.delta") {
                remainingDeltaCharacters = Math.max(
                  0,
                  remainingDeltaCharacters - (event.content?.length || 0),
                );
              }
              controller.enqueue(encodeEvent(event));
            }
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
}

export function hermesStreamResponse(stream: ReadableStream<Uint8Array>) {
  return new Response(stream, {
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}
