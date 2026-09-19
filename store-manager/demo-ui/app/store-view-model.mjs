export const STORE_ASPECT = 1137 / 909;
export const MIN_SCALE = 1;
export const MAX_SCALE = 2.5;
export const ZOOM_STEP = 0.25;
export const WHEEL_ZOOM_RATE = 0.0025;

/**
 * @typedef {{ width: number, height: number }} ViewportSize
 * @typedef {{ scale: number, x: number, y: number }} ViewState
 */

/**
 * Return the maximum screen-space translation that still keeps the contained
 * store image covering the viewport edge at the current scale.
 *
 * @param {ViewportSize} viewport
 * @param {number} scale
 */
export function getPanBounds(viewport, scale) {
  const width = Math.max(0, viewport.width);
  const height = Math.max(0, viewport.height);
  const fittedWidth = Math.min(width, height * STORE_ASPECT);
  const fittedHeight = fittedWidth / STORE_ASPECT;

  return {
    x: Math.max(0, (fittedWidth * scale - width) / 2),
    y: Math.max(0, (fittedHeight * scale - height) / 2),
  };
}

/**
 * @param {number} value
 * @param {number} minimum
 * @param {number} maximum
 */
function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Convert browser wheel units into a smooth, bounded scale delta. Small
 * trackpad movements still advance one percentage point, while a mouse-wheel
 * notch cannot jump more than one button-sized zoom step.
 *
 * @param {number} deltaY
 * @param {number} deltaMode
 * @param {number} viewportHeight
 */
export function getWheelZoomDelta(deltaY, deltaMode, viewportHeight) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;

  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? viewportHeight : 1;
  const rawDelta = -deltaY * unit * WHEEL_ZOOM_RATE;
  if (rawDelta === 0) return 0;

  const magnitude = Math.min(ZOOM_STEP, Math.max(0.01, Math.abs(rawDelta)));
  return Math.sign(rawDelta) * magnitude;
}

/**
 * @param {ViewportSize} viewport
 * @param {ViewState} view
 * @returns {ViewState}
 */
export function clampView(viewport, view) {
  const scale = Math.round(clamp(view.scale, MIN_SCALE, MAX_SCALE) * 100) / 100;

  if (scale === MIN_SCALE) {
    return { scale: MIN_SCALE, x: 0, y: 0 };
  }

  const bounds = getPanBounds(viewport, scale);

  return {
    scale,
    x: clamp(view.x, -bounds.x, bounds.x),
    y: clamp(view.y, -bounds.y, bounds.y),
  };
}

/**
 * Change scale around a point expressed in viewport coordinates, then clamp
 * the result. This keeps the same store location beneath the cursor.
 *
 * @param {ViewportSize} viewport
 * @param {ViewState} view
 * @param {number} requestedScale
 * @param {{ x: number, y: number }} point
 * @returns {ViewState}
 */
export function zoomViewAtPoint(viewport, view, requestedScale, point) {
  const currentScale = clamp(view.scale, MIN_SCALE, MAX_SCALE);
  const nextScale = Math.round(clamp(requestedScale, MIN_SCALE, MAX_SCALE) * 100) / 100;
  const scaleRatio = nextScale / currentScale;
  const offsetX = point.x - viewport.width / 2;
  const offsetY = point.y - viewport.height / 2;

  return clampView(viewport, {
    scale: nextScale,
    x: offsetX - (offsetX - view.x) * scaleRatio,
    y: offsetY - (offsetY - view.y) * scaleRatio,
  });
}

/**
 * Change scale around the current viewport center, then clamp the result.
 *
 * @param {ViewportSize} viewport
 * @param {ViewState} view
 * @param {number} requestedScale
 * @returns {ViewState}
 */
export function zoomView(viewport, view, requestedScale) {
  return zoomViewAtPoint(viewport, view, requestedScale, {
    x: viewport.width / 2,
    y: viewport.height / 2,
  });
}
