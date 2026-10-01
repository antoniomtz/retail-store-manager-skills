// People in the store: an 8-bit billboard with a contact shadow, moved along
// navigation paths by small generator behaviours (walk, wait, fade, …).
import * as THREE from "three";
import type { FloorPoint, NavGrid } from "./navigation";
import {
  cameraView,
  CharacterMaterial,
  FLOOR_STRETCH,
  PERSON_HEIGHT,
  shadowTexture,
  type Pose,
  type SpriteLibrary,
} from "./sprites";

/** Screen direction a sprite faces: 1 = right, -1 = left. */
export type Facing = 1 | -1;

export type Step =
  | { kind: "walk"; to: FloorPoint | (() => FloorPoint); speed?: number; avoid?: boolean; exact?: boolean }
  | { kind: "wait"; seconds: number; pose?: Pose; face?: Facing }
  | { kind: "until"; done: () => boolean; pose?: Pose; face?: Facing }
  | { kind: "fade"; to: number; seconds: number }
  | { kind: "pose"; walk?: Pose; rest?: Pose };

export type Behavior = Generator<Step, void, void>;

export const walk = (to: FloorPoint | (() => FloorPoint), options: Omit<Extract<Step, { kind: "walk" }>, "kind" | "to"> = {}): Step => ({ kind: "walk", to, ...options });
export const wait = (seconds: number, options: { pose?: Pose; face?: Facing } = {}): Step => ({ kind: "wait", seconds, ...options });
export const until = (done: () => boolean, options: { pose?: Pose; face?: Facing } = {}): Step => ({ kind: "until", done, ...options });
export const fade = (to: number, seconds = 0.6): Step => ({ kind: "fade", to, seconds });
export const pose = (poses: { walk?: Pose; rest?: Pose }): Step => ({ kind: "pose", ...poses });

// Art faces: stride and cart art walk to the right; the box carrier and the
// scanner pose face left.
const FACES_RIGHT: Record<Pose, boolean> = { walk: true, cart: true, carry: false, idle: true, scan: false };
const STRIDE: Record<Pose, number> = { walk: 0.34, cart: 0.42, carry: 0.34, idle: 1, scan: 1 };
const IDLE_PERIOD: Record<Pose, number> = { walk: 0, cart: 0, carry: 0, idle: 0.8, scan: 1.1 };

const planeGeometry = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
const shadowGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

export type AgentOptions = {
  sprites: SpriteLibrary;
  nav: NavGrid;
  position: FloorPoint;
  walkPose?: Pose;
  restPose?: Pose;
  outfit?: THREE.ColorRepresentation | null;
  speed?: number;
  scale?: number;
  opacity?: number;
  facing?: Facing;
};

export class Agent {
  readonly group = new THREE.Group();
  readonly position: FloorPoint;
  /** Other code may read these to coordinate queues and rooms. */
  tags = new Set<string>();
  finished = false;
  moving = false;
  facing: Facing;
  private readonly sprites: SpriteLibrary;
  private readonly nav: NavGrid;
  private readonly body: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  private readonly material = new CharacterMaterial();
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private readonly baseSpeed: number;
  private readonly scale: number;
  private readonly outfit: THREE.ColorRepresentation | null;
  private walkPose: Pose;
  private restPose: Pose;
  private shownPose: Pose | null = null;
  private frame = 0;
  private stride = 0;
  private idleClock = Math.random() * 3;
  private opacity: number;
  private fadeTarget: number;
  private fadeSpeed = Infinity;
  private heading = 0;
  private speed = 0;
  private behavior: Behavior | null = null;
  private step: Step | null = null;
  private stepTime = 0;
  private path: FloorPoint[] | null = null;
  private pathIndex = 0;
  private goal: FloorPoint | null = null;
  private retarget = 0;
  private idleFacing: Facing | null = null;
  private restOverride: Pose | null = null;
  private viewVersion = -1;

  constructor(options: AgentOptions) {
    this.sprites = options.sprites;
    this.nav = options.nav;
    this.position = { ...options.position };
    this.walkPose = options.walkPose ?? "walk";
    this.restPose = options.restPose ?? "idle";
    this.outfit = options.outfit ?? null;
    this.baseSpeed = options.speed ?? 1.05;
    this.scale = options.scale ?? 1;
    this.opacity = options.opacity ?? 1;
    this.fadeTarget = this.opacity;
    this.facing = options.facing ?? 1;

    this.body = new THREE.Mesh(planeGeometry, this.material);
    this.shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    this.shadow = new THREE.Mesh(shadowGeometry, this.shadowMaterial);
    this.shadow.position.y = 0.018;
    this.shadow.renderOrder = -1;
    this.group.add(this.shadow, this.body);
    this.faceCamera();
    this.showPose(this.restPose, 0);
    this.applyOpacity();
    this.syncTransform();
  }

  // ------------------------------------------------------------ appearance
  setPoses(poses: { walk?: Pose; rest?: Pose }) {
    if (poses.walk) this.walkPose = poses.walk;
    if (poses.rest) this.restPose = poses.rest;
  }

  private showPose(poseName: Pose, frame: number) {
    const sheet = this.sprites[poseName];
    if (this.shownPose !== poseName) {
      this.shownPose = poseName;
      this.material.setOutfit(sheet.fabric, this.outfit);
      const height = PERSON_HEIGHT * this.scale;
      this.body.scale.set(height * sheet.aspect, height * cameraView.stretch, 1);
      const footprint = Math.min(height * sheet.aspect * 0.5, height * 0.42);
      this.shadow.scale.set(footprint, 1, footprint * 0.34 * FLOOR_STRETCH);
    }
    this.material.setFrame(sheet.frames[frame]);
    const facesRight = FACES_RIGHT[poseName];
    this.material.uniforms.uFlip.value = (this.facing === 1) === facesRight ? 0 : 1;
  }

  /** Fades in or out alongside whatever the agent is doing. */
  fadeTo(value: number, seconds: number) {
    this.fadeTarget = value;
    this.fadeSpeed = seconds > 0 ? Math.abs(value - this.opacity) / seconds : Infinity;
  }

  private applyOpacity() {
    this.material.uniforms.uOpacity.value = this.opacity;
    this.shadowMaterial.opacity = this.opacity;
    this.group.visible = this.opacity > 0.01;
  }

  private syncTransform() {
    this.group.position.set(this.position.x, 0, this.position.z);
  }

  /** Teleports (used for the initial layout of a scenario). */
  place(point: FloorPoint, facing?: Facing) {
    this.position.x = point.x;
    this.position.z = point.z;
    if (facing) this.facing = facing;
    this.path = null;
    this.syncTransform();
  }

  /** Starts a new routine, abandoning whatever the agent was doing. */
  replaceBehavior(behavior: Behavior) {
    this.behavior = behavior;
    this.step = null;
    this.path = null;
    this.moving = false;
    this.restOverride = null;
    this.idleFacing = null;
  }

  // ------------------------------------------------------------- stepping
  update(dt: number, crowd: readonly Agent[], reducedMotion: boolean) {
    for (let guard = 0; guard < 8 && !this.finished; guard++) {
      if (!this.step) {
        const next = this.behavior?.next();
        if (!next || next.done) {
          this.finished = !!this.behavior;
          this.behavior = null;
          break;
        }
        this.begin(next.value);
      }
      if (!this.advance(this.step!, dt, crowd, reducedMotion)) break;
      this.step = null;
    }
    if (this.opacity !== this.fadeTarget) {
      const change = reducedMotion ? Infinity : this.fadeSpeed * dt;
      this.opacity = this.fadeTarget > this.opacity
        ? Math.min(this.fadeTarget, this.opacity + change)
        : Math.max(this.fadeTarget, this.opacity - change);
      this.applyOpacity();
    }
    this.animate(dt, reducedMotion);
  }

  private begin(step: Step) {
    this.step = step;
    this.stepTime = 0;
    if (step.kind === "walk") {
      this.goal = null;
      this.path = null;
    } else if (step.kind === "fade") {
      this.fadeTo(step.to, step.seconds);
    } else if ((step.kind === "wait" || step.kind === "until") && step.face) {
      this.idleFacing = step.face;
    }
  }

  // Returns true when the step is complete.
  private advance(step: Step, dt: number, crowd: readonly Agent[], reducedMotion: boolean) {
    this.stepTime += dt;
    switch (step.kind) {
      case "pose":
        this.setPoses(step);
        return true;
      case "fade":
        return reducedMotion || this.opacity === this.fadeTarget;
      case "wait":
        this.moving = false;
        this.speed = 0;
        if (step.pose) this.restOverride = step.pose;
        if (this.stepTime >= step.seconds) {
          this.restOverride = null;
          this.idleFacing = null;
          return true;
        }
        return false;
      case "until":
        this.moving = false;
        this.speed = 0;
        if (step.pose) this.restOverride = step.pose;
        if (step.done()) {
          this.restOverride = null;
          this.idleFacing = null;
          return true;
        }
        return false;
      case "walk":
        return this.walkStep(step, dt, crowd, reducedMotion);
    }
  }

  private walkStep(step: Extract<Step, { kind: "walk" }>, dt: number, crowd: readonly Agent[], reducedMotion: boolean) {
    const target = typeof step.to === "function" ? step.to() : step.to;
    this.retarget -= dt;
    const goalMoved = !this.goal || Math.hypot(target.x - this.goal.x, target.z - this.goal.z) > 0.3;
    if (!this.path || (goalMoved && this.retarget <= 0)) {
      this.goal = { ...target };
      this.retarget = 0.4;
      this.path = this.nav.findPath(this.position, target, { avoid: step.avoid !== false });
      this.pathIndex = 1;
      if (!this.path) {
        this.moving = false;
        return true; // unreachable: give up on this leg
      }
      if (step.exact) this.path[this.path.length - 1] = { ...target };
    }
    if (reducedMotion) {
      this.place(this.path[this.path.length - 1]);
      this.moving = false;
      return true;
    }

    const path = this.path;
    const last = path.length - 1;
    // Advance the carrot along the path (pure pursuit with a short lookahead).
    while (this.pathIndex < last && Math.hypot(path[this.pathIndex].x - this.position.x, path[this.pathIndex].z - this.position.z) < 0.45) {
      this.pathIndex++;
    }
    const carrot = path[Math.min(this.pathIndex, last)];
    const end = path[last];
    const toEnd = Math.hypot(end.x - this.position.x, end.z - this.position.z);
    if (toEnd < 0.05 && this.pathIndex >= last) {
      this.position.x = end.x;
      this.position.z = end.z;
      this.syncTransform();
      this.moving = false;
      this.speed = 0;
      return true;
    }

    const desired = Math.atan2(carrot.z - this.position.z, carrot.x - this.position.x);
    if (!this.moving) this.heading = desired;
    let turn = Math.atan2(Math.sin(desired - this.heading), Math.cos(desired - this.heading));
    const maxTurn = 5.5 * dt;
    turn = Math.max(-maxTurn, Math.min(maxTurn, turn));
    this.heading += turn;

    // Slow for sharp turns, the destination, and people directly ahead.
    const cruise = this.baseSpeed * (step.speed ?? 1);
    let limit = Math.min(cruise, 0.25 + toEnd * 1.4) * (1 - Math.min(0.6, Math.abs(turn) / maxTurn * 0.35));
    const directionX = Math.cos(this.heading);
    const directionZ = Math.sin(this.heading);
    let sidestepX = 0;
    let sidestepZ = 0;
    for (const other of crowd) {
      if (other === this || !other.group.visible) continue;
      const dx = other.position.x - this.position.x;
      const dz = other.position.z - this.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 1.1 || distance < 1e-4) continue;
      const ahead = (dx * directionX + dz * directionZ) / distance;
      if (ahead > 0.6 && distance < 0.95) limit = Math.min(limit, Math.max(0.12, (distance - 0.42) * 1.3));
      if (distance < 0.85) {
        const push = (0.85 - distance) * 1.2;
        sidestepX -= (dx / distance) * push;
        sidestepZ -= (dz / distance) * push;
      }
    }
    const acceleration = limit > this.speed ? 1.8 : 3.2;
    this.speed += Math.max(-acceleration * dt, Math.min(acceleration * dt, limit - this.speed));
    this.speed = Math.max(0, this.speed);

    // Only the sideways part of the crowd push applies, and never into a wall.
    const lateral = sidestepX * -directionZ + sidestepZ * directionX;
    const stepX = directionX * this.speed * dt + -directionZ * lateral * dt;
    const stepZ = directionZ * this.speed * dt + directionX * lateral * dt;
    const nextX = this.position.x + stepX;
    const nextZ = this.position.z + stepZ;
    if (this.nav.clearanceAt(nextX, nextZ) > 0.18 || this.nav.clearanceAt(this.position.x, this.position.z) <= 0.18) {
      this.position.x = nextX;
      this.position.z = nextZ;
    } else {
      this.position.x += directionX * this.speed * dt;
      this.position.z += directionZ * this.speed * dt;
    }
    this.stride += this.speed * dt;
    this.moving = this.speed > 0.03;
    const screen = directionX * cameraView.right.x + directionZ * cameraView.right.z;
    if (Math.abs(screen) > 0.2) this.facing = screen > 0 ? 1 : -1;
    this.syncTransform();
    return false;
  }

  // Billboards face the camera horizontally and sit slightly toward it along
  // the view ray: same screen position, but no clipping into nearby shelves.
  private faceCamera() {
    if (this.viewVersion === cameraView.version) return;
    this.viewVersion = cameraView.version;
    this.body.rotation.y = cameraView.yaw;
    this.body.position.copy(cameraView.toward);
    this.shadow.rotation.y = cameraView.yaw;
    this.shownPose = null; // re-apply the stretch for the new elevation
  }

  private animate(dt: number, reducedMotion: boolean) {
    this.faceCamera();
    if (this.moving) {
      const poseName = this.walkPose;
      this.frame = Math.floor(this.stride / STRIDE[poseName]) % 2;
      this.showPose(poseName, this.frame);
      return;
    }
    const poseName = this.restOverride ?? this.restPose;
    if (this.idleFacing) this.facing = this.idleFacing;
    const period = reducedMotion ? 0 : IDLE_PERIOD[poseName];
    this.idleClock += dt;
    this.frame = period ? Math.floor(this.idleClock / period) % 2 : 0;
    this.showPose(poseName, this.frame);
  }

  dispose() {
    this.group.removeFromParent();
    this.material.dispose();
    this.shadowMaterial.dispose();
  }
}
