const CHANNEL_LABELS = new Map([
  ["cli", "TUI"],
  ["tui", "TUI"],
  ["telegram", "Telegram"],
  ["webhook", "Webhook"],
  ["dashboard", "Dashboard"],
  ["api", "API"],
  ["discord", "Discord"],
  ["slack", "Slack"],
]);

const TOOL_LABELS = new Map([
  ["skill_view", "Loaded an operating skill"],
  ["skill_manage", "Managed an operating skill"],
  ["terminal", "Queried an operating data helper"],
  ["vision_analyze", "Analyzed an incident image"],
  ["memory", "Consulted durable memory"],
  ["viking_search", "Searched durable memory"],
  ["viking_read", "Read durable memory"],
  ["read_file", "Read managed context"],
  ["execute_code", "Processed local data"],
  ["clarify", "Requested a manager decision"],
]);

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function readAttribute(attributes, key) {
  const record = asRecord(attributes);
  if (Object.hasOwn(record, key)) return record[key];

  let current = record;
  for (const part of key.split(".")) {
    current = asRecord(current)[part];
    if (current === undefined) return undefined;
  }
  return current;
}

function parseTime(value) {
  const text = asString(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
}

export function telemetryWindowStart(value, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const lookbackHours = Number.isFinite(options.lookbackHours) ? options.lookbackHours : 24;
  const earliest = nowMs - lookbackHours * 60 * 60 * 1000;
  const requested = value === "now" ? nowMs : parseTime(value);
  const bounded = requested === null ? earliest : Math.min(nowMs, Math.max(earliest, requested));
  return new Date(bounded).toISOString();
}

function durationMs(span) {
  const start = parseTime(span.start_time);
  const end = parseTime(span.end_time);
  return start !== null && end !== null && end >= start ? end - start : null;
}

function percentile(values, percentage) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);
  return Math.round(sorted[index]);
}

function statusOf(spans, completed) {
  if (spans.some((span) => span.status_code === "ERROR")) return "error";
  return completed ? "completed" : "running";
}

function modelFor(span) {
  const attributes = span.attributes;
  return (
    asString(readAttribute(attributes, "llm.model_name")) ||
    asString(readAttribute(attributes, "nemo_relay.end.data.model")) ||
    asString(readAttribute(attributes, "nemo_relay.end.output.model")) ||
    null
  );
}

function toolFor(span) {
  const attributes = span.attributes;
  return (
    asString(readAttribute(attributes, "tool.name")) ||
    asString(readAttribute(attributes, "tool_call.function.name")) ||
    asString(readAttribute(attributes, "metadata.tool_correlation_tool_name")) ||
    asString(span.name) ||
    "tool"
  );
}

function tokenCounts(span) {
  const attributes = span.attributes;
  const prompt = asNumber(readAttribute(attributes, "llm.token_count.prompt")) || 0;
  const completion = asNumber(readAttribute(attributes, "llm.token_count.completion")) || 0;
  const reportedTotal = asNumber(readAttribute(attributes, "llm.token_count.total"));
  return { prompt, completion, total: reportedTotal ?? prompt + completion };
}

function llmPreference(span) {
  const attributes = span.attributes;
  const fidelity = asString(readAttribute(attributes, "metadata.fidelity_source"));
  const apiCallId = asString(readAttribute(attributes, "metadata.api_call_id"));
  if (fidelity === "hermes_api_hooks_sanitized") return 4;
  if (apiCallId) return 3;
  if (span.name === "custom") return 2;
  return 1;
}

function sameModelCall(left, right) {
  if (left.parent_id !== right.parent_id) return false;
  if (modelFor(left) !== modelFor(right)) return false;

  const leftStart = parseTime(left.start_time);
  const rightStart = parseTime(right.start_time);
  const leftEnd = parseTime(left.end_time);
  const rightEnd = parseTime(right.end_time);
  if (leftStart === null || rightStart === null || Math.abs(leftStart - rightStart) > 1000) return false;
  if (leftEnd !== null && rightEnd !== null && Math.abs(leftEnd - rightEnd) > 1200) return false;

  const leftTokens = tokenCounts(left);
  const rightTokens = tokenCounts(right);
  return !leftTokens.total || !rightTokens.total || leftTokens.total === rightTokens.total;
}

/** Relay can emit a sanitized hook span and a provider span for one model call. */
function canonicalLlmSpans(spans) {
  const groups = [];
  for (const span of spans.filter((candidate) => candidate.span_kind === "LLM")) {
    const apiCallId = asString(readAttribute(span.attributes, "metadata.api_call_id"));
    let group = apiCallId
      ? groups.find((candidate) => candidate.apiCallIds.has(apiCallId))
      : null;
    if (!group) group = groups.find((candidate) => sameModelCall(candidate.selected, span));

    if (!group) {
      groups.push({ selected: span, apiCallIds: new Set(apiCallId ? [apiCallId] : []) });
      continue;
    }

    if (apiCallId) group.apiCallIds.add(apiCallId);
    if (llmPreference(span) > llmPreference(group.selected)) group.selected = span;
  }
  return groups.map((group) => group.selected);
}

function traceIdFor(span) {
  return asString(asRecord(span.context).trace_id);
}

function spanIdFor(span) {
  return asString(asRecord(span.context).span_id);
}

function isNestedUnder(candidate, ancestor, spans) {
  const ancestorId = spanIdFor(ancestor);
  let parentId = asString(candidate.parent_id);
  const visited = new Set();
  if (!ancestorId || !parentId) return false;

  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    const parent = spans.find((span) => spanIdFor(span) === parentId);
    parentId = parent ? asString(parent.parent_id) : null;
  }
  return false;
}

function visionDetails(toolSpans, llmSpans, spans, configuredModel) {
  const visionTools = toolSpans.filter((span) => toolFor(span) === "vision_analyze");
  const observedModels = new Set();
  for (const tool of visionTools) {
    const toolModel = modelFor(tool);
    if (toolModel) observedModels.add(toolModel);
    for (const llm of llmSpans.filter((span) => isNestedUnder(span, tool, spans))) {
      const model = modelFor(llm);
      if (model) observedModels.add(model);
    }
  }

  const observed = [...observedModels];
  const configured = asString(configuredModel);
  return {
    analyses: visionTools.length,
    configuredModel: configured,
    observedModels: observed,
    modelSource: observed.length ? "telemetry" : configured ? "configuration" : null,
  };
}

function descendantsFor(turn, spans) {
  const traceId = traceIdFor(turn);
  const start = parseTime(turn.start_time);
  const end = parseTime(turn.end_time);
  return spans.filter((span) => {
    if (span === turn || traceIdFor(span) !== traceId) return false;
    const candidateStart = parseTime(span.start_time);
    if (start === null || candidateStart === null || candidateStart < start - 1000) return false;
    return end === null || candidateStart <= end + 1000;
  });
}

function channelFor(turn, descendants) {
  for (const span of [turn, ...descendants]) {
    const attributes = span.attributes;
    const raw =
      asString(readAttribute(attributes, "nemo_relay.end.data.platform")) ||
      asString(readAttribute(attributes, "nemo_relay.end.output.platform")) ||
      asString(readAttribute(attributes, "nemo_relay.start.data.platform")) ||
      asString(readAttribute(attributes, "metadata.gateway_path"));
    if (raw) return CHANNEL_LABELS.get(raw.toLowerCase()) || "Other";
  }
  return "Unlabeled";
}

function shortTraceReference(turn, index) {
  const traceId = traceIdFor(turn);
  const turnIndex = asNumber(readAttribute(turn.attributes, "metadata.turn_index"));
  const suffix = traceId ? traceId.slice(-8) : String(index + 1).padStart(2, "0");
  return `${suffix}:${turnIndex ?? index + 1}`;
}

function describeActions(toolSpans) {
  const actions = [];
  for (const span of [...toolSpans].sort((left, right) => (parseTime(left.start_time) ?? 0) - (parseTime(right.start_time) ?? 0))) {
    const tool = toolFor(span);
    const label = TOOL_LABELS.get(tool) || `Used ${tool.replaceAll("_", " ")}`;
    if (!actions.includes(label)) actions.push(label);
  }
  if (!actions.length) return "Answered without calling a tool";
  if (actions.length === 1) return actions[0];
  if (actions.length === 2) return `${actions[0]} and ${actions[1].toLowerCase()}`;
  return `${actions[0]}, ${actions[1].toLowerCase()}, and ${actions.length - 2} more step${actions.length === 3 ? "" : "s"}`;
}

function freshnessFor(latestTime, nowMs) {
  if (latestTime === null) return "empty";
  const age = Math.max(0, nowMs - latestTime);
  if (age <= 2 * 60 * 1000) return "active";
  if (age <= 15 * 60 * 1000) return "recent";
  return "stale";
}

function pipelineState(freshness, observed) {
  if (!observed) return "unobserved";
  if (freshness === "active") return "active";
  if (freshness === "recent") return "recent";
  return "stale";
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

export function normalizePhoenixTelemetry(envelope, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const lookbackHours = Number.isFinite(options.lookbackHours) ? options.lookbackHours : 24;
  const project = asString(options.project) || "default";
  const startedAt = telemetryWindowStart(options.startedAt, { nowMs, lookbackHours });
  const data = asRecord(envelope);
  const spans = Array.isArray(data.data) ? data.data.map(asRecord) : [];
  const turns = spans
    .filter((span) => span.name === "hermes-turn" || span.name === "hermes.turn" || readAttribute(span.attributes, "metadata.nemo_relay_scope_role") === "turn")
    .sort((left, right) => (parseTime(right.start_time) ?? 0) - (parseTime(left.start_time) ?? 0));
  const canonicalLlm = canonicalLlmSpans(spans);
  const configuredVisionModel = asString(options.auxiliaryVisionModel);

  const activities = turns.map((turn, index) => {
    const descendants = descendantsFor(turn, spans);
    const tools = descendants.filter((span) => span.span_kind === "TOOL");
    const llm = canonicalLlm.filter((span) => descendants.includes(span));
    const turnModel = modelFor(turn) || llm.map(modelFor).find(Boolean) || null;
    const vision = visionDetails(tools, llm, spans, configuredVisionModel);
    return {
      ref: shortTraceReference(turn, index),
      startedAt: asString(turn.start_time),
      durationMs: durationMs(turn),
      status: statusOf([turn, ...descendants], Boolean(turn.end_time)),
      channel: channelFor(turn, descendants),
      summary: describeActions(tools),
      toolCalls: tools.length,
      modelCalls: llm.length,
      model: turnModel,
      visionModel: vision.analyses ? vision.observedModels[0] || vision.configuredModel : null,
      visionModelSource: vision.analyses ? vision.modelSource : null,
    };
  });

  const sessionIds = new Set(
    turns
      .map((turn) => asString(readAttribute(turn.attributes, "metadata.session_id")))
      .filter(Boolean),
  );
  const failedTurns = activities.filter((activity) => activity.status === "error").length;
  const completedTurns = activities.filter((activity) => activity.status !== "running").length;
  const toolSpans = spans.filter((span) => span.span_kind === "TOOL");
  const vision = visionDetails(toolSpans, canonicalLlm, spans, configuredVisionModel);
  const turnLatencies = activities.map((activity) => activity.durationMs).filter((value) => value !== null);
  const tokens = canonicalLlm.reduce(
    (totals, span) => {
      const counts = tokenCounts(span);
      totals.prompt += counts.prompt;
      totals.completion += counts.completion;
      totals.total += counts.total;
      return totals;
    },
    { prompt: 0, completion: 0, total: 0 },
  );

  const channelCounts = new Map();
  for (const activity of activities) increment(channelCounts, activity.channel);
  const toolCounts = new Map();
  for (const span of toolSpans) increment(toolCounts, toolFor(span));
  const modelCounts = new Map();
  const modelTokens = new Map();
  for (const span of canonicalLlm) {
    const containingTurn = turns.find((turn) => descendantsFor(turn, spans).includes(span));
    const model = modelFor(span) || (containingTurn ? modelFor(containingTurn) : null) || "Unlabeled model";
    increment(modelCounts, model);
    increment(modelTokens, model, tokenCounts(span).total);
  }

  const latestTime = spans.reduce((latest, span) => {
    const value = parseTime(span.end_time) ?? parseTime(span.start_time);
    return value !== null && (latest === null || value > latest) ? value : latest;
  }, null);
  const freshness = freshnessFor(latestTime, nowMs);
  const relaySpans = spans.filter((span) =>
    Object.keys(asRecord(span.attributes)).some((key) => key.startsWith("nemo_relay.") || key.startsWith("metadata.nemo_relay")),
  );

  const sortedCounts = (counts) =>
    [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    source: {
      status: "connected",
      freshness,
      project,
      lastTelemetryAt: latestTime === null ? null : new Date(latestTime).toISOString(),
      message:
        freshness === "empty"
          ? "Phoenix is reachable, but no Hermes telemetry is available in this window."
          : freshness === "stale"
            ? "Phoenix is reachable; the latest Hermes telemetry is outside the recent-activity window."
            : "Phoenix is receiving Hermes telemetry through NeMo Relay.",
    },
    window: {
      startedAt,
      lookbackHours,
      spanCount: spans.length,
      truncated: Boolean(data.next_cursor),
    },
    summary: {
      agentTurns: turns.length,
      sessions: sessionIds.size,
      completedTurns,
      completionRate: completedTurns ? Math.round(((completedTurns - failedTurns) / completedTurns) * 1000) / 10 : null,
      modelCalls: canonicalLlm.length,
      toolCalls: toolSpans.length,
      latencyP50Ms: percentile(turnLatencies, 50),
      latencyP95Ms: percentile(turnLatencies, 95),
      tokens,
    },
    activity: activities.slice(0, 6),
    channels: sortedCounts(channelCounts),
    tools: sortedCounts(toolCounts).slice(0, 6),
    models: sortedCounts(modelCounts).slice(0, 4).map((model) => ({
      ...model,
      tokens: modelTokens.get(model.name) || 0,
    })),
    vision,
    pipeline: [
      {
        id: "hermes",
        name: "Hermes",
        role: "Agent runtime",
        state: pipelineState(freshness, turns.length > 0),
        evidence: turns.length ? `${turns.length} turn${turns.length === 1 ? "" : "s"} observed` : "No turns observed",
      },
      {
        id: "relay",
        name: "NeMo Relay",
        role: "Lifecycle capture",
        state: pipelineState(freshness, relaySpans.length > 0),
        evidence: relaySpans.length ? `${relaySpans.length} span${relaySpans.length === 1 ? "" : "s"} exported` : "No Relay evidence",
      },
      {
        id: "otlp",
        name: "OpenInference / OTLP",
        role: "Trace transport",
        state: pipelineState(freshness, spans.length > 0),
        evidence: spans.length ? `${spans.length} span${spans.length === 1 ? "" : "s"} in window` : "No spans delivered",
      },
      {
        id: "phoenix",
        name: "Phoenix",
        role: "Trace store",
        state: "connected",
        evidence: `Project: ${project}`,
      },
    ],
    privacy: {
      contentIncluded: false,
      note: "Prompts, responses, tool arguments, file paths, commands, and session identifiers are removed by the demo adapter.",
    },
  };
}

export function unavailableTelemetry(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const lookbackHours = Number.isFinite(options.lookbackHours) ? options.lookbackHours : 24;
  const project = asString(options.project) || "default";
  const startedAt = telemetryWindowStart(options.startedAt, { nowMs, lookbackHours });
  const configuredVisionModel = asString(options.auxiliaryVisionModel);
  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    source: {
      status: "unavailable",
      freshness: "unavailable",
      project,
      lastTelemetryAt: null,
      message: "Phoenix telemetry is not reachable from the demo server.",
    },
    window: { startedAt, lookbackHours, spanCount: 0, truncated: false },
    summary: {
      agentTurns: 0,
      sessions: 0,
      completedTurns: 0,
      completionRate: null,
      modelCalls: 0,
      toolCalls: 0,
      latencyP50Ms: null,
      latencyP95Ms: null,
      tokens: { prompt: 0, completion: 0, total: 0 },
    },
    activity: [],
    channels: [],
    tools: [],
    models: [],
    vision: {
      analyses: 0,
      configuredModel: configuredVisionModel,
      observedModels: [],
      modelSource: configuredVisionModel ? "configuration" : null,
    },
    pipeline: [
      { id: "hermes", name: "Hermes", role: "Agent runtime", state: "unknown", evidence: "Telemetry unavailable" },
      { id: "relay", name: "NeMo Relay", role: "Lifecycle capture", state: "unknown", evidence: "Telemetry unavailable" },
      { id: "otlp", name: "OpenInference / OTLP", role: "Trace transport", state: "unknown", evidence: "Telemetry unavailable" },
      { id: "phoenix", name: "Phoenix", role: "Trace store", state: "unavailable", evidence: "API not reachable" },
    ],
    privacy: {
      contentIncluded: false,
      note: "Prompts, responses, tool arguments, file paths, commands, and session identifiers are removed by the demo adapter.",
    },
  };
}
