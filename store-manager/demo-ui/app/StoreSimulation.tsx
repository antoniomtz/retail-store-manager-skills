import StoreManagerPanel from "./StoreManagerPanel";
import StoreViewport from "./StoreViewport";

export default function StoreSimulation() {
  return (
    <main className="operations-shell">
      <h1 className="sr-only">Retail Agent Toolkit platform demonstration</h1>
      <StoreViewport />

      <aside className="operations-dashboard" aria-label="Store Manager opening dashboard">
        <StoreManagerPanel />
      </aside>
    </main>
  );
}
