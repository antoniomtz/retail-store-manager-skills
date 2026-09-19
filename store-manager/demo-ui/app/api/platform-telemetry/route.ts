import { normalizePhoenixTelemetry, telemetryWindowStart, unavailableTelemetry } from "../../platform-telemetry-model.mjs";

export const dynamic = "force-dynamic";

const DEFAULT_PHOENIX_BASE_URL = "http://127.0.0.1:6006";
const DEFAULT_PROJECT = "default";
const DEFAULT_LOOKBACK_HOURS = 24;
const SPAN_LIMIT = 500;
const TURN_LIMIT = 100;
const RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;

const PHOENIX_QUERY = `
  query PlatformTelemetry($project: String!, $start: DateTime!, $limit: Int!) {
    project: getProjectByName(name: $project) {
      name
      spans(
        first: $limit
        timeRange: { start: $start }
        sort: { col: startTime, dir: desc }
      ) {
        edges {
          node {
            name
            spanKind
            statusCode
            startTime
            endTime
            parentId
            spanId
            tokenCountTotal
            tokenCountPrompt
            tokenCountCompletion
            metadata
            trace { traceId }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

function boundedLookbackHours(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(168, Math.max(1, Math.round(parsed))) : DEFAULT_LOOKBACK_HOURS;
}

function phoenixBaseUrl() {
  const configured = process.env.PHOENIX_BASE_URL?.trim();
  const serviceHost = process.env.SERVICE_BIND_HOST?.trim();
  const servicePort = process.env.PHOENIX_PORT?.trim() || "6006";
  const value = configured || (serviceHost ? `http://${serviceHost}:${servicePort}` : DEFAULT_PHOENIX_BASE_URL);
  const url = new URL(value);
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    throw new Error("PHOENIX_BASE_URL must be an HTTP(S) URL without embedded credentials.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function configuredVisionModel() {
  const value = process.env.HERMES_AUXILIARY_VISION_MODEL?.trim() || "";
  return /^[A-Za-z0-9._:/-]{1,200}$/.test(value) ? value : null;
}

function json(data: unknown) {
  return Response.json(data, {
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}

async function readBoundedJson(response: Response) {
  if (!response.ok) throw new Error(`Phoenix returned ${response.status}.`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_LIMIT_BYTES) {
    throw new Error("Phoenix response exceeded the demo adapter limit.");
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > RESPONSE_LIMIT_BYTES) {
    throw new Error("Phoenix response exceeded the demo adapter limit.");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function selectedTurnAttributes(value: unknown) {
  const attributes = record(value);
  return {
    model: text(attributes["llm.model_name"]) || text(attributes["nemo_relay.end.data.model"]) || text(attributes["nemo_relay.end.output.model"]),
    platform:
      text(attributes["nemo_relay.end.data.platform"]) ||
      text(attributes["nemo_relay.end.output.platform"]) ||
      text(attributes["metadata.hermes.execution_surface"]),
  };
}

function safeMetadata(value: unknown) {
  if (typeof value !== "string") return {};
  try {
    const metadata = record(JSON.parse(value));
    return {
      apiCallId: text(metadata.api_call_id),
      fidelitySource: text(metadata.fidelity_source),
      gatewayPath: text(metadata.gateway_path),
      relayScopeRole: text(metadata.nemo_relay_scope_role),
      sessionId: text(metadata.session_id),
      turnIndex: typeof metadata.turn_index === "number" ? metadata.turn_index : null,
    };
  } catch {
    return {};
  }
}

function toPhoenixEnvelope(graphql: Record<string, unknown>, turnDetails: Record<string, unknown>) {
  if (Array.isArray(graphql.errors) && graphql.errors.length) throw new Error("Phoenix GraphQL query failed.");
  const project = record(record(graphql.data).project);
  const connection = record(project.spans);
  const edges = Array.isArray(connection.edges) ? connection.edges : [];
  const turns = Array.isArray(turnDetails.data) ? turnDetails.data : [];
  const spanAttributes = new Map<string, { model: string | null; platform: string | null }>();
  for (const item of turns) {
    const span = record(item);
    const spanId = text(record(span.context).span_id);
    if (spanId) spanAttributes.set(spanId, selectedTurnAttributes(span.attributes));
  }

  return {
    data: edges.map((edge) => {
      const node = record(record(edge).node);
      const metadata = safeMetadata(node.metadata);
      const spanId = text(node.spanId);
      const selected = spanId ? spanAttributes.get(spanId) : undefined;
      return {
        name: text(node.name),
        span_kind: text(node.spanKind)?.toUpperCase(),
        status_code: text(node.statusCode)?.toUpperCase(),
        start_time: text(node.startTime),
        end_time: text(node.endTime),
        parent_id: text(node.parentId),
        context: {
          trace_id: text(record(node.trace).traceId),
          span_id: spanId,
        },
        attributes: {
          "metadata.api_call_id": metadata.apiCallId,
          "metadata.fidelity_source": metadata.fidelitySource,
          "metadata.gateway_path": metadata.gatewayPath,
          "metadata.nemo_relay_scope_role": metadata.relayScopeRole,
          "metadata.session_id": metadata.sessionId,
          "metadata.turn_index": metadata.turnIndex,
          "nemo_relay.observed": true,
          "nemo_relay.end.data.model": selected?.model || null,
          "nemo_relay.end.data.platform": selected?.platform || null,
          "llm.token_count.prompt": node.tokenCountPrompt,
          "llm.token_count.completion": node.tokenCountCompletion,
          "llm.token_count.total": node.tokenCountTotal,
          "tool.name": text(node.spanKind)?.toLowerCase() === "tool" ? text(node.name) : null,
        },
      };
    }),
    next_cursor: record(connection.pageInfo).hasNextPage ? "truncated" : null,
  };
}

export async function GET(request: Request) {
  const nowMs = Date.now();
  const lookbackHours = boundedLookbackHours(process.env.DEMO_TELEMETRY_LOOKBACK_HOURS);
  const project = process.env.PHOENIX_PROJECT?.trim() || DEFAULT_PROJECT;
  const since = new URL(request.url).searchParams.get("since");
  const start = telemetryWindowStart(since, { nowMs, lookbackHours });
  const options = {
    nowMs,
    lookbackHours,
    project,
    startedAt: start,
    auxiliaryVisionModel: configuredVisionModel(),
  };

  try {
    const base = phoenixBaseUrl();
    const graphqlEndpoint = new URL("/graphql", base);
    const turnsEndpoint = new URL(`/v1/projects/${encodeURIComponent(project)}/spans`, base);
    turnsEndpoint.searchParams.set("limit", String(TURN_LIMIT));
    turnsEndpoint.searchParams.set("start_time", start);

    const [graphqlResponse, turnsResponse] = await Promise.all([
      fetch(graphqlEndpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ query: PHOENIX_QUERY, variables: { project, start, limit: SPAN_LIMIT } }),
        signal: AbortSignal.timeout(4500),
        cache: "no-store",
      }),
      fetch(turnsEndpoint, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(4500),
        cache: "no-store",
      }),
    ]);
    const [graphql, turnDetails] = await Promise.all([
      readBoundedJson(graphqlResponse),
      readBoundedJson(turnsResponse),
    ]);

    return json(normalizePhoenixTelemetry(toPhoenixEnvelope(graphql, turnDetails), options));
  } catch {
    return json(unavailableTelemetry(options));
  }
}
