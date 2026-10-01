"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { StoreSceneContext } from "./StoreSceneContext";
import type { StoreScene, StoreZoom } from "./store-scene/StoreScene";
import { CHECKOUT_FOCUS, OPD_FOCUS, SPILL } from "./store-scene/layout";
import {
  CheckoutDemoControls,
  CheckoutQueueLayer,
  useCheckoutDemo,
} from "./CheckoutDemo";
import {
  OpdDemoControls,
  OpdRoomLayer,
  useOpdDemo,
} from "./OpdSurgeDemo";
import {
  IncidentDemoControls,
  IncidentMapLayer,
  useIncidentDemo,
} from "./IncidentDemo";

type DemoScenario = "checkout" | "opd" | "incident";
type SceneStatus = "loading" | "ready" | "unavailable";
// Each scenario tab frames its part of the store: the point to focus, how
// closely, and where it should land in the viewport (right of the scenario
// panel, leaving room for its labels).
const SCENARIO_FOCUS = {
  checkout: { x: CHECKOUT_FOCUS.x, y: 0.6, z: CHECKOUT_FOCUS.z, scale: 1.75, left: 0.66, top: 0.5 },
  opd: { x: OPD_FOCUS.x, y: 1, z: OPD_FOCUS.z, scale: 1.9, left: 0.66, top: 0.46 },
  incident: { x: SPILL.x, y: 0, z: SPILL.z, scale: 2.2, left: 0.68, top: 0.55 },
} as const;
// Camera distance factor per zoom-button press.
const ZOOM_IN = 0.8;
const ZOOM_OUT = 1.25;

export default function StoreViewport() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<StoreScene | null>(null);
  const [scene, setScene] = useState<StoreScene | null>(null);
  const [sceneStatus, setSceneStatus] = useState<SceneStatus>("loading");
  const [zoom, setZoom] = useState<StoreZoom>({ percent: 100, canZoomIn: true, canZoomOut: true });
  const [activeScenario, setActiveScenario] = useState<DemoScenario>("checkout");
  const checkoutDemo = useCheckoutDemo();
  const opdDemo = useOpdDemo();
  const incidentDemo = useIncidentDemo();

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      sceneRef.current?.resize(viewport.clientWidth, viewport.clientHeight);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // The 3D store loads after first paint behind a short loading indicator.
  useEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const controller = new AbortController();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    import("./store-scene/StoreScene")
      .then(({ StoreScene }) => StoreScene.create(canvas, {
        controlsElement: viewport,
        onZoom: setZoom,
        reducedMotion,
        signal: controller.signal,
      }))
      .then((created) => {
        if (controller.signal.aborted) {
          created.dispose();
          return;
        }
        // The viewport may have resized while the store was loading.
        created.resize(viewport.clientWidth, viewport.clientHeight);
        sceneRef.current = created;
        setScene(created);
        setSceneStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setSceneStatus("unavailable");
      });
    return () => {
      controller.abort();
      sceneRef.current?.dispose();
      sceneRef.current = null;
      setScene(null);
    };
  }, []);

  function selectScenario(scenario: DemoScenario) {
    setActiveScenario(scenario);
    scene?.focus(SCENARIO_FOCUS[scenario]);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Home") return;
    event.preventDefault();
    scene?.reset();
  }

  const sceneReady = sceneStatus === "ready";
  return (
    <section className="store-stage" aria-label="Animated isometric store layout" data-scene={sceneStatus}>
      <p className="sr-only" id="store-navigation-help">
        Drag to rotate the store, scroll or use the zoom controls to zoom, and right-drag or use the arrow keys to pan. Press Home to reset the view.
      </p>

      <div className="store-scenario-switch" role="tablist" aria-label="Store operating scenarios">
        <button
          id="checkout-scenario-tab"
          type="button"
          role="tab"
          aria-selected={activeScenario === "checkout"}
          aria-controls="checkout-scenario-panel"
          onClick={() => selectScenario("checkout")}
        >
          Checkout queue
        </button>
        <button
          id="opd-scenario-tab"
          type="button"
          role="tab"
          aria-selected={activeScenario === "opd"}
          aria-controls="opd-scenario-panel"
          onClick={() => selectScenario("opd")}
        >
          OPD surge
        </button>
        <button
          id="incident-scenario-tab"
          type="button"
          role="tab"
          aria-selected={activeScenario === "incident"}
          aria-controls="incident-scenario-panel"
          onClick={() => selectScenario("incident")}
        >
          Store incident
        </button>
      </div>

      <div className="store-view-controls" role="group" aria-label="Store view controls">
        <button
          className="store-view-control"
          type="button"
          aria-label="Zoom out store"
          title="Zoom out"
          disabled={!sceneReady || !zoom.canZoomOut}
          onClick={() => scene?.zoomBy(ZOOM_OUT)}
        >
          <span aria-hidden="true">−</span>
        </button>
        <output className="store-view-zoom" aria-live="polite" aria-atomic="true">
          {zoom.percent}%
        </output>
        <button
          className="store-view-control"
          type="button"
          aria-label="Zoom in store"
          title="Zoom in"
          disabled={!sceneReady || !zoom.canZoomIn}
          onClick={() => scene?.zoomBy(ZOOM_IN)}
        >
          <span aria-hidden="true">+</span>
        </button>
        <button
          className="store-view-control store-view-control--reset"
          type="button"
          disabled={!sceneReady}
          onClick={() => scene?.reset()}
        >
          Reset
        </button>
      </div>

      <div
        ref={viewportRef}
        className="store-stage__viewport"
        role="group"
        aria-label="Interactive store map"
        aria-describedby="store-navigation-help"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <canvas
          ref={canvasRef}
          className="store-stage__scene"
          role="img"
          aria-label="3D retail store with receiving, aisles, checkout, pickup, produce, and an operations office, with animated shoppers and associates"
        />
        <StoreSceneContext.Provider value={scene}>
          <div className="store-stage__overlay">
            {activeScenario === "checkout" ? <CheckoutQueueLayer data={checkoutDemo.data} /> : null}
            {activeScenario === "opd" ? <OpdRoomLayer data={opdDemo.data} /> : null}
            {activeScenario === "incident" ? <IncidentMapLayer /> : null}
          </div>
        </StoreSceneContext.Provider>
        {sceneStatus !== "ready" ? (
          <p className={`store-stage__status store-stage__status--${sceneStatus}`} role="status">
            {sceneStatus === "loading" ? (
              <>
                <span className="store-stage__spinner" aria-hidden="true" />
                Preparing the store…
              </>
            ) : "3D rendering is unavailable in this browser. The scenario controls still work."}
          </p>
        ) : null}
      </div>
      {activeScenario === "checkout" ? (
        <div id="checkout-scenario-panel" role="tabpanel" aria-labelledby="checkout-scenario-tab">
          <CheckoutDemoControls {...checkoutDemo} />
        </div>
      ) : activeScenario === "opd" ? (
        <div id="opd-scenario-panel" role="tabpanel" aria-labelledby="opd-scenario-tab">
          <OpdDemoControls {...opdDemo} />
        </div>
      ) : (
        <div id="incident-scenario-panel" role="tabpanel" aria-labelledby="incident-scenario-tab">
          <IncidentDemoControls {...incidentDemo} />
        </div>
      )}
    </section>
  );
}
