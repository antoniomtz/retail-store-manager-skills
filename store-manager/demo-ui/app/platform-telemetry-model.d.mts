export type TelemetryState = "active" | "recent" | "stale" | "connected" | "unobserved" | "unavailable" | "unknown";
export type TelemetryFreshness = "active" | "recent" | "stale" | "empty" | "unavailable";

export interface PlatformTelemetry {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    status: "connected" | "unavailable";
    freshness: TelemetryFreshness;
    project: string;
    lastTelemetryAt: string | null;
    message: string;
  };
  window: { startedAt: string; lookbackHours: number; spanCount: number; truncated: boolean };
  summary: {
    agentTurns: number;
    sessions: number;
    completedTurns: number;
    completionRate: number | null;
    modelCalls: number;
    toolCalls: number;
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
    tokens: { prompt: number; completion: number; total: number };
  };
  activity: Array<{
    ref: string;
    startedAt: string | null;
    durationMs: number | null;
    status: "completed" | "running" | "error";
    channel: string;
    summary: string;
    toolCalls: number;
    modelCalls: number;
    model: string | null;
    visionModel: string | null;
    visionModelSource: "telemetry" | "configuration" | null;
  }>;
  channels: Array<{ name: string; count: number }>;
  tools: Array<{ name: string; count: number }>;
  models: Array<{ name: string; count: number; tokens: number }>;
  vision: {
    analyses: number;
    configuredModel: string | null;
    observedModels: string[];
    modelSource: "telemetry" | "configuration" | null;
  };
  pipeline: Array<{
    id: string;
    name: string;
    role: string;
    state: TelemetryState;
    evidence: string;
  }>;
  privacy: { contentIncluded: false; note: string };
}

export function normalizePhoenixTelemetry(
  envelope: unknown,
  options?: { nowMs?: number; lookbackHours?: number; project?: string; startedAt?: string; auxiliaryVisionModel?: string | null },
): PlatformTelemetry;

export function unavailableTelemetry(
  options?: { nowMs?: number; lookbackHours?: number; project?: string; startedAt?: string; auxiliaryVisionModel?: string | null },
): PlatformTelemetry;

export function telemetryWindowStart(
  value: unknown,
  options?: { nowMs?: number; lookbackHours?: number },
): string;
