"use client";

import { useCallback, useRef, useState } from "react";
import HermesChat from "./HermesChat";
import PlatformTelemetry from "./PlatformTelemetry";

type PanelView = "dashboard" | "chat";
type RequestedPrompt = { id: string; text: string };

export default function StoreManagerPanel() {
  const [view, setView] = useState<PanelView>("dashboard");
  const [requestedPrompt, setRequestedPrompt] = useState<RequestedPrompt | null>(null);
  const chatTabRef = useRef<HTMLButtonElement>(null);

  const requestChatPrompt = useCallback((text: string) => {
    setRequestedPrompt({ id: crypto.randomUUID(), text });
    setView("chat");
    window.requestAnimationFrame(() => chatTabRef.current?.focus());
  }, []);

  const consumeRequestedPrompt = useCallback((id: string) => {
    setRequestedPrompt((current) => current?.id === id ? null : current);
  }, []);

  return (
    <div className="store-manager-panel">
      <nav className="panel-switch" role="tablist" aria-label="Store Manager panel">
        <button
          id="store-manager-dashboard-tab"
          type="button"
          role="tab"
          aria-controls="store-manager-panel-content"
          aria-selected={view === "dashboard"}
          onClick={() => {
            setRequestedPrompt(null);
            setView("dashboard");
          }}
        >
          Dashboard
        </button>
        <button
          id="store-manager-chat-tab"
          ref={chatTabRef}
          type="button"
          role="tab"
          aria-controls="store-manager-panel-content"
          aria-selected={view === "chat"}
          onClick={() => setView("chat")}
        >
          Chat
        </button>
      </nav>

      <div
        id="store-manager-panel-content"
        role="tabpanel"
        aria-labelledby={`store-manager-${view}-tab`}
        className="store-manager-panel__content"
      >
        {view === "dashboard" ? (
          <PlatformTelemetry
            onRunMorningBriefing={() => requestChatPrompt("Give me the morning briefing")}
          />
        ) : (
          <HermesChat
            requestedPrompt={requestedPrompt}
            onRequestedPromptConsumed={consumeRequestedPrompt}
          />
        )}
      </div>
    </div>
  );
}
