// The store itself: architecture and every zone of the sales floor and back of
// house. buildStore() may run more than once (for example after a remount), so
// each call builds a fresh group from the same seed. Units are roughly metres.
// From the default camera, +X runs toward the lower right of the screen and +Z
// toward the lower left.
import * as THREE from 'three';
import {
  add, box, faceBox, rbox, cyl, panel, inst, commitInstances, bakeStatic,
  canvasTexture, tiled, noise, rnd, pick, range, getSeed, setSeed,
} from './kit.js';

let world = new THREE.Group();

// ----------------------------------------------------------------- textures
function drawCart(ctx, x, y, s, color) {
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.lineWidth = s * .075;
  ctx.beginPath();
  ctx.moveTo(x - s * .52, y - s * .38); ctx.lineTo(x - s * .34, y - s * .38); ctx.lineTo(x - s * .2, y + s * .18);
  ctx.lineTo(x + s * .38, y + s * .18); ctx.lineTo(x + s * .5, y - s * .22); ctx.lineTo(x - s * .3, y - s * .22);
  ctx.stroke();
  ctx.lineWidth = s * .05;
  for (const k of [-.05, .12, .29]) {
    ctx.beginPath(); ctx.moveTo(x + s * k, y - s * .2); ctx.lineTo(x + s * (k - .02), y + s * .16); ctx.stroke();
  }
  for (const k of [-.12, .3]) {
    ctx.beginPath(); ctx.arc(x + s * k, y + s * .34, s * .075, 0, Math.PI * 2); ctx.fill();
  }
}
// A stack of rounded bars that reads as text at a distance.
function drawLines(ctx, x, y, width, gap, color, count) {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    ctx.beginPath();
    ctx.roundRect(x, y + i * gap, width * (i ? .78 - i * .08 : 1), gap * .34, gap * .17);
    ctx.fill();
  }
}
function limeSign(drawIcon) {
  return canvasTexture(256, 200, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#9cc43a'); g.addColorStop(1, '#7ea82b');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(40,60,10,.35)'; ctx.lineWidth = 6; ctx.strokeRect(3, 3, w - 6, h - 6);
    drawIcon(ctx, w, h);
  });
}
function plankTexture(base) {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += h / 4) {
      const g = ctx.createLinearGradient(0, y, 0, y + h / 4);
      g.addColorStop(0, 'rgba(255,240,210,.14)'); g.addColorStop(1, 'rgba(60,30,10,.1)');
      ctx.fillStyle = g; ctx.fillRect(0, y, w, h / 4);
      ctx.fillStyle = 'rgba(55,32,14,.45)'; ctx.fillRect(0, y, w, 2.5);
      for (let k = 0; k < 7; k++) {
        ctx.fillStyle = `rgba(80,45,20,${.05 + rnd() * .06})`;
        ctx.fillRect(0, y + 6 + rnd() * (h / 4 - 10), w, 1);
      }
    }
  });
}

const TEX = {
  tile: tiled(canvasTexture(1024, 1024, (ctx, w) => {
    const s = w / 8; // 8×8 tiles of 0.8 m
    ctx.fillStyle = '#bdad97'; ctx.fillRect(0, 0, w, w);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const v = rnd() * 8 - 4;
      ctx.fillStyle = `rgb(${218 + v},${205 + v},${189 + v})`;
      ctx.fillRect(c * s + 2, r * s + 2, s - 4, s - 4);
      const sheen = ctx.createLinearGradient(c * s, r * s, c * s + s, r * s + s);
      sheen.addColorStop(0, 'rgba(255,255,255,.05)'); sheen.addColorStop(1, 'rgba(120,100,80,.035)');
      ctx.fillStyle = sheen; ctx.fillRect(c * s + 2, r * s + 2, s - 4, s - 4);
    }
    noise(ctx, w, w, 26000, .035, 2);
  }), 6.4),
  concrete: tiled(canvasTexture(512, 512, (ctx, w) => {
    ctx.fillStyle = '#6e6d6a'; ctx.fillRect(0, 0, w, w);
    for (let i = 0; i < 40; i++) {
      const g = ctx.createRadialGradient(rnd() * w, rnd() * w, 0, rnd() * w, rnd() * w, 40 + rnd() * 90);
      g.addColorStop(0, `rgba(${rnd() > .5 ? '255,255,255' : '40,40,40'},.05)`); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
    }
    noise(ctx, w, w, 18000, .08, 2);
    ctx.strokeStyle = 'rgba(55,55,55,.28)'; ctx.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath(); ctx.moveTo(i * w / 4, 0); ctx.lineTo(i * w / 4, w); ctx.moveTo(0, i * w / 4); ctx.lineTo(w, i * w / 4); ctx.stroke();
    }
  }), 6.4),
  carpet: tiled(canvasTexture(256, 256, (ctx, w) => {
    ctx.fillStyle = '#6f6d6b'; ctx.fillRect(0, 0, w, w);
    noise(ctx, w, w, 9000, .12, 1.5);
  }), 2),
  cartSign: limeSign((ctx, w, h) => drawCart(ctx, w / 2, h / 2, 120, '#fff')),
  listSign: limeSign((ctx) => drawLines(ctx, 70, 62, 120, 30, '#fff', 3)),
  headerSign: canvasTexture(256, 96, (ctx, w, h) => {
    ctx.fillStyle = '#f1f0ea'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#39443f'; ctx.fillRect(0, 0, 58, h);
    drawLines(ctx, 78, 26, 140, 22, '#9aa39b', 2);
  }),
  screen: canvasTexture(256, 192, (ctx, w, h) => {
    ctx.fillStyle = '#18231f'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9ccc38'; ctx.fillRect(16, 16, w - 32, 24);
    ctx.fillStyle = '#5f8f2a'; ctx.fillRect(16, 54, 104, 118);
    drawLines(ctx, 138, 60, 100, 26, '#cfe9a2', 4);
  }),
  laneSign: canvasTexture(128, 160, (ctx, w, h) => {
    ctx.fillStyle = '#16201c'; ctx.fillRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#8fc23a'); g.addColorStop(1, '#5d8d25');
    ctx.fillStyle = g; ctx.fillRect(14, 14, w - 28, h - 28);
    ctx.fillStyle = '#eef8d8'; ctx.fillRect(34, 44, w - 68, 12); ctx.fillRect(34, 68, w - 84, 10); ctx.fillRect(34, 90, w - 76, 10);
  }),
  notice: canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#f4f3ef'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#3a3f41'; ctx.lineWidth = 12; ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.fillStyle = '#d98f22'; ctx.fillRect(30, 30, 90, 16);
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = i % 3 ? '#9ba1a3' : '#5d6467';
      ctx.fillRect(30, 62 + i * 19, 90 + rnd() * 110, 7);
    }
  }),
  officeBoard: canvasTexture(384, 256, (ctx, w, h) => {
    ctx.fillStyle = '#2c3633'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#1b2220'; ctx.lineWidth = 12; ctx.strokeRect(6, 6, w - 12, h - 12);
    drawLines(ctx, 44, 60, 200, 34, '#9dc83a', 3);
    ctx.fillStyle = '#9dc83a'; ctx.fillRect(250, 150, 80, 50);
  }),
  cork: canvasTexture(128, 160, (ctx, w, h) => {
    ctx.fillStyle = '#c69b62'; ctx.fillRect(0, 0, w, h);
    noise(ctx, w, h, 1500, .15, 2);
    ctx.strokeStyle = '#8a6a44'; ctx.lineWidth = 8; ctx.strokeRect(4, 4, w - 8, h - 8);
    for (const [x, y, c] of [[20, 22, '#f7f5ee'], [66, 30, '#e9e2a9'], [26, 88, '#f7f5ee'], [72, 96, '#d98f22']]) {
      ctx.fillStyle = c; ctx.fillRect(x, y, 36, 44);
    }
  }),
  clock: canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#f8f8f5'; ctx.beginPath(); ctx.arc(64, 64, 60, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = ctx.fillStyle = '#2d3335'; ctx.lineWidth = 8; ctx.stroke();
    ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(64, 64); ctx.lineTo(64, 24); ctx.moveTo(64, 64); ctx.lineTo(92, 72); ctx.stroke();
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) ctx.fillRect(62 + Math.cos(a) * 48, 62 + Math.sin(a) * 48, 4, 4);
  }),
  frame: canvasTexture(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#2c3336'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#58656b'; ctx.fillRect(14, 14, w - 28, h - 28);
    ctx.fillStyle = '#a9b3a0'; ctx.fillRect(30, 40, 90, 14); ctx.fillRect(30, 64, 140, 10);
  }),
  laptop: canvasTexture(128, 96, (ctx, w, h) => {
    ctx.fillStyle = '#222b28'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e9efe6'; ctx.fillRect(8, 8, w - 16, h - 16);
    ctx.fillStyle = '#89b832'; ctx.fillRect(14, 14, 40, 30);
    drawLines(ctx, 62, 18, 50, 14, '#6b7470', 4);
  }),
};

// ---------------------------------------------------------------- materials
// Albedos match the demo's isometric art direction.
const PALETTE = {
  // [colour, roughness, metalness]
  cap: ['#e3ddd6', .82], wallCream: ['#c4b8a8', .93], wallBlue: ['#7a8d9b', .92], wallApparel: ['#8d9da6', .92],
  wallKhaki: ['#b8a97c', .92], wallDock: ['#a8a198', .93], wallOffice: ['#ddd6cc', .92], wallStorage: ['#b8b6b0', .93],
  exterior: ['#3e474c', .95], parapetIn: ['#cfc2b0', .9], storageFloor: ['#cfccc4', .8],
  wood: ['#a9794a', .62], woodLight: ['#c99a63', .58], woodDark: ['#6e4c2d', .7],
  charcoal: ['#4a4d50', .5, .12], counterTop: ['#8b9093', .4, .3], silverPanel: ['#aeb3b6', .38, .45],
  metal: ['#4b5255', .46, .45], metalLight: ['#c8cccb', .36, .55], chrome: ['#e0e4e4', .2, .9],
  black: ['#18191b', .42, .1], white: ['#f3f1ec', .62], offWhite: ['#e4e1da', .66], plinth: ['#48494a', .7, .1],
  door: ['#4d5457', .55, .2], doorBlue: ['#6d7f8b', .6, .1], rubber: ['#1b1c1d', .85],
  cardboard: ['#c9a26d', .86], pallet: ['#c8922e', .78], palletDark: ['#9c6d22', .82],
  truck: ['#d9d6d2', .42, .05], truckInside: ['#b9b4ab', .8], yellow: ['#e2a526', .6], orangeLine: ['#d98f22', .6],
  soil: ['#3f3226', 1], stem: ['#5c6b33', .8], potWhite: ['#eeebe5', .5], potWood: ['#b98d5b', .7],
  bread: ['#c98a3f', .7], cartGreen: ['#56703a', .55, .25], chair: ['#5e813a', .75],
};
const M = Object.fromEntries(Object.entries(PALETTE).map(([name, [color, roughness, metalness = 0]]) =>
  [name, new THREE.MeshStandardMaterial({ color, roughness, metalness })]));
Object.assign(M, {
  tile: new THREE.MeshStandardMaterial({ map: TEX.tile, roughness: .3, envMapIntensity: .6 }),
  concrete: new THREE.MeshStandardMaterial({ map: TEX.concrete, roughness: .88 }),
  carpet: new THREE.MeshStandardMaterial({ map: TEX.carpet, roughness: 1 }),
  plank: new THREE.MeshStandardMaterial({ map: plankTexture('#b1804d'), roughness: .62 }),
  plankLight: new THREE.MeshStandardMaterial({ map: plankTexture('#c9985e'), roughness: .6 }),
  fridgeLight: new THREE.MeshStandardMaterial({ color: '#f4e4bd', roughness: .6, emissive: '#f6dfa6', emissiveIntensity: 1.1 }),
  tailLight: new THREE.MeshStandardMaterial({ color: '#b3261e', roughness: .4, emissive: '#6a0f0a', emissiveIntensity: .6 }),
  glass: new THREE.MeshStandardMaterial({ color: '#c9dde3', roughness: .05, metalness: .15, transparent: true, opacity: .28, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.6 }),
  clearGlass: new THREE.MeshStandardMaterial({ color: '#eef4f2', roughness: .04, transparent: true, opacity: .12, depthWrite: false, envMapIntensity: .6 }),
  darkGlass: new THREE.MeshStandardMaterial({ color: '#27353a', roughness: .08, metalness: .3, transparent: true, opacity: .55, depthWrite: false, envMapIntensity: 1.4 }),
});
// Lit bottles inside the stockroom fridge.
const FRIDGE_STOCK = ['#d8a43b', '#e6c45a', '#c07a2c', '#ecd887', '#9a5424', '#e9e2cc']
  .map((color) => new THREE.MeshStandardMaterial({ color, roughness: .35, emissive: color, emissiveIntensity: .35 }));

// -------------------------------------------------------------------- plan
// Wall centre lines. Tall walls are .24 thick, partitions .22, parapets .3.
const JX = -7.45, JZ = -4.45;       // where the dock, stockroom and sales-floor walls meet
const REAR = -10.42;                // stockroom rear wall
const PICK_REAR = -9.62;            // pickup rear wall; the stockroom runs deeper
const PICK_X = -.1;                 // stockroom / pickup partition
const WING_Z = 3.9, WING_X = -8.9;  // apparel wing back and side walls
const LEFT_X = -20.05;              // far-left parapet
const FRONT_LEFT_Z = 11.45;         // front parapet left of the office
const FRONT_Z = 12.35;              // front parapet right of the office
const NOTCH_X = 10.95, NOTCH_Z = 6.35, RIGHT_X = 11.85; // right-hand parapets and their notch
const APRON_X = -23.2;              // end of the loading apron under the truck
const OFFICE = { x0: .7, x1: 5.12, z0: 12.1, z1: 15.22 }; // office floor
const STOCK_H = 2.85, PICK_H = 3.1, DOCK_H = 3.4, PARAPET_H = .5;

// Rebuilding restarts from the seed the textures above left behind, so every
// build dresses the store identically.
const BUILD_SEED = getSeed();

// Tiled, reflective floor shared by the sales floor, stockroom and pickup area
// (edges run along wall centre lines, hidden under the walls).
const SALES_FLOOR = [[JX, REAR], [PICK_X, REAR], [PICK_X, PICK_REAR], [RIGHT_X, PICK_REAR], [RIGHT_X, NOTCH_Z],
  [NOTCH_X, NOTCH_Z], [NOTCH_X, FRONT_Z], [OFFICE.x1, FRONT_Z], [OFFICE.x1, OFFICE.z0], [OFFICE.x0, OFFICE.z0],
  [OFFICE.x0, FRONT_LEFT_Z], [WING_X, FRONT_LEFT_Z], [WING_X, WING_Z], [JX, WING_Z]];
// Outer edge of the dark slab everything stands on: the outside faces of the walls.
const OUTLINE = [[JX - .12, REAR - .12], [PICK_X + .11, REAR - .12], [PICK_X + .11, PICK_REAR - .12],
  [RIGHT_X + .15, PICK_REAR - .12], [RIGHT_X + .15, NOTCH_Z + .15], [NOTCH_X + .15, NOTCH_Z + .15],
  [NOTCH_X + .15, FRONT_Z + .15], [OFFICE.x1 + .12, FRONT_Z + .15], [OFFICE.x1 + .12, OFFICE.z1 + .12],
  [OFFICE.x0 - .11, OFFICE.z1 + .12], [OFFICE.x0 - .11, FRONT_LEFT_Z + .15], [LEFT_X - .15, FRONT_LEFT_Z + .15],
  [LEFT_X - .15, WING_Z + .12], [APRON_X, WING_Z + .12], [APRON_X, JZ - .12], [JX - .12, JZ - .12]];

// Plan polygons are [x, z] pairs; shapes are drawn in XY and laid flat.
const planShape = (points) => new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));

function floor(points, material) {
  add(world, new THREE.ShapeGeometry(planShape(points)), material, 0, .004, 0, { rx: -Math.PI / 2, cast: false });
}
// Walls run along X or Z; `pos`/`neg` finish the faces toward +/- the other
// axis and `start`/`end` the two ends. At a corner one wall runs through and
// the other stops at its face: overlapping walls would leave coplanar faces
// that z-fight (flicker) as the camera moves.
function wallX(x0, x1, z, h, t, pos, neg, start = M.cap, end = start) {
  faceBox(world, (x0 + x1) / 2, h / 2, z, x1 - x0, h, t, { px: end, nx: start, py: M.cap, ny: M.cap, pz: pos, nz: neg });
  box(world, (x0 + x1) / 2, h + .03, z, x1 - x0 + .02, .06, t + .07, M.cap);
}
function wallZ(z0, z1, x, h, t, pos, neg, start = M.cap, end = start) {
  faceBox(world, x, h / 2, (z0 + z1) / 2, t, h, z1 - z0, { px: pos, nx: neg, py: M.cap, ny: M.cap, pz: end, nz: start });
  box(world, x, h + .03, (z0 + z1) / 2, t + .07, .06, z1 - z0 + .02, M.cap);
}

function buildShell() {
  const slab = new THREE.ExtrudeGeometry(planShape(OUTLINE), { depth: .9, bevelEnabled: false });
  slab.rotateX(-Math.PI / 2);
  add(world, slab, M.exterior, 0, -.9, 0, { cast: false });

  floor(SALES_FLOOR, M.tile);
  floor([[APRON_X, JZ], [JX, JZ], [JX, WING_Z], [APRON_X, WING_Z]], M.concrete);
  floor([[LEFT_X, WING_Z], [WING_X, WING_Z], [WING_X, FRONT_LEFT_Z], [LEFT_X, FRONT_LEFT_Z]], M.storageFloor);
  floor([[OFFICE.x0, OFFICE.z0], [OFFICE.x1, OFFICE.z0], [OFFICE.x1, OFFICE.z1], [OFFICE.x0, OFFICE.z1]], M.carpet);

  // Rear walls: blue-grey in the stockroom, khaki behind the pickup area.
  wallX(JX - .12, PICK_X + .11, REAR, STOCK_H, .24, M.wallBlue, M.exterior, M.exterior);
  wallX(PICK_X + .11, RIGHT_X + .15, PICK_REAR, PICK_H, .24, M.wallKhaki, M.exterior, M.exterior);
  wallZ(REAR + .12, JZ + .12, JX, STOCK_H, .24, M.wallBlue, M.exterior);
  // Dock back wall, split around the roller-door opening.
  wallX(LEFT_X - .15, -13.55, JZ, DOCK_H, .24, M.wallDock, M.exterior, M.wallDock);
  wallX(-11.25, JX - .12, JZ, DOCK_H, .24, M.wallDock, M.exterior, M.wallDock);
  faceBox(world, -12.4, (DOCK_H + 2.8) / 2, JZ, 2.3, DOCK_H - 2.8, .24,
    { px: M.wallDock, nx: M.wallDock, py: M.cap, ny: M.wallDock, pz: M.wallDock, nz: M.exterior });
  box(world, -12.4, DOCK_H + .03, JZ, 2.32, .06, .31, M.cap);
  // Interior partitions.
  wallX(JX - .12, PICK_X + .11, JZ, 2.2, .22, M.wallCream, M.wallBlue);
  wallZ(REAR + .12, JZ - .11, PICK_X, 2.2, .22, M.wallCream, M.wallBlue);
  wallZ(JZ + .11, WING_Z - .12, JX, 1.75, .22, M.wallCream, M.wallDock);
  wallX(LEFT_X - .15, -6.3, WING_Z, 3, .24, M.wallApparel, M.wallDock, M.wallCream);
  wallZ(WING_Z + .12, FRONT_LEFT_Z, WING_X, 3, .24, M.wallApparel, M.wallStorage, M.wallCream);
  // Low cut-away parapets along the front of the building.
  wallX(LEFT_X - .15, OFFICE.x0 - .05, FRONT_LEFT_Z, PARAPET_H, .3, M.exterior, M.parapetIn, M.exterior);
  wallZ(WING_Z + .12, FRONT_LEFT_Z - .15, LEFT_X, PARAPET_H, .3, M.parapetIn, M.exterior);
  wallX(OFFICE.x1 + .12, NOTCH_X + .15, FRONT_Z, PARAPET_H, .3, M.exterior, M.parapetIn, M.exterior);
  wallZ(NOTCH_Z + .15, FRONT_Z - .15, NOTCH_X, PARAPET_H, .3, M.exterior, M.parapetIn);
  wallX(NOTCH_X - .15, RIGHT_X + .15, NOTCH_Z, PARAPET_H, .3, M.exterior, M.parapetIn, M.parapetIn, M.exterior);
  wallZ(PICK_REAR + .12, NOTCH_Z - .15, RIGHT_X, PARAPET_H, .3, M.exterior, M.parapetIn);
}

// ------------------------------------------------------------ shared props
const CARTON = ['#c9a06a', '#d1ab76', '#bf955e', '#c6a473', '#d6b27e'];

function pallet(x, z, w = 1.15, d = 1, y0 = 0) {
  box(world, x, y0 + .128, z, w, .035, d, M.pallet);
  for (const k of [-1, 0, 1]) box(world, x, y0 + .06, z + k * (d / 2 - .07), w, .09, .12, M.palletDark);
}
// A cols × rows × levels stack of taped cartons, some with shipping labels.
function cartons(x, z, cols, rows, levels, bw, bd, bh, y0 = .146) {
  for (let l = 0; l < levels; l++) for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    const cx = x - (cols - 1) * bw / 2 + c * bw, cz = z - (rows - 1) * bd / 2 + r * bd, cy = y0 + bh / 2 + l * bh;
    inst('box', pick(CARTON), cx, cy, cz, bw - .025, bh - .012, bd - .025, { finish: 'matte' });
    if (l === levels - 1) inst('box', '#e6d2a9', cx, cy + bh / 2 - .004, cz, .07, .012, bd - .02, { finish: 'matte' });
    if (r === rows - 1 && rnd() > .45) inst('box', '#f5f2ea', cx - bw * .12, cy, cz + bd / 2 - .005, bw * .38, bh * .3, .012, { finish: 'matte' });
  }
}
// Open steel shelving; every deck but the top is filled with boxes.
function metalShelf(x0, x1, z0, z1, h, levels, frame = M.metal, deck = M.metalLight) {
  const xc = (x0 + x1) / 2, zc = (z0 + z1) / 2, d = z1 - z0;
  for (const x of [x0 + .03, x1 - .03]) for (const z of [z0 + .03, z1 - .03]) box(world, x, h / 2, z, .05, h, .05, frame);
  for (let l = 0; l < levels; l++) {
    const y = .12 + l * (h - .14) / (levels - 1);
    box(world, xc, y, zc, x1 - x0, .03, d, deck);
    if (l === levels - 1) break;
    for (let x = x0 + .08, bw = range(.32, .5); x + bw <= x1 - .05; x += bw, bw = range(.32, .5)) {
      const bh = range(.22, .38);
      inst('box', pick([...CARTON, '#e8e4da', '#dcd6ca']), x + bw / 2, y + .015 + bh / 2, zc + range(-.05, .05), bw - .03, bh, d - .12, { finish: 'matte' });
    }
  }
}
// House plant: tapered pot and a fan of tilted leaves.
const LEAVES = ['#4e7f2c', '#5d8f33', '#3f6c26', '#6b9c3a', '#46752a'];
function plant(x, z, s, pot = M.potWhite) {
  cyl(world, x, .22 * s, z, .2 * s, .15 * s, .44 * s, pot, 22);
  cyl(world, x, .44 * s, z, .185 * s, .185 * s, .02 * s, M.soil, 18, { cast: false });
  box(world, x, .75 * s, z, .03 * s, .62 * s, .03 * s, M.stem);
  for (let i = 0; i < 18; i++) {
    const a = i * 2.39996 + rnd() * .4, tilt = .35 + rnd() * .85, len = (.36 + rnd() * .26) * s;
    const reach = Math.cos(tilt) * len / 2, y0 = (.5 + i / 30) * s;
    inst('leaf', pick(LEAVES), x + Math.sin(a) * reach, y0 + Math.sin(tilt) * len / 2, z + Math.cos(a) * reach,
      .085 * s, .014 * s, len / 2, { ry: a, rx: -tilt });
  }
}

// ------------------------------------------------------------ loading dock
function buildDock() {
  // Safety lines.
  box(world, -10, .011, -.27, .08, .006, 8.2, M.orangeLine, { cast: false });
  box(world, -13.2, .011, 3.55, 5.8, .006, .08, M.orangeLine, { cast: false });

  pallet(-11.6, -1.2); cartons(-11.6, -1.2, 2, 2, 3, .52, .46, .42);
  pallet(-10.55, .95, 1, .95); cartons(-10.55, .95, 2, 2, 2, .46, .44, .4);
  pallet(-12.35, -4.1, 1.1, .95); cartons(-12.35, -4.1, 2, 2, 2, .5, .44, .42);
  for (let i = 0; i < 2; i++) for (let l = 0; l < 3; l++) {
    inst('box', l % 2 ? '#4a74a0' : '#5783ae', -13.8 + i * .58, .19 + l * .36, 3.45, .54, .34, .6);
  }

  // Roller door: dark bay beyond, striped housing and side guides.
  box(world, -12.4, 1.4, -4.98, 2.3, 2.8, .05, M.charcoal, { cast: false });
  box(world, -12.4, .01, -4.75, 2.3, .01, .5, M.concrete, { cast: false });
  for (const x of [-13.5, -11.3]) box(world, x, 1.42, JZ + .16, .13, 2.84, .12, M.door);
  box(world, -12.4, 2.88, JZ + .2, 2.46, .22, .22, M.yellow);
  for (let i = 0; i < 9; i++) box(world, -13.45 + i * .26, 2.88, JZ + .315, .1, .2, .01, M.charcoal, { cast: false, rz: .7 });
  box(world, -12.4, 2.73, JZ + .16, 2.2, .07, .08, M.charcoal);

  // Notice board, sensor, service door and stacked totes on the back wall.
  panel(world, -10.35, 1.78, JZ + .125, .78, .82, TEX.notice);
  rbox(world, -10.2, 2.52, JZ + .17, .16, .12, .09, M.charcoal, .02);
  box(world, -9.25, 1.08, JZ + .13, 1.02, 2.16, .04, M.metal);
  box(world, -9.25, 1.06, JZ + .15, .9, 2.08, .04, M.door);
  panel(world, -9.08, 1.5, JZ + .172, .32, .42, TEX.notice);
  box(world, -9.62, 1.02, JZ + .19, .03, .2, .05, M.chrome);
  rbox(world, -10.35, .21, JZ + .42, .62, .4, .46, M.charcoal, .03);
  rbox(world, -10.35, .6, JZ + .42, .6, .36, .44, M.plinth, .03);
  rbox(world, -9.75, .18, JZ + .38, .42, .34, .38, M.charcoal, .03);
}

// Box truck backed into the bay, rear doors open.
function buildTruck() {
  const x0 = -20.4, x1 = -13.62, z0 = -3.56, z1 = -1.06, xc = (x0 + x1) / 2, zc = (z0 + z1) / 2, L = x1 - x0;
  const bed = 1.08, top = 3.66, H = top - bed, W = z1 - z0;
  // Cargo box: walls, roof and a lighter interior lining.
  rbox(world, xc, bed + H / 2, z1 - .04, L, H, .08, M.truck, .03);
  rbox(world, xc, bed + H / 2, z0 + .04, L, H, .08, M.truck, .03);
  rbox(world, xc, top - .04, zc, L, .08, W, M.truck, .03);
  box(world, x0 + .04, bed + H / 2, zc, .08, H, W, M.truck);
  box(world, xc, bed + .03, zc, L, .06, W - .1, M.truckInside);
  for (const z of [z1 - .09, z0 + .09]) box(world, xc, bed + H / 2, z, L - .1, H - .1, .02, M.truckInside, { cast: false });
  box(world, xc, top - .1, zc, L - .1, .02, W - .1, M.truckInside, { cast: false });
  // Rear frame, bumper and tail lights.
  for (const z of [z0 + .05, z1 - .05]) box(world, x1 + .02, bed + H / 2, z, .12, H + .02, .12, M.metalLight);
  box(world, x1 + .02, top - .07, zc, .14, .16, W, M.metalLight);
  box(world, x1 + .02, bed - .02, zc, .16, .1, W, M.metal);
  box(world, x1 + .12, .6, zc, .12, .14, W - .2, M.charcoal);
  for (const z of [z0 + .18, z1 - .18]) box(world, x1 + .1, .82, z, .05, .12, .2, M.tailLight);
  // Doors swing about the rear corners: the near one folds flat against the side.
  const doorW = W / 2 - .02;
  for (const [hingeZ, side, angle] of [[z1, 1, Math.PI * 1.5], [z0, -1, 2.55]]) {
    rbox(world, x1 + .02 + Math.sin(angle) * doorW / 2, bed + H / 2, hingeZ - side * Math.cos(angle) * doorW / 2 + side * .06,
      .05, H - .06, doorW, M.truck, .02, { ry: side * (Math.PI / 2 - angle) + Math.PI / 2 });
  }
  // Chassis, wheels and cab.
  box(world, xc + .3, .78, zc, L - .6, .3, 1.7, M.charcoal);
  for (const x of [-15.2, -16.4, -21.9]) for (const z of [z0 + .12, z1 - .12]) {
    cyl(world, x, .48, z, .48, .48, .34, M.rubber, 26, { rx: Math.PI / 2 });
    cyl(world, x, .48, z + Math.sign(z - zc) * .18, .26, .26, .02, M.metalLight, 20, { rx: Math.PI / 2, cast: false });
  }
  for (const x of [-15.8, -21.9]) box(world, x, 1.03, z1 - .06, 1.5, .1, .12, M.charcoal);
  rbox(world, -21.7, 1.7, zc, 2.5, 2.3, W - .1, M.truck, .22);
  box(world, -21.2, 2.35, z1 - .06, 1.3, .75, .04, M.darkGlass, { cast: false });
  box(world, -22.96, 2.2, zc, .04, .9, 2.1, M.darkGlass, { cast: false });
  box(world, -22.98, 1, zc, .04, .5, 1.9, M.charcoal);
  // Cargo.
  pallet(-14.4, -1.75, 1, 1, bed); cartons(-14.4, -1.75, 2, 2, 2, .47, .46, .42, bed + .146);
  pallet(-14.4, -2.85, 1, 1, bed); cartons(-14.4, -2.85, 2, 2, 3, .47, .46, .4, bed + .146);
  cartons(-15.6, -2.3, 2, 3, 3, .5, .7, .44, bed + .03);
}

// --------------------------------------------------------------- stockroom
function buildStockroom() {
  // Three-door merchandiser against the side wall, lit from inside.
  const x = -6.93, z0 = -8.55, z1 = -5.75, zc = (z0 + z1) / 2, d = z1 - z0, D = .78, front = x + D / 2;
  box(world, x - D / 2 + .03, 1.06, zc, .06, 2.12, d, M.metal);
  box(world, x, 2.07, zc, D, .1, d, M.metal);
  box(world, x, .09, zc, D, .18, d, M.charcoal);
  for (const z of [z0 + .03, z1 - .03]) box(world, x, 1.06, z, D, 2.12, .06, M.metal);
  rbox(world, x + .04, 2.26, zc, D + .06, .28, d + .06, M.charcoal, .02);
  for (let i = 0; i < 3; i++) {
    const cz = z0 + (i + .5) * d / 3, dw = d / 3 - .06;
    box(world, x - D / 2 + .07, 1.1, cz, .02, 1.8, dw, M.fridgeLight, { cast: false });
    for (let s = 0; s < 5; s++) {
      const y = .3 + s * .36;
      box(world, x, y, cz, D - .12, .02, dw, M.metalLight, { cast: false });
      for (let k = 0; k < 6; k++) for (const dx of [.12, -.08]) {
        cyl(world, x + dx, y + .12, cz - dw / 2 + .08 + k * (dw - .16) / 5, .045, .045, .22, pick(FRIDGE_STOCK), 10, { cast: false });
      }
    }
    if (i > 0) box(world, front - .02, 1.12, z0 + i * d / 3, .06, 1.98, .06, M.charcoal);
    box(world, front, 1.12, cz, .03, 1.94, dw, M.clearGlass, { cast: false });
    box(world, front + .03, 1.2, cz + dw / 2 - .1, .03, .7, .04, M.chrome);
  }
  for (const y of [2.08, .16]) box(world, front - .02, y, zc, .06, .08, d, M.charcoal);

  metalShelf(-6.7, -5.2, -10.28, -9.62, 1.85, 4);
  rbox(world, -5.95, 2.06, -9.95, .78, .38, .52, M.white, .03);
  metalShelf(-4.6, -3.1, -10.28, -9.4, 2.2, 5, M.charcoal, M.chrome);

  // Wire stock trolley.
  const tx = -4.45, tz = -7.8;
  for (const y of [.32, .98]) box(world, tx, y, tz, 1.05, .03, .62, M.chrome);
  for (const dx of [-.5, .5]) for (const dz of [-.29, .29]) {
    box(world, tx + dx, .72, tz + dz, .03, 1.2, .03, M.chrome);
    cyl(world, tx + dx, .07, tz + dz, .07, .07, .06, M.rubber, 10, { rx: Math.PI / 2 });
  }
  box(world, tx - .5, 1.34, tz, .03, .03, .62, M.chrome);
  for (let i = 0; i < 6; i++) {
    inst('box', pick(['#c79b61', '#e3c37e', '#8a5a33', '#d7cfbf', '#5e7fa0']), tx - .35 + (i % 3) * .34, 1.12, tz - .14 + Math.floor(i / 3) * .28, .3, range(.18, .3), .24, { finish: 'matte' });
  }
  for (let i = 0; i < 4; i++) inst('box', pick(CARTON), tx - .3 + i * .22, .46, tz, .2, .24, .5, { finish: 'matte' });

  // Rear service door and wall clock.
  box(world, -2.3, 1.1, REAR + .14, 1.06, 2.2, .06, M.metal);
  box(world, -2.3, 1.08, REAR + .17, .92, 2.1, .04, M.door);
  box(world, -2.15, 1.55, REAR + .2, .36, .5, .01, M.darkGlass, { cast: false });
  box(world, -2.63, 1.05, REAR + .21, .03, .22, .05, M.chrome);
  cyl(world, -1, 2.1, REAR + .15, .2, .2, .05, M.charcoal, 28, { rx: Math.PI / 2 });
  panel(world, -1, 2.1, REAR + .18, .34, .34, TEX.clock);
}

// ----------------------------------------------------- pickup & service
// Order-pickup shelving stocked with folded paper bags.
function bagShelf(x0, x1, zBack, h) {
  const d = .66, zc = zBack + d / 2, xc = (x0 + x1) / 2, w = x1 - x0;
  for (const x of [x0 + .04, x1 - .04]) rbox(world, x, h / 2, zc, .08, h, d, M.plank, .015);
  box(world, xc, h / 2, zBack + .02, w, h, .03, M.woodDark);
  for (let l = 0; l < 3; l++) {
    const y = .12 + l * (h - .1) / 3;
    rbox(world, xc, y, zc, w - .06, .05, d, M.woodLight, .01);
    for (let x = x0 + .14; x < x1 - .28;) {
      const bw = range(.24, .32), bh = range(.3, .42), bx = x + bw / 2, base = y + .025;
      inst('box', pick(['#c1935c', '#b9884f', '#caa06a', '#b48551']), bx, base + bh / 2, zc + .03, bw - .03, bh, .2, { ry: range(-.12, .12), finish: 'matte' });
      inst('box', '#9f7443', bx, base + bh + .02, zc + .03, bw * .6, .04, .16, { finish: 'matte' });
      if (rnd() > .35) inst('box', '#f7f4ec', bx, base + bh * .45, zc + .135, bw * .5, bh * .32, .01, { finish: 'matte' });
      x += bw + .04;
    }
  }
  rbox(world, xc, h + .03, zc, w + .04, .06, d + .04, M.woodLight, .015);
  box(world, xc, .04, zc, w - .1, .08, d - .1, M.plinth);
}

function buildPickup() {
  // Service counter against the partition, with two wall monitors above it.
  const x = PICK_X + .54, z0 = -6.6, z1 = -4.62, zc = (z0 + z1) / 2, d = z1 - z0;
  rbox(world, x, .47, zc, .8, .94, d, M.plank, .03);
  rbox(world, x + .02, .97, zc, .9, .06, d + .08, M.woodLight, .02);
  for (let i = 1; i < 3; i++) box(world, x + .405, .47, z0 + i * d / 3, .012, .82, .02, M.woodDark, { cast: false });
  box(world, x + .03, .05, zc, .76, .1, d - .06, M.plinth);
  rbox(world, x - .05, 1.12, z1 - .28, .3, .24, .3, M.black, .03);
  box(world, x + .08, 1.28, z1 - .3, .03, .22, .26, M.black);
  rbox(world, x, 1.06, zc - .15, .34, .14, .36, M.offWhite, .03);
  rbox(world, x + .05, 1.13, zc - .75, .42, .26, .4, M.cardboard, .01);
  rbox(world, x + .08, 1.03, z1 - .72, .22, .06, .26, M.charcoal, .01);
  for (const z of [-5.25, -6]) {
    rbox(world, PICK_X + .16, 1.62, z, .05, .5, .72, M.black, .02);
    panel(world, PICK_X + .19, 1.62, z, .66, .44, TEX.screen, { ry: Math.PI / 2, glow: .5 });
  }
  // Glazed door into the stockroom.
  box(world, PICK_X + .13, 1.12, -7.8, .05, 2.24, 1.06, M.metalLight);
  box(world, PICK_X + .16, 1.1, -7.8, .02, 2.1, .9, M.glass, { cast: false });
  panel(world, PICK_X + .18, 1.35, -7.62, .26, .34, TEX.notice, { ry: Math.PI / 2 });

  bagShelf(1.75, 4.7, PICK_REAR + .13, 1.62);
  bagShelf(5.15, 6.95, -8.35, 1.42);
  plant(1.05, -9.05, 1.25);
  plant(1, -8, .82, M.potWood);
  plant(7.45, -8, 1.3);

  // Cart corral with a row of nested carts.
  const cx0 = 8.1, cx1 = 11.2, cz0 = -6.9, cz1 = -5.85, czc = (cz0 + cz1) / 2;
  for (const z of [cz0, cz1]) {
    box(world, (cx0 + cx1) / 2, 1.1, z, cx1 - cx0, .045, .045, M.metal);
    box(world, (cx0 + cx1) / 2, .55, z, cx1 - cx0, .035, .035, M.metal);
    for (let i = 0; i <= 4; i++) box(world, cx0 + i * (cx1 - cx0) / 4, .55, z, .045, 1.1, .045, M.metal);
  }
  for (const xx of [cx0, cx1]) box(world, xx, 1.1, czc, .045, .045, cz1 - cz0, M.metal);
  for (let i = 0; i < 6; i++) {
    const xx = cx0 + .45 + i * .42;
    box(world, xx, .68, czc, .62, .025, .66, M.cartGreen);
    box(world, xx - .31, .83, czc, .02, .3, .66, M.cartGreen);
    for (const dz of [-.33, .33]) box(world, xx, .83, czc + dz, .62, .3, .02, M.cartGreen, { cast: false });
    box(world, xx + .33, 1.04, czc, .03, .03, .6, M.chrome);
    box(world, xx, .38, czc, .5, .02, .5, M.cartGreen, { cast: false });
    for (const dz of [-.28, .28]) cyl(world, xx, .06, czc + dz, .05, .05, .05, M.rubber, 8, { rx: Math.PI / 2 });
  }
}

// ---------------------------------------------------------------- aisles
const PRODUCT = ['#c99338', '#b9762f', '#d4a54a', '#8c5b33', '#a9492f', '#7f8a3a', '#9aa368', '#4d6b3a',
  '#e3d3ae', '#e8e2d4', '#4c6d8f', '#c9772e', '#b98a4e', '#6f8f3a', '#d9c69a', '#a3683a'];
// Dark labels on the palest packs, cream on the rest (luma of the linear colour).
const labelFor = (hex) => {
  const c = new THREE.Color(hex);
  return c.r * .3 + c.g * .59 + c.b * .11 > .45 ? '#7a5a36' : '#e9dfc6';
};

// Fills one shelf with runs of identical packs (and cans on low shelves).
// Along 'z' the packs face ±X from `edge`; along 'x' they face +Z.
function stockShelf(axis, edge, side, y, from, to, depth, cans = false) {
  const place = (along, across, w, h, d) => axis === 'z'
    ? [edge + side * across, y + h / 2, along, d, h, w]
    : [along, y + h / 2, edge + across, w, h, d];
  for (let p = from + .03; p < to - .12; p += .025) {
    const color = pick(PRODUCT), round = cans && rnd() > .45, labelled = !round && rnd() > .35;
    const w = round ? range(.12, .15) : range(.16, .27), h = round ? range(.16, .22) : range(.2, .31);
    for (let n = 2 + Math.floor(rnd() * 4); n > 0 && p + w < to - .02; n--, p += w) {
      const c = p + w / 2;
      if (round) {
        for (const off of [.25, .75]) {
          const [px, py, pz] = place(c, depth * off, w, h, 0);
          inst('cyl', color, px, py, pz, w - .012, h, w - .012, { finish: 'gloss' });
        }
      } else {
        const [px, py, pz, sx, sy, sz] = place(c, depth / 2, w - .016, h, depth);
        inst('box', color, px, py, pz, sx, sy, sz);
      }
      if (labelled) {
        const [lx, , lz, sx, , sz] = place(c, depth + .004, (w - .016) * .7, h, .006);
        inst('box', labelFor(color), lx, y + h * .55, lz, sx, h * .3, sz);
      }
    }
  }
}

// Double-sided gondola along Z with an end cap facing the front of the store.
function gondola(cx, zBack, zFront, signs) {
  const L = zFront - zBack, zc = (zBack + zFront) / 2, W = 1.14, H = 1.9;
  box(world, cx, .07, zc, W - .04, .14, L, M.metal);
  box(world, cx, H / 2, zc, .09, H, L - .02, M.plinth);
  const bays = Math.round(L / 1.25);
  for (let b = 0; b <= bays; b++) box(world, cx, H / 2 + .02, zBack + b * L / bays, .16, H + .04, .06, M.metal);
  for (let l = 0; l < 5; l++) {
    const y = .15 + l * .36;
    for (const side of [-1, 1]) {
      box(world, cx + side * .3, y, zc, .5, .03, L - .06, M.metal);
      box(world, cx + side * .56, y + .02, zc, .014, .06, L - .08, M.white, { cast: false });
      stockShelf('z', cx + side * .07, side, y + .015, zBack, zFront, .44, l < 2);
    }
  }
  rbox(world, cx, H + .03, zc, .2, .06, L + .02, M.metal, .02);

  const ez = zFront + .02;
  box(world, cx, H / 2, ez, W + .04, H, .05, M.metal);
  for (let l = 0; l < 3; l++) {
    const y = .15 + l * .38;
    box(world, cx, y, ez + .19, W, .03, .34, M.metalLight);
    stockShelf('x', ez + .03, 1, y + .015, cx - W / 2, cx + W / 2, .3);
  }
  signs.forEach((texture, i) => {
    const w = (W + .06) / signs.length, x = cx - (W + .06) / 2 + (i + .5) * w;
    rbox(world, x, 1.6, ez + .06, w, .64, .06, M.metal, .02);
    panel(world, x, 1.6, ez + .095, w - .06, .58, texture);
  });
  // Aisle marker over the rear end.
  box(world, cx, H + .38, zBack + .2, .05, .5, .05, M.metal);
  rbox(world, cx, H + .56, zBack + .2, .8, .26, .05, M.white, .02);
  panel(world, cx, H + .56, zBack + .228, .76, .24, TEX.headerSign);
}

// ------------------------------------------------------------------ produce
const FRUIT = {
  orange: { colors: ['#ee8a20', '#e77d1a', '#f39a2c'], r: .085 },
  lemon: { colors: ['#f1cf36', '#e8c22b', '#f4da4e'], r: .072, scale: [1.15, .9, 1] },
  greenApple: { colors: ['#a2c243', '#8fb336', '#b3cc55'], r: .08 },
  tomato: { colors: ['#d6402b', '#c2352a', '#e0522f'], r: .075 },
  pear: { colors: ['#cdc23e', '#bdb836', '#d8cf55'], r: .08, scale: [1, 1.2, 1] },
  lime: { colors: ['#7aab35', '#62992c'], r: .062 },
  peach: { colors: ['#ef9f58', '#e48b4a', '#f3b46a'], r: .08 },
  potato: { colors: ['#c79d63', '#b88e55', '#d6ad72'], r: .085, scale: [1.25, .8, 1] },
  plum: { colors: ['#5a2b4b', '#4a2341', '#6c3658'], r: .07 },
  root: { colors: ['#6e4b2e', '#5d3f27', '#7e5634'], r: .09 },
  lettuce: { colors: ['#7cb23f', '#5f9a33', '#8fc550'], r: .15, shape: 'clump' },
  broccoli: { colors: ['#3f7a2e', '#4e8b37', '#5a9a3d'], r: .11, shape: 'clump' },
  banana: { colors: ['#efd44a', '#e6c93d', '#f3dd62'] },
};

// Heaps fruit into a w × d bin whose floor is at height y.
function fillBin(type, cx, cz, w, d, y) {
  const { colors, r, scale = [1, 1, 1], shape } = FRUIT[type];
  if (type === 'banana') { // hands of four curved fingers
    for (let i = 0; i < 7; i++) {
      const bx = cx + range(-w / 2 + .12, w / 2 - .12), bz = cz + range(-d / 2 + .12, d / 2 - .12), a = rnd() * Math.PI;
      for (let k = 0; k < 4; k++) {
        inst('fruit', pick(colors), bx - Math.sin(a) * k * .04, y + .06 + (i % 2) * .05, bz + Math.cos(a) * k * .04, .2, .045, .05, { ry: a, rz: .25, finish: 'gloss' });
      }
    }
    return;
  }
  const nx = Math.max(1, Math.round((w - .04) / (r * 2.1))), nz = Math.max(1, Math.round((d - .04) / (r * 2.1)));
  for (let layer = 0; layer < 2; layer++) {
    const cols = nx - layer, rows = nz - layer;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const u = cols > 1 ? i / (cols - 1) - .5 : 0, v = rows > 1 ? j / (rows - 1) - .5 : 0;
      const mound = Math.max(0, (1 - (u * u + v * v) * 2) * r * .9), rr = r * range(.9, 1.08);
      inst(shape || 'fruit', pick(colors),
        cx + u * (w - r * (2.2 + layer * 2)) + range(-.012, .012),
        y + rr * scale[1] + layer * r * 1.25 + mound,
        cz + v * (d - r * (2.2 + layer * 2)) + range(-.012, .012),
        rr * scale[0], rr * scale[1], rr * scale[2], { ry: rnd() * 6.28, finish: shape ? 'satin' : 'gloss' });
    }
  }
}

// Wooden produce table with a grid of bins (row-major `fills`) and price cards.
function produceTable(cx, cz, cols, rows, cw, cd, fills, legs = false) {
  const W = cols * cw + .14, D = rows * cd + .14, top = legs ? .84 : .74;
  if (legs) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      box(world, cx + sx * (W / 2 - .06), (top - .2) / 2, cz + sz * (D / 2 - .06), .08, top - .2, .08, M.woodDark);
    }
    rbox(world, cx, top - .1, cz, W, .24, D, M.plank, .02);
  } else {
    box(world, cx, .09, cz, W - .12, .18, D - .12, M.plinth);
    rbox(world, cx, .18 + (top - .18) / 2, cz, W, top - .18, D, M.plank, .02);
  }
  box(world, cx, top - .005, cz, W - .08, .02, D - .08, M.woodDark, { cast: false });
  for (const s of [-1, 1]) {
    rbox(world, cx, top + .09, cz + s * (D / 2 - .03), W, .2, .06, M.woodLight, .012);
    rbox(world, cx + s * (W / 2 - .03), top + .09, cz, .06, .2, D, M.woodLight, .012);
  }
  for (let c = 1; c < cols; c++) box(world, cx - W / 2 + .07 + c * cw, top + .07, cz, .035, .15, D - .08, M.woodLight);
  for (let r = 1; r < rows; r++) box(world, cx, top + .07, cz - D / 2 + .07 + r * cd, W - .08, .15, .035, M.woodLight);
  fills.forEach((type, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    fillBin(type, cx - W / 2 + .07 + (c + .5) * cw, cz - D / 2 + .07 + (r + .5) * cd, cw - .05, cd - .05, top);
  });
  for (let c = 0; c < cols; c++) {
    const x = cx - W / 2 + .07 + (c + .6) * cw, z = cz - D / 2 + .03;
    box(world, x, top + .3, z, .015, .22, .015, M.black);
    box(world, x, top + .42, z, .15, .11, .012, M.black);
    box(world, x, top + .42, z + .008, .1, .03, .004, M.white, { cast: false });
  }
}

function buildSalesFloor() {
  gondola(-6.6, -3.35, 2.25, [TEX.cartSign]);
  gondola(-3.3, -3, 1.15, [TEX.cartSign, TEX.listSign]);
  gondola(-.32, -2.95, .72, [TEX.headerSign]);
  plant(-6.3, -3.8, 1.05, M.potWood);

  produceTable(5.95, 3.9, 4, 3, .84, .72, ['greenApple', 'pear', 'lettuce', 'lettuce', 'potato', 'peach',
    'broccoli', 'banana', 'lemon', 'tomato', 'broccoli', 'root']);
  produceTable(4.8, 6.45, 2, 2, .66, .62, ['orange', 'orange', 'orange', 'orange'], true);
  produceTable(5.85, 9.25, 3, 2, .8, .98, ['banana', 'plum', 'lime', 'tomato', 'orange', 'greenApple']);
  // Crate of greens at the head of the third aisle.
  rbox(world, -.45, .3, 1.5, .92, .6, .72, M.plankLight, .02);
  fillBin('lettuce', -.45, 1.5, .82, .62, .6);
  fillBin('broccoli', -.33, 1.45, .5, .4, .72);

  // Glass merchandiser with stacked shopping baskets.
  const x = 8.55, z = 7.7;
  rbox(world, x, .24, z, 1.18, .48, .96, M.offWhite, .03);
  box(world, x, .5, z, 1.14, .04, .92, M.woodLight);
  for (let i = 0; i < 2; i++) for (let l = 0; l < 3; l++) box(world, x - .26 + i * .52, .58 + l * .12, z, .46, .1, .8, M.black);
  box(world, x, .82, z, 1.12, .64, .9, M.clearGlass, { cast: false });
  box(world, x, 1.14, z, 1.14, .02, .92, M.clearGlass, { cast: false });
  for (const dx of [-.56, .56]) for (const dz of [-.45, .45]) box(world, x + dx, .82, z + dz, .025, .64, .025, M.chrome);
}

// ------------------------------------------------------------- checkouts
// Self-checkout: dark counter with scanner, scale and card reader, an optional
// raised silver bagging cabinet, customer screen(s) and lane-sign pole(s).
function checkout(x, z, w, d, { silver = .36, twin = false, bare = false } = {}) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  world.add(g);
  const H = 1, dark = w * (1 - silver), darkX = -w / 2 + dark / 2, silverX = w / 2 - (w - dark) / 2;
  box(g, 0, .05, 0, w - .08, .1, d - .08, M.black);
  rbox(g, darkX, .03 + H / 2, 0, dark, H - .06, d, M.charcoal, .035);
  rbox(g, darkX, H + .02, 0, dark + .04, .05, d + .04, M.counterTop, .02);
  rbox(g, darkX + .05, H + .06, .06, dark - .3, .03, d - .36, M.charcoal, .01);
  box(g, -w / 2 + dark * .55, H + .076, .06, dark * .34, .004, d * .36, M.darkGlass, { cast: false });
  box(g, darkX, .55, d / 2 + .004, dark - .16, .012, .01, M.black, { cast: false });
  for (let i = 1; i < 3; i++) box(g, -w / 2 + i * dark / 3, .53, d / 2 + .004, .012, .8, .01, M.black, { cast: false });
  rbox(g, -w / 2 + .2, H + .09, d / 2 - .22, .16, .06, .22, M.black, .012);
  rbox(g, -w / 2 + dark * .6, H + .1, .05, .32, .07, .3, M.silverPanel, .01);
  rbox(g, -w / 2 + dark * .58, H + .21, .05, .24, .15, .19, M.cardboard, .02);
  rbox(g, -w / 2 + dark * .67, H + .19, .15, .15, .1, .13, M.bread, .03);
  if (silver > 0) {
    rbox(g, silverX, .08 + H / 2, 0, w - dark, H + .04, d, M.silverPanel, .035);
    rbox(g, silverX, H + .12, 0, w - dark + .03, .04, d + .03, M.counterTop, .015);
    rbox(g, silverX, H + .22, 0, .32, .16, .3, M.offWhite, .02);
  }
  if (bare) return;
  for (const sx of twin ? [-w * .2, w * .18] : [0]) {
    rbox(g, sx, H + .12, -d / 2 + .24, .24, .08, .2, M.black, .02);
    box(g, sx, H + .34, -d / 2 + .22, .06, .44, .06, M.black);
    rbox(g, sx, H + .62, -d / 2 + .26, .62, .46, .06, M.black, .025, { rx: -.2 });
    panel(g, sx, H + .62, -d / 2 + .294, .54, .38, TEX.screen, { rx: -.2, glow: .6 });
  }
  for (const px of twin ? [-w / 2 + .08, w / 2 - .08] : [-w / 2 + .08]) {
    cyl(g, px, 1.2, -d / 2 + .08, .028, .028, 2.4, M.metal, 10);
    rbox(g, px, 2.36, -d / 2 + .08, .4, .52, .07, M.black, .02);
    panel(g, px, 2.36, -d / 2 + .117, .33, .44, TEX.laneSign, { glow: .5 });
  }
}

function buildCheckouts() {
  checkout(9.65, .92, 1.9, 1.1);
  checkout(10.45, -2.1, 1.85, 1.1);
  checkout(5.15, -.78, 1.9, 1.08, { silver: 0, twin: true });
  checkout(6.75, .5, 1.2, 1, { silver: .5, bare: true });
  // Double lane: long back counter, bagging unit in front and a carrier-bag stand.
  checkout(6.75, -3.65, 2.9, 1.1, { silver: 0, twin: true });
  checkout(7.7, -2.55, 1.2, 1.05, { silver: .55, bare: true });
  box(world, 7.05, 1.1, -2.1, .04, 1, .04, M.metal);
  rbox(world, 7.05, .95, -1.99, .36, .72, .07, M.white, .03);
}

// -------------------------------------------- electronics & apparel wing
// A 4 × 3 grid of laptops, tablets, boxed items and photo frames.
function devices(x0, x1, z0, z1, y) {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
    const x = x0 + (c + .5) * (x1 - x0) / 4, z = z0 + (r + .5) * (z1 - z0) / 3, kind = (r * 4 + c) % 5;
    if (kind === 0 || kind === 3) {
      box(world, x, y + .012, z + .04, .34, .022, .24, M.black);
      box(world, x, y + .13, z - .08, .34, .22, .015, M.black, { rx: -.3 });
      box(world, x, y + .13, z - .07, .3, .18, .004, M.chrome, { rx: -.3, cast: false });
    } else if (kind === 1) {
      rbox(world, x, y + .01, z, .26, .02, .18, M.black, .01);
      box(world, x, y + .021, z, .22, .002, .15, M.darkGlass, { cast: false });
    } else if (kind === 2) {
      rbox(world, x, y + .08, z, .2, .16, .16, M.offWhite, .02);
    } else {
      rbox(world, x, y + .14, z - .05, .2, .28, .04, M.metalLight, .01, { rx: -.15 });
    }
  }
}

function buildApparelWing() {
  // Device table with drawer fronts.
  {
    const x = -3, z = 9.25, w = 2.3, d = 1.25;
    box(world, x, .05, z, w - .06, .1, d - .06, M.plinth);
    rbox(world, x, .45, z, w, .72, d, M.wood, .02);
    rbox(world, x, .84, z, w + .06, .06, d + .06, M.woodLight, .015);
    for (let i = 1; i < 4; i++) box(world, x - w / 2 + i * w / 4, .45, z + d / 2 + .003, .012, .6, .006, M.woodDark, { cast: false });
    box(world, x + w / 2 + .003, .45, z, .006, .6, .012, M.woodDark, { cast: false });
    for (let i = 0; i < 4; i++) box(world, x - w / 2 + (i + .5) * w / 4, .62, z + d / 2 + .01, .12, .025, .02, M.yellow);
    devices(x - w / 2 + .1, x + w / 2 - .1, z - d / 2 + .1, z + d / 2 - .1, .87);
  }
  // Small-appliance island: toasters on the low tier, microwaves and coffee makers on top.
  {
    const x = .75, z = 7.5;
    rbox(world, x, .3, z, 1.75, .6, 2.2, M.wood, .02);
    rbox(world, x, .62, z, 1.8, .05, 2.26, M.woodLight, .015);
    rbox(world, x - .1, .8, z - .15, .95, .36, 1.4, M.wood, .02);
    rbox(world, x - .1, 1, z - .15, 1, .05, 1.45, M.woodLight, .015);
    for (const [dx, dz] of [[-.55, .6], [.45, .8], [.55, .2], [.55, -.45], [-.45, -.85]]) {
      rbox(world, x + dx, .78, z + dz, .3, .28, .34, rnd() > .5 ? M.black : M.offWhite, .03);
    }
    for (const [dx, dz] of [[-.35, -.55], [-.35, .1]]) {
      rbox(world, x + dx, 1.2, z + dz, .46, .34, .38, M.black, .03);
      box(world, x + dx + .05, 1.2, z + dz + .195, .3, .22, .01, M.darkGlass, { cast: false });
    }
    for (const [dx, dz] of [[.15, -.45], [.15, .25]]) {
      rbox(world, x + dx, 1.19, z + dz, .3, .32, .3, M.metalLight, .03);
      cyl(world, x + dx + .04, 1.1, z + dz + .1, .06, .06, .12, M.black, 12);
    }
  }
  // Double clothing rail on a grey plinth, with a bag on its top shelf.
  {
    const x0 = -3.85, x1 = -1.15, z = 7.42;
    box(world, (x0 + x1) / 2, .03, z, x1 - x0 + .25, .06, 1, M.plinth);
    for (const x of [x0, (x0 + x1) / 2 + .2, x1]) {
      box(world, x, .88, z, .05, 1.72, .05, M.metal);
      box(world, x, .09, z, .06, .06, .8, M.metal);
    }
    box(world, (x0 + x1) / 2, 1.66, z, x1 - x0, .035, .035, M.chrome);
    box(world, x1 - .55, 2, z, 1.2, .04, .52, M.metal);
    for (const x of [x1 - 1.1, x1]) box(world, x, 1.84, z, .04, .34, .04, M.metal);
    rbox(world, x1 - .45, 2.13, z, .38, .22, .16, M.black, .03);
    const tones = ['#2a3a52', '#f1efe9', '#2b2d30', '#8e969b', '#1d2b40', '#e3dfd6', '#3c4448'];
    for (let x = x0 + .1; x < x1 - .08; x += .075) {
      const color = x > x1 - .65 ? pick(['#86a53a', '#7a9a32', '#95b243']) : pick(tones);
      inst('box', color, x, 1.2, z, .055, range(.78, .95), .5, { finish: 'matte' });
    }
  }
  // Alcove: printers on a low shelf, a tall end unit and a rail by the wall.
  {
    const x = -6.7, z0 = 6.1, z1 = 9.1, zc = (z0 + z1) / 2, d = z1 - z0;
    for (const z of [z0, z1]) rbox(world, x, .57, z, .86, 1.14, .05, M.woodLight, .01);
    box(world, x - .41, .57, zc, .04, 1.14, d, M.woodDark);
    for (const y of [.06, .44, .8, 1.13]) rbox(world, x, y, zc, .86, .04, d, M.woodLight, .01);
    for (const y of [.08, .46]) {
      for (let z = z0 + .08, bw = range(.32, .44); z < z1 - .3; z += bw, bw = range(.32, .44)) {
        inst('box', pick(['#eceae4', '#d9d6ce', '#c7c4bc']), x + .05, y + .16, z + bw / 2, .6, .3, bw - .04);
      }
    }
    for (let i = 0; i < 4; i++) {
      const z = z0 + .45 + i * .72;
      rbox(world, x, 1.27, z, .5, .24, .42, M.offWhite, .03);
      box(world, x + .2, 1.34, z, .12, .02, .3, M.charcoal, { cast: false });
    }
    metalShelf(-7.12, -6.3, 5.35, 6.02, 2, 4, M.charcoal);
    rbox(world, -6.72, 2.19, 5.68, .62, .36, .56, M.cardboard, .01);
    box(world, -8, 1.52, 4.45, 1.3, .03, .03, M.chrome);
    for (const rx of [-8.62, -7.38]) {
      box(world, rx, .76, 4.45, .04, 1.52, .04, M.metal);
      box(world, rx, .03, 4.45, .06, .06, .5, M.metal);
    }
    for (let i = 0; i < 11; i++) {
      inst('box', pick(['#1f2124', '#e7e1d6', '#bca98b', '#f4f2ec', '#2a2d31']), -8.5 + i * .105, 1.1, 4.45, .06, range(.72, .84), .46, { finish: 'matte' });
    }
    rbox(world, -8.45, .48, 9.4, .55, .96, 1, M.offWhite, .03);
    panel(world, WING_X + .13, 2, 5.5, .9, .45, TEX.frame, { ry: Math.PI / 2 });
    box(world, -7.95, 1.1, WING_Z + .14, 1.08, 2.2, .04, M.metalLight);
    box(world, -7.95, 1.08, WING_Z + .16, .94, 2.12, .04, M.doorBlue);
    box(world, -8.28, 1.05, WING_Z + .2, .03, .2, .05, M.chrome);
  }
  // Storage room beyond the alcove: racks of blue totes.
  for (let r = 0; r < 3; r++) for (let l = 0; l < 4; l++) for (let k = 0; k < 3; k++) {
    inst('box', pick(['#4e7aa6', '#5b88b3', '#46719b']), -18.6 + r * 2.4 + k * .62, .2 + l * .4, 4.5, .56, .36, .7);
  }
}

// -------------------------------------------------------------------- office
function buildOffice() {
  const { x0, x1, z0, z1 } = OFFICE;
  // Back wall with a dark display board and a pin board.
  wallX(x0 - .05, x1, z0 - .01, 2.3, .22, M.wallOffice, M.wallCream);
  box(world, 2.72, 1.62, z0 + .12, 1.28, .8, .03, M.black);
  panel(world, 2.72, 1.62, z0 + .137, 1.2, .72, TEX.officeBoard, { glow: .15 });
  panel(world, 3.95, 1.3, z0 + .115, .62, .74, TEX.cork);
  // Glazed side wall with white mullions, and cut-away curbs on the open sides.
  box(world, x0, 1.15, (z0 + z1) / 2, .025, 2.26, z1 - z0 - .1, M.glass, { cast: false });
  for (const z of [11.5, z0 + 1.1, z0 + 2.2, z1 - .05]) box(world, x0, 1.16, z, .09, 2.32, .09, M.white);
  for (const y of [2.32, .05]) box(world, x0, y, (z0 + z1) / 2 - .3, .11, .1, z1 - z0 + .6, M.white);
  wallX(x0 - .05, x1 + .12, z1, .32, .24, M.exterior, M.wallOffice, M.exterior);
  wallZ(z0 + .1, z1 - .12, x1, .32, .24, M.exterior, M.wallOffice);
  // L-shaped desk with a drawer pedestal.
  rbox(world, 2.65, .76, 12.85, 2.5, .05, .82, M.woodLight, .015);
  rbox(world, 3.6, .76, 13.62, .66, .05, .82, M.woodLight, .015);
  box(world, 1.47, .38, 12.85, .05, .72, .76, M.wood);
  rbox(world, 3.6, .37, 13.25, .6, .72, 1.5, M.plank, .02);
  for (let i = 0; i < 3; i++) box(world, 3.25, .2 + i * .22, 13.55, .012, .012, .3, M.chrome, { cast: false });
  box(world, 2.5, .45, 12.5, 2, .5, .03, M.wood);
  // Laptop, phone, tape dispenser and papers.
  box(world, 2.25, .795, 13, .44, .02, .3, M.metalLight);
  box(world, 2.25, .95, 12.84, .44, .3, .015, M.metalLight, { rx: -.28 });
  panel(world, 2.25, .95, 12.85, .4, .26, TEX.laptop, { rx: -.28, glow: .35 });
  rbox(world, 3.05, .82, 12.62, .14, .08, .2, M.black, .02);
  rbox(world, 3.4, .83, 12.95, .1, .1, .1, M.black, .02);
  box(world, 1.8, .79, 12.7, .3, .01, .38, M.white, { ry: .2 });
  // Task chair.
  const cx = 2.35, cz = 13.9;
  cyl(world, cx, .3, cz, .03, .03, .4, M.black, 8);
  rbox(world, cx, .52, cz, .52, .08, .5, M.chair, .03);
  rbox(world, cx, .88, cz + .23, .5, .56, .08, M.chair, .04, { rx: .08 });
  for (let i = 0; i < 5; i++) {
    const a = i * Math.PI * 2 / 5;
    box(world, cx + Math.cos(a) * .2, .07, cz + Math.sin(a) * .2, .4, .03, .045, M.black, { ry: -a });
    cyl(world, cx + Math.cos(a) * .38, .03, cz + Math.sin(a) * .38, .03, .03, .04, M.black, 8);
  }
  plant(1.1, 14.62, 1.05);
}

// Builds the whole store and merges it into a few dozen draw calls.
// Returns the scene-graph root, the shape of the reflective tiled floor and the
// walkable plan polygons used for navigation.
export function buildStore() {
  world = new THREE.Group();
  setSeed(BUILD_SEED);
  buildShell();
  buildDock();
  buildTruck();
  buildStockroom();
  buildPickup();
  buildSalesFloor();
  buildCheckouts();
  buildApparelWing();
  buildOffice();
  commitInstances(world);
  bakeStatic(world);
  // Plan polygons people can walk on: the tiled floor and the loading dock.
  const walkableFloors = [SALES_FLOOR, [[APRON_X, JZ], [JX, JZ], [JX, WING_Z], [APRON_X, WING_Z]]];
  return { root: world, floorShape: planShape(SALES_FLOOR), walkableFloors };
}
