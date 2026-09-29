// Scenario props drawn in the 3D store: the spill decal, the OPD room focus,
// backlog totes and dashed floor routes.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { FloorPoint } from "./navigation";
import { FLOOR_STRETCH, VIEW_YAW } from "./sprites";

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Opacity that eases toward 0 or 1 and reports when fully hidden. */
class Presence {
  value = 0;
  target = 0;

  step(dt: number, seconds: number) {
    const rate = dt / Math.max(0.001, seconds);
    this.value = this.target > this.value ? Math.min(this.target, this.value + rate) : Math.max(this.target, this.value - rate);
    return this.value;
  }
}

// ------------------------------------------------------------------ spill
/** The 8-bit spill laid flat on the floor, stretched so it reads as drawn. */
export class SpillDecal {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly presence = new Presence();
  private readonly size: { width: number; depth: number };

  constructor(texture: THREE.Texture, aspect: number, at: FloorPoint) {
    // A standard lit-colour copy of the sprite texture (the character shader
    // uses raw, premultiplied texels instead).
    const spill = texture.clone();
    spill.colorSpace = THREE.SRGBColorSpace;
    spill.premultiplyAlpha = false;
    spill.needsUpdate = true;
    this.material = new THREE.MeshBasicMaterial({ map: spill, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    // The 94 px spill art at the store's default 50 px per metre.
    const width = 1.85;
    this.size = { width, depth: (width / aspect) * FLOOR_STRETCH };
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.material);
    this.mesh.rotation.y = VIEW_YAW;
    this.mesh.position.set(at.x, 0.022, at.z);
    this.mesh.renderOrder = -2;
    this.mesh.visible = false;
  }

  set active(value: boolean) {
    this.presence.target = value ? 1 : 0;
  }

  update(dt: number, reducedMotion: boolean) {
    const t = reducedMotion ? (this.presence.value = this.presence.target) : this.presence.step(dt, this.presence.target ? 0.52 : 0.3);
    const scale = 0.94 + 0.06 * easeOut(t);
    this.mesh.scale.set(this.size.width * scale, 1, this.size.depth * scale);
    this.material.opacity = t;
    this.mesh.visible = t > 0.001;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}

// -------------------------------------------------------------- room focus
const AMBER = new THREE.Color("#f0a91f");
const LIME = new THREE.Color("#b6e83d");

/**
 * Glowing rails along the stockroom wall tops plus a faint floor tint, so the
 * alert frames the room even where its partitions hide the floor.
 */
export class RoomFocus {
  readonly group = new THREE.Group();
  private readonly railMaterial = new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, depthWrite: false });
  private readonly floorMaterial = new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
  private readonly presence = new Presence();
  private clock = 0;
  private recovered = false;

  constructor(room: { x0: number; z0: number; x1: number; z1: number }, walls: { rear: number; left: number; front: number; right: number }) {
    const { x0, z0, x1, z1 } = room;
    const rail = (x: number, y: number, z: number, width: number, depth: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.07, depth), this.railMaterial);
      mesh.position.set(x, y + 0.1, z);
      this.group.add(mesh);
    };
    const pad = 0.12;
    rail((x0 + x1) / 2, walls.rear, z0 - pad, x1 - x0 + 2 * pad, 0.09);
    rail(x0 - pad, walls.left, (z0 + z1) / 2, 0.09, z1 - z0 + 2 * pad);
    rail((x0 + x1) / 2, walls.front, z1 + pad, x1 - x0 + 2 * pad, 0.09);
    rail(x1 + pad, walls.right, (z0 + z1) / 2, 0.09, z1 - z0 + 2 * pad);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2), this.floorMaterial);
    floor.position.set((x0 + x1) / 2, 0.02, (z0 + z1) / 2);
    floor.renderOrder = -3;
    this.group.add(floor);
    this.group.visible = false;
  }

  set state(value: "off" | "alert" | "recovered") {
    this.presence.target = value === "off" ? 0 : 1;
    this.recovered = value === "recovered";
  }

  update(dt: number, reducedMotion: boolean) {
    this.clock += dt;
    const t = reducedMotion ? (this.presence.value = this.presence.target) : this.presence.step(dt, 0.4);
    const color = this.recovered ? LIME : AMBER;
    const pulse = this.recovered || reducedMotion ? 1 : 0.62 + 0.38 * (0.5 + 0.5 * Math.cos((this.clock / 1.6) * Math.PI * 2));
    this.railMaterial.color.copy(color);
    this.floorMaterial.color.copy(color);
    this.railMaterial.opacity = 0.9 * t * pulse;
    this.floorMaterial.opacity = 0.14 * t * pulse;
    this.group.visible = t > 0.001;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((object) => (object as THREE.Mesh).geometry?.dispose());
    this.railMaterial.dispose();
    this.floorMaterial.dispose();
  }
}

// ------------------------------------------------------------------ totes
const TOTE_BACKLOG = { top: new THREE.Color("#f6bd54"), body: new THREE.Color("#c98522") };
const TOTE_ON_PACE = { top: new THREE.Color("#c5e879"), body: new THREE.Color("#75a526") };

/** One tote per backlog unit, stacked 3 × 3 × 2 on a pallet. */
export class ToteStack {
  static readonly CAPACITY = 18;
  readonly group = new THREE.Group();
  private readonly pallet: THREE.Mesh;
  private readonly totes: { mesh: THREE.Mesh; home: THREE.Vector3; shown: number; delay: number }[] = [];
  private readonly material = new THREE.MeshLambertMaterial({ color: TOTE_BACKLOG.body });
  private readonly presence = new Presence();
  private count = 0;

  constructor(at: FloorPoint) {
    this.pallet = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.13, 1.02), new THREE.MeshLambertMaterial({ color: "#c8922e" }));
    this.pallet.position.set(at.x, 0.065, at.z);
    this.group.add(this.pallet);
    const geometry = new RoundedBoxGeometry(0.36, 0.22, 0.29, 2, 0.03);
    for (let i = 0; i < ToteStack.CAPACITY; i++) {
      const level = Math.floor(i / 9);
      const row = Math.floor((i % 9) / 3);
      const column = i % 3;
      const mesh = new THREE.Mesh(geometry, this.material);
      const home = new THREE.Vector3(at.x - 0.4 + column * 0.4, 0.13 + 0.11 + level * 0.235, at.z - 0.32 + row * 0.32);
      mesh.position.copy(home);
      mesh.visible = false;
      this.group.add(mesh);
      this.totes.push({ mesh, home, shown: 0, delay: 0 });
    }
    this.group.visible = false;
  }

  set visible(value: boolean) {
    this.presence.target = value ? 1 : 0;
  }

  setBacklog(units: number, onPace: boolean) {
    const next = Math.max(0, Math.min(ToteStack.CAPACITY, Math.round(units)));
    this.totes.forEach((tote, index) => {
      if (index >= this.count && index < next) tote.delay = (index - this.count) * 0.028;
    });
    this.count = next;
    const palette = onPace ? TOTE_ON_PACE : TOTE_BACKLOG;
    this.material.color.copy(palette.body).lerp(palette.top, 0.35);
  }

  update(dt: number, reducedMotion: boolean) {
    const t = reducedMotion ? (this.presence.value = this.presence.target) : this.presence.step(dt, 0.3);
    this.group.visible = t > 0.001;
    this.totes.forEach((tote, index) => {
      const wanted = index < this.count ? 1 : 0;
      if (tote.delay > 0 && wanted) {
        tote.delay -= dt;
        return;
      }
      tote.shown = reducedMotion ? wanted : wanted > tote.shown ? Math.min(1, tote.shown + dt / 0.36) : Math.max(0, tote.shown - dt / 0.25);
      const drop = wanted ? (1 - easeOut(tote.shown)) * 0.7 : 0;
      tote.mesh.visible = tote.shown > 0.001 && t > 0.001;
      tote.mesh.position.set(tote.home.x, tote.home.y + drop, tote.home.z);
      tote.mesh.scale.setScalar(wanted ? 1 : Math.max(0.001, tote.shown));
    });
  }

  dispose() {
    this.group.removeFromParent();
    this.pallet.geometry.dispose();
    (this.pallet.material as THREE.Material).dispose();
    this.totes[0]?.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ------------------------------------------------------------ route lines
const ROUTE_VERTEX = /* glsl */ `
  attribute float along;
  varying float vAlong;
  varying float vAcross;
  void main() {
    vAlong = along;
    vAcross = uv.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const ROUTE_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  uniform float offset;
  varying float vAlong;
  varying float vAcross;
  void main() {
    float dash = step(0.45, fract((vAlong - offset) / 0.34));
    float edge = smoothstep(0.0, 0.25, vAcross) * smoothstep(1.0, 0.75, vAcross);
    gl_FragColor = vec4(color, opacity * dash * edge);
    #include <colorspace_fragment>
  }`;

/** A dashed, flowing floor route that fades in, holds, then fades out. */
export class RouteLine {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private age = 0;

  constructor(points: FloorPoint[], color: THREE.ColorRepresentation = "#76b900", private readonly lifetime = 5.4) {
    const width = 0.1;
    const positions: number[] = [];
    const uvs: number[] = [];
    const along: number[] = [];
    const indices: number[] = [];
    let distance = 0;
    points.forEach((point, i) => {
      const previous = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      const dx = next.x - previous.x;
      const dz = next.z - previous.z;
      const length = Math.hypot(dx, dz) || 1;
      const nx = -dz / length;
      const nz = dx / length;
      if (i > 0) distance += Math.hypot(point.x - previous.x, point.z - previous.z);
      positions.push(point.x + nx * width, 0.03, point.z + nz * width, point.x - nx * width, 0.03, point.z - nz * width);
      uvs.push(0, 0, 0, 1);
      along.push(distance, distance);
      if (i > 0) {
        const base = (i - 1) * 2;
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute("along", new THREE.Float32BufferAttribute(along, 1));
    geometry.setIndex(indices);
    this.material = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: 0 }, offset: { value: 0 } },
      vertexShader: ROUTE_VERTEX,
      fragmentShader: ROUTE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.renderOrder = -1;
  }

  /** Returns false once the line has fully faded. */
  update(dt: number) {
    this.age += dt;
    const t = this.age / this.lifetime;
    this.material.uniforms.offset.value = this.age * 0.8;
    this.material.uniforms.opacity.value = t < 0.1 ? t / 0.1 : t > 0.8 ? Math.max(0, (1 - t) / 0.2) : 1;
    return t < 1;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
