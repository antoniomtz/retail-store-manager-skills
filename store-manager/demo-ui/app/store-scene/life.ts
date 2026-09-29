// Everyone in the store. Ambient shoppers and staff follow daily routines;
// the checkout queue, OPD room and spill follow the live scenario state.
import * as THREE from "three";
import { Agent, fade, pose, until, wait, walk, type AgentOptions, type Behavior, type Facing } from "./agents";
import {
  BROWSE_SPOTS,
  CART_PICKUP,
  DOCK_DROPS,
  DOCK_TRUCK,
  ENTRANCE,
  EXIT,
  LANE_ONE,
  LANE_ONE_CASHIER,
  LANE_ONE_EXIT,
  LANE_TWO,
  LANE_TWO_CASHIER,
  LANE_TWO_CASHIER_START,
  LANE_TWO_EXIT,
  OPD_DOOR_INSIDE,
  OPD_FLEX_START,
  OPD_PICK_SPOTS,
  OPD_ROOM,
  OPD_TOTE_PALLET,
  PICKUP_COUNTER,
  PICKUP_DESK,
  PICKUP_SHELVES,
  PRODUCE_CHECK_SPOTS,
  QUEUE_ARRIVALS,
  SELF_CHECKOUTS,
  SHELF_CHECK_SPOTS,
  SPILL,
  type Spot,
} from "./layout";
import type { FloorPoint, NavGrid } from "./navigation";
import { RoomFocus, RouteLine, SpillDecal, ToteStack } from "./props";
import type { Pose, SpriteLibrary } from "./sprites";

/** Checkout queue as the UI shows it: people per staffed register. */
export type CheckoutVisual = { laneOne: number; laneTwo: number; laneTwoOpen: boolean };
/** OPD room as the UI shows it, already reconciled with the model counts. */
export type OpdVisual = {
  incidentActive: boolean;
  recovered: boolean;
  onPace: boolean;
  backlogUnits: number;
  activePickers: number;
  flexVisible: number;
  flexAssigned: number;
};

const RIGHT: Facing = 1;
/** Associates wear the lime vest; customers get their own colours. */
const CUSTOMER_COLOURS = ["#d9534f", "#f0913a", "#4aa3df", "#9b59b6", "#e84393", "#17a589", "#3867d6", "#f1c40f", "#c0392b", "#8e44ad", "#16a085", "#e17055"];
const CART_COLOURS = ["#2f5fd0", "#00897b", "#e69f00", "#c0392b", "#6c5ce7", null];
const DOCK_JACKET = "#e8742c";

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)];
const near = (a: FloorPoint, b: FloorPoint, distance = 0.12) => Math.hypot(a.x - b.x, a.z - b.z) < distance;

/** Spots that one person uses at a time (shelf faces, picking positions). */
class SpotPool {
  private readonly taken = new Set<Spot>();

  constructor(private readonly spots: readonly Spot[]) {}

  claim(preferNear?: FloorPoint) {
    const free = this.spots.filter((spot) => !this.taken.has(spot));
    if (!free.length) return null;
    const ranked = preferNear
      ? free.map((spot) => ({ spot, score: Math.hypot(spot.x - preferNear.x, spot.z - preferNear.z) + rand(0, 4) })).sort((a, b) => a.score - b.score)
      : free.map((spot) => ({ spot, score: Math.random() })).sort((a, b) => a.score - b.score);
    const spot = ranked[0].spot;
    this.taken.add(spot);
    return spot;
  }

  take(spot: Spot) {
    this.taken.add(spot);
    return spot;
  }

  release(spot: Spot | null) {
    if (spot) this.taken.delete(spot);
  }
}

/** Where a room worker currently stands, so leaving always frees the spot. */
type SpotHolder = { spot: Spot | null };

type SelfCheckout = { pay: Spot; queue: FloorPoint[]; line: Agent[] };

export class StoreLife {
  time = 0;
  private readonly agents: Agent[] = [];
  private readonly routes: RouteLine[] = [];
  private readonly browse = new SpotPool(BROWSE_SPOTS);
  private readonly shelfChecks = new SpotPool([...SHELF_CHECK_SPOTS, ...PRODUCE_CHECK_SPOTS]);
  private readonly roomSpots = new SpotPool(Object.values(OPD_PICK_SPOTS));
  private readonly registers: SelfCheckout[] = SELF_CHECKOUTS.map((register) => ({ ...register, line: [] }));
  private readonly spill: SpillDecal;
  private readonly focus: RoomFocus;
  private readonly totes: ToteStack;
  private readonly checkout = new CheckoutDirector(this);
  private readonly opd = new OpdDirector(this);
  private reservations = { queue: [] as FloorPoint[], spill: false };
  private shopperTimer = 0;

  constructor(
    readonly scene: THREE.Scene,
    readonly nav: NavGrid,
    readonly sprites: SpriteLibrary,
    readonly options: { reducedMotion: boolean },
  ) {
    this.spill = new SpillDecal(sprites.spill, sprites.spillAspect, SPILL);
    // Stockroom wall heights from store.js: tall outer walls, lower partitions.
    this.focus = new RoomFocus(OPD_ROOM, { rear: 2.85, left: 2.85, front: 2.2, right: 2.2 });
    this.totes = new ToteStack(OPD_TOTE_PALLET);
    scene.add(this.spill.mesh, this.focus.group, this.totes.group);
    this.populate();
  }

  // ------------------------------------------------------------ population
  spawn(options: Omit<AgentOptions, "sprites" | "nav">) {
    const agent = new Agent({ sprites: this.sprites, nav: this.nav, scale: rand(0.95, 1.04), ...options });
    this.agents.push(agent);
    this.scene.add(agent.group);
    return agent;
  }

  private populate() {
    // Shoppers already mid-visit when the page opens.
    for (let i = 0; i < 7; i++) this.addShopper(true, i < 4);
    // Staff with routines.
    const staff = (position: FloorPoint, behavior: (agent: Agent) => Behavior, extra: Partial<AgentOptions> = {}) => {
      const agent = this.spawn({ position, ...extra });
      agent.tags.add("staff");
      agent.tags.add("ambient");
      agent.replaceBehavior(behavior(agent));
      return agent;
    };
    staff(SHELF_CHECK_SPOTS[2], (agent) => this.shelfChecker(agent, SHELF_CHECK_SPOTS[2]));
    staff(PRODUCE_CHECK_SPOTS[0], (agent) => this.shelfChecker(agent, PRODUCE_CHECK_SPOTS[0]));
    staff(PICKUP_DESK, () => this.pickupAssociate());
    staff(LANE_ONE_CASHIER, () => this.stand(LANE_ONE_CASHIER));
    staff(DOCK_TRUCK, (agent) => this.dockStocker(agent), { outfit: DOCK_JACKET, walkPose: "carry", restPose: "carry", facing: -1 });
    for (const spot of [OPD_PICK_SPOTS.trolley, OPD_PICK_SPOTS.shelfRight]) {
      staff(spot, (agent) => this.picker(agent, { spot: this.roomSpots.take(spot) }), { restPose: "scan" });
    }
  }

  private addShopper(alreadyInside: boolean, withCart: boolean) {
    const start = alreadyInside ? this.nav.nearestWalkable(pick(BROWSE_SPOTS)) : ENTRANCE;
    const agent = this.spawn({
      position: start,
      walkPose: withCart ? "cart" : "walk",
      restPose: withCart ? "cart" : "idle",
      outfit: withCart ? pick(CART_COLOURS) : pick(CUSTOMER_COLOURS),
      speed: withCart ? rand(0.72, 0.9) : rand(0.95, 1.2),
      opacity: alreadyInside ? 1 : 0,
    });
    agent.tags.add("shopper");
    agent.tags.add("ambient");
    agent.replaceBehavior(this.shopper(agent, withCart, alreadyInside));
  }

  // -------------------------------------------------------------- routines
  private *shopper(agent: Agent, withCart: boolean, alreadyInside: boolean): Behavior {
    if (!alreadyInside) {
      agent.fadeTo(1, 0.8);
      if (withCart) {
        agent.setPoses({ walk: "walk", rest: "idle" });
        yield walk(CART_PICKUP);
        yield wait(rand(0.8, 1.4), { face: CART_PICKUP.face });
        yield pose({ walk: "cart", rest: "cart" });
      }
    }
    // A short, mostly local browse: each next stop is near the last one.
    let last: FloorPoint = agent.position;
    for (let stops = Math.floor(rand(alreadyInside ? 1 : 2, 5)); stops > 0; stops--) {
      const spot = this.browse.claim(last);
      if (!spot) break;
      yield walk(spot);
      yield* this.browseAt(spot);
      this.browse.release(spot);
      last = spot;
    }
    // Pay at the self-checkout with the shortest line, if one has room.
    const register = [...this.registers].sort((a, b) => a.line.length - b.line.length)[0];
    if (register.line.length <= register.queue.length) {
      register.line.push(agent);
      const place = () => {
        const index = register.line.indexOf(agent);
        return index <= 0 ? register.pay : register.queue[Math.min(index - 1, register.queue.length - 1)];
      };
      for (;;) {
        const target = place();
        yield walk(target, { exact: true });
        if (register.line[0] === agent) break;
        yield until(() => place() !== target, { face: RIGHT });
      }
      yield wait(rand(4, 7.5), { face: register.pay.face });
      register.line.shift();
    }
    agent.fadeTo(0, 3.2);
    yield walk(EXIT);
    yield fade(0, 0.3);
  }

  // Looks at the shelf, sometimes glances along the aisle, then back.
  private *browseAt(spot: Spot): Behavior {
    const face = spot.face ?? RIGHT;
    yield wait(rand(1.6, 3.5), { face });
    if (Math.random() < 0.45) yield wait(rand(0.7, 1.4), { face: face === 1 ? -1 : 1 });
    yield wait(rand(1.2, 3.2), { face });
  }

  private *shelfChecker(agent: Agent, first: Spot): Behavior {
    let spot: Spot | null = first;
    for (;;) {
      if (spot) {
        yield walk(spot);
        yield wait(rand(7, 14), { pose: "scan", face: spot.face });
        this.shelfChecks.release(spot);
      } else {
        yield wait(2);
      }
      spot = this.shelfChecks.claim(agent.position);
    }
  }

  private *pickupAssociate(): Behavior {
    for (;;) {
      yield walk(PICKUP_DESK);
      yield wait(rand(6, 11), { face: PICKUP_DESK.face });
      const shelf = pick(PICKUP_SHELVES);
      yield walk(shelf);
      yield wait(rand(3, 5), { pose: "scan", face: shelf.face });
      yield walk(PICKUP_COUNTER);
      yield wait(rand(3, 6), { face: PICKUP_COUNTER.face });
    }
  }

  private *dockStocker(agent: Agent): Behavior {
    for (;;) {
      agent.setPoses({ walk: "walk", rest: "idle" });
      yield walk(DOCK_TRUCK);
      yield wait(rand(1, 1.8), { face: DOCK_TRUCK.face });
      yield pose({ walk: "carry", rest: "carry" });
      const drop = pick(DOCK_DROPS);
      yield walk(drop, { speed: 0.8 });
      yield wait(rand(0.8, 1.4), { face: drop.face });
    }
  }

  /** OPD picker moving between the room's shelves, trolley and totes. */
  *picker(agent: Agent, holder: SpotHolder): Behavior {
    for (;;) {
      const spot = holder.spot;
      if (spot) {
        yield walk(spot);
        yield wait(rand(5, 10), { pose: "scan", face: spot.face });
        this.roomSpots.release(spot);
      } else {
        yield wait(1.5);
      }
      holder.spot = this.roomSpots.claim(agent.position);
    }
  }

  claimRoomSpot(preferNear?: FloorPoint) {
    return this.roomSpots.claim(preferNear);
  }

  releaseRoomSpot(spot: Spot | null) {
    this.roomSpots.release(spot);
  }

  *stand(spot: Spot): Behavior {
    // Staff step between waiting customers rather than around the line.
    yield walk(spot, { exact: true, avoid: false });
    yield until(() => false, { face: spot.face });
  }

  /** Walks somewhere, fading out, and is then removed. */
  *leave(agent: Agent, via: FloorPoint[], to: FloorPoint = EXIT, walkPose: Pose = "walk"): Behavior {
    agent.setPoses({ walk: walkPose });
    for (const point of via) yield walk(point, { avoid: false });
    agent.fadeTo(0, 2.4);
    yield walk(to);
    yield fade(0, 0.3);
  }

  addRoute(from: FloorPoint, to: FloorPoint, color?: THREE.ColorRepresentation, lifetime?: number) {
    const path = this.nav.findPath(from, to, { avoid: false });
    if (!path || path.length < 2 || this.options.reducedMotion) return;
    const route = new RouteLine(path, color, lifetime);
    this.routes.push(route);
    this.scene.add(route.mesh);
  }

  // --------------------------------------------------------------- scenarios
  setCheckout(state: CheckoutVisual | null) {
    this.checkout.apply(state);
    this.reservations.queue = this.checkout.occupiedSlots();
    this.updateReservations();
  }

  setOpd(state: OpdVisual | null) {
    this.opd.apply(state);
    this.focus.state = !state ? "off" : state.recovered ? "recovered" : state.incidentActive ? "alert" : "off";
    this.totes.visible = !!state;
    if (state) this.totes.setBacklog(state.backlogUnits, state.onPace);
  }

  setIncident(active: boolean) {
    this.spill.active = active;
    this.reservations.spill = active;
    this.updateReservations();
  }

  private updateReservations() {
    this.nav.setReservations([
      ...this.reservations.queue.map((point) => ({ point, radius: 0.55, weight: 6 })),
      ...(this.reservations.spill ? [{ point: SPILL, radius: 1.5, weight: 14 }] : []),
    ]);
  }

  // ------------------------------------------------------------------ loop
  update(dt: number) {
    this.time += dt;
    const reducedMotion = this.options.reducedMotion;
    // With reduced motion the ambient store holds still; scenario people
    // still move (instantly) so the scene matches the live state.
    for (const agent of this.agents) {
      if (reducedMotion && agent.tags.has("ambient")) continue;
      agent.update(dt, this.agents, reducedMotion);
    }
    for (let i = this.agents.length - 1; i >= 0; i--) {
      const agent = this.agents[i];
      if (!agent.finished) continue;
      agent.dispose();
      this.agents.splice(i, 1);
    }
    // Keep a steady stream of shoppers arriving.
    const shoppers = this.agents.filter((agent) => agent.tags.has("shopper")).length;
    this.shopperTimer -= dt;
    if (!reducedMotion && shoppers < 7 && this.shopperTimer <= 0) {
      this.addShopper(false, Math.random() < 0.55);
      this.shopperTimer = rand(2.5, 7);
    }
    for (let i = this.routes.length - 1; i >= 0; i--) {
      if (this.routes[i].update(dt)) continue;
      this.routes[i].dispose();
      this.routes.splice(i, 1);
    }
    this.spill.update(dt, reducedMotion);
    this.focus.update(dt, reducedMotion);
    this.totes.update(dt, reducedMotion);
  }

  dispose() {
    for (const agent of this.agents) agent.dispose();
    for (const route of this.routes) route.dispose();
    this.agents.length = 0;
    this.nav.setReservations([]); // the grid is shared with any later scene
    this.spill.dispose();
    this.focus.dispose();
    this.totes.dispose();
  }
}

// ------------------------------------------------------------ checkout queue
type QueueTicket = { lane: 0 | 1; moveAt: number };

/**
 * Two first-in, first-out lines. People join at the tail, pay at the head,
 * and when register 6 opens the tail of line one walks over to it.
 */
class CheckoutDirector {
  private readonly lanes: [Agent[], Agent[]] = [[], []];
  private readonly tickets = new Map<Agent, QueueTicket>();
  private cashier: Agent | null = null;
  private laneTwoOpen = false;
  private active = false;

  constructor(private readonly life: StoreLife) {}

  occupiedSlots() {
    return [
      ...this.lanes[0].map((_, index) => LANE_ONE[Math.min(index, LANE_ONE.length - 1)]),
      ...this.lanes[1].map((_, index) => LANE_TWO[Math.min(index, LANE_TWO.length - 1)]),
    ];
  }

  private slotFor(agent: Agent): FloorPoint {
    const ticket = this.tickets.get(agent);
    if (!ticket) return agent.position;
    if (this.life.time < ticket.moveAt) return { ...agent.position };
    const slots = ticket.lane === 0 ? LANE_ONE : LANE_TWO;
    const index = Math.max(0, this.lanes[ticket.lane].indexOf(agent));
    const slot = slots[Math.min(index, slots.length - 1)];
    // Anyone beyond the defined slots waits a step further back.
    if (index < slots.length) return slot;
    const previous = slots[slots.length - 2];
    const overflow = index - slots.length + 1;
    return { x: slot.x + (slot.x - previous.x) * overflow, z: slot.z + (slot.z - previous.z) * overflow };
  }

  private *waitInLine(agent: Agent): Behavior {
    for (;;) {
      const target = this.slotFor(agent);
      if (!near(agent.position, target, 0.08)) yield walk(() => this.slotFor(agent), { exact: true, avoid: false, speed: 0.9 });
      const settled = this.slotFor(agent);
      yield until(() => !near(this.slotFor(agent), settled, 0.05), { face: RIGHT });
    }
  }

  private customer(position: FloorPoint, lane: 0 | 1, visible: boolean) {
    const agent = this.life.spawn({
      position,
      walkPose: "walk",
      restPose: "idle",
      outfit: pick(CUSTOMER_COLOURS),
      speed: rand(0.95, 1.15),
      opacity: visible ? 1 : 0,
      facing: RIGHT,
    });
    agent.tags.add("queue");
    this.tickets.set(agent, { lane, moveAt: 0 });
    this.lanes[lane].push(agent);
    agent.replaceBehavior(this.waitInLine(agent));
    return agent;
  }

  // The person at the register pays, then leaves past the bagging area.
  private serve(agent: Agent, lane: 0 | 1, order: number) {
    this.tickets.delete(agent);
    agent.tags.delete("queue");
    const register = lane === 0 ? LANE_ONE[0] : LANE_TWO[0];
    const exit = lane === 0 ? LANE_ONE_EXIT : LANE_TWO_EXIT;
    const startAt = this.life.time + order * 1.1;
    const life = this.life;
    agent.replaceBehavior((function* (): Behavior {
      yield until(() => life.time >= startAt, { face: RIGHT });
      yield walk(register, { exact: true, avoid: false });
      yield wait(0.7, { face: RIGHT });
      yield* life.leave(agent, [exit]);
    })());
  }

  private dismiss(agent: Agent) {
    this.tickets.delete(agent);
    agent.replaceBehavior((function* (): Behavior {
      yield fade(0, 0.35);
    })());
  }

  apply(state: CheckoutVisual | null) {
    if (!state) {
      for (const agent of [...this.lanes[0], ...this.lanes[1]]) this.dismiss(agent);
      this.lanes[0] = [];
      this.lanes[1] = [];
      if (this.cashier) this.dismiss(this.cashier);
      this.cashier = null;
      this.laneTwoOpen = false;
      this.active = false;
      return;
    }
    const instant = !this.active || this.life.options.reducedMotion;
    this.active = true;
    const targets: [number, number] = [state.laneOne, state.laneTwoOpen ? state.laneTwo : 0];

    if (instant) {
      for (const lane of [0, 1] as const) {
        const slots = lane === 0 ? LANE_ONE : LANE_TWO;
        while (this.lanes[lane].length < targets[lane]) {
          const index = this.lanes[lane].length;
          this.customer(slots[Math.min(index, slots.length - 1)], lane, true);
        }
      }
      if (state.laneTwoOpen) this.openLaneTwo(true);
      this.laneTwoOpen = state.laneTwoOpen;
      this.trim(targets);
      return;
    }

    // Register 6 opens: the tail of line one walks over, one after another.
    if (state.laneTwoOpen && !this.laneTwoOpen) {
      const movers = Math.max(0, Math.min(this.lanes[0].length - targets[0], targets[1] - this.lanes[1].length));
      const moving = this.lanes[0].splice(this.lanes[0].length - movers, movers);
      moving.forEach((agent, index) => {
        this.tickets.set(agent, { lane: 1, moveAt: this.life.time + 0.35 + index * 0.24 });
        this.lanes[1].push(agent);
      });
      if (moving.length) this.life.addRoute(LANE_ONE[Math.min(LANE_ONE.length - 1, targets[0])], LANE_TWO[Math.min(LANE_TWO.length - 1, moving.length - 1)]);
      this.openLaneTwo(false);
    } else if (!state.laneTwoOpen && this.laneTwoOpen && this.cashier) {
      this.cashier.replaceBehavior(this.life.leave(this.cashier, [LANE_TWO_CASHIER_START], LANE_TWO_CASHIER_START));
      this.cashier = null;
    }
    this.laneTwoOpen = state.laneTwoOpen;
    this.trim(targets);
  }

  private openLaneTwo(instant: boolean) {
    if (this.cashier) return;
    const cashier = this.life.spawn({ position: instant ? LANE_TWO_CASHIER : LANE_TWO_CASHIER_START, opacity: instant ? 1 : 0, facing: LANE_TWO_CASHIER.face });
    cashier.tags.add("staff");
    if (!instant) cashier.fadeTo(1, 0.6);
    cashier.replaceBehavior(this.life.stand(LANE_TWO_CASHIER));
    this.cashier = cashier;
  }

  // Serves people from the head of a line, or brings new people to its tail.
  private trim(targets: [number, number]) {
    for (const lane of [0, 1] as const) {
      let order = 0;
      while (this.lanes[lane].length > targets[lane]) this.serve(this.lanes[lane].shift()!, lane, order++);
      while (this.lanes[lane].length < targets[lane]) {
        const agent = this.customer(this.life.nav.nearestWalkable(pick(QUEUE_ARRIVALS)), lane, false);
        agent.fadeTo(1, 0.7);
      }
    }
  }
}

// --------------------------------------------------------------- OPD room
type RoomWorker = { agent: Agent; spot: Spot | null };

/**
 * Supplemental pickers and cross-trained flex associates. The room's two
 * regular pickers are part of the ambient staff.
 */
class OpdDirector {
  private pickers: RoomWorker[] = [];
  private flex: { agent: Agent; home: Spot; assigned: boolean; spot: Spot | null }[] = [];
  private active = false;

  constructor(private readonly life: StoreLife) {}

  private *enterRoom(worker: RoomWorker, fromOutside: boolean): Behavior {
    if (fromOutside) yield walk(OPD_DOOR_INSIDE, { avoid: false });
    yield* this.life.picker(worker.agent, worker);
  }

  private *leaveRoom(worker: RoomWorker): Behavior {
    this.life.releaseRoomSpot(worker.spot);
    worker.spot = null;
    yield walk(OPD_DOOR_INSIDE, { avoid: false });
    yield* this.life.leave(worker.agent, [{ x: 1.6, z: -7.3 }], { x: 2.8, z: -6.4 });
  }

  private *stockShelves(agent: Agent, home: Spot): Behavior {
    yield walk(home);
    yield until(() => false, { pose: "scan", face: home.face });
  }

  private *joinOpd(entry: RoomWorker): Behavior {
    yield walk(OPD_DOOR_INSIDE, { avoid: false });
    yield* this.life.picker(entry.agent, entry);
  }

  apply(state: OpdVisual | null) {
    const target = state
      ? { pickers: state.activePickers, flex: state.flexVisible, assigned: state.flexAssigned }
      : { pickers: 0, flex: 0, assigned: 0 };
    const instant = !this.active || this.life.options.reducedMotion;
    this.active = !!state;

    // Supplemental pickers: a call-out walks out through the door.
    while (this.pickers.length > target.pickers) {
      const worker = this.pickers.pop()!;
      if (!state) {
        this.life.releaseRoomSpot(worker.spot);
        worker.agent.replaceBehavior((function* (): Behavior { yield fade(0, 0.35); })());
      } else {
        worker.agent.replaceBehavior(this.leaveRoom(worker));
      }
    }
    while (this.pickers.length < target.pickers) {
      const spot = this.life.claimRoomSpot();
      const start = instant && spot ? spot : { x: 1.4, z: -7.4 };
      const agent = this.life.spawn({ position: start, restPose: "scan", opacity: instant ? 1 : 0 });
      agent.tags.add("staff");
      if (!instant) agent.fadeTo(1, 0.6);
      const worker = { agent, spot };
      agent.replaceBehavior(this.enterRoom(worker, !instant));
      this.pickers.push(worker);
    }

    // Flex associates stock grocery until the workforce receipt assigns them.
    while (this.flex.length > target.flex) {
      const entry = this.flex.pop()!;
      this.life.releaseRoomSpot(entry.spot);
      entry.agent.replaceBehavior((function* (): Behavior { yield fade(0, 0.5); })());
    }
    while (this.flex.length < target.flex) {
      const home = OPD_FLEX_START[this.flex.length % OPD_FLEX_START.length];
      const agent = this.life.spawn({ position: home, restPose: "scan", opacity: 0, facing: home.face });
      agent.tags.add("staff");
      agent.fadeTo(1, instant ? 0 : 0.6);
      agent.replaceBehavior(this.stockShelves(agent, home));
      this.flex.push({ agent, home, assigned: false, spot: null });
    }
    this.flex.forEach((entry, index) => {
      const assigned = index < target.assigned;
      if (assigned === entry.assigned) return;
      entry.assigned = assigned;
      if (assigned) {
        entry.spot = this.life.claimRoomSpot(OPD_DOOR_INSIDE);
        if (instant && entry.spot) {
          entry.agent.place(entry.spot);
          entry.agent.replaceBehavior(this.life.picker(entry.agent, entry));
        } else {
          if (index === 0) this.life.addRoute(entry.home, OPD_DOOR_INSIDE, "#76b900", 5.5);
          const delay = index * 0.52;
          const life = this.life;
          const joinOpd = this.joinOpd(entry);
          const startAt = life.time + delay;
          entry.agent.replaceBehavior((function* (): Behavior {
            yield until(() => life.time >= startAt);
            yield* joinOpd;
          })());
        }
      } else {
        this.life.releaseRoomSpot(entry.spot);
        entry.spot = null;
        const walkBack = this.stockShelves(entry.agent, entry.home);
        entry.agent.replaceBehavior(instant ? (entry.agent.place(entry.home), walkBack) : walkBack);
      }
    });
  }
}
