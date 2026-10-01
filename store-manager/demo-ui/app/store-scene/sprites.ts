// 8-bit character sprites cut in the browser from the committed sprite sheets,
// drawn as upright billboards whose outfit colour is swapped in the shader, so
// one texture serves every shopper.
import * as THREE from "three";

export type Pose = "walk" | "cart" | "carry" | "idle" | "scan";
/** Fabric hue band that the outfit recolour replaces. */
export type Fabric = "lime" | "blue" | "none";

type FramePair = [THREE.Texture, THREE.Texture];
export type PoseSheet = { frames: FramePair; aspect: number; fabric: Fabric };
export type SpriteLibrary = Record<Pose, PoseSheet> & { spill: THREE.Texture; spillAspect: number };

const SHEET_A = "/characters/avatar-motion-a-alpha-hard.png";
const SHEET_B = "/characters/avatar-motion-b-alpha-hard.png";
const ACTION_SHEET = "/characters/avatar-actions-alpha.png";
const WAITING = ["/characters/waiting-idle-a.png", "/characters/waiting-idle-b.png"] as const;
const SPILL = "/incident-spill.png";
const PADDING = 8;

/** Apparent on-screen height of a person, in metres at the store's scale. */
export const PERSON_HEIGHT = 1.3;
// Default isometric camera direction (target to camera; see StoreScene).
export const VIEW_DIRECTION = new THREE.Vector3(0.52814, 0.58245, 0.62277).normalize();
/** Floor decals are stretched along the default view so they read as drawn. */
export const FLOOR_STRETCH = 1 / VIEW_DIRECTION.y;
export const VIEW_YAW = Math.atan2(VIEW_DIRECTION.x, VIEW_DIRECTION.z);

/** Where the camera currently looks from; character billboards turn toward it. */
export const cameraView = {
  version: 0,
  yaw: 0,
  /** Upright planes stretch to keep the art's proportions, capped near top-down. */
  stretch: 1,
  /** Offset toward the camera along the view ray, so sprites don't clip shelves. */
  toward: new THREE.Vector3(),
  /** On-screen right as a floor direction, for choosing which way to face. */
  right: new THREE.Vector3(),
};

/** Updates the shared camera direction (a unit vector from the target to the camera). */
export function setCameraDirection(direction: THREE.Vector3) {
  const elevation = Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
  cameraView.yaw = Math.atan2(direction.x, direction.z);
  cameraView.stretch = Math.min(1.6, 1 / Math.cos(elevation));
  cameraView.toward.copy(direction).multiplyScalar(0.38);
  cameraView.right.set(direction.z, 0, -direction.x).normalize();
  cameraView.version++;
}
setCameraDirection(VIEW_DIRECTION);

async function loadImage(src: string) {
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  await image.decode();
  return image;
}

function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  return canvas;
}

// Residual magenta key pixels from the generated sheets become transparent.
function removeMagentaKey(data: ImageData) {
  const pixels = data.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const [red, green, blue, alpha] = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
    if (alpha && red >= 105 && blue >= 85 && green <= Math.min(red, blue) * 0.72 && Math.abs(red - blue) <= 125) {
      pixels[i + 3] = 0;
    }
  }
}

type Bounds = { left: number; top: number; right: number; bottom: number };

function alphaBounds(data: ImageData): Bounds | null {
  const { width, height, data: pixels } = data;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!pixels[(y * width + x) * 4 + 3]) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { left, top, right: right + 1, bottom: bottom + 1 };
}

function cutCell(image: HTMLImageElement, column: number, row: number) {
  const width = Math.floor(image.width / 2);
  const height = Math.floor(image.height / 2);
  const canvas = canvasOf(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(image, column * width, row * height, width, height, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height);
  removeMagentaKey(data);
  context.putImageData(data, 0, 0);
  return { canvas, bounds: alphaBounds(data) };
}

function crop(source: HTMLCanvasElement | HTMLImageElement, bounds: Bounds) {
  const canvas = canvasOf(bounds.right - bounds.left, bounds.bottom - bounds.top);
  canvas.getContext("2d")!.drawImage(source, -bounds.left, -bounds.top);
  return canvas;
}

function pad(bounds: Bounds, width: number, height: number): Bounds {
  return {
    left: Math.max(0, bounds.left - PADDING),
    top: Math.max(0, bounds.top - PADDING),
    right: Math.min(width, bounds.right + PADDING),
    bottom: Math.min(height, bounds.bottom + PADDING),
  };
}

// Stride frames share one crop (their union bounds) so the feet stay aligned.
function motionPair(sheetA: HTMLImageElement, sheetB: HTMLImageElement, column: number, row: number) {
  const first = cutCell(sheetA, column, row);
  const second = cutCell(sheetB, column, row);
  if (!first.bounds || !second.bounds) throw new Error("Missing sprite content");
  const union = pad({
    left: Math.min(first.bounds.left, second.bounds.left),
    top: Math.min(first.bounds.top, second.bounds.top),
    right: Math.max(first.bounds.right, second.bounds.right),
    bottom: Math.max(first.bounds.bottom, second.bounds.bottom),
  }, first.canvas.width, first.canvas.height);
  return [crop(first.canvas, union), crop(second.canvas, union)] as const;
}

// Action poses are centred independently and bottom-aligned on one canvas.
function actionPair(sheet: HTMLImageElement, row: number) {
  const crops = [0, 1].map((column) => {
    const cell = cutCell(sheet, column, row);
    if (!cell.bounds) throw new Error("Missing action content");
    return crop(cell.canvas, pad(cell.bounds, cell.canvas.width, cell.canvas.height));
  });
  const width = Math.max(...crops.map((item) => item.width));
  const height = Math.max(...crops.map((item) => item.height));
  return crops.map((item) => {
    const canvas = canvasOf(width, height);
    canvas.getContext("2d")!.drawImage(item, Math.floor((width - item.width) / 2), height - item.height);
    return canvas;
  }) as unknown as readonly [HTMLCanvasElement, HTMLCanvasElement];
}

function spriteTexture(source: HTMLCanvasElement | HTMLImageElement) {
  const texture = source instanceof HTMLCanvasElement ? new THREE.CanvasTexture(source) : new THREE.Texture(source);
  // Raw sRGB values: the character shader recolours and outputs them as-is.
  texture.colorSpace = THREE.NoColorSpace;
  texture.premultiplyAlpha = true; // clean, halo-free mip edges
  texture.magFilter = THREE.NearestFilter; // crisp 8-bit pixels when magnified
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function sheet(pair: readonly [HTMLCanvasElement | HTMLImageElement, HTMLCanvasElement | HTMLImageElement], fabric: Fabric): PoseSheet {
  return {
    frames: [spriteTexture(pair[0]), spriteTexture(pair[1])],
    aspect: pair[0].width / pair[0].height,
    fabric,
  };
}

export async function loadSpriteLibrary(): Promise<SpriteLibrary> {
  const [sheetA, sheetB, actions, waitingA, waitingB, spill] = await Promise.all(
    [SHEET_A, SHEET_B, ACTION_SHEET, ...WAITING, SPILL].map(loadImage),
  );
  return {
    walk: sheet(motionPair(sheetA, sheetB, 0, 0), "lime"),
    cart: sheet(motionPair(sheetA, sheetB, 1, 0), "blue"),
    carry: sheet(motionPair(sheetA, sheetB, 0, 1), "none"),
    idle: sheet([waitingA, waitingB], "lime"),
    scan: sheet(actionPair(actions, 1), "lime"),
    spill: spriteTexture(spill),
    spillAspect: spill.width / spill.height,
  };
}

// ------------------------------------------------------------------ shader
const FABRIC_BANDS: Record<Fabric, [number, number, number]> = {
  lime: [0.16, 0.3, 0.35],
  blue: [0.52, 0.69, 0.38],
  none: [2, 2, 2],
};

const CHARACTER_VERTEX = /* glsl */ `
  uniform float uFlip;
  varying vec2 vUv;
  void main() {
    vUv = vec2(mix(uv.x, 1.0 - uv.x, uFlip), uv.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const CHARACTER_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform float uOpacity;
  uniform vec3 uBand;      // hue min, hue max, saturation min
  uniform vec3 uTarget;    // hue, saturation, enabled
  varying vec2 vUv;

  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
  }
  vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * clamp(p - 1.0, 0.0, 1.0);
  }

  void main() {
    vec4 texel = texture2D(map, vUv);
    if (texel.a < 0.1) discard;
    vec3 color = texel.rgb / texel.a;
    if (uTarget.z > 0.5) {
      vec3 hsv = rgb2hsv(color);
      if (hsv.x >= uBand.x && hsv.x <= uBand.y && hsv.y >= uBand.z && hsv.z >= 0.12) {
        color = hsv2rgb(vec3(uTarget.x, min(1.0, max(hsv.y * 0.85, uTarget.y * 0.75)), hsv.z));
      }
    }
    float alpha = texel.a * uOpacity;
    gl_FragColor = vec4(color * alpha, alpha);
  }`;

// HSV hue and saturation of the sRGB colour, matching the original builder.
function hueSaturation(color: THREE.ColorRepresentation) {
  const parsed = new THREE.Color(color);
  const hsl = parsed.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);
  const { r, g, b } = parsed.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return { hue: hsl.h, saturation: max ? (max - min) / max : 0 };
}

export class CharacterMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      uniforms: {
        map: { value: null },
        uFlip: { value: 0 },
        uOpacity: { value: 1 },
        uBand: { value: new THREE.Vector3(2, 2, 2) },
        uTarget: { value: new THREE.Vector3(0, 0, 0) },
      },
      vertexShader: CHARACTER_VERTEX,
      fragmentShader: CHARACTER_FRAGMENT,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: true,
    });
  }

  setFrame(texture: THREE.Texture) {
    this.uniforms.map.value = texture;
  }

  /** Swaps the given fabric band to `color`, or restores the art when null. */
  setOutfit(fabric: Fabric, color: THREE.ColorRepresentation | null) {
    const [hueMin, hueMax, saturationMin] = FABRIC_BANDS[fabric];
    this.uniforms.uBand.value.set(hueMin, hueMax, saturationMin);
    if (color === null || fabric === "none") {
      this.uniforms.uTarget.value.set(0, 0, 0);
      return;
    }
    const { hue, saturation } = hueSaturation(color);
    this.uniforms.uTarget.value.set(hue, saturation, 1);
  }
}

// --------------------------------------------------------------- shadows
let blobTexture: THREE.Texture | null = null;

/** Soft two-tone contact shadow under each character. */
export function shadowTexture() {
  if (blobTexture) return blobTexture;
  const canvas = canvasOf(128, 64);
  const context = canvas.getContext("2d")!;
  context.fillStyle = "rgba(20, 23, 22, 0.44)";
  context.beginPath();
  context.ellipse(64, 32, 62, 30, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "rgba(8, 10, 10, 0.5)";
  context.beginPath();
  context.ellipse(64, 32, 40, 18, 0, 0, Math.PI * 2);
  context.fill();
  blobTexture = new THREE.CanvasTexture(canvas);
  blobTexture.colorSpace = THREE.SRGBColorSpace;
  return blobTexture;
}
