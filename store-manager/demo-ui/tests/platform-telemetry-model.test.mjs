import assert from "node:assert/strict";
import test from "node:test";

import { normalizePhoenixTelemetry, telemetryWindowStart, unavailableTelemetry } from "../app/platform-telemetry-model.mjs";

const NOW = Date.parse("2026-08-08T00:00:00Z");

function span({
  name,
  kind,
  spanId,
  parentId = "turn-1",
  traceId = "000000000000000000000000trace001",
  start,
  end,
  status = "UNSET",
  attributes = {},
}) {
  return {
    name,
    span_kind: kind,
    status_code: status,
    start_time: start,
    end_time: end,
    parent_id: parentId,
    context: { span_id: spanId, trace_id: traceId },
    attributes,
  };
}

test("normalizes Phoenix spans without exposing trace content or double-counting correlated LLM spans", () => {
  const payload = {
    next_cursor: null,
    data: [
      span({
        name: "hermes-turn",
        kind: "CHAIN",
        spanId: "turn-1",
        parentId: "agent-1",
        start: "2026-08-07T23:59:30Z",
        end: "2026-08-07T23:59:50Z",
        attributes: {
          "metadata.nemo_relay_scope_role": "turn",
          "metadata.session_id": "private-session-id",
          "metadata.turn_index": 1,
          "nemo_relay.end.data.model": "nvidia/demo-model",
          "nemo_relay.end.data.platform": "telegram",
          "input.value": "DO-NOT-EXPOSE-PROMPT",
        },
      }),
      span({
        name: "custom",
        kind: "LLM",
        spanId: "llm-hook-1",
        start: "2026-08-07T23:59:31.000Z",
        end: "2026-08-07T23:59:36.000Z",
        status: "OK",
        attributes: {
          "metadata.api_call_id": "call-1",
          "metadata.fidelity_source": "hermes_api_hooks_sanitized",
          "llm.model_name": "nvidia/demo-model",
          "llm.token_count.prompt": 100,
          "llm.token_count.completion": 20,
          "llm.token_count.total": 120,
          "output.value": "DO-NOT-EXPOSE-RESPONSE",
        },
      }),
      span({
        name: "openai.chat_completions",
        kind: "LLM",
        spanId: "llm-provider-1",
        start: "2026-08-07T23:59:31.050Z",
        end: "2026-08-07T23:59:35.950Z",
        status: "OK",
        attributes: {
          "llm.model_name": "nvidia/demo-model",
          "llm.token_count.prompt": 100,
          "llm.token_count.completion": 20,
          "llm.token_count.total": 120,
          "llm.input_messages.0.message.content": "DO-NOT-EXPOSE-PROMPT",
        },
      }),
      span({
        name: "vision_analyze",
        kind: "TOOL",
        spanId: "tool-1",
        start: "2026-08-07T23:59:37Z",
        end: "2026-08-07T23:59:40Z",
        attributes: {
          "tool.name": "vision_analyze",
          "tool.parameters.image_url": "/private/image.png",
          "nemo_relay.observed": true,
        },
      }),
    ],
  };

  const result = normalizePhoenixTelemetry(payload, {
    nowMs: NOW,
    lookbackHours: 24,
    project: "default",
    auxiliaryVisionModel: "nvidia/configured-vision-model",
  });

  assert.equal(result.source.status, "connected");
  assert.equal(result.source.freshness, "active");
  assert.equal(result.summary.agentTurns, 1);
  assert.equal(result.summary.sessions, 1);
  assert.equal(result.summary.modelCalls, 1, "correlated hook and provider spans represent one model call");
  assert.deepEqual(result.summary.tokens, { prompt: 100, completion: 20, total: 120 });
  assert.equal(result.summary.toolCalls, 1);
  assert.equal(result.summary.latencyP95Ms, 20_000);
  assert.equal(result.summary.completionRate, 100);
  assert.equal(result.activity[0].channel, "Telegram");
  assert.equal(result.activity[0].summary, "Analyzed an incident image");
  assert.equal(result.activity[0].model, "nvidia/demo-model");
  assert.equal(result.activity[0].visionModel, "nvidia/configured-vision-model");
  assert.equal(result.activity[0].visionModelSource, "configuration");
  assert.equal(result.models[0].name, "nvidia/demo-model");
  assert.deepEqual(result.vision, {
    analyses: 1,
    configuredModel: "nvidia/configured-vision-model",
    observedModels: [],
    modelSource: "configuration",
  });
  assert.deepEqual(result.channels, [{ name: "Telegram", count: 1 }]);

  const browserPayload = JSON.stringify(result);
  assert.doesNotMatch(browserPayload, /DO-NOT-EXPOSE/);
  assert.doesNotMatch(browserPayload, /private-session-id|private\/image\.png/);
  assert.equal(result.privacy.contentIncluded, false);
});

test("prefers a nested vision-model span over configured perception metadata", () => {
  const payload = {
    next_cursor: null,
    data: [
      span({
        name: "hermes-turn",
        kind: "CHAIN",
        spanId: "turn-vision",
        parentId: "agent-vision",
        traceId: "000000000000000000000000trace003",
        start: "2026-08-07T23:59:30Z",
        end: "2026-08-07T23:59:45Z",
        attributes: { "metadata.nemo_relay_scope_role": "turn" },
      }),
      span({
        name: "vision_analyze",
        kind: "TOOL",
        spanId: "vision-tool",
        parentId: "turn-vision",
        traceId: "000000000000000000000000trace003",
        start: "2026-08-07T23:59:32Z",
        end: "2026-08-07T23:59:40Z",
        attributes: { "tool.name": "vision_analyze" },
      }),
      span({
        name: "vision-provider",
        kind: "LLM",
        spanId: "vision-model-call",
        parentId: "vision-tool",
        traceId: "000000000000000000000000trace003",
        start: "2026-08-07T23:59:33Z",
        end: "2026-08-07T23:59:39Z",
        attributes: { "llm.model_name": "nvidia/observed-vision-model" },
      }),
    ],
  };

  const result = normalizePhoenixTelemetry(payload, {
    nowMs: NOW,
    auxiliaryVisionModel: "nvidia/configured-vision-model",
  });
  assert.equal(result.activity[0].visionModel, "nvidia/observed-vision-model");
  assert.equal(result.activity[0].visionModelSource, "telemetry");
  assert.deepEqual(result.vision.observedModels, ["nvidia/observed-vision-model"]);
  assert.equal(result.vision.modelSource, "telemetry");
});

test("reports stale, truncated, and failed telemetry honestly", () => {
  const payload = {
    next_cursor: "next-page",
    data: [
      span({
        name: "hermes-turn",
        kind: "CHAIN",
        spanId: "turn-error",
        parentId: "agent-error",
        traceId: "000000000000000000000000trace002",
        start: "2026-08-07T21:00:00Z",
        end: "2026-08-07T21:00:05Z",
        status: "ERROR",
        attributes: {
          "metadata.nemo_relay_scope_role": "turn",
          "metadata.session_id": "session-error",
          "nemo_relay.observed": true,
        },
      }),
    ],
  };

  const result = normalizePhoenixTelemetry(payload, { nowMs: NOW });
  assert.equal(result.source.freshness, "stale");
  assert.equal(result.window.truncated, true);
  assert.equal(result.summary.completionRate, 0);
  assert.equal(result.activity[0].status, "error");
  assert.equal(result.pipeline.find((stage) => stage.id === "phoenix")?.state, "connected");
});

test("uses an explicit unavailable contract instead of fake telemetry", () => {
  const result = unavailableTelemetry({ nowMs: NOW, lookbackHours: 12, project: "retail" });
  assert.equal(result.source.status, "unavailable");
  assert.equal(result.source.project, "retail");
  assert.equal(result.window.lookbackHours, 12);
  assert.equal(result.summary.agentTurns, 0);
  assert.deepEqual(result.activity, []);
  assert.equal(result.pipeline.find((stage) => stage.id === "phoenix")?.state, "unavailable");
});

test("bounds a UI-only telemetry baseline without changing stored traces", () => {
  assert.equal(
    telemetryWindowStart("now", { nowMs: NOW, lookbackHours: 24 }),
    "2026-08-08T00:00:00.000Z",
  );
  assert.equal(
    telemetryWindowStart("2026-08-07T23:45:00Z", { nowMs: NOW, lookbackHours: 24 }),
    "2026-08-07T23:45:00.000Z",
  );
  assert.equal(
    telemetryWindowStart("2020-01-01T00:00:00Z", { nowMs: NOW, lookbackHours: 24 }),
    "2026-08-07T00:00:00.000Z",
  );
  assert.equal(
    telemetryWindowStart("invalid", { nowMs: NOW, lookbackHours: 24 }),
    "2026-08-07T00:00:00.000Z",
  );
});
