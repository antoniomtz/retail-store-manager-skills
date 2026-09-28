import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";


async function request(path = "/", init = {}) {
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


test("keeps Hermes chat disabled without its server-side runtime", async () => {
  const status = await request("/api/hermes-chat");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { enabled: false, connected: false });

  const turn = await request("/api/hermes-chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "Give me the morning briefing." }),
  });
  assert.equal(turn.status, 503);
  assert.doesNotMatch(JSON.stringify(await turn.json()), /key|token|credential/i);
});


test("proxies one isolated Hermes session and strips sensitive tool details", async () => {
  const key = "b".repeat(64);
  const knownSession = "retail_ui_11111111-1111-4111-8111-111111111111";
  const requests = [];
  const server = createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      requests.push({ authorization: incoming.headers.authorization, url: incoming.url });
      if (incoming.url === "/v1/capabilities") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ features: { session_chat_streaming: true } }));
      } else if (incoming.url === `/api/sessions/${knownSession}/messages`) {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({
          data: [
            { id: "one", role: "user", content: "Morning brief" },
            { id: "two", role: "tool", content: "private tool output" },
            { id: "three", role: "assistant", content: "**Ready**" },
          ],
        }));
      } else if (incoming.method === "POST" && incoming.url === "/api/sessions") {
        outgoing.writeHead(201, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ object: "hermes.session" }));
      } else if (incoming.method === "POST" && incoming.url?.match(/^\/api\/sessions\/retail_ui_[^/]+\/chat\/stream$/)) {
        outgoing.writeHead(200, { "content-type": "text/event-stream" });
        outgoing.write('event: tool.started\ndata: {"tool_name":"skill_view","args":{"secret":"must-not-escape"},"preview":"/private/path"}\n\n');
        outgoing.write('event: tool.completed\ndata: {"tool_name":"skill_view"}\n\n');
        outgoing.write('event: assistant.completed\ndata: {"content":"## Opening priorities"}\n\n');
        outgoing.end('event: done\ndata: {}\n\n');
      } else {
        outgoing.writeHead(404, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: "not_found" }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const environment = {
    STORE_MANAGER_HERMES_CHAT_ENABLED: process.env.STORE_MANAGER_HERMES_CHAT_ENABLED,
    HERMES_API_SERVER_KEY: process.env.HERMES_API_SERVER_KEY,
    HERMES_API_SERVER_PORT: process.env.HERMES_API_SERVER_PORT,
  };
  process.env.STORE_MANAGER_HERMES_CHAT_ENABLED = "1";
  process.env.HERMES_API_SERVER_KEY = key;
  process.env.HERMES_API_SERVER_PORT = String(address.port);

  try {
    const status = await request("/api/hermes-chat");
    assert.equal((await status.json()).connected, true);

    const history = await request(`/api/hermes-chat?session_id=${knownSession}`);
    assert.deepEqual((await history.json()).messages, [
      { id: "one", role: "user", content: "Morning brief" },
      { id: "three", role: "assistant", content: "**Ready**" },
    ]);

    const turn = await request("/api/hermes-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "Give me the morning briefing.", session_id: null }),
    });
    assert.equal(turn.status, 200);
    const stream = await turn.text();
    assert.match(stream, /skill_view|Opening priorities/);
    assert.doesNotMatch(stream, /must-not-escape|\/private\/path|secret/);
    assert.equal(requests.every((item) => item.authorization === `Bearer ${key}`), true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});


test("rejects cross-origin chat mutations", async () => {
  const response = await request("/api/hermes-chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "demo-ui.example.test",
      origin: "https://malicious.example",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ input: "run a command" }),
  });
  assert.equal(response.status, 403);
});
