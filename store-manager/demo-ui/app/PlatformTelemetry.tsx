"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MorningBriefingPresentation } from "./morning-briefing-model.mjs";
import type { PlatformTelemetry as PlatformTelemetryData } from "./platform-telemetry-model.mjs";

const POLL_INTERVAL_MS = 12_000;
const BRIEFING_POLL_INTERVAL_MS = 3_000;
const VIEW_START_STORAGE_KEY = "retail-store-manager.telemetry-view-start";
type BriefingDialog = "team" | "readiness";

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

function clockTime(value: string) {
  const match = value.match(/T([01][0-9]|2[0-3]):([0-5][0-9])/);
  if (!match) return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

function leaderStatus(value: "on_site" | "scheduled") {
  return value === "on_site" ? "On site" : "Scheduled";
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

function LoadingPanel({ requestFailed }: { requestFailed: boolean }) {
  return (
    <section className="dashboard-panel telemetry-empty" aria-live="polite">
      <span className="telemetry-empty__pulse" aria-hidden="true" />
      <strong>{requestFailed ? "The browser cannot reach the demo API" : "Connecting to platform telemetry"}</strong>
    </section>
  );
}

type PlatformTelemetryProps = {
  onRunMorningBriefing: () => void;
};

export default function PlatformTelemetry({ onRunMorningBriefing }: PlatformTelemetryProps) {
  const [data, setData] = useState<PlatformTelemetryData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const [viewReady, setViewReady] = useState(false);
  const [viewSince, setViewSince] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<MorningBriefingPresentation | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<PlatformTelemetryData["activity"][number] | null>(null);
  const [briefingDialog, setBriefingDialog] = useState<BriefingDialog | null>(null);
  const activityTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const briefingTriggerRef = useRef<HTMLButtonElement | null>(null);
  const briefingCloseButtonRef = useRef<HTMLButtonElement | null>(null);

  const closeActivityDetails = useCallback(() => {
    setSelectedActivity(null);
    window.requestAnimationFrame(() => activityTriggerRef.current?.focus());
  }, []);

  const closeBriefingDetails = useCallback(() => {
    setBriefingDialog(null);
    window.requestAnimationFrame(() => briefingTriggerRef.current?.focus());
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
    if (!viewReady) return;

    let active = true;
    let controller: AbortController | null = null;

    async function loadBriefing() {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/api/morning-briefing", {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Morning briefing request failed with ${response.status}.`);
        const next = await response.json() as MorningBriefingPresentation;
        if (active) setBriefing(next);
      } catch (error) {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) {
          setBriefing((current) => current?.status === "ready" ? current : null);
        }
      }
    }

    void loadBriefing();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadBriefing();
    }, BRIEFING_POLL_INTERVAL_MS);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [viewReady]);

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

  useEffect(() => {
    if (!briefingDialog) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    briefingCloseButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeBriefingDetails();
      } else if (event.key === "Tab") {
        const dialog = briefingCloseButtonRef.current?.closest("[role=dialog]");
        const controls = dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])");
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [briefingDialog, closeBriefingDetails]);

  const badge = resetFailed
    ? { tone: "error", label: "Reset failed" }
    : sourceBadge(data, refreshing, requestFailed);

  async function resetTelemetryView() {
    if (resetting) return;
    setResetting(true);
    setResetFailed(false);
    try {
      const response = await fetch("/api/morning-briefing", {
        method: "DELETE",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Morning briefing reset failed with ${response.status}.`);
      const next = await response.json() as MorningBriefingPresentation;
      if (next.status !== "empty") throw new Error("Morning briefing reset was not confirmed.");
      setBriefing(next);
      setSelectedActivity(null);
      setData(null);
      setRequestFailed(false);
      setViewSince("now");
    } catch {
      setResetFailed(true);
    } finally {
      setResetting(false);
    }
  }

  function showTelemetryHistory() {
    window.sessionStorage.removeItem(VIEW_START_STORAGE_KEY);
    setResetFailed(false);
    setSelectedActivity(null);
    setData(null);
    setRequestFailed(false);
    setViewSince(null);
  }

  return (
    <div className="platform-telemetry">
      <header className="platform-header">
        <div>
          <span className="platform-eyebrow">Store Manager</span>
          <h2>Opening dashboard</h2>
        </div>
        <div className="platform-header__actions">
          <button
            type="button"
            className="telemetry-view-button"
            aria-label={viewSince ? "Show telemetry history" : "Reset activity view"}
            title={viewSince ? "Return to the full telemetry window" : "Clear morning priorities and start a fresh activity view without deleting Phoenix traces"}
            disabled={resetting}
            onClick={viewSince ? showTelemetryHistory : () => void resetTelemetryView()}
          >
            <span aria-hidden="true">↻</span>{resetting ? "Resetting" : viewSince ? "Show history" : "Reset"}
          </button>
          <span className={`source-badge source-badge--${badge.tone}`} aria-live="polite">
            <i aria-hidden="true" />{viewSince && data ? "Fresh demo view" : badge.label}
          </span>
        </div>
      </header>

      {briefing?.status === "ready" && briefing.presentation ? (
        <section className="morning-priorities" aria-labelledby="morning-priorities-title">
          <header className="morning-priorities__heading">
            <div>
              <span className="section-icon" aria-hidden="true">☀</span>
              <h3 id="morning-priorities-title">Opening brief</h3>
            </div>
            <time dateTime={briefing.presentation.publishedAt}>{briefing.businessDate}</time>
          </header>

          <div className="briefing-summary-grid">
            <button
              type="button"
              className="briefing-summary briefing-summary--team"
              aria-label="View opening team"
              onClick={(event) => {
                briefingTriggerRef.current = event.currentTarget;
                setSelectedActivity(null);
                setBriefingDialog("team");
              }}
            >
              <span className="briefing-summary__icon" aria-hidden="true">👥</span>
              <span className="briefing-summary__copy">
                <small>Opening team</small>
                <strong>{briefing.presentation.openingTeam.length} leaders</strong>
                <span>{briefing.presentation.openingTeam.filter((leader) => leader.status === "on_site").length} on site</span>
              </span>
              <i aria-hidden="true">›</i>
            </button>
            <button
              type="button"
              className={`briefing-summary briefing-summary--readiness briefing-summary--${briefing.presentation.readiness.overallStatus}`}
              aria-label="View store readiness"
              onClick={(event) => {
                briefingTriggerRef.current = event.currentTarget;
                setSelectedActivity(null);
                setBriefingDialog("readiness");
              }}
            >
              <span className="briefing-summary__icon" aria-hidden="true">🏪</span>
              <span className="briefing-summary__copy">
                <small>Store readiness</small>
                <strong>{briefing.presentation.readiness.areasReady} of {briefing.presentation.readiness.areasChecked} ready</strong>
                <span>{briefing.presentation.readiness.issues.length} open issue{briefing.presentation.readiness.issues.length === 1 ? "" : "s"}</span>
              </span>
              <i aria-hidden="true">›</i>
            </button>
          </div>

          <div className="morning-priorities__subheading">
            <span aria-hidden="true">🚨</span>
            <h4>Open first</h4>
          </div>
          <div className="morning-priority-grid">
            {briefing.presentation.priorities.map((priority) => (
              <article className={`dashboard-panel morning-priority-card morning-priority-card--${priority.rank}`} key={priority.rank}>
                <span className="morning-priority-card__rank" aria-hidden="true">{priority.rank}</span>
                <div>
                  <h4>{priority.title}</h4>
                  <p>{priority.evidence}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {briefing?.status === "empty" ? (
        <section className="dashboard-panel morning-briefing-empty" aria-live="polite">
          <span className="section-icon" aria-hidden="true">☀</span>
          <strong>No morning briefing yet.</strong>
          <button type="button" onClick={onRunMorningBriefing}>
            <span aria-hidden="true">✦</span>
            Give me a morning briefing
          </button>
        </section>
      ) : null}

      {!data ? <LoadingPanel requestFailed={requestFailed} /> : (
        <section className="dashboard-panel activity-panel" aria-labelledby="activity-title">
          <header className="panel-heading panel-heading--stacked">
            <h3 id="activity-title"><span aria-hidden="true">✦</span> What the agent did</h3>
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
              <h3 id="activity-modal-title">Agent activity details</h3>
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

      {briefingDialog && briefing?.status === "ready" && briefing.presentation ? (
        <div
          className="activity-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeBriefingDetails();
          }}
        >
          <section
            className="activity-modal briefing-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="briefing-modal-title"
          >
            <header className="activity-modal__header briefing-modal__header">
              <div>
                <span className="briefing-modal__eyebrow">{briefing.businessDate}</span>
                <h3 id="briefing-modal-title">
                  {briefingDialog === "team" ? "👥 Opening team" : "🏪 Store readiness"}
                </h3>
              </div>
              <button
                ref={briefingCloseButtonRef}
                type="button"
                className="activity-modal__close"
                aria-label={`Close ${briefingDialog === "team" ? "opening team" : "store readiness"}`}
                onClick={closeBriefingDetails}
              >
                ×
              </button>
            </header>

            {briefingDialog === "team" ? (
              <div className="briefing-table-wrap">
                <table className="briefing-table">
                  <thead>
                    <tr><th>Department</th><th>Lead or coach</th><th>Shift</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {briefing.presentation.openingTeam.map((leader) => (
                      <tr key={leader.reference}>
                        <td>{leader.departments.join(", ")}</td>
                        <td><strong>{leader.displayName}</strong><span>{leader.role}</span></td>
                        <td>{leader.shift}</td>
                        <td><span className={`status-chip status-chip--${leader.status}`}>{leaderStatus(leader.status)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="readiness-details">
                <div className="readiness-score">
                  <div>
                    <strong>{briefing.presentation.readiness.areasReady}/{briefing.presentation.readiness.areasChecked}</strong>
                    <span>areas ready</span>
                  </div>
                  <div className="readiness-score__track" aria-hidden="true">
                    <i style={{ width: `${(briefing.presentation.readiness.areasReady / briefing.presentation.readiness.areasChecked) * 100}%` }} />
                  </div>
                  <span className={`status-chip status-chip--${briefing.presentation.readiness.overallStatus}`}>
                    {briefing.presentation.readiness.overallStatus === "ready" ? "Ready" : "Attention needed"}
                  </span>
                </div>

                {briefing.presentation.readiness.issues.length ? (
                  <section className="readiness-section" aria-labelledby="opening-issues-title">
                    <h4 id="opening-issues-title">Open issues</h4>
                    <div className="briefing-table-wrap">
                      <table className="briefing-table briefing-table--compact readiness-issue-table">
                        <thead><tr><th>Issue</th><th>Owner</th><th>Resolve by</th></tr></thead>
                        <tbody>
                          {briefing.presentation.readiness.issues.map((issue) => (
                            <tr key={issue.id}>
                              <td>
                                <span className={`severity-dot severity-dot--${issue.severity}`} aria-label={`${issue.severity} severity`} />
                                <strong>{issue.description}</strong>
                              </td>
                              <td>{issue.ownerRole}</td>
                              <td><time dateTime={issue.targetResolutionAt}>{clockTime(issue.targetResolutionAt)}</time></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ) : null}

                {briefing.presentation.readiness.staffingGaps.length ? (
                  <section className="readiness-section" aria-labelledby="coverage-gaps-title">
                    <h4 id="coverage-gaps-title">Coverage gaps</h4>
                    <div className="briefing-table-wrap">
                      <table className="briefing-table briefing-table--compact">
                        <thead><tr><th>Department</th><th>Window</th><th>Scheduled</th><th>Needed</th></tr></thead>
                        <tbody>
                          {briefing.presentation.readiness.staffingGaps.map((gap) => (
                            <tr key={`${gap.department}-${gap.timeWindow}`}>
                              <td><strong>{gap.department}</strong></td>
                              <td>{gap.timeWindow}</td>
                              <td>{gap.scheduledHeadcount}</td>
                              <td>{gap.requiredHeadcount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ) : null}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
