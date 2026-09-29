import assert from "node:assert/strict";
import test from "node:test";

import {
  clampView,
  getPanBounds,
  MAX_SCALE,
  MIN_SCALE,
  PAN_OVERSCROLL,
  STORE_ASPECT,
  zoomView,
  zoomViewAtPoint,
  ZOOM_STEP,
} from "../app/store-view-model.mjs";

const viewport = { width: 800, height: 600 };

test("keeps the unzoomed store framing fixed", () => {
  assert.equal(STORE_ASPECT, 1137 / 909);
  assert.deepEqual(getPanBounds(viewport, MIN_SCALE), { x: 0, y: 0 });
  assert.deepEqual(clampView(viewport, { scale: MIN_SCALE, x: 400, y: -400 }), { scale: MIN_SCALE, x: 0, y: 0 });
});

test("lets a magnified store pan slightly past its framing", () => {
  const bounds = getPanBounds(viewport, MIN_SCALE + ZOOM_STEP);
  assert.ok(bounds.y >= PAN_OVERSCROLL);
  const clamped = clampView(viewport, { scale: 99, x: 99_999, y: -99_999 });
  const maximum = getPanBounds(viewport, MAX_SCALE);
  assert.deepEqual(clamped, { scale: MAX_SCALE, x: maximum.x, y: -maximum.y });
});

test("zooms around the pointer and the viewport centre", () => {
  assert.equal(zoomView(viewport, { scale: MIN_SCALE, x: 0, y: 0 }, MIN_SCALE + ZOOM_STEP).scale, 1.25);
  const atCorner = zoomViewAtPoint(viewport, { scale: MIN_SCALE, x: 0, y: 0 }, 2, { x: 600, y: 450 });
  assert.equal(atCorner.scale, 2);
  assert.ok(atCorner.x < 0 && atCorner.y < 0, "zooming toward the lower right pans the view up and left");
});
