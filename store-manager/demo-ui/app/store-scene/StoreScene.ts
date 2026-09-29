// WebGL host for the 3D store. The static store (ambient occlusion, polished
// floor reflection, baked shadows) is rendered only when the view changes and
// cached with its depth; every frame then composites that image and draws the
// moving 8-bit characters on top, depth-tested against the shelves.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { canvasTexture } from "./kit.js";
import { buildStore } from "./store.js";
import { STORE_ASPECT } from "../store-view-model.mjs";
import { NavGrid } from "./navigation";
import { loadSpriteLibrary, VIEW_DIRECTION } from "./sprites";
import { StoreLife, type CheckoutVisual, type OpdVisual } from "./life";

export type { CheckoutVisual, OpdVisual };
export type StoreView = { scale: number; x: number; y: number };
export type ScreenPoint = { x: number; y: number };

const CAMERA_DISTANCE = 133;
const VIEW_EASING_MS = 90;
// Scenario focus and reset glide rather than snap.
const FOCUS_TWEEN_MS = 900;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

// The store and its walkability grid are deterministic, so they are built once
// per page and shared by any remounted scene.
let storeModel: { root: THREE.Group; floorShape: THREE.Shape; nav: NavGrid } | null = null;
function sharedStore() {
  if (!storeModel) {
    const { root, floorShape, walkableFloors } = buildStore();
    storeModel = { root, floorShape, nav: new NavGrid(root, walkableFloors) };
  }
  return storeModel;
}

// Planar reflection with a small Vogel-disk blur for a waxed, hazy floor.
const ReflectionShader = {
  name: "BlurredReflection",
  uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null } },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    varying vec4 vUv;
    const int SAMPLES = 20;
    const float BLUR = 0.0055;
    const float STRENGTH = 0.2;
    void main() {
      vec2 uv = vUv.xy / vUv.w;
      vec3 sum = vec3(0.0);
      float total = 0.0;
      for (int i = 0; i < SAMPLES; i++) {
        float r = sqrt((float(i) + 0.5) / float(SAMPLES));
        float a = float(i) * 2.39996;
        float w = 1.0 - r * 0.6;
        sum += texture2D(tDiffuse, uv + vec2(cos(a), sin(a)) * r * BLUR).rgb * w;
        total += w;
      }
      gl_FragColor = vec4(sum / total * color, STRENGTH);
      #include <colorspace_fragment>
    }`,
};

// Copies the cached store colour and depth into the default framebuffer.
const CompositeShader = {
  uniforms: { tColor: { value: null as THREE.Texture | null }, tDepth: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    varying vec2 vUv;
    void main() {
      gl_FragColor = texture2D(tColor, vUv);
      gl_FragDepth = texture2D(tDepth, vUv).x;
    }`,
};

type Anchor = { element: HTMLElement; position: THREE.Vector3 };

export type StoreSceneOptions = { reducedMotion?: boolean; signal?: AbortSignal };

export class StoreScene {
  private readonly life: StoreLife;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(7.8, STORE_ASPECT, 20, 460);
  private readonly baseCamera = new THREE.PerspectiveCamera(7.8, STORE_ASPECT, 20, 460);
  private readonly staticScene = new THREE.Scene();
  private readonly dynamicScene = new THREE.Scene();
  private readonly composer: EffectComposer;
  private readonly depthTarget: THREE.WebGLRenderTarget;
  private readonly composite: FullScreenQuad;
  private readonly depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  private readonly reflector: Reflector | null;
  private readonly anchors = new Set<Anchor>();
  private readonly clock = new THREE.Timer();
  private readonly projected = new THREE.Vector3();
  private readonly coarsePointer: boolean;
  private size = { width: 1, height: 1 };
  private viewTarget: StoreView = { scale: 1, x: 0, y: 0 };
  private viewCurrent: StoreView = { scale: 1, x: 0, y: 0 };
  private viewTween: { from: StoreView; to: StoreView; elapsed: number } | null = null;
  private readonly reducedMotion: boolean;
  private staticDirty = true;
  private anchorsDirty = true;
  private firstFrame: (() => void) | null = null;
  private disposed = false;

  static async create(canvas: HTMLCanvasElement, options: StoreSceneOptions) {
    const sprites = await loadSpriteLibrary();
    // A superseded mount must not open a second context on the same canvas.
    options.signal?.throwIfAborted();
    const scene = new StoreScene(canvas, sprites, options);
    await new Promise<void>((resolve) => { scene.firstFrame = resolve; });
    return scene;
  }

  private constructor(canvas: HTMLCanvasElement, sprites: Awaited<ReturnType<typeof loadSpriteLibrary>>, options: StoreSceneOptions) {
    this.coarsePointer = matchMedia("(pointer: coarse)").matches;
    this.reducedMotion = options.reducedMotion === true;
    // Antialiasing comes from the multisampled composer target.
    this.renderer = new THREE.WebGLRenderer({ canvas, powerPreference: "high-performance" });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false; // the store is static: shadows render once

    const { root, floorShape, nav } = sharedStore();
    const scene = this.staticScene;
    // Slate backdrop, lighter toward the lower left.
    scene.background = canvasTexture(512, 512, (context: CanvasRenderingContext2D, width: number, height: number) => {
      const gradient = context.createLinearGradient(0, height, width * 0.8, 0);
      gradient.addColorStop(0, "#6b7984");
      gradient.addColorStop(0.42, "#5f6c76");
      gradient.addColorStop(1, "#58646d");
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
    });
    scene.add(root);
    scene.environmentIntensity = 0.25;
    scene.add(new THREE.HemisphereLight("#f3f1ec", "#a89985", 1.2));
    // Key light from the upper left, so shadows fall to the right.
    const sun = new THREE.DirectionalLight("#fff1da", 2.05);
    sun.position.set(-26, 38, 26);
    sun.target.position.set(-5, 0, 2.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -31, right: 31, top: 29, bottom: -29, near: 5, far: 120 });
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 0.025;
    sun.shadow.radius = 7;
    const fill = new THREE.DirectionalLight("#dce7ee", 0.3);
    fill.position.set(30, 18, -14);
    scene.add(sun, sun.target, fill);

    // Characters are unlit sprites; props such as totes get simple lighting.
    this.dynamicScene.add(new THREE.HemisphereLight("#f6f3ec", "#a89985", 2.2));
    const dynamicSun = new THREE.DirectionalLight("#fff1da", 1.6);
    dynamicSun.position.set(-26, 38, 26);
    this.dynamicScene.add(dynamicSun);

    for (const camera of [this.camera, this.baseCamera]) {
      camera.position.copy(VIEW_DIRECTION).multiplyScalar(CAMERA_DISTANCE);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(); // the base camera is only projected, never rendered
    }

    this.reflector = null;
    if (!this.coarsePointer) {
      const reflector = new Reflector(new THREE.ShapeGeometry(floorShape), { shader: ReflectionShader, color: 0xffffff, clipBias: 0.003 });
      reflector.rotation.x = -Math.PI / 2;
      reflector.position.y = 0.012;
      Object.assign(reflector.material, { transparent: true, depthWrite: false });
      const ceiling = new THREE.Color("#e2d3c0");
      const renderReflection = reflector.onBeforeRender;
      reflector.onBeforeRender = function (...args) {
        if (scene.overrideMaterial) return; // skip the ambient-occlusion and depth passes
        const background = scene.background;
        scene.background = ceiling;
        renderReflection.apply(this, args);
        scene.background = background;
      };
      scene.add(reflector);
      this.reflector = reflector;
    }

    // Ground-truth ambient occlusion supplies the soft contact shading.
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    this.composer.renderToScreen = false;
    this.composer.addPass(new RenderPass(scene, this.camera));
    const ambientOcclusion = new GTAOPass(scene, this.camera);
    ambientOcclusion.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.6, thickness: 1.4, scale: 1.15, samples: 16 });
    ambientOcclusion.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 16 });
    ambientOcclusion.blendIntensity = 0.9;
    this.composer.addPass(ambientOcclusion);
    this.composer.addPass(new OutputPass());

    this.depthTarget = new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(1, 1) });
    this.composite = new FullScreenQuad(new THREE.ShaderMaterial({
      ...CompositeShader,
      uniforms: THREE.UniformsUtils.clone(CompositeShader.uniforms),
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.AlwaysDepth,
    }));

    this.life = new StoreLife(this.dynamicScene, nav, sprites, { reducedMotion: options.reducedMotion === true });

    canvas.addEventListener("webglcontextrestored", this.bakeLighting);
    this.bakeLighting();
    this.resize(canvas.clientWidth, canvas.clientHeight);
    this.clock.connect(document);
    this.renderer.setAnimationLoop(this.frame);
  }

  // Environment map and the one-off shadow map; rebuilt after context loss.
  private bakeLighting = () => {
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.staticScene.environment?.dispose();
    this.staticScene.environment = pmrem.fromScene(room, 0.04).texture;
    pmrem.dispose();
    room.dispose();
    this.renderer.shadowMap.needsUpdate = true;
    this.staticDirty = true;
  };

  // ---------------------------------------------------------------- view
  resize(width: number, height: number) {
    if (!width || !height) return; // hidden: keep the last good size
    this.size = { width, height };
    const pixelRatio = Math.min(devicePixelRatio, this.coarsePointer ? 1.5 : 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.depthTarget.setSize(Math.round(width * pixelRatio), Math.round(height * pixelRatio));
    this.reflector?.getRenderTarget().setSize(Math.round((width * pixelRatio) / 2), Math.round((height * pixelRatio) / 2));
    // At 100% the whole store framing (STORE_ASPECT) fits inside the viewport.
    for (const camera of [this.camera, this.baseCamera]) {
      camera.aspect = width / height;
      camera.zoom = Math.min(1, width / height / STORE_ASPECT);
    }
    this.baseCamera.updateProjectionMatrix();
    this.applyView(this.viewCurrent);
  }

  /**
   * Moves toward a zoom/pan view. Large jumps (scenario focus, reset) glide;
   * small ones (wheel, buttons) ease quickly; `immediate` follows a drag.
   */
  setView(view: StoreView, immediate = false) {
    const current = this.viewCurrent;
    this.viewTarget = { ...view };
    const largeJump = Math.abs(view.scale - current.scale) > 0.3 || Math.hypot(view.x - current.x, view.y - current.y) > 240;
    this.viewTween = largeJump && !immediate && !this.reducedMotion ? { from: { ...current }, to: { ...view }, elapsed: 0 } : null;
    if (immediate || this.reducedMotion) this.applyView(this.viewTarget);
  }

  // Zoom and pan crop the fixed isometric view like the 2D transform
  // translate(x, y) scale(scale) about the viewport centre, so the view model
  // (store-view-model.mjs) can clamp it in screen pixels.
  private applyView(view: StoreView) {
    this.viewCurrent = { ...view };
    const { width, height } = this.size;
    const { scale, x, y } = view;
    if (scale === 1 && x === 0 && y === 0) {
      this.camera.clearViewOffset();
    } else {
      const subWidth = width / scale;
      const subHeight = height / scale;
      this.camera.setViewOffset(width, height, width / 2 - x / scale - subWidth / 2, height / 2 - y / scale - subHeight / 2, subWidth, subHeight);
    }
    this.camera.updateProjectionMatrix();
    this.staticDirty = true;
    this.anchorsDirty = true;
  }

  private easeView(deltaMs: number) {
    const tween = this.viewTween;
    if (tween) {
      // Zoom evenly (log scale) while the view centre travels in a line.
      tween.elapsed += deltaMs;
      const t = Math.min(1, tween.elapsed / FOCUS_TWEEN_MS);
      const e = easeInOutCubic(t);
      const { width, height } = this.size;
      const scale = Math.exp(Math.log(tween.from.scale) + (Math.log(tween.to.scale) - Math.log(tween.from.scale)) * e);
      const centre = (view: StoreView, half: number, offset: number) => half - offset / view.scale;
      const cx = centre(tween.from, width / 2, tween.from.x) + (centre(tween.to, width / 2, tween.to.x) - centre(tween.from, width / 2, tween.from.x)) * e;
      const cy = centre(tween.from, height / 2, tween.from.y) + (centre(tween.to, height / 2, tween.to.y) - centre(tween.from, height / 2, tween.from.y)) * e;
      this.applyView(t >= 1 ? tween.to : { scale, x: (width / 2 - cx) * scale, y: (height / 2 - cy) * scale });
      if (t >= 1) this.viewTween = null;
      return;
    }
    const target = this.viewTarget;
    const current = this.viewCurrent;
    if (current.scale === target.scale && current.x === target.x && current.y === target.y) return;
    const t = 1 - Math.exp(-deltaMs / VIEW_EASING_MS);
    const next = {
      scale: current.scale + (target.scale - current.scale) * t,
      x: current.x + (target.x - current.x) * t,
      y: current.y + (target.y - current.y) * t,
    };
    const settled = Math.abs(next.scale - target.scale) < 0.001 && Math.abs(next.x - target.x) < 0.3 && Math.abs(next.y - target.y) < 0.3;
    this.applyView(settled ? target : next);
  }

  /** Viewport position of a world point in the unzoomed (100%) framing. */
  baseScreenPoint(x: number, y: number, z: number): ScreenPoint {
    this.projected.set(x, y, z).project(this.baseCamera);
    return {
      x: ((this.projected.x + 1) / 2) * this.size.width,
      y: ((1 - this.projected.y) / 2) * this.size.height,
    };
  }

  /** Keeps an HTML label pinned to a world position; returns its remover. */
  addAnchor(element: HTMLElement, position: readonly [number, number, number]) {
    const anchor = { element, position: new THREE.Vector3(...position) };
    this.anchors.add(anchor);
    this.anchorsDirty = true;
    return () => { this.anchors.delete(anchor); };
  }

  private updateAnchors() {
    const { width, height } = this.size;
    for (const { element, position } of this.anchors) {
      this.projected.copy(position).project(this.camera);
      const x = ((this.projected.x + 1) / 2) * width;
      const y = ((1 - this.projected.y) / 2) * height;
      element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      element.style.visibility = "visible";
    }
    this.anchorsDirty = false;
  }

  // ------------------------------------------------------------- scenario
  setCheckout(state: CheckoutVisual | null) {
    this.life.setCheckout(state);
  }

  setOpd(state: OpdVisual | null) {
    this.life.setOpd(state);
  }

  setIncident(active: boolean) {
    this.life.setIncident(active);
  }

  // ------------------------------------------------------------ rendering
  private renderStatic() {
    const { renderer, staticScene } = this;
    this.composer.render();
    // Depth of opaque fixtures only, so characters show through glass.
    const hidden: THREE.Object3D[] = [];
    staticScene.traverse((object) => {
      const material = (object as THREE.Mesh).material as THREE.Material | undefined;
      if (object.visible && material && !Array.isArray(material) && material.transparent) {
        object.visible = false;
        hidden.push(object);
      }
    });
    const background = staticScene.background;
    staticScene.background = null;
    staticScene.overrideMaterial = this.depthOnly;
    renderer.setRenderTarget(this.depthTarget);
    renderer.clear();
    renderer.render(staticScene, this.camera);
    staticScene.overrideMaterial = null;
    staticScene.background = background;
    for (const object of hidden) object.visible = true;
    renderer.setRenderTarget(null);
    this.staticDirty = false;
  }

  private frame = (time?: number) => {
    if (this.disposed) return;
    this.clock.update(time);
    const deltaMs = Math.min(100, this.clock.getDelta() * 1000);
    this.easeView(deltaMs);
    this.life.update(deltaMs / 1000);
    if (this.staticDirty) this.renderStatic();

    const { renderer } = this;
    const material = this.composite.material as THREE.ShaderMaterial;
    material.uniforms.tColor.value = this.composer.readBuffer.texture;
    material.uniforms.tDepth.value = this.depthTarget.depthTexture;
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    renderer.clear();
    this.composite.render(renderer);
    renderer.render(this.dynamicScene, this.camera);
    renderer.autoClear = true;

    if (this.anchorsDirty) this.updateAnchors();
    if (this.firstFrame) {
      this.firstFrame();
      this.firstFrame = null;
    }
  };

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.clock.dispose();
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.bakeLighting);
    this.life.dispose();
    this.composer.dispose();
    this.depthTarget.dispose();
    this.composite.dispose();
    this.reflector?.dispose();
    this.staticScene.environment?.dispose();
    this.staticScene.remove(sharedStore().root);
    this.renderer.dispose();
  }
}
