"use client";

/* eslint-disable @next/next/no-img-element */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  clampView,
  getWheelZoomDelta,
  MAX_SCALE,
  MIN_SCALE,
  zoomView,
  zoomViewAtPoint,
  ZOOM_STEP,
} from "./store-view-model.mjs";
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

type ViewState = {
  scale: number;
  x: number;
  y: number;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  scale: number;
};

const INITIAL_VIEW: ViewState = { scale: MIN_SCALE, x: 0, y: 0 };
const KEYBOARD_PAN_STEP = 40;
type DemoScenario = "checkout" | "opd" | "incident";

function getViewportSize(viewport: HTMLDivElement) {
  return { width: viewport.clientWidth, height: viewport.clientHeight };
}

function viewsMatch(first: ViewState, second: ViewState) {
  return first.scale === second.scale
    && Math.abs(first.x - second.x) < 0.01
    && Math.abs(first.y - second.y) < 0.01;
}

export default function StoreViewport() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  const [dragging, setDragging] = useState(false);
  const [activeScenario, setActiveScenario] = useState<DemoScenario>("checkout");
  const checkoutDemo = useCheckoutDemo();
  const opdDemo = useOpdDemo();
  const incidentDemo = useIncidentDemo();

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const observer = new ResizeObserver(() => {
      setView((current) => {
        const next = clampView(getViewportSize(viewport), current);
        return viewsMatch(current, next) ? current : next;
      });
    });

    const handleWheel = (event: WheelEvent) => {
      const scaleDelta = getWheelZoomDelta(
        event.deltaY,
        event.deltaMode,
        viewport.clientHeight,
      );
      if (scaleDelta === 0) return;

      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const point = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };

      setView((current) => {
        const next = zoomViewAtPoint(
          getViewportSize(viewport),
          current,
          current.scale + scaleDelta,
          point,
        );
        return viewsMatch(current, next) ? current : next;
      });
    };

    observer.observe(viewport);
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("wheel", handleWheel);
    };
  }, []);

  function changeZoom(direction: -1 | 1) {
    const viewport = viewportRef.current;
    if (!viewport) return;

    setView((current) => zoomView(
      getViewportSize(viewport),
      current,
      current.scale + direction * ZOOM_STEP,
    ));
  }

  function resetView() {
    dragRef.current = null;
    setDragging(false);
    setView(INITIAL_VIEW);
  }

  function selectScenario(scenario: DemoScenario) {
    setActiveScenario(scenario);
    const viewport = viewportRef.current;
    if (!viewport || scenario === "checkout") {
      setView(INITIAL_VIEW);
      return;
    }

    const size = getViewportSize(viewport);
    const scale = Math.min(MAX_SCALE, scenario === "opd" ? 1.45 : 1.3);
    const roomCenter = scenario === "opd"
      ? { x: size.width * 0.59, y: size.height * 0.17 }
      : { x: size.width * 0.67, y: size.height * 0.72 };
    setView(clampView(size, {
      scale,
      x: -(roomCenter.x - size.width / 2) * scale,
      y: -(roomCenter.y - size.height / 2) * scale,
    }));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (view.scale <= MIN_SCALE || !event.isPrimary || event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
      scale: view.scale,
    };
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    if (!drag || !viewport || drag.pointerId !== event.pointerId) return;

    event.preventDefault();
    const next = clampView(getViewportSize(viewport), {
      scale: drag.scale,
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    });
    setView((current) => viewsMatch(current, next) ? current : next);
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Home") {
      event.preventDefault();
      resetView();
      return;
    }

    if (view.scale <= MIN_SCALE) return;

    let deltaX = 0;
    let deltaY = 0;

    switch (event.key) {
      case "ArrowLeft":
        deltaX = KEYBOARD_PAN_STEP;
        break;
      case "ArrowRight":
        deltaX = -KEYBOARD_PAN_STEP;
        break;
      case "ArrowUp":
        deltaY = KEYBOARD_PAN_STEP;
        break;
      case "ArrowDown":
        deltaY = -KEYBOARD_PAN_STEP;
        break;
      default:
        return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;

    event.preventDefault();
    setView((current) => clampView(getViewportSize(viewport), {
      ...current,
      x: current.x + deltaX,
      y: current.y + deltaY,
    }));
  }

  const isPannable = view.scale > MIN_SCALE;
  const canReset = isPannable || view.x !== 0 || view.y !== 0;
  const viewportClassName = [
    "store-stage__viewport",
    isPannable ? "store-stage__viewport--pannable" : "",
    dragging ? "store-stage__viewport--dragging" : "",
  ].filter(Boolean).join(" ");
  const canvasStyle = {
    "--store-scale": view.scale,
    "--store-pan-x": `${view.x}px`,
    "--store-pan-y": `${view.y}px`,
  } as CSSProperties;

  return (
    <section className="store-stage" aria-label="Animated isometric store layout">
      <p className="sr-only" id="store-navigation-help">
        Use the zoom controls or scroll over the store to zoom. Once magnified, drag with a mouse or touch, or use the arrow keys to move around the store. Press Home to reset the view.
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
          disabled={view.scale <= MIN_SCALE}
          onClick={() => changeZoom(-1)}
        >
          <span aria-hidden="true">−</span>
        </button>
        <output className="store-view-zoom" aria-live="polite" aria-atomic="true">
          {Math.round(view.scale * 100)}%
        </output>
        <button
          className="store-view-control"
          type="button"
          aria-label="Zoom in store"
          title="Zoom in"
          disabled={view.scale >= MAX_SCALE}
          onClick={() => changeZoom(1)}
        >
          <span aria-hidden="true">+</span>
        </button>
        <button
          className="store-view-control store-view-control--reset"
          type="button"
          disabled={!canReset}
          onClick={resetView}
        >
          Reset
        </button>
      </div>

      <div
        ref={viewportRef}
        className={viewportClassName}
        role="group"
        aria-label="Interactive store map"
        aria-describedby="store-navigation-help"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
      >
        <div className="store-stage__canvas" style={canvasStyle}>
          <img
            className="store-stage__image"
            src="/store-layout-no-people.png"
            alt="Isometric retail store with loading dock, aisles, checkout, pickup, produce, and an operations office"
            draggable={false}
          />
          <img
            className="store-stage__characters store-stage__characters--animated"
            src="/store-characters-moving.gif?v=cart-loops-3"
            alt=""
            aria-hidden="true"
            draggable={false}
          />
          <img
            className="store-stage__characters store-stage__characters--poster"
            src="/store-characters-poster.png?v=cart-loops-3"
            alt=""
            aria-hidden="true"
            draggable={false}
          />
          {activeScenario === "checkout" ? <CheckoutQueueLayer data={checkoutDemo.data} /> : null}
          {activeScenario === "opd" ? <OpdRoomLayer data={opdDemo.data} /> : null}
          {activeScenario === "incident" ? <IncidentMapLayer /> : null}
        </div>
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
