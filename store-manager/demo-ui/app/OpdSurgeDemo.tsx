"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { OpdDemoState, OpdPlan } from "./opd-demo-model.mjs";
import { opdPickerVisualCounts, unavailableOpdState } from "./opd-demo-model.mjs";

const POLL_INTERVAL_MS = 2_000;
const MAX_VISUAL_FLEX_ASSOCIATES = 2;

type MutationAction = "reset" | "trigger" | "approve" | "advance";

const PHASE_COPY: Record<OpdDemoState["phase"], { eyebrow: string; title: string; detail: string; tone: string }> = {
  normal: {
    eyebrow: "Online orders on pace",
    title: "OPD is within plan",
    detail: "Trigger a demand surge and picker call-out to wake Hermes through the signed webhook.",
    tone: "lime",
  },
  hermes_analyzing: {
    eyebrow: "Demand surge and call-out detected",
    title: "Hermes is preparing the manager response",
    detail: "The incident is active. Hermes is comparing safe staffing options, weighing the store tradeoffs, and preparing the manager message.",
    tone: "amber",
  },
  awaiting_approval: {
    eyebrow: "Hermes recommendation ready",
    title: "Manager decision required",
    detail: "Hermes finished the manager response. Only its committed recommendation and alternate are shown here.",
    tone: "amber",
  },
  action_executed: {
    eyebrow: "Staffing move verified",
    title: "OPD recovery is underway",
    detail: "The workforce system accepted the approved move. Current conditions remain visible until the scheduled checkpoint is measured.",
    tone: "amber",
  },
  progress_on_track: {
    eyebrow: "30-minute progress target met",
    title: "OPD recovery is on track",
    detail: "The early check passed. Temporary associates remain assigned until the 90-minute recovery window ends.",
    tone: "amber",
  },
  progress_off_track: {
    eyebrow: "30-minute progress target missed",
    title: "OPD recovery needs attention",
    detail: "The early check missed at least one target. Temporary associates remain assigned while the manager reviews the risk.",
    tone: "red",
  },
  recovered: {
    eyebrow: "Follow-up target met",
    title: "OPD recovery confirmed",
    detail: "The measured pick rate and remaining backlog are both within the recovery target.",
    tone: "lime",
  },
  follow_up: {
    eyebrow: "Follow-up target missed",
    title: "More recovery is needed",
    detail: "The approved action ran, but the measured operation still needs manager attention.",
    tone: "red",
  },
  unavailable: {
    eyebrow: "OPD workflow unavailable",
    title: "Waiting for the deployed simulator",
    detail: "Start this UI with its private Store Manager runtime adapter.",
    tone: "red",
  },
};

async function readResponse(response: Response) {
  const payload = await response.json() as OpdDemoState | { message?: string };
  if (!response.ok) {
    throw new Error("message" in payload && payload.message ? payload.message : "OPD demo action failed.");
  }
  return payload as OpdDemoState;
}

export function useOpdDemo() {
  const [data, setData] = useState<OpdDemoState>(() => unavailableOpdState());
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<MutationAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/opd-demo", {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal,
      });
      const next = await readResponse(response);
      setData(next);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setData((current) => current.connected ? current : unavailableOpdState());
      setError("The OPD workflow is temporarily unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => void refresh(controller.signal), 0);
    const interval = window.setInterval(() => void refresh(controller.signal), POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refresh]);

  const mutate = useCallback(async (action: MutationAction, planId?: string) => {
    setBusyAction(action);
    setError(null);
    try {
      const response = await fetch("/api/opd-demo", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ action, ...(planId ? { planId } : {}) }),
      });
      setData(await readResponse(response));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "OPD demo action failed.");
    } finally {
      setBusyAction(null);
    }
  }, []);

  return { data, loading, busyAction, error, mutate };
}

function FlexAssociate({ index, assigned }: { index: number; assigned: boolean }) {
  const style = { "--opd-associate-index": index } as CSSProperties;
  return (
    <span
      className={`opd-flex-associate opd-flex-associate--${index + 1}${assigned ? " opd-flex-associate--assigned" : ""}`}
      style={style}
      data-assigned={assigned ? "true" : "false"}
    >
      <img className="opd-flex-associate__pose opd-flex-associate__pose--a" src="/characters/shelf-check-a.png" alt="" />
      <img className="opd-flex-associate__pose opd-flex-associate__pose--b" src="/characters/shelf-check-b.png" alt="" />
    </span>
  );
}

function ActivePicker({ index }: { index: number }) {
  const sprites = ["/characters/shelf-check-a.png", "/characters/shelf-check-b.png"];
  return (
    <span className={`opd-active-picker opd-active-picker--${index + 1}`}>
      <img src={sprites[index % sprites.length]} alt="" />
    </span>
  );
}

export function OpdRoomLayer({ data }: { data: OpdDemoState }) {
  const incidentActive = data.events.length > 0 || !["normal", "unavailable"].includes(data.phase);
  const associatesVisible = incidentActive
    ? Math.min(MAX_VISUAL_FLEX_ASSOCIATES, data.recoveryContext.availableAssociates)
    : 0;
  const associatesAssigned = data.receipt?.assignmentStatus === "active"
    ? Math.min(associatesVisible, data.receipt.associatesAssigned)
    : 0;
  const pickerVisuals = opdPickerVisualCounts(data.operations.currentPickers, associatesAssigned);
  const demandEvent = data.events.find((event) => event.type === "demand_surge");
  const calloutEvent = data.events.find((event) => event.type === "associate_callout");

  return (
    <div
      className={`opd-room-layer opd-room-layer--${data.phase}`}
      data-reported-pickers={pickerVisuals.reported}
      data-represented-pickers={pickerVisuals.represented}
      aria-hidden="true"
    >
      {incidentActive ? <span className="opd-room-focus" /> : null}
      <div className="opd-room-kpi">
        <span>OPD PICKING</span>
        <strong>{data.operations.currentPickRate.toLocaleString()} / hr</strong>
        <small>{data.operations.backlog.toLocaleString()} items waiting</small>
      </div>
      {incidentActive ? (
        <div className="opd-room-events">
          {demandEvent ? <span>+{demandEvent.additionalOrdersDue} orders due</span> : null}
          {calloutEvent ? <span>−{calloutEvent.pickerReduction} picker</span> : null}
        </div>
      ) : null}
      <div className="opd-backlog" data-visual-units={data.operations.backlogVisualUnits}>
        {Array.from({ length: data.operations.backlogVisualUnits }, (_, index) => (
          <span
            className="opd-backlog__tote"
            style={{ "--opd-tote-index": index } as CSSProperties}
            key={`opd-backlog-${index + 1}`}
          />
        ))}
      </div>
      {Array.from({ length: pickerVisuals.supplemental }, (_, index) => (
        <ActivePicker index={index} key={`opd-active-picker-${index + 1}`} />
      ))}
      {Array.from({ length: associatesVisible }, (_, index) => (
        <FlexAssociate index={index} assigned={index < associatesAssigned} key={`opd-flex-${index + 1}`} />
      ))}
      {associatesAssigned > 0 ? (
        <div className="opd-assignment-path">
          <span />
          <strong>{associatesAssigned} flex {associatesAssigned === 1 ? "associate" : "associates"} joining OPD</strong>
        </div>
      ) : null}
    </div>
  );
}

function OpdMetrics({ data }: { data: OpdDemoState }) {
  return (
    <dl className="checkout-demo__metrics opd-demo__metrics">
      <div>
        <dt>Backlog now</dt>
        <dd>{data.operations.backlog.toLocaleString()}</dd>
      </div>
      <div>
        <dt>Pick rate</dt>
        <dd>{data.operations.currentPickRate.toLocaleString()}/h</dd>
      </div>
      <div>
        <dt>Pickers</dt>
        <dd>{data.operations.currentPickers}</dd>
      </div>
    </dl>
  );
}

function OpdPlanButton({ plan, busy, onApprove }: { plan: OpdPlan; busy: boolean; onApprove: () => void }) {
  return (
    <button
      className={`checkout-plan opd-plan${plan.recommended ? " checkout-plan--recommended opd-plan--recommended" : ""}`}
      type="button"
      disabled={busy}
      onClick={onApprove}
    >
      <span>{plan.recommended ? "Hermes recommends" : "Alternate"}</span>
      <strong>{plan.title}</strong>
      <small>
        {plan.additionalAssociates} {plan.additionalAssociates === 1 ? "associate" : "associates"} · {plan.assignmentDurationMinutes} min · expected {plan.projectedPickRate.toLocaleString()}/h and {plan.projectedBacklog.toLocaleString()} waiting
      </small>
      <em className={plan.meetsCheckpoint ? "opd-plan__met" : "opd-plan__missed"}>
        {plan.meetsCheckpoint ? "Meets both follow-up targets" : "Misses at least one follow-up target"}
      </em>
    </button>
  );
}

function EventSummary({ data }: { data: OpdDemoState }) {
  const demand = data.events.find((event) => event.type === "demand_surge");
  const callout = data.events.find((event) => event.type === "associate_callout");
  if (!demand && !callout) return null;
  return (
    <div className="opd-demo__events" aria-label="Detected OPD changes">
      {demand ? <span>📦 {demand.additionalOrdersDue} additional orders · {demand.additionalBacklog} items added to picking</span> : null}
      {callout ? <span>👤 One picker called out · capacity fell {callout.pickRateReduction}/h</span> : null}
    </div>
  );
}

function ActionProgress({ data }: { data: OpdDemoState }) {
  if (!data.receipt) return null;
  const selected = data.decision?.plans.find((plan) => plan.planId === data.receipt?.planId);
  return (
    <div className="checkout-demo__receipt opd-demo__receipt">
      <span>Verified workforce receipt</span>
      <strong>
        {data.receipt.assignmentStatus === "completed" ? "Completed" : "Active"}: {data.receipt.associatesAssigned} cross-trained {data.receipt.associatesAssigned === 1 ? "associate" : "associates"} for {data.receipt.assignmentDurationMinutes} minutes
      </strong>
      <div className="opd-demo__comparison">
        <p><b>Observed now</b><span>{data.operations.currentPickRate.toLocaleString()}/h · {data.operations.backlog.toLocaleString()} waiting</span></p>
        {selected ? <p><b>Expected at {selected.projectionHorizonMinutes} min</b><span>{selected.projectedPickRate.toLocaleString()}/h · {selected.projectedBacklog.toLocaleString()} waiting</span></p> : null}
      </div>
    </div>
  );
}

function CheckpointResult({ data }: { data: OpdDemoState }) {
  if (!data.checkpoint || !["met", "missed"].includes(data.checkpoint.status || "")) return null;
  return (
    <div className={`opd-demo__checkpoint opd-demo__checkpoint--${data.checkpoint.targetMet ? "met" : "missed"}`}>
      <span>
        {data.checkpoint.stage === "final"
          ? data.checkpoint.targetMet ? "✓ Final recovery verified" : "! Final recovery missed"
          : data.checkpoint.targetMet ? "✓ Progress is on track" : "! Early check missed"}
      </span>
      <strong>
        {data.checkpoint.measuredPickRate.toLocaleString()}/h and {data.checkpoint.measuredBacklog.toLocaleString()} items waiting
      </strong>
      <small>
        Targets: at least {data.checkpoint.minimumPickRate.toLocaleString()}/h and no more than {data.checkpoint.maximumBacklog.toLocaleString()} waiting.
      </small>
      {data.checkpoint.guidance ? <small>{data.checkpoint.guidance}</small> : null}
    </div>
  );
}

export function OpdDemoControls({
  data,
  loading,
  busyAction,
  error,
  mutate,
}: ReturnType<typeof useOpdDemo>) {
  const copy = PHASE_COPY[data.phase];
  const busy = busyAction !== null;
  const plans = useMemo(() => data.decision?.plans || [], [data.decision]);

  return (
    <section className={`checkout-demo checkout-demo--${copy.tone} opd-demo`} aria-label="OPD surge scenario">
      <header className="checkout-demo__header">
        <span className="checkout-demo__signal" aria-hidden="true" />
        <div>
          <span>{copy.eyebrow}</span>
          <h2>{copy.title}</h2>
        </div>
      </header>

      <OpdMetrics data={data} />
      <p className="checkout-demo__detail">{loading ? "Connecting to OPD operations…" : copy.detail}</p>
      <div className="opd-demo__targets">
        <span>{data.operations.ordersDue.toLocaleString()} orders due</span>
        <span>Normal pace {data.operations.normalPickRate.toLocaleString()}/h</span>
        {data.events.length > 0 && data.operations.recoveryMinimumPickRate > 0 ? (
          <span>{data.recoveryContext.checkpointAfterMinutes} min recovery check ≥ {data.operations.recoveryMinimumPickRate.toLocaleString()}/h</span>
        ) : null}
        {data.events.length > 0 && data.operations.recoveryMaximumBacklog > 0 ? (
          <span>{data.recoveryContext.checkpointAfterMinutes} min backlog ≤ {data.operations.recoveryMaximumBacklog.toLocaleString()}</span>
        ) : null}
      </div>
      <EventSummary data={data} />

      {data.phase === "awaiting_approval" ? (
        <div className="checkout-demo__plans" aria-label="OPD manager approval options">
          {data.decision?.author === "hermes" && data.decision.recommendationReason ? (
            <div className="checkout-demo__reasoning">
              <span>Why Hermes recommends it</span>
              <p>{data.decision.recommendationReason}</p>
              {data.decision.tradeoffSummary ? <small>Tradeoff: {data.decision.tradeoffSummary}</small> : null}
            </div>
          ) : null}
          {plans.map((plan) => (
            <OpdPlanButton
              plan={plan}
              busy={busy || !data.capabilities.simulatedApproval}
              onApprove={() => void mutate("approve", plan.planId)}
              key={plan.planId}
            />
          ))}
          <p>
            {data.capabilities.simulatedApproval
              ? "Demo control: simulates the manager callback against the exact persisted Hermes decision."
              : "Approve one of these exact plans from the Telegram decision buttons."}
          </p>
        </div>
      ) : null}

      <ActionProgress data={data} />
      <CheckpointResult data={data} />
      {error ? <p className="checkout-demo__error" role="alert">{error}</p> : null}

      <div className="checkout-demo__actions">
        <button
          className="checkout-demo__primary"
          type="button"
          disabled={busy || !data.connected || !["normal", "recovered", "follow_up"].includes(data.phase)}
          onClick={() => void mutate("trigger")}
        >
          {busyAction === "trigger" ? "Sending event…" : "Trigger OPD surge + call-out"}
        </button>
        {["action_executed", "progress_on_track", "progress_off_track"].includes(data.phase) ? (
          <button type="button" disabled={busy} onClick={() => void mutate("advance")}>
            {busyAction === "advance"
              ? "Measuring…"
              : data.checkpoint?.stage === "progress" && data.checkpoint.status !== "scheduled"
                ? `Measure final outcome after ${data.checkpoint.nextMeasurementAfterMinutes} min`
                : `Check progress after ${data.checkpoint?.nextMeasurementAfterMinutes || data.recoveryContext.checkpointAfterMinutes} min`}
          </button>
        ) : null}
        <button type="button" disabled={busy || !data.connected} onClick={() => void mutate("reset")}>
          {busyAction === "reset" ? "Resetting…" : "Reset"}
        </button>
      </div>
    </section>
  );
}
