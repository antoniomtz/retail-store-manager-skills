import { stableJson } from "../stable-json.mjs";

const DEFAULT_CAMEL_BASE_URL = "http://127.0.0.1:18080";
const CAMEL_RESPONSE_LIMIT_BYTES = 512 * 1024;
const WEBHOOK_RESPONSE_LIMIT_BYTES = 16 * 1024;
const STORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEBHOOK_SECRET_PATTERN = /^[0-9a-f]{64}$/;
const LOOPBACK_HOST = "127.0.0.1";

export type StoreIdentity = {
  store_id: string;
  business_date: string;
};

type WebhookRoute = "checkout-queue" | "opd-surge" | "store-incident";

export function noStoreJson(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4
    || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function camelBaseUrl() {
  const configured = process.env.STORE_MANAGER_CAMEL_BASE_URL?.trim();
  const serviceHost = process.env.SERVICE_BIND_HOST?.trim();
  const servicePort = process.env.STORE_MANAGER_CAMEL_PORT?.trim() || "18080";
  const value = configured
    || (serviceHost ? `http://${serviceHost}:${servicePort}` : DEFAULT_CAMEL_BASE_URL);
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid Camel endpoint");
  }
  if (url.hostname !== "localhost" && !isPrivateIpv4(url.hostname)) {
    throw new Error("Camel endpoint must remain private");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

export function runtimeIdentity(): StoreIdentity {
  const storeId = process.env.STORE_MANAGER_STORE_ID?.trim();
  const businessDate = process.env.STORE_MANAGER_BUSINESS_DATE?.trim();
  if (
    !storeId
    || !STORE_ID_PATTERN.test(storeId)
    || !businessDate
    || !BUSINESS_DATE_PATTERN.test(businessDate)
  ) {
    throw new Error("Store Manager demo identity is unavailable");
  }
  return { store_id: storeId, business_date: businessDate };
}

export function simulatedApprovalEnabled() {
  return process.env.DEMO_ALLOW_SIMULATED_APPROVAL === "1";
}

export async function boundedJson(
  response: Response,
  limitBytes = CAMEL_RESPONSE_LIMIT_BYTES,
) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new Error("response too large");
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > limitBytes) {
    throw new Error("response too large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("invalid JSON response");
  }
  if (!response.ok) {
    const detail = parsed && typeof parsed === "object" && "message" in parsed
      ? String((parsed as { message?: unknown }).message || "")
      : "";
    throw new Error(detail || `platform returned HTTP ${response.status}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid response object");
  }
  return parsed as Record<string, unknown>;
}

export async function camelRequest(path: string, payload?: Record<string, unknown>) {
  const response = await fetch(new URL(path, camelBaseUrl()), {
    method: payload ? "POST" : "GET",
    headers: payload
      ? { accept: "application/json", "content-type": "application/json" }
      : { accept: "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  return boundedJson(response);
}

export async function operatingState(path: string) {
  const identity = runtimeIdentity();
  const endpoint = new URL(path, camelBaseUrl());
  endpoint.searchParams.set("store_id", identity.store_id);
  endpoint.searchParams.set("business_date", identity.business_date);
  const response = await fetch(endpoint, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  return boundedJson(response);
}

function webhookRuntime() {
  const secret = process.env.STORE_MANAGER_WEBHOOK_SECRET?.trim();
  const port = Number(process.env.STORE_MANAGER_WEBHOOK_PORT?.trim());
  if (
    !secret
    || !WEBHOOK_SECRET_PATTERN.test(secret)
    || !Number.isInteger(port)
    || port < 1024
    || port > 65535
  ) {
    throw new Error("Hermes webhook runtime is unavailable");
  }
  return { secret, port };
}

export function requireWebhookRuntime() {
  webhookRuntime();
}

export async function notifyHermes(
  route: WebhookRoute,
  payload: Record<string, unknown> & { notification_id: string },
) {
  const { secret, port } = webhookRuntime();
  const body = stableJson(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${body}`),
  ));
  const signature = Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

  const response = await fetch(`http://${LOOPBACK_HOST}:${port}/webhooks/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": payload.notification_id,
      "x-webhook-signature-v2": signature,
      "x-webhook-timestamp": timestamp,
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const result = await boundedJson(response, WEBHOOK_RESPONSE_LIMIT_BYTES);
  if (response.status !== 202 || result.status !== "accepted") {
    throw new Error("Hermes did not accept the event");
  }
  return typeof result.delivery_id === "string" ? result.delivery_id : null;
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (!(["http:", "https:"] as string[]).includes(originUrl.protocol)) return false;

  const requestHosts = new Set([new URL(request.url).host.toLowerCase()]);
  for (const header of ["x-forwarded-host", "host"] as const) {
    const candidate = request.headers.get(header)?.split(",", 1)[0]?.trim().toLowerCase();
    if (candidate && /^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(candidate)) {
      requestHosts.add(candidate);
    }
  }
  return requestHosts.has(originUrl.host.toLowerCase());
}
