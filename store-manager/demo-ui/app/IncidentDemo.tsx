"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { IncidentDemoState } from "./incident-demo-model.mjs";
import { unavailableIncidentState } from "./incident-demo-model.mjs";
import { useStoreScene } from "./StoreSceneContext";

type DeliveryTarget = "ui" | "telegram";
type MutationAction = "trigger" | "reset";
type IncidentStep = {
  id: string;
  label: string;
  state: "running" | "completed" | "failed";
};
type StreamEvent = {
  type?: string;
  content?: string;
  tool_name?: string;
};

const TOOL_LABELS: Record<string, string> = {
  skill_view: "Incident skill loaded",
  vision_analyze: "Image analyzed",
  terminal: "Response options checked",
  read_file: "Response format loaded",
};

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

function readSseBlock(block: string): StreamEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    return null;
  }
}

export function useIncidentDemo() {
  const [data, setData] = useState<IncidentDemoState>(() => unavailableIncidentState());
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<MutationAction | null>(null);
  const [deliveryTarget, setDeliveryTarget] = useState<DeliveryTarget>("ui");
  const [steps, setSteps] = useState<IncidentStep[]>([]);
  const [assessment, setAssessment] = useState("");
  const [assessmentOpen, setAssessmentOpen] = useState(false);
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

  const updateToolStep = useCallback((toolName: string, state: IncidentStep["state"]) => {
    const id = `tool:${toolName}`;
    const label = TOOL_LABELS[toolName]
      || toolName.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
    setSteps((current) => {
      const existing = current.find((step) => step.id === id);
      if (!existing) return [...current, { id, label, state }];
      return current.map((step) => step.id === id ? { ...step, state } : step);
    });
  }, []);

  const runUiAssessment = useCallback(async () => {
    setData((current) => ({
      ...current,
      active: true,
      phase: "sending",
      deliveryTarget: "ui",
    }));
    setSteps([{ id: "session", label: "Starting Hermes assessment", state: "running" }]);

    const response = await fetch("/api/incident-demo/stream", {
      method: "POST",
      headers: { accept: "text/event-stream" },
    });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(payload.message || "Hermes could not start the incident assessment.");
    }

    setData((current) => ({ ...current, phase: "analyzing" }));
    setSteps((current) => current.map((step) => step.id === "session"
      ? { ...step, label: "Hermes assessment started", state: "completed" }
      : step));

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalContent = "";
    let streamedContent = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      if (done && buffer.trim()) blocks.push(buffer);

      for (const block of blocks) {
        const event = readSseBlock(block);
        if (!event?.type) continue;
        if (event.type === "tool.started" && event.tool_name) {
          updateToolStep(event.tool_name, "running");
        } else if ((event.type === "tool.completed" || event.type === "tool.failed") && event.tool_name) {
          updateToolStep(event.tool_name, event.type === "tool.completed" ? "completed" : "failed");
        } else if (event.type === "assistant.delta" && event.content) {
          streamedContent += event.content;
          setAssessment(streamedContent);
        } else if (event.type === "assistant.completed") {
          finalContent = event.content?.trim() || streamedContent.trim();
          setAssessment(finalContent);
        } else if (event.type === "error") {
          throw new Error(event.content || "Hermes could not complete the incident assessment.");
        }
      }
      if (done) break;
    }
    if (!finalContent) throw new Error("Hermes completed without an incident assessment.");

    setSteps((current) => [
      ...current,
      { id: "complete", label: "Assessment ready", state: "completed" },
    ]);
    setData((current) => ({ ...current, phase: "complete" }));
  }, [updateToolStep]);

  const mutate = useCallback(async (action: MutationAction) => {
    setBusyAction(action);
    setError(null);
    try {
      if (action === "reset") {
        const response = await fetch("/api/incident-demo", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        setData(await readResponse(response));
        setSteps([]);
        setAssessment("");
        setAssessmentOpen(false);
        return;
      }

      setAssessment("");
      setAssessmentOpen(false);
      setSteps([]);
      if (deliveryTarget === "ui") {
        await runUiAssessment();
        return;
      }

      setData((current) => ({
        ...current,
        active: true,
        phase: "sending",
        deliveryTarget: "telegram",
      }));
      const response = await fetch("/api/incident-demo", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ action, delivery: "telegram" }),
      });
      setData(await readResponse(response));
    } catch (caught) {
      setData((current) => ({ ...current, active: true, phase: "failed" }));
      setSteps((current) => current.map((step) => step.state === "running"
        ? { ...step, state: "failed" }
        : step));
      setError(caught instanceof Error ? caught.message : "Store incident demo action failed.");
    } finally {
      setBusyAction(null);
    }
  }, [deliveryTarget, runUiAssessment]);

  return {
    data,
    loading,
    busyAction,
    deliveryTarget,
    steps,
    assessment,
    assessmentOpen,
    error,
    setDeliveryTarget,
    setAssessmentOpen,
    mutate,
  };
}

/** Shows the 8-bit spill on the store floor while the incident tab is open. */
export function IncidentMapLayer() {
  const scene = useStoreScene();

  useEffect(() => {
    scene?.setIncident(true);
    return () => scene?.setIncident(false);
  }, [scene]);

  return <div className="incident-map-layer" data-spill="visible" aria-hidden="true" />;
}

const PHASE_COPY: Record<IncidentDemoState["phase"], { eyebrow: string; title: string; tone: string }> = {
  ready: {
    eyebrow: "Store safety monitoring",
    title: "Incident scene ready",
    tone: "lime",
  },
  sending: {
    eyebrow: "Incident detected",
    title: "Starting Hermes assessment",
    tone: "amber",
  },
  analyzing: {
    eyebrow: "Incident detected",
    title: "Hermes is assessing the scene",
    tone: "amber",
  },
  complete: {
    eyebrow: "Assessment complete",
    title: "Hermes recommendation is ready",
    tone: "lime",
  },
  sent: {
    eyebrow: "Incident assessment requested",
    title: "Hermes response is going to Telegram",
    tone: "amber",
  },
  failed: {
    eyebrow: "Incident detected",
    title: "Hermes assessment needs attention",
    tone: "red",
  },
  unavailable: {
    eyebrow: "Incident workflow unavailable",
    title: "Waiting for the deployed Hermes runtime",
    tone: "red",
  },
};

function IncidentSteps({ steps }: { steps: IncidentStep[] }) {
  return (
    <ol
      className="incident-demo__steps"
      aria-label="Hermes incident assessment progress"
      aria-live="polite"
    >
      {steps.map((step) => (
        <li key={step.id} className={`incident-demo__step incident-demo__step--${step.state}`}>
          <i aria-hidden="true" />
          <span>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

function IncidentAssessment({ content }: { content: string }) {
  return (
    <div className="incident-demo__markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
          img: ({ alt }) => <span>Image: {alt || "attachment"}</span>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

type IncidentAssessmentModalProps = {
  assessment: string;
  busy: boolean;
  error: string | null;
  steps: IncidentStep[];
  setOpen: (open: boolean) => void;
  onReset: () => void;
};

function IncidentAssessmentModal({
  assessment,
  busy,
  error,
  steps,
  setOpen,
  onReset,
}: IncidentAssessmentModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalCardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const priorFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        modalCardRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
        ) || [],
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", closeOnEscape);
      priorFocus?.focus();
    };
  }, [setOpen]);

  return createPortal(
    <div
      className="incident-assessment-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="incident-assessment-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <article className="incident-assessment-modal__card" ref={modalCardRef}>
        <header>
          <div className="incident-assessment-modal__title">
            <span className="incident-assessment-modal__mark" aria-hidden="true">✦</span>
            <h2 id="incident-assessment-title">Hermes incident assessment</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close assessment"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </header>
        <div className="incident-assessment-modal__body" aria-busy={busy}>
          {steps.length ? <IncidentSteps steps={steps} /> : null}
          {assessment ? <IncidentAssessment content={assessment} /> : null}
          {error ? <p className="checkout-demo__error" role="alert">{error}</p> : null}
        </div>
        <footer>
          <button type="button" onClick={() => setOpen(false)}>Close</button>
          <button type="button" disabled={busy} onClick={onReset}>Reset</button>
        </footer>
      </article>
    </div>,
    document.body,
  );
}

export function IncidentDemoControls(props: ReturnType<typeof useIncidentDemo>) {
  const {
    data,
    loading,
    busyAction,
    deliveryTarget,
    steps,
    assessment,
    assessmentOpen,
    error,
    setDeliveryTarget,
    setAssessmentOpen,
    mutate,
  } = props;
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

      {loading ? <p className="checkout-demo__detail">Connecting…</p> : null}

      {!data.active ? (
        <fieldset className="incident-demo__delivery" disabled={busy || !data.connected}>
          <legend className="sr-only">Output destination</legend>
          <label className={deliveryTarget === "ui" ? "is-selected" : ""}>
            <input
              type="radio"
              name="incident-delivery"
              value="ui"
              checked={deliveryTarget === "ui"}
              onChange={() => setDeliveryTarget("ui")}
            />
            <strong>UI</strong>
          </label>
          <label
            className={deliveryTarget === "telegram" ? "is-selected" : ""}
            title={data.telegramEnabled ? undefined : "Telegram is not configured"}
          >
            <input
              type="radio"
              name="incident-delivery"
              value="telegram"
              checked={deliveryTarget === "telegram"}
              disabled={!data.telegramEnabled}
              onChange={() => setDeliveryTarget("telegram")}
            />
            <strong>Telegram</strong>
          </label>
        </fieldset>
      ) : null}

      {data.active ? (
        <figure className="incident-demo__camera">
          <div className="incident-demo__camera-frame">
            <img src={data.image.src} alt={data.image.alt} />
            <span>LIVE INCIDENT</span>
          </div>
          <figcaption>
            <strong>{data.image.location}</strong>
          </figcaption>
        </figure>
      ) : (
        <div className="incident-demo__standby" aria-hidden="true">
          <span>01</span>
          <strong>Produce-area camera ready</strong>
        </div>
      )}

      {data.deliveryTarget === "ui"
        && data.active
        && data.phase !== "complete"
        && steps.length > 0
        ? <IncidentSteps steps={steps} />
        : null}

      {data.deliveryTarget === "ui" && data.active ? (
        <div className="checkout-demo__receipt incident-demo__receipt">
          <span>{data.phase === "complete" ? "Assessment ready" : "Assessment in progress"}</span>
          <button type="button" onClick={() => setAssessmentOpen(true)}>
            {data.phase === "complete" ? "View assessment" : "View live output"}
          </button>
        </div>
      ) : null}

      {data.phase === "sent" ? (
        <div className="checkout-demo__receipt incident-demo__receipt">
          <span>Telegram delivery started</span>
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
          {busyAction === "trigger" ? "Assessing incident…" : "Trigger store incident"}
        </button>
        <button
          type="button"
          disabled={busy || !data.connected || !data.active}
          onClick={() => void mutate("reset")}
        >
          {busyAction === "reset" ? "Resetting…" : "Reset"}
        </button>
      </div>

      {assessmentOpen && data.deliveryTarget === "ui" && typeof document !== "undefined"
        ? (
          <IncidentAssessmentModal
            assessment={assessment}
            busy={busy}
            error={error}
            steps={steps}
            setOpen={setAssessmentOpen}
            onReset={() => void mutate("reset")}
          />
        )
        : null}
    </section>
  );
}
