// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type Scene, type SceneState } from "./player";
import { STORY, storyTimes } from "./story";

/* a manual clock for requestAnimationFrame, and a controllable IntersectionObserver */
let rafQueue: Array<(t: number) => void> = [];
let now = 0;
const observers: Array<{ cb: IntersectionObserverCallback; opts?: IntersectionObserverInit; targets: Element[] }> = [];

function tick(ms: number) {
  now += ms;
  const q = rafQueue;
  rafQueue = [];
  q.forEach((f) => f(now));
}
/* advance the page clock in ~60 fps frames (the player caps one frame's step at 0.1 s) */
function run(ms: number) {
  for (let left = ms; left > 0; left -= 16) tick(Math.min(16, left));
}
function setVisible(visible: boolean) {
  /* the view observer is the one with a threshold; the near observer has a rootMargin */
  for (const o of observers) {
    o.cb(o.targets.map((target) => ({ isIntersecting: visible, target }) as IntersectionObserverEntry), {} as IntersectionObserver);
  }
}
function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  rafQueue = [];
  now = 0;
  observers.length = 0;
  vi.stubGlobal("requestAnimationFrame", (f: (t: number) => void) => {
    rafQueue.push(f);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: IntersectionObserverCallback;
      entry: { cb: IntersectionObserverCallback; opts?: IntersectionObserverInit; targets: Element[] };
      constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
        this.cb = cb;
        this.entry = { cb, opts, targets: [] };
        observers.push(this.entry);
      }
      observe(el: Element) {
        this.entry.targets.push(el);
      }
      disconnect() {
        const i = observers.indexOf(this.entry);
        if (i >= 0) observers.splice(i, 1);
      }
    },
  );
  /* a WebGL context that exists, so the player goes on to load the (fake) scene */
  HTMLCanvasElement.prototype.getContext = ((kind: string) =>
    kind.startsWith("webgl") ? { getExtension: () => null } : null) as unknown as HTMLCanvasElement["getContext"];
  setHidden(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  window.__players = [];
});

function fakeScene() {
  const frames: SceneState[] = [];
  const disposed = { n: 0 };
  const scene: Scene = {
    init() {},
    frame(s) {
      frames.push(s);
    },
    resize() {},
    theme() {},
    dispose() {
      disposed.n++;
    },
  };
  return { scene, frames, disposed };
}

async function mountPlayer(params = "") {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const fake = fakeScene();
  const player = mount(root, {
    story: STORY,
    scene: async () => ({ default: () => fake.scene }),
    params: new URLSearchParams(params),
    reducedMotion: false,
  });
  setVisible(true);
  await player.ready();
  return { root, player, ...fake };
}

describe("story player", () => {
  it("plays while the stage is on screen and the tab is visible", async () => {
    const { player } = await mountPlayer();
    tick(16);
    run(1000);
    run(1000);
    expect(player.state().t).toBeGreaterThan(1.5);
  });

  it("pauses off screen and resumes when back in view", async () => {
    const { player } = await mountPlayer();
    tick(16);
    run(500);
    setVisible(false);
    const t = player.state().t;
    run(1000);
    run(1000);
    expect(player.state().t).toBe(t);
    expect(rafQueue).toHaveLength(0);
    setVisible(true);
    tick(16);
    run(500);
    expect(player.state().t).toBeGreaterThan(t);
  });

  it("pauses in a hidden tab", async () => {
    const { player } = await mountPlayer();
    tick(16);
    run(500);
    setHidden(true);
    const t = player.state().t;
    run(1000);
    expect(player.state().t).toBe(t);
    setHidden(false);
    tick(16);
    run(400);
    expect(player.state().t).toBeGreaterThan(t);
  });

  it("freezes on ?t= and draws that exact moment", async () => {
    const { player, frames } = await mountPlayer("t=21.5");
    run(1000);
    expect(player.state().t).toBe(21.5);
    expect(frames.at(-1)?.t).toBe(21.5);
    expect(frames.at(-1)?.stepId).toBe("rules");
  });

  it("loops back to the start after the end card", async () => {
    const { player } = await mountPlayer();
    const { total } = storyTimes();
    player.seek(total - 0.05);
    player.play();
    tick(16);
    run(100);
    expect(player.state().t).toBeLessThan(1);
  });

  it("gives the review capture one settled beat per caption line", async () => {
    const { player } = await mountPlayer();
    expect(player.beats()).toHaveLength(13);
  });

  it("cleans up on destroy: no stage, no observers, scene disposed, not listed", async () => {
    const { root, player, disposed } = await mountPlayer();
    expect(root.querySelector(".tp-stage")).not.toBeNull();
    player.destroy();
    expect(root.querySelector(".tp-stage")).toBeNull();
    expect(root.classList.contains("tp-player")).toBe(false);
    expect(observers).toHaveLength(0);
    expect(disposed.n).toBe(1);
    expect(window.__players).not.toContain(player);
  });
});
