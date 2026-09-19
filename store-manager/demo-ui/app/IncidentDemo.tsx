"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useState } from "react";
import type { IncidentDemoState } from "./incident-demo-model.mjs";
import { unavailableIncidentState } from "./incident-demo-model.mjs";

type MutationAction = "trigger" | "reset";

async function readResponse(response: Response) {
  const payload = await response.json() as IncidentDemoState | { message?: string };
  if (!response.ok) {
    throw new Error(
      "message" in payload && payload.message
        ? payload.message
        : "Store incident demo action failed.",
    );
  }
  return payload as IncidentDemoState;
}

export function useIncidentDemo() {
  const [data, setData] = useState<IncidentDemoState>(() => unavailableIncidentState());
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<MutationAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/incident-demo", {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(readResponse)
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setData(unavailableIncidentState());
        setError("The incident workflow is temporarily unavailable.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const mutate = useCallback(async (action: MutationAction) => {
    setBusyAction(action);
    setError(null);
    if (action === "trigger") {
      setData((current) => ({
        ...current,
        active: true,
        phase: "sending",
      }));
    }
    try {
      const response = await fetch("/api/incident-demo", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      setData(await readResponse(response));
    } catch (caught) {
      setData((current) => ({ ...current, active: true, phase: "failed" }));
      setError(caught instanceof Error ? caught.message : "Store incident demo action failed.");
    } finally {
      setBusyAction(null);
    }
  }, []);

  return { data, loading, busyAction, error, mutate };
}

export function IncidentMapLayer() {
  return (
    <img
      className="store-stage__incidents store-stage__incidents--active"
      src="/store-incidents-overlay.png"
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

const PHASE_COPY: Record<IncidentDemoState["phase"], { eyebrow: string; title: string; detail: string; tone: string }> = {
  ready: {
    eyebrow: "Store safety monitoring",
    title: "Incident scene ready",
    detail: "Trigger the camera event to show the current image and ask Hermes for a response plan.",
    tone: "lime",
  },
  sending: {
    eyebrow: "Incident detected",
    title: "Hermes is analyzing the image",
    detail: "The authenticated event was sent. Hermes vision is inspecting the current image before requesting bounded response options.",
    tone: "amber",
  },
  sent: {
    eyebrow: "Incident assessment requested",
    title: "Hermes response is going to Telegram",
    detail: "Hermes is analyzing the image, comparing available response teams, and will send its recommendation to the configured manager.",
    tone: "amber",
  },
  failed: {
    eyebrow: "Incident detected",
    title: "Hermes notification needs attention",
    detail: "The visual incident remains active, but the agent did not accept the notification.",
    tone: "red",
  },
  unavailable: {
    eyebrow: "Incident workflow unavailable",
    title: "Waiting for the deployed webhook",
    detail: "Install the current Store Manager package and start this UI with its private runtime adapter.",
    tone: "red",
  },
};

export function IncidentDemoControls({
  data,
  loading,
  busyAction,
  error,
  mutate,
}: ReturnType<typeof useIncidentDemo>) {
  const copy = PHASE_COPY[data.phase];
  const busy = busyAction !== null;

  return (
    <section
      className={`checkout-demo checkout-demo--${copy.tone} incident-demo`}
      aria-label="Store incident scenario"
    >
      <header className="checkout-demo__header">
        <span className="checkout-demo__signal" aria-hidden="true" />
        <div>
          <span>{copy.eyebrow}</span>
          <h2>{copy.title}</h2>
        </div>
      </header>

      <p className="checkout-demo__detail">
        {loading ? "Connecting to the incident workflow…" : copy.detail}
      </p>

      {data.active ? (
        <figure className="incident-demo__camera">
          <div className="incident-demo__camera-frame">
            <img src={data.image.src} alt={data.image.alt} />
            <span>LIVE INCIDENT</span>
          </div>
          <figcaption>
            <strong>{data.image.location}</strong>
            <span>Current image supplied to Hermes auxiliary vision</span>
          </figcaption>
        </figure>
      ) : (
        <div className="incident-demo__standby" aria-hidden="true">
          <span>01</span>
          <strong>Produce-area camera ready</strong>
        </div>
      )}

      {data.phase === "sent" ? (
        <div className="checkout-demo__receipt incident-demo__receipt">
          <span>Telegram delivery started</span>
          <strong>No manager approval is required for this advisory response.</strong>
        </div>
      ) : null}

      {error ? <p className="checkout-demo__error" role="alert">{error}</p> : null}

      <div className="checkout-demo__actions">
        <button
          className="checkout-demo__primary"
          type="button"
          disabled={busy || !data.connected || data.active}
          onClick={() => void mutate("trigger")}
        >
          {busyAction === "trigger" ? "Sending incident…" : "Trigger store incident"}
        </button>
        <button
          type="button"
          disabled={busy || !data.connected || !data.active}
          onClick={() => void mutate("reset")}
        >
          {busyAction === "reset" ? "Resetting…" : "Reset"}
        </button>
      </div>
    </section>
  );
}
