"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PlatformTelemetry as PlatformTelemetryData, TelemetryState } from "./platform-telemetry-model.mjs";

const POLL_INTERVAL_MS = 12_000;
const VIEW_START_STORAGE_KEY = "retail-store-manager.telemetry-view-start";

const TOOL_LABELS = new Map([
  ["skill_view", "Skill load"],
  ["skill_manage", "Skill management"],
  ["terminal", "Data helper"],
  ["vision_analyze", "Vision analysis"],
  ["memory", "Memory"],
  ["viking_search", "Memory search"],
  ["viking_read", "Memory read"],
  ["read_file", "Context read"],
  ["execute_code", "Local processing"],
]);

function compactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function duration(value: number | null) {
  if (value === null) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function relativeTime(value: string | null) {
  if (!value) return "No activity yet";
  const deltaSeconds = Math.round((Date.parse(value) - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, "second");
  const minutes = Math.round(deltaSeconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function absoluteTime(value: string | null) {
  if (!value) return "Not recorded";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(timestamp));
}

function activityStatusLabel(status: PlatformTelemetryData["activity"][number]["status"]) {
  if (status === "running") return "In progress";
  if (status === "error") return "Error";
  return "Completed";
}

function sourceBadge(data: PlatformTelemetryData | null, refreshing: boolean, requestFailed: boolean) {
  if (requestFailed && !data) return { tone: "error", label: "UI connection failed" };
  if (!data) return { tone: "muted", label: "Connecting" };
  if (refreshing) return { tone: "muted", label: "Refreshing" };
  if (data.source.status === "unavailable") return { tone: "error", label: "Telemetry unavailable" };
  if (data.source.freshness === "active") return { tone: "active", label: "Live activity" };
  if (data.source.freshness === "recent") return { tone: "recent", label: "Recent activity" };
  if (data.source.freshness === "stale") return { tone: "stale", label: "No recent activity" };
  return { tone: "muted", label: "Waiting for traces" };
}

function stateLabel(state: TelemetryState) {
  if (state === "active") return "Active";
  if (state === "recent") return "Recent";
  if (state === "connected") return "Connected";
  if (state === "stale") return "Stale";
  if (state === "unavailable") return "Unavailable";
  if (state === "unobserved") return "No evidence";
  return "Unknown";
}

function visionEvidence(vision: PlatformTelemetryData["vision"]) {
  if (!vision.analyses) return "Perception · configured · no analysis in window";
  const count = `${vision.analyses} vision ${vision.analyses === 1 ? "analysis" : "analyses"}`;
  return vision.modelSource === "telemetry"
    ? `Perception · ${count} · model traced`
    : `Perception · ${count} · tool traced; model from config`;
}

function MetricCard({ code, label, value, detail }: { code: string; label: string; value: string; detail: string }) {
  return (
    <article className="metric-card" aria-label={`${label}: ${value}`} title={detail}>
      <div className="metric-card__top">
        <span className="metric-code" aria-hidden="true">{code}</span>
        <strong>{value}</strong>
      </div>
      <span className="metric-label">{label}</span>
      <span className="metric-detail">{detail}</span>
    </article>
  );
}

function LoadingPanel({ requestFailed }: { requestFailed: boolean }) {
  return (
    <section className="dashboard-panel telemetry-empty" aria-live="polite">
      <span className="telemetry-empty__pulse" aria-hidden="true" />
      <strong>{requestFailed ? "The browser cannot reach the demo API" : "Connecting to platform telemetry"}</strong>
      <span>{requestFailed ? "The UI will retry automatically; no sample values are being substituted." : "The demo server is requesting metadata-only spans from Phoenix."}</span>
    </section>
  );
}

export default function PlatformTelemetry() {
  const [data, setData] = useState<PlatformTelemetryData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const [viewReady, setViewReady] = useState(false);
  const [viewSince, setViewSince] = useState<string | null>(null);
  const [selectedActivity, setSelectedActivity] = useState<PlatformTelemetryData["activity"][number] | null>(null);
  const activityTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const closeActivityDetails = useCallback(() => {
    setSelectedActivity(null);
    window.requestAnimationFrame(() => activityTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = window.sessionStorage.getItem(VIEW_START_STORAGE_KEY);
      if (stored && Number.isFinite(Date.parse(stored))) setViewSince(stored);
      else window.sessionStorage.removeItem(VIEW_START_STORAGE_KEY);
      setViewReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!viewReady) return;

    let active = true;
    let controller: AbortController | null = null;

    async function load() {
      controller?.abort();
      controller = new AbortController();
      setRefreshing(true);
      try {
        const endpoint = viewSince
          ? `/api/platform-telemetry?since=${encodeURIComponent(viewSince)}`
          : "/api/platform-telemetry";
        const response = await fetch(endpoint, {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Telemetry request failed with ${response.status}.`);
        const next = await response.json() as PlatformTelemetryData;
        if (active) {
          setData(next);
          setRequestFailed(false);
          if (viewSince && next.window.startedAt !== viewSince) {
            window.sessionStorage.setItem(VIEW_START_STORAGE_KEY, next.window.startedAt);
            setViewSince(next.window.startedAt);
          }
        }
      } catch (error) {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) {
          setData(null);
          setRequestFailed(true);
        }
      } finally {
        if (active) setRefreshing(false);
      }
    }

    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [viewReady, viewSince]);

  useEffect(() => {
    if (!selectedActivity) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeActivityDetails();
      } else if (event.key === "Tab") {
        // The close button is intentionally the modal's only interactive control.
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeActivityDetails, selectedActivity]);

  const badge = sourceBadge(data, refreshing, requestFailed);
  const summary = data?.summary;
  const metrics = [
    {
      code: "HT",
      label: "Hermes turns",
      value: summary ? compactNumber(summary.agentTurns) : "—",
      detail: data ? `${summary?.sessions ?? 0} session${summary?.sessions === 1 ? "" : "s"} in window` : "Awaiting Phoenix",
    },
    {
      code: "OK",
      label: "Trace success",
      value: summary?.completionRate === null || summary?.completionRate === undefined ? "—" : `${summary.completionRate}%`,
      detail: "Completed turns without a traced error",
    },
    {
      code: "P95",
      label: "Turn latency",
      value: summary ? duration(summary.latencyP95Ms) : "—",
      detail: "95th percentile end-to-end turn time",
    },
    {
      code: "TK",
      label: "LLM tokens",
      value: summary ? compactNumber(summary.tokens.total) : "—",
      detail: summary ? `${compactNumber(summary.modelCalls)} deduplicated model call${summary.modelCalls === 1 ? "" : "s"}` : "Awaiting Phoenix",
    },
  ];

  function resetTelemetryView() {
    setSelectedActivity(null);
    setData(null);
    setRequestFailed(false);
    setViewSince("now");
  }

  function showTelemetryHistory() {
    window.sessionStorage.removeItem(VIEW_START_STORAGE_KEY);
    setSelectedActivity(null);
    setData(null);
    setRequestFailed(false);
    setViewSince(null);
  }

  return (
    <div className="platform-telemetry">
      <header className="platform-header">
        <div>
          <span className="platform-eyebrow">Retail Agent Toolkit</span>
          <h2>Platform activity</h2>
          <p>How Hermes reasons, uses tools, and delivers traces.</p>
        </div>
        <div className="platform-header__actions">
          <button
            type="button"
            className="telemetry-view-button"
            aria-label={viewSince ? "Show telemetry history" : "Reset activity view"}
            title={viewSince ? "Return to the full telemetry window" : "Start a fresh demo view without deleting Phoenix traces"}
            onClick={viewSince ? showTelemetryHistory : resetTelemetryView}
          >
            <span aria-hidden="true">↻</span>{viewSince ? "Show history" : "Reset"}
          </button>
          <span className={`source-badge source-badge--${badge.tone}`} aria-live="polite">
            <i aria-hidden="true" />{viewSince && data ? "Fresh demo view" : badge.label}
          </span>
        </div>
      </header>

      <section className="metric-grid" aria-label="Hermes telemetry summary">
        {metrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}
      </section>

      {!data ? <LoadingPanel requestFailed={requestFailed} /> : (
        <>
          <section className="dashboard-panel activity-panel" aria-labelledby="activity-title">
            <header className="panel-heading panel-heading--stacked">
              <div>
                <span className="panel-kicker">Plain-language view</span>
                <h3 id="activity-title">What the agent did</h3>
              </div>
              <span>{relativeTime(data.source.lastTelemetryAt)}</span>
            </header>

            {data.activity.length ? (
              <div className="activity-list">
                {data.activity.map((activity) => (
                  <button
                    className="activity-row"
                    type="button"
                    key={activity.ref}
                    aria-label={`View agent activity details: ${activity.summary}`}
                    onClick={(event) => {
                      activityTriggerRef.current = event.currentTarget;
                      setSelectedActivity(activity);
                    }}
                  >
                    <span className={`activity-marker activity-marker--${activity.status}`} aria-hidden="true" />
                    <div className="activity-copy">
                      <strong>{activity.summary}</strong>
                      <span>
                        {activity.channel} · {duration(activity.durationMs)} · {activity.toolCalls} tool{activity.toolCalls === 1 ? "" : "s"} · {activity.modelCalls} model call{activity.modelCalls === 1 ? "" : "s"}
                      </span>
                    </div>
                    <span className="activity-row__open">
                      <time dateTime={activity.startedAt ?? undefined}>{relativeTime(activity.startedAt)}</time>
                      <i aria-hidden="true">›</i>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="panel-empty">
                <strong>{viewSince ? "Fresh demo view ready" : "No Hermes turns in this window"}</strong>
                <span>{viewSince ? "New Hermes activity will appear here. Phoenix history was not deleted." : data.source.message}</span>
              </div>
            )}
          </section>

          <section className="dashboard-panel execution-panel" aria-labelledby="execution-title">
            <header className="panel-heading panel-heading--stacked">
              <div>
                <span className="panel-kicker">Technical view</span>
                <h3 id="execution-title">Models, tools, and channels</h3>
              </div>
              <span>{viewSince ? "Since reset" : `${data.window.lookbackHours}h window`}</span>
            </header>

            <div className="execution-grid">
              <div className="execution-column">
                <span className="execution-label">Top tools</span>
                <div className="usage-list">
                  {data.tools.length ? data.tools.slice(0, 4).map((tool) => (
                    <div key={tool.name}>
                      <span>{TOOL_LABELS.get(tool.name) || tool.name.replaceAll("_", " ")}</span>
                      <code>{tool.name}</code>
                      <strong>{tool.count}</strong>
                    </div>
                  )) : <span className="usage-empty">No tool calls observed</span>}
                </div>
              </div>
              <div className="execution-column">
                <span className="execution-label">Model roles & entry paths</span>
                <div className="model-list">
                  {data.models.length ? data.models.slice(0, 2).map((model) => (
                    <div key={model.name} title={model.name}>
                      <strong>{model.name}</strong>
                      <span>Traced model · {model.count} call{model.count === 1 ? "" : "s"} · {compactNumber(model.tokens)} tokens</span>
                    </div>
                  )) : <span className="usage-empty">No model calls observed</span>}
                  {data.vision.configuredModel || data.vision.observedModels[0] ? (
                    <div title={data.vision.observedModels[0] || data.vision.configuredModel || undefined}>
                      <strong>{data.vision.observedModels[0] || data.vision.configuredModel}</strong>
                      <span>{visionEvidence(data.vision)}</span>
                    </div>
                  ) : null}
                </div>
                <div className="channel-list" aria-label="Hermes entry paths">
                  {data.channels.map((channel) => (
                    <span key={channel.name}>{channel.name} <strong>{channel.count}</strong></span>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="dashboard-panel pipeline-panel" aria-labelledby="pipeline-title">
            <header className="panel-heading panel-heading--stacked">
              <div>
                <span className="panel-kicker">Evidence path</span>
                <h3 id="pipeline-title">Telemetry delivery</h3>
              </div>
              <span>Metadata only</span>
            </header>
            <div className="pipeline-flow">
              {data.pipeline.map((stage, index) => (
                <article className="pipeline-stage" key={stage.id}>
                  <div className="pipeline-stage__heading">
                    <i className={`pipeline-dot pipeline-dot--${stage.state}`} aria-hidden="true" />
                    <strong>{stage.name}</strong>
                  </div>
                  <span>{stage.role}</span>
                  <small>{stage.evidence}</small>
                  {index < data.pipeline.length - 1 ? <b aria-hidden="true">→</b> : null}
                  <span className="sr-only">{stateLabel(stage.state)}</span>
                </article>
              ))}
            </div>
            <footer className="telemetry-footnote">
              <span>{data.privacy.note}</span>
              <span>{data.window.spanCount} spans{data.window.truncated ? " (latest page)" : ""} · Project {data.source.project}</span>
            </footer>
          </section>
        </>
      )}

      {selectedActivity ? (
        <div
          className="activity-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeActivityDetails();
          }}
        >
          <section
            className="activity-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="activity-modal-title"
            aria-describedby="activity-modal-summary"
          >
            <header className="activity-modal__header">
              <div>
                <span className="panel-kicker">Complete action summary</span>
                <h3 id="activity-modal-title">Agent activity details</h3>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                className="activity-modal__close"
                aria-label="Close agent activity details"
                onClick={closeActivityDetails}
              >
                ×
              </button>
            </header>

            <p id="activity-modal-summary" className="activity-modal__summary">
              {selectedActivity.summary}
            </p>

            <dl className="activity-modal__metadata">
              <div><dt>Status</dt><dd>{activityStatusLabel(selectedActivity.status)}</dd></div>
              <div><dt>Entry path</dt><dd>{selectedActivity.channel}</dd></div>
              <div><dt>Started</dt><dd>{absoluteTime(selectedActivity.startedAt)}</dd></div>
              <div><dt>Duration</dt><dd>{duration(selectedActivity.durationMs)}</dd></div>
              <div><dt>Tool calls</dt><dd>{selectedActivity.toolCalls}</dd></div>
              <div><dt>Model calls</dt><dd>{selectedActivity.modelCalls}</dd></div>
              {selectedActivity.model ? <div><dt>Orchestrator model</dt><dd>{selectedActivity.model}</dd></div> : null}
              {selectedActivity.visionModel ? <div><dt>Perception model</dt><dd>{selectedActivity.visionModel}</dd></div> : null}
              {selectedActivity.visionModelSource ? (
                <div>
                  <dt>Perception evidence</dt>
                  <dd>{selectedActivity.visionModelSource === "telemetry" ? "Model captured in telemetry" : "Configured model; vision tool captured"}</dd>
                </div>
              ) : null}
            </dl>

            <p className="activity-modal__privacy">
              This metadata-only view excludes prompts, responses, tool arguments, commands, file paths, and session identifiers.
            </p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
