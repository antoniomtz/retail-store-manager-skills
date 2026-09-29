// Named places on the store floor (metres, see store.js). +X runs toward the
// lower right of the default view and +Z toward the lower left.
import type { Facing } from "./agents";
import type { FloorPoint } from "./navigation";

export type Spot = FloorPoint & { face?: Facing };
type Point3 = readonly [number, number, number];

const R: Facing = 1;
const L: Facing = -1;

/** Shoppers appear and leave through the cut-away right-hand wall. */
export const ENTRANCE: FloorPoint = { x: 11.25, z: -4.3 };
export const EXIT: FloorPoint = { x: 11.25, z: 5.2 };
/** Where cart shoppers collect a cart, beside the corral. */
export const CART_PICKUP: Spot = { x: 9.7, z: -5.25, face: L };

/** Shelf faces, tables and displays that shoppers browse. */
export const BROWSE_SPOTS: Spot[] = [
  // Grocery gondolas (east faces look left on screen, west faces right).
  { x: -5.55, z: -1.6, face: L }, { x: -5.55, z: 0.6, face: L },
  { x: -4.35, z: -2.0, face: R }, { x: -4.35, z: 0.2, face: R },
  { x: -2.25, z: -1.2, face: L }, { x: -2.25, z: 0.5, face: L },
  { x: -1.35, z: -2.1, face: R }, { x: -1.35, z: -0.2, face: R },
  { x: 0.72, z: -1.8, face: L }, { x: 0.72, z: 0.1, face: L },
  // End caps and the crate of greens.
  { x: -6.6, z: 3.1, face: R }, { x: -3.3, z: 2.0, face: R }, { x: -0.45, z: 2.35, face: R },
  // Produce tables.
  { x: 4.8, z: 2.3, face: L }, { x: 6.2, z: 2.3, face: L }, { x: 3.7, z: 3.6, face: R },
  { x: 5.2, z: 5.5, face: R }, { x: 6.8, z: 5.5, face: R }, { x: 3.6, z: 6.45, face: R },
  { x: 4.1, z: 9.3, face: R }, { x: 7.6, z: 9.3, face: L }, { x: 5.85, z: 10.8, face: R },
  { x: 8.55, z: 8.7, face: R },
  // Electronics, appliances, apparel and printers.
  { x: -3.0, z: 8.1, face: L }, { x: -1.35, z: 9.3, face: L }, { x: -0.7, z: 7.5, face: R },
  { x: 2.2, z: 7.5, face: L }, { x: -2.5, z: 6.35, face: L }, { x: -5.75, z: 7.6, face: L },
  // Pickup bag shelves.
  { x: 2.6, z: -8.3, face: R }, { x: 3.9, z: -8.3, face: R }, { x: 6.0, z: -7.2, face: R },
];

/** Aisle points where associates scan shelves. */
export const SHELF_CHECK_SPOTS: Spot[] = [
  { x: -5.55, z: -0.5, face: L }, { x: -4.35, z: -1.0, face: R }, { x: -2.25, z: -0.3, face: L },
  { x: -1.35, z: -1.2, face: R }, { x: 0.72, z: -0.9, face: L }, { x: -5.75, z: 6.8, face: L },
];
export const PRODUCE_CHECK_SPOTS: Spot[] = [
  { x: 4.5, z: 2.3, face: L }, { x: 7.0, z: 2.3, face: L }, { x: 3.7, z: 4.4, face: R },
  { x: 6.0, z: 5.5, face: R }, { x: 4.1, z: 8.9, face: R },
];

/** Customer order pickup at the service counter, and its bag shelves. */
export const PICKUP_COUNTER: Spot = { x: 1.35, z: -5.5, face: L };
export const PICKUP_DESK: Spot = { x: 1.3, z: -6.25, face: L };
export const PICKUP_SHELVES: Spot[] = [{ x: 2.7, z: -8.3, face: R }, { x: 6.1, z: -7.2, face: R }];

/** Self-checkouts used by everyday shoppers (not the scenario lanes). */
export const SELF_CHECKOUTS: { pay: Spot; queue: FloorPoint[] }[] = [
  { pay: { x: 9.35, z: 1.95, face: L }, queue: [{ x: 8.65, z: 2.15 }, { x: 8.0, z: 2.35 }] },
  { pay: { x: 10.1, z: -1.05, face: L }, queue: [{ x: 9.45, z: -0.8 }, { x: 8.8, z: -0.55 }] },
];

// ------------------------------------------------------------- checkout
// Register 1 is the always-staffed double lane; register 6 is the twin
// counter Hermes can open. Customers queue on the customer (+Z) side.
export const CHECKOUT_QUEUE_SPACING = 0.62;
export const LANE_ONE: FloorPoint[] = (() => {
  const slots: FloorPoint[] = [];
  for (let i = 0; i < 8; i++) slots.push({ x: 6.05 - i * CHECKOUT_QUEUE_SPACING, z: -2.55 });
  for (let i = 0; i < 4; i++) slots.push({ x: 1.35, z: -3.15 - i * CHECKOUT_QUEUE_SPACING * 0.95 });
  return slots;
})();
export const LANE_TWO: FloorPoint[] = Array.from({ length: 6 }, (_, i) => ({ x: 4.75 - i * CHECKOUT_QUEUE_SPACING, z: 0.25 }));
export const LANE_ONE_CASHIER: Spot = { x: 6.35, z: -4.55, face: L };
export const LANE_TWO_CASHIER: Spot = { x: 4.95, z: -1.8, face: R };
/** Where the extra cashier comes from before register 6 opens. */
export const LANE_TWO_CASHIER_START: FloorPoint = { x: 2.6, z: -6.2 };
/** Paid customers walk out past the bagging area toward the exit. */
export const LANE_ONE_EXIT: FloorPoint = { x: 7.0, z: -1.25 };
export const LANE_TWO_EXIT: FloorPoint = { x: 6.2, z: 1.85 };
export const REGISTER_SIX_LABEL: Point3 = [5.15, 2.95, -1.24];
export const LANE_TRANSFER_LABEL: Point3 = [2.9, 0.6, -1.1];
/** Centre of the checkout scene: both staffed registers and their lines. */
export const CHECKOUT_FOCUS: FloorPoint = { x: 4.7, z: -2.0 };
/** Aisle mouths where new queue customers emerge from their shopping. */
export const QUEUE_ARRIVALS: FloorPoint[] = [
  { x: -1.8, z: -3.6 }, { x: -1.8, z: 1.6 }, { x: 0.8, z: 2.6 }, { x: 2.8, z: 3.2 }, { x: -4.9, z: 1.5 },
];

// --------------------------------------------------------------- OPD room
// Only the back-left part of the stockroom is visible over its partitions.
export const OPD_ROOM = { x0: -7.25, z0: -10.25, x1: -0.3, z1: -4.62 };
export const OPD_DOOR_INSIDE: FloorPoint = { x: -0.75, z: -7.8 };
/** The visible back of the stockroom where the pickers work. */
export const OPD_FOCUS: FloorPoint = { x: -4.1, z: -8.0 };
export const OPD_PICK_SPOTS: Record<string, Spot> = {
  shelfLeft: { x: -5.95, z: -8.95, face: R },
  shelfRight: { x: -3.85, z: -8.75, face: R },
  trolley: { x: -3.45, z: -7.75, face: L },
  trolleyFront: { x: -4.45, z: -7.0, face: R },
  fridge: { x: -6.05, z: -7.35, face: L },
  totes: { x: -2.45, z: -7.35, face: R },
  shelfGap: { x: -4.95, z: -9.05, face: R },
  backDoor: { x: -2.6, z: -9.6, face: R },
};
export const OPD_TOTE_PALLET = { x: -2.7, z: -8.45 };
export const OPD_KPI_LABEL: Point3 = [-3.9, 3.05, -10.4];
export const OPD_ASSIGNMENT_LABEL: Point3 = [0.9, 0.4, -3.6];
/** Cross-trained grocery associates stocking the aisles before reassignment. */
export const OPD_FLEX_START: Spot[] = [
  { x: -2.25, z: -1.9, face: L },
  { x: -1.35, z: -0.6, face: R },
];

// ---------------------------------------------------------------- dock
export const DOCK_TRUCK: Spot = { x: -13.15, z: -2.3, face: L };
export const DOCK_DROPS: Spot[] = [
  { x: -11.0, z: -0.25, face: L },
  { x: -10.0, z: 0.1, face: L },
  { x: -12.4, z: 2.75, face: L },
];

// ------------------------------------------------------------- incident
/** The synthetic spill beside the produce tables. */
export const SPILL: FloorPoint = { x: 9.1, z: 3.45 };
