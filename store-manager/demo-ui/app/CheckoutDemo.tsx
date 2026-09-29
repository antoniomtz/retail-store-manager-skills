"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CheckoutDemoState, CheckoutPlan } from "./checkout-demo-model.mjs";
import { unavailableCheckoutState } from "./checkout-demo-model.mjs";
import { SceneAnchor, useStoreScene } from "./StoreSceneContext";
import { LANE_TRANSFER_LABEL, REGISTER_SIX_LABEL } from "./store-scene/layout";

const POLL_INTERVAL_MS = 2_000;

// The first six customers stay at register 1; when Hermes's approved plan
// opens another staffed register, the rest move to it.
const LANE_ONE_CAPACITY_AFTER_SPLIT = 6;

type MutationAction = "reset" | "trigger" | "approve" | "advance";

const PHASE_COPY: Record<CheckoutDemoState["phase"], { eyebrow: string; title: string; detail: string; tone: string }> = {
  normal: {
    eyebrow: "Checkout operating normally",
    title: "Queue is within target",
    detail: "Trigger a surge to send a computer-vision event to Hermes.",
    tone: "lime",
  },
  hermes_analyzing: {
    eyebrow: "Checkout surge detected",
    title: "Hermes is building a recovery plan",
    detail: "The signed event is active. Waiting for Hermes to compare staffing options and constraints.",
    tone: "amber",
  },
  awaiting_approval: {
    eyebrow: "Hermes recommendation ready",
    title: "Manager decision required",
    detail: "Hermes evaluated the safe actions and committed this decision. Telegram delivery may complete moments later.",
    tone: "amber",
  },
  action_executed: {
    eyebrow: "Staffing action accepted",
    title: "Recovery is in progress",
    detail: "The simulated staffing system returned a verified receipt. Measure the scheduled follow-up next.",
    tone: "lime",
  },
  recovered: {
    eyebrow: "Follow-up measured",
    title: "Checkout recovered",
    detail: "The queue and wait are back within the operating target.",
    tone: "lime",
  },
  follow_up: {
    eyebrow: "Follow-up measured",
    title: "More recovery is needed",
    detail: "The action ran, but the measured queue has not fully returned to target.",
    tone: "amber",
  },
  unavailable: {
    eyebrow: "Checkout workflow unavailable",
    title: "Waiting for the deployed simulator",
    detail: "Start this UI with its private Store Manager runtime adapter.",
    tone: "red",
  },
};

async function readResponse(response: Response) {
  const payload = await response.json() as CheckoutDemoState | { message?: string };
  if (!response.ok) {
    throw new Error("message" in payload && payload.message ? payload.message : "Checkout demo action failed.");
  }
  return payload as CheckoutDemoState;
}

export function useCheckoutDemo() {
  const [data, setData] = useState<CheckoutDemoState>(() => unavailableCheckoutState());
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<MutationAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/checkout-demo", {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal,
      });
      const next = await readResponse(response);
      setData(next);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setData((current) => current.connected ? current : unavailableCheckoutState());
      setError("The checkout workflow is temporarily unavailable.");
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
      const response = await fetch("/api/checkout-demo", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ action, ...(planId ? { planId } : {}) }),
      });
      const next = await readResponse(response);
      setData(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout demo action failed.");
    } finally {
      setBusyAction(null);
    }
  }, []);

  return { data, loading, busyAction, error, mutate };
}

export function CheckoutQueueLayer({ data }: { data: CheckoutDemoState }) {
  const scene = useStoreScene();
  const splitAcrossLanes = Boolean(
    data.receipt?.staffedRegistersOpened
    && data.queue.activeStaffedLanes > data.queue.baselineStaffedLanes,
  );
  const laneOne = splitAcrossLanes
    ? Math.min(LANE_ONE_CAPACITY_AFTER_SPLIT, data.queue.visiblePeople)
    : data.queue.visiblePeople;
  const laneTwo = data.queue.visiblePeople - laneOne;
  const selectedPlanTitle = data.decision?.plans.find((plan) => plan.planId === data.receipt?.planId)?.title
    || "Additional staffed register open";

  useEffect(() => {
    scene?.setCheckout({ laneOne, laneTwo, laneTwoOpen: splitAcrossLanes });
  }, [scene, laneOne, laneTwo, splitAcrossLanes]);
  useEffect(() => () => scene?.setCheckout(null), [scene]);

  return (
    <div
      className="checkout-queue-layer"
      data-queue-customers={data.queue.visiblePeople}
      data-lane-one-customers={laneOne}
      data-lane-two-customers={laneTwo}
      aria-hidden="true"
    >
      {splitAcrossLanes ? (
        <>
          {laneTwo > 0 ? (
            <SceneAnchor at={LANE_TRANSFER_LABEL} className="checkout-lane-transfer">
              <strong>
                Redirecting {laneTwo} {laneTwo === 1 ? "customer" : "customers"}
              </strong>
            </SceneAnchor>
          ) : null}
          <SceneAnchor at={REGISTER_SIX_LABEL} className="checkout-register-open">
            <span className="checkout-register-open__pulse" />
            <strong>{selectedPlanTitle}</strong>
          </SceneAnchor>
        </>
      ) : null}
    </div>
  );
}

function QueueMetrics({ data }: { data: CheckoutDemoState }) {
  return (
    <dl className="checkout-demo__metrics">
      <div>
        <dt>People</dt>
        <dd>{data.queue.people}</dd>
      </div>
      <div>
        <dt>Wait</dt>
        <dd>{data.queue.waitMinutes.toFixed(1)}m</dd>
      </div>
      <div>
        <dt>Staffed registers open</dt>
        <dd>{data.queue.activeStaffedLanes}</dd>
      </div>
    </dl>
  );
}

function PlanButton({ plan, busy, onApprove }: { plan: CheckoutPlan; busy: boolean; onApprove: () => void }) {
  return (
    <button
      className={`checkout-plan${plan.recommended ? " checkout-plan--recommended" : ""}`}
      type="button"
      disabled={busy}
      onClick={onApprove}
    >
      <span>{plan.recommended ? "Recommended" : "Alternate"}</span>
      <strong>{plan.title}</strong>
      <small>{plan.associatesReassigned} associate · {plan.assignmentDurationMinutes} min · projected {plan.projectedWaitMinutes.toFixed(1)}m wait</small>
    </button>
  );
}

export function CheckoutDemoControls({
  data,
  loading,
  busyAction,
  error,
  mutate,
}: ReturnType<typeof useCheckoutDemo>) {
  const copy = PHASE_COPY[data.phase];
  const busy = busyAction !== null;
  const plans = useMemo(() => data.decision?.plans || [], [data.decision]);

  return (
    <section className={`checkout-demo checkout-demo--${copy.tone}`} aria-label="Checkout queue scenario">
      <header className="checkout-demo__header">
        <span className="checkout-demo__signal" aria-hidden="true" />
        <div>
          <span>{copy.eyebrow}</span>
          <h2>{copy.title}</h2>
        </div>
      </header>

      <QueueMetrics data={data} />
      <p className="checkout-demo__detail">{loading ? "Connecting to checkout operations…" : copy.detail}</p>

      {data.phase === "awaiting_approval" && data.capabilities.simulatedApproval ? (
        <div className="checkout-demo__plans" aria-label="Demo approval options">
          {data.decision?.author === "hermes" && data.decision.recommendationReason ? (
            <div className="checkout-demo__reasoning">
              <span>Hermes reasoning</span>
              <p>{data.decision.recommendationReason}</p>
              {data.decision.tradeoffSummary ? <small>{data.decision.tradeoffSummary}</small> : null}
            </div>
          ) : null}
          {plans.map((plan) => (
            <PlanButton
              plan={plan}
              busy={busy}
              onApprove={() => void mutate("approve", plan.planId)}
              key={plan.planId}
            />
          ))}
          <p>Demo control: simulates the manager callback against the persisted Hermes decision; the external system still validates it and returns a receipt.</p>
        </div>
      ) : null}

      {data.receipt ? (
        <div className="checkout-demo__receipt">
          <span>Verified action receipt</span>
          <strong>
            {data.receipt.staffedRegistersOpened > 0
              ? `${data.receipt.staffedRegistersOpened} staffed register opened`
              : `${data.receipt.selfCheckoutHostsRepositioned} self-checkout helper assigned`}
          </strong>
        </div>
      ) : null}

      {error ? <p className="checkout-demo__error" role="alert">{error}</p> : null}

      <div className="checkout-demo__actions">
        <button
          className="checkout-demo__primary"
          type="button"
          disabled={busy || !data.connected || !["normal", "recovered", "follow_up"].includes(data.phase)}
          onClick={() => void mutate("trigger")}
        >
          {busyAction === "trigger" ? "Sending event…" : "Trigger queue surge"}
        </button>
        {data.phase === "action_executed" ? (
          <button type="button" disabled={busy} onClick={() => void mutate("advance")}>
            {busyAction === "advance" ? "Measuring…" : `Measure after ${data.checkpoint?.afterMinutes || 10} min`}
          </button>
        ) : null}
        <button type="button" disabled={busy || !data.connected} onClick={() => void mutate("reset")}>
          {busyAction === "reset" ? "Resetting…" : "Reset"}
        </button>
      </div>
    </section>
  );
}
