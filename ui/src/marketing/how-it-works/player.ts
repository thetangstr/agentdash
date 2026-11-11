/**
 * Story player for the "How it works" section (ported from the threejs-marketing-pages kit).
 *
 * Builds the chapter chips, pause button, progress ruler and caption from the story, runs one clock
 * (starts when the stage is in view, loops, pauses off screen and in hidden tabs) and drives one scene
 * module. This file never imports three: the scene loader does, so three and the scene arrive as a
 * separate chunk, and only when the player comes near the viewport and the browser has WebGL.
 *
 * Scene contract. The module's default export is a factory (or an object) returning:
 *   init(ctx)      ctx = { host, story, colors, w, h, dpr, small }        may return a Promise
 *   frame(s)       s = { t, dt, total, step, stepId, stepT, line, lineT, ch, playing }
 *                  Draw everything as a function of s.t. Carry no state between frames, so seeks,
 *                  pauses, loops and ?t= freezes always look right.
 *   resize(w, h)
 *   theme(colors)  colors from the page's CSS variables, as '#rrggbb'
 *   dispose()      optional: free the renderer when the page unmounts
 *
 * URL params: ?t=12.5 freezes on that moment (review captures), ?still=1 forces the text version.
 * window.__players lists mounted players ({ seek, state, pause, play, ready, beats, total, root })
 * for the capture script.
 */
import type { Story } from "./story";

export interface SceneColors {
  accent: string;
  fg: string;
  fg2: string;
  fg3: string;
  line: string;
  bg: string;
  surface: string;
  surface2: string;
  signal: string;
  dark: boolean;
}

export interface SceneState {
  t: number;
  dt: number;
  total: number;
  step: number;
  stepId: string;
  stepT: number;
  line: number;
  lineT: number;
  ch: number;
  playing: boolean;
}

export interface SceneInit {
  host: HTMLElement;
  story: Story;
  colors: SceneColors;
  w: number;
  h: number;
  dpr: number;
  small: boolean;
}

export interface Scene {
  init(ctx: SceneInit): void | Promise<void>;
  frame(s: SceneState): void;
  resize(w: number, h: number): void;
  theme(colors: SceneColors): void;
  dispose?(): void;
}

export type SceneModule = { default: (() => Scene) | Scene };
export type SceneLoader = () => Promise<SceneModule>;

export interface MountOptions {
  story: Story;
  scene: SceneLoader;
  /** Where the stage goes (default: the root). */
  stageHost?: HTMLElement;
  /** Where the clock, ruler and caption go (default: the root). */
  footHost?: HTMLElement;
  loop?: boolean;
  /** Defaults to the page's query string. */
  params?: URLSearchParams;
  /** Defaults to prefers-reduced-motion. */
  reducedMotion?: boolean;
}

export interface Beat {
  t: number;
  step: string;
  line: number;
}

export interface PlayerApi {
  root: HTMLElement;
  total: number;
  starts: number[];
  seek(t: number): void;
  state(): Omit<SceneState, "dt" | "playing">;
  pause(): void;
  play(): void;
  ready(): Promise<void>;
  beats(): Beat[];
  destroy(): void;
}

declare global {
  interface Window {
    __players?: PlayerApi[];
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function clock(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return String(m).padStart(2, "0") + ":" + s.toFixed(1).padStart(4, "0");
}

/* any CSS colour (oklch, color-mix, rgba...) -> '#rrggbb' as it shows over `base`, through a 1px canvas */
let cx: CanvasRenderingContext2D | null | undefined;
function hex(css: string, base: string): string {
  if (cx === undefined) {
    try {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      cx = cv.getContext("2d", { willReadFrequently: true });
    } catch {
      cx = null;
    }
  }
  if (!cx) return "#000000";
  cx.clearRect(0, 0, 1, 1);
  cx.fillStyle = base;
  cx.fillRect(0, 0, 1, 1);
  cx.fillStyle = "#000";
  cx.fillStyle = css;
  cx.fillRect(0, 0, 1, 1);
  const d = cx.getImageData(0, 0, 1, 1).data;
  return "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
}

const TOKENS = {
  accent: "--accent", fg: "--fg", fg2: "--fg-2", fg3: "--fg-3", line: "--line",
  bg: "--bg", surface: "--surface", surface2: "--surface-2", signal: "--signal",
} as const;
type TokenKey = keyof typeof TOKENS;

export function readColors(scope: HTMLElement): SceneColors {
  const probe = el("span");
  probe.style.display = "none";
  scope.appendChild(probe);
  const raw = {} as Record<TokenKey, string>;
  for (const k of Object.keys(TOKENS) as TokenKey[]) {
    probe.style.color = "var(" + TOKENS[k] + ")";
    raw[k] = getComputedStyle(probe).color;
  }
  probe.remove();
  const surface = hex(raw.surface, "#ffffff");
  const out = { surface } as Record<TokenKey, string>;
  /* translucent tokens (hairlines) become the colour they actually show on the stage */
  for (const k of Object.keys(raw) as TokenKey[]) if (!out[k]) out[k] = hex(raw[k], surface);
  const n = parseInt(surface.slice(1), 16);
  const dark = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 < 0.45;
  return { ...out, dark };
}

/** True when the browser can make a WebGL context. Checked before three is downloaded. */
export function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';

export function mount(root: HTMLElement, opts: MountOptions): PlayerApi {
  const story = opts.story;
  const params = opts.params ?? new URLSearchParams(window.location.search);
  const loopOn = opts.loop ?? true;
  const steps = story.steps;
  const chapters = story.chapters;
  const starts: number[] = [];
  let total = 0;
  steps.forEach((s) => {
    starts.push(total);
    total += s.dur;
  });

  const players = (window.__players = window.__players || []);
  const cleanups: Array<() => void> = [];
  const added: HTMLElement[] = [];
  let destroyed = false;

  const clampT = (x: number) => Math.max(0, Math.min(total - 0.001, x));
  const still = (opts.reducedMotion ?? prefersReducedMotion()) || params.get("still") === "1";
  let t = params.has("t") ? clampT(Number(params.get("t")) || 0) : 0;
  let userPaused = params.has("t"); /* ?t= freezes on that moment (for review captures) */
  let inView = false;
  let speed = 1;
  let scene: Scene | null = null;
  let loading: Promise<void> | null = null;
  let raf = 0;
  let last = 0;

  root.classList.add("tp-player");

  const stateAt = (tt: number) => {
    let i = 0;
    while (i < steps.length - 1 && tt >= starts[i + 1]) i++;
    const s = steps[i];
    const stepT = Math.min(1, Math.max(0, (tt - starts[i]) / s.dur));
    const n = Math.max(1, s.lines.length);
    const line = Math.min(n - 1, Math.floor(stepT * n));
    return { t: tt, total, step: i, stepId: s.id, stepT, line, lineT: Math.min(1, stepT * n - line), ch: s.ch };
  };

  const api: PlayerApi = {
    root,
    total,
    starts,
    seek: (tt) => seek(tt),
    state: () => stateAt(t),
    pause: () => {
      userPaused = true;
      sync();
    },
    play: () => {
      userPaused = false;
      sync();
    },
    ready: () => (still ? Promise.resolve() : load()),
    /* the settled moment of every caption line (80% through it, clear of the loop fade): what reviewers judge */
    beats: () =>
      steps.flatMap((s, i) =>
        s.lines.map((_, j) => ({
          t: +Math.min(total - 0.8, starts[i] + ((j + 0.8) * s.dur) / s.lines.length).toFixed(3),
          step: s.id,
          line: j,
        })),
      ),
    destroy,
  };
  players.push(api);

  /* reduced motion or ?still=1: the story is the text StoryText renders; no stage, no three */
  if (still) {
    root.classList.add("is-still");
    return api;
  }

  /* ---------- DOM ---------- */
  const stage = el("div", "tp-stage");
  const host = el("div", "tp-canvas");
  host.setAttribute("aria-hidden", "true");
  const pauseBtn = el("button", "tp-pause");
  pauseBtn.type = "button";
  pauseBtn.addEventListener("click", () => {
    userPaused = !userPaused;
    sync();
  });
  stage.append(host);

  const chips = el("div", "tp-chips");
  const chipEls = chapters.map((c, i) => {
    const first = starts[steps.findIndex((s) => s.ch === i)] || 0;
    const b = el("button", "tp-chip");
    b.type = "button";
    b.append(el("span", "tp-chip-n", c.n), el("span", "tp-chip-l", c.label));
    if (c.status) b.append(el("span", "tp-chip-s", c.status));
    b.setAttribute("aria-label", "Play from " + c.label);
    b.addEventListener("click", () => {
      seek(first + 0.001);
    });
    chips.appendChild(b);
    return b;
  });
  if (chapters.length) stage.appendChild(chips);
  stage.append(pauseBtn);
  (opts.stageHost ?? root).appendChild(stage);
  added.push(stage);

  const foot = el("div", "tp-foot");
  const scale = el("div", "tp-scale");
  const nowEl = el("span", "tp-now");
  scale.append(nowEl, el("span", "tp-total", clock(total)));
  const ruler = el("div", "tp-ruler");
  const fill = el("div", "tp-fill");
  ruler.appendChild(fill);
  const dots = steps.map((s, i) => {
    if (s.ch < 0) return null;
    const d = el("button", "tp-dot");
    d.type = "button";
    d.style.left = (starts[i] / total) * 100 + "%";
    d.setAttribute("aria-label", "Play from " + (s.title || "step " + (i + 1)));
    d.addEventListener("click", () => seek(starts[i] + 0.001));
    ruler.appendChild(d);
    return d;
  });
  /* the caption repeats the story text for sighted readers; screen readers get StoryText instead */
  const cap = el("div", "tp-cap");
  cap.setAttribute("aria-hidden", "true");
  const capK = el("span", "tp-cap-k");
  const capT = el("p", "tp-cap-t");
  cap.append(capK, capT);
  foot.append(scale, ruler, cap);
  (opts.footHost ?? root).appendChild(foot);
  added.push(foot);

  let shown = "";
  const paintUI = (st: ReturnType<typeof stateAt> & { playing: boolean }) => {
    const s = steps[st.step];
    const key = st.step + ":" + st.line;
    if (key !== shown) {
      shown = key;
      const nIn = steps.slice(0, st.step + 1).filter((x) => x.ch === s.ch).length;
      capK.textContent = s.ch < 0 ? story.brand : String(nIn).padStart(2, "0") + " / " + s.title;
      capT.classList.remove("in");
      void capT.offsetWidth; /* restart the caption's entrance (only while playing: seeks and freezes show it settled) */
      capT.textContent = s.lines[st.line] || "";
      if (st.playing) capT.classList.add("in");
      cap.classList.toggle("is-end", s.ch < 0);
      chipEls.forEach((b, i) => {
        if (i === s.ch) b.setAttribute("aria-current", "step");
        else b.removeAttribute("aria-current");
      });
      dots.forEach((d, i) => {
        if (d) d.classList.toggle("is-done", i <= st.step);
      });
    }
    fill.style.width = (st.t / total) * 100 + "%";
    nowEl.textContent = clock(st.t);
  };

  /* ---------- clock ---------- */
  let colors = readColors(root);
  const isPlaying = () => inView && !document.hidden && !userPaused && !!scene && !destroyed;
  function render(dt: number) {
    const st = { ...stateAt(t), dt, playing: isPlaying() };
    paintUI(st);
    if (scene) scene.frame(st);
  }
  function loop(now: number) {
    raf = 0;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (!isPlaying()) return;
    t += dt * speed;
    if (t >= total) {
      if (loopOn) t %= total;
      else {
        t = total - 0.001;
        userPaused = true;
        sync();
        return;
      }
    }
    render(dt);
    raf = requestAnimationFrame(loop);
  }
  function sync() {
    if (destroyed || still) return;
    pauseBtn.innerHTML = userPaused ? PLAY : PAUSE;
    pauseBtn.setAttribute("aria-label", userPaused ? "Play animation" : "Pause animation");
    root.classList.toggle("is-paused", userPaused);
    if (isPlaying() && !raf) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
    if (!isPlaying()) render(0);
  }
  function seek(tt: number) {
    t = clampT(tt);
    if (!destroyed && !still) render(0);
  }

  /* ---------- scene loading: three and the scene arrive only near the viewport ---------- */
  function size() {
    const r = host.getBoundingClientRect();
    return { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
  }
  function fail(reason: string, err?: unknown) {
    root.classList.remove("is-loading");
    root.classList.add("is-failed");
    /* a warning, not an error: the text story takes the stage's place and the page carries on */
    console.warn("how-it-works: " + reason, err ?? "");
  }
  function load(): Promise<void> {
    if (loading) return loading;
    if (!hasWebGL()) {
      fail("WebGL is unavailable, showing the text story");
      loading = Promise.resolve();
      return loading;
    }
    root.classList.add("is-loading");
    loading = opts
      .scene()
      .then(async (mod) => {
        if (destroyed) return;
        const sc = typeof mod.default === "function" ? mod.default() : mod.default;
        const { w, h } = size();
        await sc.init({ host, story, colors, w, h, dpr: Math.min(2, window.devicePixelRatio || 1), small: w < 560 });
        if (destroyed) {
          sc.dispose?.();
          return;
        }
        scene = sc;
        root.classList.remove("is-loading");
        root.classList.add("is-ready");
        render(0);
        sync();
      })
      .catch((err) => fail("the scene failed to load, showing the text story", err));
    return loading;
  }

  render(0);
  sync();

  if (typeof IntersectionObserver === "function") {
    const near = new IntersectionObserver((en) => {
      if (en.some((e) => e.isIntersecting)) void load();
    }, { rootMargin: "700px 0px" });
    near.observe(root);
    const view = new IntersectionObserver((en) => {
      inView = en[0].isIntersecting;
      sync();
    }, { threshold: 0.25 });
    view.observe(stage);
    cleanups.push(() => near.disconnect(), () => view.disconnect());
  } else {
    inView = true;
    void load();
  }
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => {
      if (scene) {
        const { w, h } = size();
        scene.resize(w, h);
        render(0);
      }
    });
    ro.observe(host);
    cleanups.push(() => ro.disconnect());
  }
  document.addEventListener("visibilitychange", sync);
  cleanups.push(() => document.removeEventListener("visibilitychange", sync));

  /* the marketing site is light only today; if it ever switches theme on <html> or <body>, re-colour */
  const retheme = new MutationObserver(() => {
    colors = readColors(root);
    if (scene) {
      scene.theme(colors);
      render(0);
    }
  });
  for (const n of [document.documentElement, document.body].filter(Boolean)) {
    retheme.observe(n, { attributes: true, attributeFilter: ["data-theme", "class"] });
  }
  cleanups.push(() => retheme.disconnect());

  /* review controls, sent by the review page that frames this one (speed, height, freeze, play) */
  const onMessage = (e: MessageEvent) => {
    if (window.parent === window || e.source !== window.parent) return;
    const m = e.data as { type?: string; speed?: number; hk?: string; t?: number; play?: boolean } | null;
    if (!m || m.type !== "tp-mock") return;
    if (m.speed) speed = +m.speed;
    if (m.hk) root.style.setProperty("--tp-hk", String(m.hk));
    if (m.t != null) {
      userPaused = true;
      seek(+m.t);
      sync();
    }
    if (m.play) {
      userPaused = false;
      sync();
    }
  };
  window.addEventListener("message", onMessage);
  cleanups.push(() => window.removeEventListener("message", onMessage));

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    for (const c of cleanups.splice(0)) c();
    scene?.dispose?.();
    scene = null;
    for (const n of added.splice(0)) n.remove();
    root.classList.remove("tp-player", "is-still", "is-failed", "is-loading", "is-ready", "is-paused");
    const i = players.indexOf(api);
    if (i >= 0) players.splice(i, 1);
  }

  return api;
}
