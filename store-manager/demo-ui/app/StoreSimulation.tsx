import PlatformTelemetry from "./PlatformTelemetry";
import StoreViewport from "./StoreViewport";

export default function StoreSimulation() {
  return (
    <main className="operations-shell">
      <h1 className="sr-only">Retail Agent Toolkit platform demonstration</h1>
      <StoreViewport />

      <aside className="operations-dashboard" aria-label="Retail agent platform activity">
        <PlatformTelemetry />
      </aside>
    </main>
  );
}
