// Small modelling kit: seeded randomness, canvas textures, primitive helpers,
// instanced props and a static-mesh baker.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Seeded so the procedurally dressed store is identical on every load.
let seed = 928172;
export const getSeed = () => seed;
export function setSeed(value) {
  seed = value;
}
export function rnd() {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 4294967296;
}
export const pick = (list) => list[Math.floor(rnd() * list.length)];
export const range = (min, max) => min + rnd() * (max - min);

// ----------------------------------------------------------------- textures
export function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8; // three.js clamps this to what the GPU supports
  return texture;
}

// Tiles a texture across geometry whose UVs are in metres.
export function tiled(texture, metres) {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.setScalar(1 / metres);
  return texture;
}

// Light and dark speckles for surface grain.
export function noise(ctx, width, height, count, alpha, size) {
  for (let i = 0; i < count; i++) {
    const v = rnd() > .5 ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * rnd()})`;
    ctx.fillRect(rnd() * width, rnd() * height, size, size);
  }
}

// ------------------------------------------------------------------- meshes
// Every helper returns a static mesh flagged for bakeStatic().
const unitBox = new THREE.BoxGeometry(1, 1, 1);

export function add(parent, geometry, material, x, y, z, { cast = true, rx = 0, ry = 0, rz = 0 } = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  mesh.userData.bake = true;
  parent.add(mesh);
  return mesh;
}

export function box(parent, x, y, z, w, h, d, material, options) {
  const mesh = add(parent, unitBox, material, x, y, z, options);
  mesh.scale.set(w, h, d);
  return mesh;
}

// A box with a different material per face: { px, nx, py, ny, pz, nz }.
export function faceBox(parent, x, y, z, w, h, d, f) {
  return box(parent, x, y, z, w, h, d, [f.px, f.nx, f.py, f.ny, f.pz, f.nz]);
}

const roundedBoxes = new Map();
export function rbox(parent, x, y, z, w, h, d, material, radius, options) {
  const r = Math.max(.002, Math.min(radius, Math.min(w, h, d) / 2 - .002));
  const key = [w, h, d, r].map((v) => v.toFixed(3)).join();
  if (!roundedBoxes.has(key)) roundedBoxes.set(key, new RoundedBoxGeometry(w, h, d, 2, r));
  return add(parent, roundedBoxes.get(key), material, x, y, z, options);
}

export function cyl(parent, x, y, z, rTop, rBottom, h, material, segments, options) {
  return add(parent, new THREE.CylinderGeometry(rTop, rBottom, h, segments), material, x, y, z, options);
}

// Printed graphic (sign, screen, poster) facing +Z unless rotated.
const panelMaterials = new Map();
export function panel(parent, x, y, z, w, h, texture, { rx = 0, ry = 0, glow = 0 } = {}) {
  const key = texture.uuid + glow;
  if (!panelMaterials.has(key)) {
    const material = new THREE.MeshStandardMaterial({ map: texture, roughness: .5 });
    if (glow) Object.assign(material, { emissive: new THREE.Color('#fff'), emissiveMap: texture, emissiveIntensity: glow });
    panelMaterials.set(key, material);
  }
  return add(parent, new THREE.PlaneGeometry(w, h), panelMaterials.get(key), x, y, z, { rx, ry, cast: false });
}

// --------------------------------------------------------- instanced props
// Thousands of products, fruit, cartons and leaves share a handful of
// instanced meshes; each item keeps its own colour.
const SHAPES = {
  box: unitBox,
  fruit: new THREE.IcosahedronGeometry(1, 2),
  clump: new THREE.IcosahedronGeometry(1, 1),
  leaf: new THREE.SphereGeometry(1, 10, 6),
  cyl: new THREE.CylinderGeometry(.5, .5, 1, 14),
};
const FINISHES = {
  matte: new THREE.MeshStandardMaterial({ roughness: .85 }),
  satin: new THREE.MeshStandardMaterial({ roughness: .55 }),
  gloss: new THREE.MeshStandardMaterial({ roughness: .33 }),
};
const batches = new Map();
const placer = new THREE.Object3D();
placer.rotation.order = 'YXZ'; // yaw first, then tilt: natural for leaves and bananas

export function inst(shape, color, x, y, z, sx, sy, sz, { finish = 'satin', rx = 0, ry = 0, rz = 0 } = {}) {
  const key = `${shape}|${finish}`;
  if (!batches.has(key)) batches.set(key, { shape, finish, items: [] });
  placer.position.set(x, y, z);
  placer.rotation.set(rx, ry, rz);
  placer.scale.set(sx, sy, sz);
  placer.updateMatrix();
  batches.get(key).items.push([placer.matrix.clone(), new THREE.Color(color)]);
}

export function commitInstances(parent) {
  for (const { shape, finish, items } of batches.values()) {
    const mesh = new THREE.InstancedMesh(SHAPES[shape], FINISHES[finish], items.length);
    items.forEach(([matrix, color], i) => {
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, color);
    });
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
  }
  batches.clear();
}

// ------------------------------------------------------------------ baking
// Merges every flagged mesh under `root` into one mesh per material (and
// shadow setting), turning thousands of fixtures into a few dozen draw calls.
function sliceVertices(geometry, start, count) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const { array, itemSize } = geometry.attributes[name];
    out.setAttribute(name, new THREE.BufferAttribute(array.slice(start * itemSize, (start + count) * itemSize), itemSize));
  }
  return out;
}

export function bakeStatic(root) {
  root.updateMatrixWorld(true);
  const buckets = new Map();
  const baked = [];
  root.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.userData.bake) return;
    const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    const materials = [mesh.material].flat();
    const groups = Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count: geometry.attributes.position.count, materialIndex: 0 }];
    for (const { start, count, materialIndex } of groups) {
      const material = materials[materialIndex];
      const key = material.uuid + mesh.castShadow;
      if (!buckets.has(key)) buckets.set(key, { material, cast: mesh.castShadow, parts: [] });
      buckets.get(key).parts.push(sliceVertices(geometry, start, count));
    }
    baked.push(mesh);
  });
  baked.forEach((mesh) => mesh.removeFromParent());
  for (const { material, cast, parts } of buckets.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(parts), material);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}
