/**
 * Helpers shared by the story scenes (ported from the threejs-marketing-pages kit): easing, a renderer
 * stage whose colours match the page's CSS, fat lines that draw on, crisp constant-pixel-size markers,
 * HTML labels and cards placed by the 3D camera, and a keyframed orbit camera. Every helper is stateless
 * or takes the time it should show, so scenes stay pure functions of story time.
 *
 * Only the scene modules import this file, so three stays out of every chunk but theirs.
 */
import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { CSS3DObject, CSS3DRenderer } from "three/addons/renderers/CSS3DRenderer.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { SceneColors } from "./player";

THREE.ColorManagement.enabled = false; /* site hex colours in, the same hex out (CSS-like blending) */

export { THREE };
export type V3 = THREE.Vector3;

/* ---------- time maths ---------- */
export const DEG = Math.PI / 180;
export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const ramp = (t: number, a: number, b: number) => clamp((t - a) / (b - a)); /* 0 before a, 1 after b */
export const win = (t: number, a: number, b: number, fi = 0.4, fo = 0.4) =>
  Math.min(ramp(t, a, a + fi), 1 - ramp(t, b - fo, b)); /* on during [a, b] */
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const eio = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const eout = (x: number) => 1 - Math.pow(1 - x, 3);
export const sine = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * x);
export const backOut = (x: number) => {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};
export function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

/* style writes only when the value changes: labels and cards are touched every frame */
const STY = new WeakMap<HTMLElement, Record<string, string>>();
export function sty(el: HTMLElement, prop: string, v: string) {
  let m = STY.get(el);
  if (!m) STY.set(el, (m = {}));
  if (m[prop] !== v) {
    m[prop] = v;
    el.style.setProperty(prop, v);
  }
}
export function cls(el: HTMLElement, name: string, on: boolean) {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

/* ---------- stage: WebGL underneath, optional HTML card layer, HTML label layer on top, one camera ---------- */
export interface Stage {
  root: HTMLDivElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  cardScene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  lineMats: Set<LineMaterial>;
  viewH: { value: number };
  w: number;
  h: number;
  setSize(w: number, h: number): void;
  render(): void;
  setOpacity(a: number): void;
  dispose(): void;
}

export function createStage(
  host: HTMLElement,
  { dpr = 1, labels = true, cards = false, fov = 30 }: { dpr?: number; labels?: boolean; cards?: boolean; fov?: number } = {},
): Stage {
  const root = document.createElement("div");
  root.className = "tp-gl"; /* scenes toggle .is-small on it for phone label rules in player.css */
  root.style.cssText = "position:absolute;inset:0";
  host.appendChild(root);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(Math.min(2, dpr));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  root.appendChild(renderer.domElement);
  let cr: CSS3DRenderer | null = null;
  if (cards) {
    cr = new CSS3DRenderer();
    cr.domElement.className = "tp-cards";
    cr.domElement.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    root.appendChild(cr.domElement);
  }
  let lr: CSS2DRenderer | null = null;
  if (labels) {
    lr = new CSS2DRenderer();
    lr.domElement.className = "tp-labels";
    lr.domElement.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    root.appendChild(lr.domElement);
  }
  const scene = new THREE.Scene();
  const cardScene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 500);
  const lineMats = new Set<LineMaterial>();
  const viewH = { value: 1 }; /* shared uniform: marks size themselves in CSS pixels */
  /* three r160's CSS renderers only check each object's own .visible, so an object inside a hidden group
     would still show. Hide those for this render, then restore, so group.visible works as for meshes. */
  const off: THREE.Object3D[] = [];
  const hideOrphans = (sc: THREE.Scene, test: (o: THREE.Object3D) => boolean) => {
    sc.traverse((o) => {
      if (!test(o) || !o.visible) return;
      let p = o.parent;
      while (p && p.visible) p = p.parent;
      if (p) {
        o.visible = false;
        off.push(o);
      }
    });
  };
  const stage: Stage = {
    root, renderer, scene, cardScene, camera, lineMats, viewH, w: 1, h: 1,
    setSize(w, h) {
      this.w = w;
      this.h = h;
      viewH.value = h;
      renderer.setSize(w, h, false);
      cr?.setSize(w, h);
      lr?.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      lineMats.forEach((m) => m.resolution.set(w, h));
    },
    render() {
      renderer.render(scene, camera);
      if (cr) {
        hideOrphans(cardScene, (o) => o instanceof CSS3DObject);
        cr.render(cardScene, camera);
      }
      if (lr) {
        hideOrphans(scene, (o) => o instanceof CSS2DObject);
        hideOrphans(cardScene, (o) => o instanceof CSS2DObject);
        lr.render(scene, camera);
      }
      for (const o of off.splice(0)) o.visible = true;
    },
    setOpacity(a) {
      sty(root, "opacity", a.toFixed(3));
    },
    dispose() {
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      root.remove();
    },
  };
  return stage;
}

export type Palette = Record<Exclude<keyof SceneColors, "dark">, THREE.Color> & { dark: boolean };
export function palette(colors: SceneColors): Palette {
  const P = { dark: !!colors.dark } as Palette;
  for (const k of Object.keys(colors) as Array<keyof SceneColors>) {
    const v = colors[k];
    if (typeof v === "string") (P as Record<string, unknown>)[k] = new THREE.Color(v);
  }
  return P;
}

/* ---------- fat lines (WebGL lineWidth is always 1px, Line2 is not) ---------- */
export type FatLine = Line2 & { material: LineMaterial; userData: { len: number } };
export function fatLine(
  stage: Stage,
  pts: THREE.Vector3[],
  { width = 1.5, opacity = 1, reveal = false, ro = 0, depth = false, dashed = false }:
  { width?: number; opacity?: number; reveal?: boolean; ro?: number; depth?: boolean; dashed?: boolean } = {},
): FatLine {
  const g = new LineGeometry();
  g.setPositions(pts.flatMap((p) => [p.x, p.y, p.z]));
  g.userData.seg = pts.length - 1;
  const m = new LineMaterial({ color: 0xffffff, linewidth: width, transparent: true, opacity, depthWrite: false, depthTest: depth });
  if (reveal) {
    m.dashed = true;
    m.dashSize = 1e-4;
    m.gapSize = 1e6;
  } else if (dashed) {
    m.dashed = true;
    m.dashSize = 0.09;
    m.gapSize = 0.07;
  }
  m.resolution.set(stage.w, stage.h);
  stage.lineMats.add(m);
  const line = new Line2(g, m) as FatLine;
  line.computeLineDistances();
  line.renderOrder = ro;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
  line.userData.len = len;
  return line;
}
/* draw a reveal line on from its start: k = 0..1 of its length */
export function drawOn(line: FatLine, k: number) {
  line.visible = k > 0.001;
  line.material.dashSize = Math.max(1e-4, k * line.userData.len);
}

/* draw a dashed (non-reveal) line on segment by segment: k = 0..1 of its points */
export function drawSegs(line: FatLine, k: number) {
  const n = (line.geometry as THREE.InstancedBufferGeometry & { userData: { seg?: number } }).userData.seg ?? 0;
  line.visible = k > 0.001;
  (line.geometry as THREE.InstancedBufferGeometry).instanceCount = Math.max(1, Math.round(clamp(k) * n));
}

/* lay a fatLine (created with the same point count) along the quadratic curve a -> c -> b, in place.
   Writes the GPU buffer only when the curve moved; dashed lines get their dash distances recomputed then. */
export function setLinePointsFromCurve(line: FatLine, pts: THREE.Vector3[], a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3) {
  const n = pts.length - 1;
  let moved = false;
  for (let i = 0; i <= n; i++) {
    const s = i / n, k0 = (1 - s) * (1 - s), k1 = 2 * (1 - s) * s, k2 = s * s;
    const x = k0 * a.x + k1 * c.x + k2 * b.x, y = k0 * a.y + k1 * c.y + k2 * b.y, z = k0 * a.z + k1 * c.z + k2 * b.z;
    const p = pts[i];
    if (Math.abs(p.x - x) + Math.abs(p.y - y) + Math.abs(p.z - z) > 1e-5) {
      p.set(x, y, z);
      moved = true;
    }
  }
  if (!moved) return;
  const data = (line.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute).data;
  const arr = data.array as Float32Array;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[i + 1], o = i * 6;
    arr[o] = p.x; arr[o + 1] = p.y; arr[o + 2] = p.z; arr[o + 3] = q.x; arr[o + 4] = q.y; arr[o + 5] = q.z;
  }
  data.needsUpdate = true;
  line.geometry.computeBoundingSphere();
  if (line.material.dashed) line.computeLineDistances();
}

/* quadratic arc from a to b, lifted `lift` above the higher end */
export function arcPoints(a: THREE.Vector3, b: THREE.Vector3, lift = 0.6, n = 48): THREE.Vector3[] {
  const c = a.clone().add(b).multiplyScalar(0.5);
  c.y = Math.max(a.y, b.y) + lift;
  return quadPoints(a, c, b, n);
}
/* quadratic curve through a control point */
export function quadPoints(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, n = 48): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n, k0 = (1 - s) * (1 - s), k1 = 2 * (1 - s) * s, k2 = s * s;
    pts.push(new THREE.Vector3(k0 * a.x + k1 * c.x + k2 * b.x, k0 * a.y + k1 * c.y + k2 * b.y, k0 * a.z + k1 * c.z + k2 * b.z));
  }
  return pts;
}
/* the point at fraction f of a polyline's length (for pulses riding a line) */
const CUM = new WeakMap<THREE.Vector3[], number[]>();
export function pointAlong(pts: THREE.Vector3[], f: number, out = new THREE.Vector3()): THREE.Vector3 {
  let cum = CUM.get(pts);
  if (!cum) {
    cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    CUM.set(pts, cum);
  }
  const s = clamp(f) * cum[cum.length - 1];
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const k = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
  return out.copy(pts[i - 1]).lerp(pts[i], clamp(k));
}

/* ---------- marks: ring nodes, discs and square markers as crisp camera-facing SDF quads ----------
   They keep a constant size in CSS pixels at any distance, antialias at any DPR, and can carry a soft halo. */
const MVS = `
uniform float uPx, uViewH, uPad;
varying vec2 vP; varying float vR;
void main(){
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float d = max(0.001, -mv.z);
  float q = uPx + 2.0 * uPad;
  float wpp = 2.0 * d / (projectionMatrix[1][1] * uViewH);
  mv.xy += position.xy * q * wpp;
  vP = position.xy * q; vR = uPx * 0.5;
  gl_Position = projectionMatrix * mv;
}`;
const MFS = `
uniform vec3 uStroke, uFill;
uniform float uBorder, uHalo, uOp, uShape, uDash;
varying vec2 vP; varying float vR;
float sdf(vec2 p, float r){
  if (uShape < 0.5) return length(p) - r;
  float rr = min(r, 3.0); vec2 q = abs(p) - vec2(r) + rr;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rr;
}
void main(){
  float d = sdf(vP, vR);
  float aa = max(fwidth(d), 0.0001) * 0.7;
  float inS = 1.0 - smoothstep(-aa, aa, d);
  float inF = 1.0 - smoothstep(-aa, aa, d + min(uBorder, vR * 0.6));
  if (uDash > 0.5) {
    float ang = atan(vP.y, vP.x);
    float on = step(0.0, sin(ang * 6.0));
    inS = mix(inF, inS, on);
  }
  float glow = uHalo > 0.0 ? exp(-max(d, 0.0) / (uHalo * 0.45)) * 0.22 : 0.0;
  vec3 c = mix(uStroke, uFill, inF);
  float a = max(inS, glow * (1.0 - inS)) * uOp;
  if (a < 0.002) discard;
  gl_FragColor = vec4(c, a);
}`;
const QUAD = new THREE.PlaneGeometry(1, 1);
export interface Mark {
  mesh: THREE.Mesh;
  u: Record<string, THREE.IUniform>;
  set(a: number, k?: number): void;
  paint(stroke: THREE.Color, fill?: THREE.Color): void;
  dash(on: boolean): void;
}
/* shape: 'ring' (stroke + fill), 'disc' (paint stroke and fill the same), 'square' (rounded) */
export function mark(
  stage: Stage,
  { shape = "ring", px = 14, border = 2.5, halo = 0, ro = 10, depth = false }:
  { shape?: "ring" | "disc" | "square"; px?: number; border?: number; halo?: number; ro?: number; depth?: boolean } = {},
): Mark {
  const u: Record<string, THREE.IUniform> = {
    uPx: { value: px }, uViewH: stage.viewH, uPad: { value: halo * 2.6 + 2 },
    uStroke: { value: new THREE.Color() }, uFill: { value: new THREE.Color() },
    uBorder: { value: border }, uHalo: { value: halo }, uOp: { value: 1 }, uShape: { value: shape === "square" ? 1 : 0 },
    uDash: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: MVS, fragmentShader: MFS, transparent: true, depthTest: depth, depthWrite: false });
  const mesh = new THREE.Mesh(QUAD, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = ro;
  return {
    mesh, u,
    /* opacity a, size multiplier k (pop-ins overshoot with backOut) */
    set(a, k = 1) {
      mesh.visible = a > 0.004;
      u.uOp.value = a;
      u.uPx.value = px * k;
    },
    paint(stroke, fill = stroke) {
      (u.uStroke.value as THREE.Color).copy(stroke);
      (u.uFill.value as THREE.Color).copy(fill);
    },
    dash(on) {
      u.uDash.value = on ? 1 : 0;
    },
  };
}

/* a unit circle for landing ripples: scale it from 0.1 to 0.6 with eout, fade with (1 - u) */
export const RING_G = new THREE.BufferGeometry().setFromPoints(
  Array.from({ length: 65 }, (_, i) => {
    const a = (i / 64) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
  }),
);

/* ---------- HTML labels: real text in the site's fonts, positioned by the 3D camera ----------
   Anchor with obj.center (0..1 of the label box) and offset with the to-r / to-l / to-u classes. */
export interface Label {
  el: HTMLDivElement;
  obj: CSS2DObject;
  set(a: number): void;
}
export function label(html: string, cl = ""): Label {
  const el = document.createElement("div");
  el.className = "tp-label " + cl;
  el.innerHTML = html;
  const obj = new CSS2DObject(el);
  return {
    el, obj,
    set(a) {
      obj.visible = a > 0.01;
      sty(el, "opacity", a.toFixed(3));
    },
  };
}

/* ---------- HTML cards in 3D: the site's own card styles, moved by the camera (CSS3D) ----------
   `px` is the card's design width; world size = px * PX. */
export const PX = 0.01;
export interface Card {
  el: HTMLDivElement;
  obj: CSS3DObject;
  w: number;
  h: number;
  set(a: number): void;
}
export function card(html: string, cl = "", width = 220): Card {
  const el = document.createElement("div");
  el.className = "tp-card " + cl;
  el.style.width = width + "px";
  el.innerHTML = html;
  const obj = new CSS3DObject(el);
  obj.scale.setScalar(PX);
  const c: Card = {
    el, obj, w: width * PX, h: 0,
    set(a) {
      obj.visible = a > 0.01;
      sty(el, "opacity", a.toFixed(3));
    },
  };
  return c;
}

/* ---------- camera ----------
   Keys: { t, dur, target: [x, y, z], dist, el, az } (degrees). Any field may be a function of T. Each key
   eases in over `dur` seconds from wherever the previous keys left the camera. seam: seconds before
   `total` over which the camera glides back to the first key, so a loop restarts without a cut. */
type Num = number | ((T: number) => number);
type Vec = [number, number, number] | ((T: number) => [number, number, number]);
export interface CamKey {
  t: number;
  dur?: number;
  target: Vec;
  dist: Num;
  el: Num;
  az: Num;
}
export interface Pose {
  x: number;
  y: number;
  z: number;
  dist: number;
  el: number;
  az: number;
}
export function cameraRig(camera: THREE.PerspectiveCamera, keys: CamKey[], { total = Infinity, seam = 0.75 } = {}) {
  const F: Array<keyof Pose> = ["x", "y", "z", "dist", "el", "az"];
  const num = (v: Num, T: number) => (typeof v === "function" ? v(T) : v);
  const pose = (k: CamKey, T: number): Pose => {
    const tg = typeof k.target === "function" ? k.target(T) : k.target;
    return { x: tg[0], y: tg[1], z: tg[2], dist: num(k.dist, T), el: num(k.el, T), az: num(k.az, T) };
  };
  return {
    poseAt(T: number): Pose {
      const p = pose(keys[0], T);
      for (let i = 1; i < keys.length; i++) {
        const k = keys[i];
        const u = ramp(T, k.t, k.t + (k.dur ?? 1.6));
        if (u <= 0) break;
        const q = pose(k, T);
        const e = eio(u);
        for (const f of F) p[f] = lerp(p[f], q[f], e);
      }
      const back = eio(ramp(T, total - seam, total));
      if (back > 0) {
        const q = pose(keys[0], 0);
        for (const f of F) p[f] = lerp(p[f], q[f], back);
      }
      return p;
    },
    /* place the camera; sway adds a slow breath so a held shot never looks frozen */
    apply(p: Pose, T: number, sway = 1) {
      const az = (p.az + 1.3 * Math.sin(T * 0.23) * sway) * DEG;
      const el = (p.el + 0.6 * Math.sin(T * 0.19 + 1) * sway) * DEG;
      camera.position.set(p.x + p.dist * Math.sin(az) * Math.cos(el), p.y + p.dist * Math.sin(el), p.z + p.dist * Math.cos(az) * Math.cos(el));
      camera.lookAt(p.x, p.y, p.z);
      camera.updateMatrixWorld();
    },
  };
}
export function orbitDir(az: number, el: number): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), Math.cos(az * DEG) * Math.cos(el * DEG));
}
/* smallest distance along `dir` from `target` that keeps every point inside the frame (margin m of NDC,
   or [mx, my] per axis). Binary search, so it holds for any fov, aspect or view offset. Cache per stage size. */
export function fitDistance(
  camera: THREE.PerspectiveCamera, target: THREE.Vector3, dir: THREE.Vector3, points: THREE.Vector3[],
  m: number | [number, number] = 0.85, lo = 0.5, hi = 600,
): number {
  const [mx, my] = typeof m === "number" ? [m, m] : m;
  const c = camera.clone();
  const v = new THREE.Vector3();
  const fits = (d: number) => {
    c.position.copy(target).addScaledVector(dir, d);
    c.lookAt(target);
    c.updateMatrixWorld();
    return points.every((p) => {
      v.copy(p).project(c);
      return v.z < 1 && Math.abs(v.x) <= mx && Math.abs(v.y) <= my;
    });
  };
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
