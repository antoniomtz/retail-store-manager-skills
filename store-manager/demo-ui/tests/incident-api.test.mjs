import assert from "node:assert/strict";
import test from "node:test";

async function request(path = "/api/incident-demo", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(new URL(path, "http://localhost/"), {
      ...init,
      headers: { accept: "application/json", ...init.headers },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

function preserveEnvironment() {
  const names = [
    "STORE_MANAGER_STORE_ID",
    "STORE_MANAGER_BUSINESS_DATE",
    "STORE_MANAGER_TELEGRAM_ENABLED",
    "STORE_MANAGER_INCIDENT_IMAGE_PATH",
    "HERMES_API_SERVER_KEY",
    "HERMES_API_SERVER_PORT",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function configureRuntime(telegramEnabled = "0") {
  process.env.STORE_MANAGER_STORE_ID = "SEA-014";
  process.env.STORE_MANAGER_BUSINESS_DATE = "2026-08-03";
  process.env.STORE_MANAGER_TELEGRAM_ENABLED = telegramEnabled;
  process.env.STORE_MANAGER_INCIDENT_IMAGE_PATH =
    "/home/test/.hermes/skills/store-manager/store-incident-response/assets/incident.jpg";
  process.env.HERMES_API_SERVER_KEY = "b".repeat(64);
  process.env.HERMES_API_SERVER_PORT = "8642";
}

test("keeps UI incident assessment available without Telegram", async () => {
  const restore = preserveEnvironment();
  configureRuntime("0");
  try {
    const status = await request();
    assert.equal(status.status, 200);
    const payload = await status.json();
    assert.equal(payload.connected, true);
    assert.equal(payload.telegramEnabled, false);

    const telegram = await request("/api/incident-demo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "trigger", delivery: "telegram" }),
    });
    assert.equal(telegram.status, 409);
    assert.equal((await telegram.json()).error, "telegram_unavailable");
  } finally {
    restore();
  }
});
test("rejects an untrusted incident path and cross-origin mutation", async () => {
  const restore = preserveEnvironment();
  configureRuntime("1");
  try {
    process.env.STORE_MANAGER_INCIDENT_IMAGE_PATH = "/tmp/untrusted.jpg";
    const status = await request();
    assert.equal((await status.json()).connected, false);

    const crossOrigin = await request("/api/incident-demo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "demo-ui.example.test",
        origin: "https://malicious.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ action: "reset" }),
    });
    assert.equal(crossOrigin.status, 403);
  } finally {
    restore();
  }
});
