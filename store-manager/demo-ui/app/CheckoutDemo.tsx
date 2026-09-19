"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { CheckoutDemoState, CheckoutPlan } from "./checkout-demo-model.mjs";
import { unavailableCheckoutState } from "./checkout-demo-model.mjs";

const POLL_INTERVAL_MS = 2_000;

const PRIMARY_LANE = [
  [676, 412, 48], [683, 432, 52], [690, 452, 56], [697, 472, 60],
  [704, 492, 64], [711, 512, 68], [718, 532, 72], [725, 552, 74],
  [732, 572, 76], [739, 592, 78], [746, 612, 80], [753, 632, 82],
] as const;

const SECONDARY_LANE = [
  [736, 365, 49], [746, 385, 54], [756, 405, 59],
  [766, 425, 64], [776, 445, 69], [786, 465, 74],
] as const;

const CUSTOMER_VEST_HUES = [0, 42, 88, 145, 198, 246, 300, 25, 115, 175, 220, 335];

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

function customerPosition(index: number, splitAcrossLanes: boolean) {
  const firstReassignedCustomer = PRIMARY_LANE.length - SECONDARY_LANE.length;
  const startingValues = PRIMARY_LANE[index % PRIMARY_LANE.length];

  if (splitAcrossLanes && index >= firstReassignedCustomer) {
    const reassignedIndex = index - firstReassignedCustomer;
    return {
      lane: 2,
      reassigned: true,
      reassignedIndex,
      startingValues,
      values: SECONDARY_LANE[reassignedIndex % SECONDARY_LANE.length],
    };
  }
  return {
    lane: 1,
    reassigned: false,
    reassignedIndex: -1,
    startingValues,
    values: startingValues,
  };
}

function CustomerPose({ pose, src }: { pose: "a" | "b"; src: string }) {
  return (
    <span className={`checkout-customer__pose checkout-customer__pose--${pose}`}>
      <img className="checkout-customer__sprite checkout-customer__sprite--tinted" src={src} alt="" />
      <img className="checkout-customer__sprite checkout-customer__sprite--skin checkout-customer__sprite--face" src={src} alt="" />
      <img className="checkout-customer__sprite checkout-customer__sprite--skin checkout-customer__sprite--left-hand" src={src} alt="" />
      <img className="checkout-customer__sprite checkout-customer__sprite--skin checkout-customer__sprite--right-hand" src={src} alt="" />
    </span>
  );
}

export function CheckoutQueueLayer({ data }: { data: CheckoutDemoState }) {
  const firstReassignedCustomer = PRIMARY_LANE.length - SECONDARY_LANE.length;
  const splitAcrossLanes = Boolean(
    data.receipt?.staffedRegistersOpened
    && data.queue.activeStaffedLanes > data.queue.baselineStaffedLanes,
  );
  const reassignedCustomerCount = splitAcrossLanes
    ? Math.max(0, data.queue.visiblePeople - firstReassignedCustomer)
    : 0;
  const selectedPlanTitle = data.decision?.plans.find((plan) => plan.planId === data.receipt?.planId)?.title
    || "Additional staffed register open";

  return (
    <div className="checkout-queue-layer" aria-hidden="true">
      {Array.from({ length: data.queue.visiblePeople }, (_, index) => {
        const { lane, reassigned, reassignedIndex, startingValues, values } = customerPosition(index, splitAcrossLanes);
        const [x, y, height] = values;
        const [startX, startY, startHeight] = startingValues;
        const pathOneX = startX + 34;
        const pathOneY = startY - 10;
        const pathTwoX = x + 24;
        const pathTwoY = y + 16;
        const style = {
          "--customer-x": `${(x / 1137) * 100}%`,
          "--customer-y": `${(y / 909) * 100}%`,
          "--customer-height": `${(height / 909) * 100}%`,
          "--customer-start-x": `${(startX / 1137) * 100}%`,
          "--customer-start-y": `${(startY / 909) * 100}%`,
          "--customer-start-height": `${(startHeight / 909) * 100}%`,
          "--customer-path-one-x": `${(pathOneX / 1137) * 100}%`,
          "--customer-path-one-y": `${(pathOneY / 909) * 100}%`,
          "--customer-path-two-x": `${(pathTwoX / 1137) * 100}%`,
          "--customer-path-two-y": `${(pathTwoY / 909) * 100}%`,
          "--customer-vest-hue": `${CUSTOMER_VEST_HUES[index % CUSTOMER_VEST_HUES.length]}deg`,
          "--customer-delay": `${-((index * 0.17) % 1.6)}s`,
          "--customer-move-delay": `${Math.max(0, reassignedIndex) * 240}ms`,
        } as CSSProperties;
        return (
          <span
            className={`checkout-customer checkout-customer--lane-${lane}${reassigned ? " checkout-customer--reassigned" : ""}`}
            style={style}
            key={`checkout-customer-${index + 1}`}
          >
            <CustomerPose pose="a" src="/characters/waiting-idle-a.png" />
            <CustomerPose pose="b" src="/characters/waiting-idle-b.png" />
          </span>
        );
      })}
      {splitAcrossLanes ? (
        <>
          <div className="checkout-lane-transfer" role="presentation">
            <span />
            <strong>
              Redirecting {reassignedCustomerCount} {reassignedCustomerCount === 1 ? "customer" : "customers"}
            </strong>
          </div>
          <div className="checkout-register-open" role="presentation">
            <span className="checkout-register-open__pulse" />
            <strong>{selectedPlanTitle}</strong>
          </div>
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
