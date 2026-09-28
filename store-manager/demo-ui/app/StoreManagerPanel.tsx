"use client";

import { useState } from "react";
import HermesChat from "./HermesChat";
import PlatformTelemetry from "./PlatformTelemetry";

type PanelView = "dashboard" | "chat";

export default function StoreManagerPanel() {
  const [view, setView] = useState<PanelView>("dashboard");

  return (
    <div className="store-manager-panel">
      <nav className="panel-switch" role="tablist" aria-label="Store Manager panel">
        <button
          id="store-manager-dashboard-tab"
          type="button"
          role="tab"
          aria-controls="store-manager-panel-content"
          aria-selected={view === "dashboard"}
          onClick={() => setView("dashboard")}
        >
          Dashboard
        </button>
        <button
          id="store-manager-chat-tab"
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
        {view === "dashboard" ? <PlatformTelemetry /> : <HermesChat />}
      </div>
    </div>
  );
}
