// Walkability grid rasterized from the built store, with clearance-aware A*
// so people follow the middle of aisles and walk through doors, not walls.
import * as THREE from "three";

export type FloorPoint = { x: number; z: number };
/** Plan polygon as [x, z] pairs, as defined in store.js. */
export type PlanPolygon = ReadonlyArray<ReadonlyArray<number>>;
type Rect = { x0: number; z0: number; x1: number; z1: number };

export const CELL = 0.2;
/** Body radius kept clear of fixtures and walls. */
export const BODY_RADIUS = 0.3;
const BOUNDS = { x0: -23.6, x1: 12.4, z0: -10.8, z1: 15.6 };
// Geometry between ankle and head height blocks walking.
const BLOCK_MIN_Y = 0.03;
const BLOCK_MAX_Y = 1.9;
// Door openings carved through walls after inflation.
const DOORS: Rect[] = [
  { x0: -0.72, z0: -8.22, x1: 0.62, z1: -7.38 }, // glazed stockroom door from the pickup area
];

function insidePolygon(x: number, z: number, polygon: PlanPolygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

class MinHeap {
  private items: number[] = [];
  private scores: number[] = [];

  get size() {
    return this.items.length;
  }

  push(item: number, score: number) {
    const { items, scores } = this;
    items.push(item);
    scores.push(score);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (scores[parent] <= scores[i]) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      [scores[i], scores[parent]] = [scores[parent], scores[i]];
      i = parent;
    }
  }

  pop() {
    const { items, scores } = this;
    const top = items[0];
    const lastItem = items.pop()!;
    const lastScore = scores.pop()!;
    if (items.length) {
      items[0] = lastItem;
      scores[0] = lastScore;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && scores[left] < scores[smallest]) smallest = left;
        if (right < items.length && scores[right] < scores[smallest]) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        [scores[i], scores[smallest]] = [scores[smallest], scores[i]];
        i = smallest;
      }
    }
    return top;
  }
}

export class NavGrid {
  readonly cols = Math.ceil((BOUNDS.x1 - BOUNDS.x0) / CELL);
  readonly rows = Math.ceil((BOUNDS.z1 - BOUNDS.z0) / CELL);
  /** Distance in metres from each cell centre to the nearest obstacle or edge. */
  readonly clearance: Float32Array;
  readonly walkable: Uint8Array;
  /** Extra traversal cost, e.g. to keep shoppers out of a checkout queue. */
  readonly avoidCost: Float32Array;

  constructor(root: THREE.Object3D, floors: PlanPolygon[]) {
    const count = this.cols * this.rows;
    const blocked = new Uint8Array(count);
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const { x, z } = this.cellCentre(col, row);
        if (!floors.some((floor) => insidePolygon(x, z, floor))) blocked[row * this.cols + col] = 1;
      }
    }
    this.rasterizeObstacles(root, blocked);
    this.clearance = this.distanceField(blocked);
    this.walkable = new Uint8Array(count);
    for (let i = 0; i < count; i++) this.walkable[i] = this.clearance[i] >= BODY_RADIUS ? 1 : 0;
    for (const door of DOORS) {
      this.forEachCellIn(door, (index) => {
        this.walkable[index] = 1;
        this.clearance[index] = Math.max(this.clearance[index], BODY_RADIUS);
      });
    }
    this.avoidCost = new Float32Array(count);
  }

  // ------------------------------------------------------------ geometry
  cellCentre(col: number, row: number): FloorPoint {
    return { x: BOUNDS.x0 + (col + 0.5) * CELL, z: BOUNDS.z0 + (row + 0.5) * CELL };
  }

  cellOf(x: number, z: number) {
    const col = Math.floor((x - BOUNDS.x0) / CELL);
    const row = Math.floor((z - BOUNDS.z0) / CELL);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    return row * this.cols + col;
  }

  isWalkable(x: number, z: number) {
    const index = this.cellOf(x, z);
    return index >= 0 && this.walkable[index] === 1;
  }

  clearanceAt(x: number, z: number) {
    const index = this.cellOf(x, z);
    return index >= 0 ? this.clearance[index] : 0;
  }

  private forEachCellIn(rect: Rect, visit: (index: number) => void) {
    const c0 = Math.max(0, Math.floor((rect.x0 - BOUNDS.x0) / CELL));
    const c1 = Math.min(this.cols - 1, Math.floor((rect.x1 - BOUNDS.x0) / CELL));
    const r0 = Math.max(0, Math.floor((rect.z0 - BOUNDS.z0) / CELL));
    const r1 = Math.min(this.rows - 1, Math.floor((rect.z1 - BOUNDS.z0) / CELL));
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) visit(row * this.cols + col);
  }

  // Marks the plan footprint of every triangle and instance that occupies the
  // band between ankle and head height.
  private rasterizeObstacles(root: THREE.Object3D, blocked: Uint8Array) {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const matrix = new THREE.Matrix4();
    const mark = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) => {
      if (maxY < BLOCK_MIN_Y || minY > BLOCK_MAX_Y) return;
      this.forEachCellIn({ x0: minX, z0: minZ, x1: maxX, z1: maxZ }, (index) => { blocked[index] = 1; });
    };
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry;
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
        const instanced = mesh as THREE.InstancedMesh;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        for (let i = 0; i < instanced.count; i++) {
          instanced.getMatrixAt(i, matrix);
          box.copy(geometry.boundingBox!).applyMatrix4(matrix).applyMatrix4(instanced.matrixWorld);
          mark(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z);
        }
        return;
      }
      const position = geometry.getAttribute("position");
      if (!position) return;
      const index = geometry.getIndex();
      const corner = new THREE.Vector3();
      const triangles = index ? index.count / 3 : position.count / 3;
      for (let t = 0; t < triangles; t++) {
        box.makeEmpty();
        for (let k = 0; k < 3; k++) {
          const vertex = index ? index.getX(t * 3 + k) : t * 3 + k;
          box.expandByPoint(corner.fromBufferAttribute(position, vertex).applyMatrix4(mesh.matrixWorld));
        }
        mark(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z);
      }
    });
  }

  // Two-pass chamfer distance transform (1, √2) in metres.
  private distanceField(blocked: Uint8Array) {
    const { cols, rows } = this;
    const far = 1e6;
    const distance = new Float32Array(cols * rows);
    for (let i = 0; i < distance.length; i++) distance[i] = blocked[i] ? 0 : far;
    const diagonal = Math.SQRT2;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        let d = distance[i];
        if (col > 0) d = Math.min(d, distance[i - 1] + 1);
        if (row > 0) {
          d = Math.min(d, distance[i - cols] + 1);
          if (col > 0) d = Math.min(d, distance[i - cols - 1] + diagonal);
          if (col < cols - 1) d = Math.min(d, distance[i - cols + 1] + diagonal);
        }
        distance[i] = d;
      }
    }
    for (let row = rows - 1; row >= 0; row--) {
      for (let col = cols - 1; col >= 0; col--) {
        const i = row * cols + col;
        let d = distance[i];
        if (col < cols - 1) d = Math.min(d, distance[i + 1] + 1);
        if (row < rows - 1) {
          d = Math.min(d, distance[i + cols] + 1);
          if (col < cols - 1) d = Math.min(d, distance[i + cols + 1] + diagonal);
          if (col > 0) d = Math.min(d, distance[i + cols - 1] + diagonal);
        }
        distance[i] = d;
      }
    }
    // Cell-centre distance to the nearest blocked cell's edge.
    for (let i = 0; i < distance.length; i++) distance[i] = Math.max(0, distance[i] - 0.5) * CELL;
    return distance;
  }

  // ------------------------------------------------------------- queries
  /** Nearest walkable point, searching outward in rings. */
  nearestWalkable(point: FloorPoint): FloorPoint {
    if (this.isWalkable(point.x, point.z)) return { ...point };
    const start = this.cellOf(point.x, point.z);
    const col0 = start >= 0 ? start % this.cols : Math.floor((point.x - BOUNDS.x0) / CELL);
    const row0 = start >= 0 ? Math.floor(start / this.cols) : Math.floor((point.z - BOUNDS.z0) / CELL);
    for (let radius = 1; radius < 40; radius++) {
      let best: FloorPoint | null = null;
      let bestDistance = Infinity;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
          const col = col0 + dc;
          const row = row0 + dr;
          if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) continue;
          if (!this.walkable[row * this.cols + col]) continue;
          const centre = this.cellCentre(col, row);
          const distance = Math.hypot(centre.x - point.x, centre.z - point.z);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = centre;
          }
        }
      }
      if (best) return best;
    }
    return { ...point };
  }

  /** True when a body can walk the straight segment keeping `clearance` metres. */
  lineOfSight(a: FloorPoint, b: FloorPoint, clearance = BODY_RADIUS) {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(length / (CELL * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const index = this.cellOf(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (index < 0 || !this.walkable[index] || this.clearance[index] < clearance) return false;
    }
    return true;
  }

  /**
   * Clearance-weighted A* returning a smoothed polyline from `from` to `to`
   * (both snapped onto walkable cells), or null when unreachable.
   */
  findPath(from: FloorPoint, to: FloorPoint, { avoid = true } = {}): FloorPoint[] | null {
    const start = this.nearestWalkable(from);
    const goal = this.nearestWalkable(to);
    const startIndex = this.cellOf(start.x, start.z);
    const goalIndex = this.cellOf(goal.x, goal.z);
    if (startIndex < 0 || goalIndex < 0) return null;
    if (startIndex === goalIndex) return [start, goal];

    const { cols, rows } = this;
    const cost = new Float32Array(cols * rows).fill(Infinity);
    const parent = new Int32Array(cols * rows).fill(-1);
    const closed = new Uint8Array(cols * rows);
    const heap = new MinHeap();
    const goalCol = goalIndex % cols;
    const goalRow = Math.floor(goalIndex / cols);
    const heuristic = (index: number) => {
      const dc = Math.abs((index % cols) - goalCol);
      const dr = Math.abs(Math.floor(index / cols) - goalRow);
      return (Math.max(dc, dr) + (Math.SQRT2 - 1) * Math.min(dc, dr)) * CELL;
    };
    cost[startIndex] = 0;
    heap.push(startIndex, heuristic(startIndex));
    const neighbours = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ] as const;
    while (heap.size) {
      const current = heap.pop();
      if (current === goalIndex) break;
      if (closed[current]) continue;
      closed[current] = 1;
      const col = current % cols;
      const row = Math.floor(current / cols);
      for (const [dc, dr, step] of neighbours) {
        const nc = col + dc;
        const nr = row + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const next = nr * cols + nc;
        if (!this.walkable[next] || closed[next]) continue;
        // No cutting corners past a blocked cell.
        if (dc && dr && (!this.walkable[row * cols + nc] || !this.walkable[nr * cols + col])) continue;
        // Prefer the middle of aisles, and optionally stay out of reserved zones.
        const crowding = Math.max(0, 0.9 - this.clearance[next]) * 1.6;
        const reserved = avoid ? this.avoidCost[next] : 0;
        const candidate = cost[current] + step * CELL * (1 + crowding + reserved);
        if (candidate < cost[next]) {
          cost[next] = candidate;
          parent[next] = current;
          heap.push(next, candidate + heuristic(next));
        }
      }
    }
    if (parent[goalIndex] < 0) return null;

    const cells: FloorPoint[] = [];
    for (let index = goalIndex; index >= 0; index = parent[index]) {
      cells.push(this.cellCentre(index % cols, Math.floor(index / cols)));
      if (index === startIndex) break;
    }
    cells.reverse();
    cells[0] = start;
    cells[cells.length - 1] = goal;
    return this.smooth(cells);
  }

  // String-pulls the cell path while keeping a comfortable margin, then
  // rounds the remaining corners.
  private smooth(cells: FloorPoint[]) {
    const pulled: FloorPoint[] = [cells[0]];
    let anchor = 0;
    while (anchor < cells.length - 1) {
      let next = anchor + 1;
      for (let candidate = cells.length - 1; candidate > anchor + 1; candidate--) {
        if (this.lineOfSight(cells[anchor], cells[candidate], BODY_RADIUS + 0.12)) {
          next = candidate;
          break;
        }
      }
      pulled.push(cells[next]);
      anchor = next;
    }
    if (pulled.length < 3) return pulled;
    // One Chaikin pass where the cut corner stays walkable.
    const rounded: FloorPoint[] = [pulled[0]];
    for (let i = 1; i < pulled.length - 1; i++) {
      const previous = pulled[i - 1];
      const corner = pulled[i];
      const next = pulled[i + 1];
      const inPoint = { x: corner.x + (previous.x - corner.x) * 0.25, z: corner.z + (previous.z - corner.z) * 0.25 };
      const outPoint = { x: corner.x + (next.x - corner.x) * 0.25, z: corner.z + (next.z - corner.z) * 0.25 };
      if (this.lineOfSight(inPoint, outPoint)) rounded.push(inPoint, outPoint);
      else rounded.push(corner);
    }
    rounded.push(pulled[pulled.length - 1]);
    return rounded;
  }

  // --------------------------------------------------------- reservations
  /** Replaces the zones (queues, spills) that ambient walkers route around. */
  setReservations(zones: ReadonlyArray<{ point: FloorPoint; radius: number; weight: number }>) {
    this.avoidCost.fill(0);
    for (const { point, radius, weight } of zones) {
      this.forEachCellIn({ x0: point.x - radius, z0: point.z - radius, x1: point.x + radius, z1: point.z + radius }, (index) => {
        const centre = this.cellCentre(index % this.cols, Math.floor(index / this.cols));
        const distance = Math.hypot(centre.x - point.x, centre.z - point.z);
        if (distance <= radius) this.avoidCost[index] += weight * (1 - distance / radius);
      });
    }
  }
}
