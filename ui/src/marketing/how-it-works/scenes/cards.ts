/**
 * CARDS: the "floating panels" treatment of the How it works story.
 *
 * The marketing site's own mini-cards float in 3D (CSS3D), joined by thin lines drawn in WebGL underneath
 * them: You (the accountable person), the Chief of Staff, and the agents from the plan. One agent,
 * Research, gets its operating Profile, Access rules and Scorecard flipping into the middle slot, each
 * joined to the people and agents it concerns. Pulses ride the lines for requests and approvals.
 *
 * Every card position, flip, tag and line is a function of story time (frame(s) reads s.t only), so
 * seeks, pauses, loops and ?t= captures are exact. Desktop and phone have their own layouts; the camera
 * fits the cards each caption line is about.
 */
import {
  THREE, DEG, clamp, ramp, win, lerp, eio, eout, backOut, sty, cls,
  createStage, palette, fatLine, drawSegs, setLinePointsFromCurve, mark, card, cameraRig, orbitDir, fitDistance, PX,
  type Stage, type Palette, type FatLine, type Mark, type Card, type CamKey, type Pose,
} from "../kit";
import type { Scene, SceneColors, SceneInit, SceneState } from "../player";
import type { Story } from "../story";

const V3 = THREE.Vector3;
type XYZ = [number, number, number];
type Layout = "d" | "p";

/* ---------- the cards: the site's mini-card markup (player.css .tp-card) ---------- */
const tag = (text: string, k = "", kind = "") => `<span class="tp-tag ${kind}"${k ? ` data-k="${k}"` : ""}>${text}</span>`;
const row = (k: string, v: string, attrs = "") => `<div class="tp-card__row"${attrs}><span>${k}</span><span>${v}</span></div>`;
const head = (kind: string, right = "") => `<div class="tp-card__head"><span class="tp-card__kind">${kind}</span>${right}</div>`;

interface CardSpec {
  id: string;
  w: { d: number; p: number };
  html: (n: Story["names"]) => string;
  cl?: string;
  pos: { d: XYZ; p: XYZ };
  end?: { d?: XYZ; p?: XYZ | null };
  tilt?: { d?: number; p?: number };
}

const CARDS: CardSpec[] = [
  {
    id: "you", w: { d: 186, p: 158 }, pos: { d: [-4.6, 0.75, 0], p: [-0.9, 2.72, 0] },
    html: (n) => head("Person") + `<div class="tp-card__name">${n.you}</div><div class="tp-card__sub">Accountable person</div>` +
      `<div class="tp-card__status tp-swap">${tag("Always reachable", "reached", "is-on")}${tag("Your decision", "decide", "is-wait")}</div>`,
  },
  {
    id: "cos", w: { d: 206, p: 170 }, pos: { d: [0, 2.3, 0], p: [0.9, 2.72, 0] },
    html: (n) => head("Agent") + `<div class="tp-card__name">${n.cos}</div>` +
      `<div class="tp-card__sub tp-swap"><span data-k="plans">Plans the team</span><span data-k="pm">Performance manager</span></div>`,
  },
  {
    id: "plan", w: { d: 250, p: 250 }, pos: { d: [0, -0.15, 0.25], p: [0, 0.82, 0.2] },
    html: (n) => head("Team plan", `<span class="tp-swap">${tag("Draft", "draft", "is-wait")}${tag("Confirmed", "confirmed", "is-on")}</span>`) +
      `<div class="tp-card__name">Proposed team</div>` +
      `<ul class="tp-card__list">${n.agents.map((a) => `<li>${a}</li>`).join("")}</ul>` +
      `<div class="tp-card__foot">Drafted by the ${n.cos}</div>`,
  },
  {
    id: "hire", w: { d: 214, p: 214 }, cl: "is-ghost", pos: { d: [-3.35, -1.6, 0.2], p: [0.32, 0.22, 0.85] }, tilt: { p: -2.5 },
    html: () => head("New hire", tag("Waiting", "", "is-wait")) +
      `<div class="tp-card__name">Beyond the plan</div><div class="tp-card__sub">Not hired until you approve</div>`,
  },
  {
    id: "research", w: { d: 200, p: 166 }, pos: { d: [4.6, 0.95, 0], p: [-0.92, -1.12, 0] },
    html: (n) => head("Agent") + `<div class="tp-card__name">${n.agents[0]}</div><div class="tp-card__sub">From the plan</div>` +
      `<div class="tp-card__status tp-swap">${tag("Active", "active")}${tag("Active · not paused", "notpaused", "is-on")}</div>`,
  },
  {
    id: "sales", w: { d: 172, p: 150 }, cl: "is-small", pos: { d: [4.4, -0.62, 0], p: [0.95, -0.72, 0] },
    html: (n) => head("Agent") + `<div class="tp-card__name">${n.agents[1]}</div><div class="tp-card__sub">From the plan</div>`,
  },
  {
    id: "support", w: { d: 172, p: 150 }, cl: "is-small", pos: { d: [4.4, -1.78, 0], p: [0.95, -1.62, 0] },
    html: (n) => head("Agent") + `<div class="tp-card__name">${n.agents[2]}</div><div class="tp-card__sub">From the plan</div>`,
  },
  {
    id: "profile", w: { d: 250, p: 250 }, pos: { d: [0, -0.15, 0.25], p: [0, 0.82, 0.2] },
    end: { d: [-0.5, 0.78, -0.8], p: [-0.24, 1.5, -0.7] },
    html: (n) => head("Operating profile", `<span class="tp-swap">${tag("v1", "v1")}${tag("v2 applied", "v2", "is-on")}</span>`) +
      `<div class="tp-card__name">${n.agents[0]}</div><div class="tp-card__rows">` +
      row("Job", `<span class="tp-swap"><span data-k="job1">Weekly market research for Sales</span><span data-k="job2">Weekly market research for Sales, <b class="tp-new">plus support themes</b></span></span>`) +
      row("Written by", n.you) + `</div>`,
  },
  {
    id: "proposal", w: { d: 232, p: 228 }, pos: { d: [-3.3, -1.5, 0.2], p: [0.3, 0.12, 0.85] }, tilt: { p: -2.5 },
    html: () => head("Proposed change", tag("v2")) + `<div class="tp-card__rows">` +
      row("Job", `<b class="tp-new">+ support themes</b>`) +
      row("Status", `<span class="tp-swap"><span data-k="pwait">Waiting for approval</span><span data-k="pok" class="tp-ok">Approved by You</span></span>`) + `</div>`,
  },
  {
    id: "access", w: { d: 250, p: 250 }, pos: { d: [0, -0.15, 0.25], p: [0, 0.82, 0.2] },
    end: { d: [-0.25, 0.32, -0.4], p: [-0.12, 1.16, -0.35] },
    html: (n) => head("Access rules", `<span class="tp-swap">${tag("Shadow", "mshadow", "is-wait")}${tag("Enforce", "menforce", "is-on")}</span>`) +
      `<div class="tp-card__name">${n.agents[0]}</div><div class="tp-card__rows">` +
      row("Sees", "Research projects") + row("Does", "Creates and updates issues") + row("Talks to", `${n.cos}, ${n.agents[1]}`) + `</div>`,
  },
  {
    id: "log", w: { d: 236, p: 228 }, pos: { d: [2.05, -2.05, 0.35], p: [0.3, 0.12, 0.85] }, tilt: { p: -2.5 },
    html: () => head("Shadow log", tag("Logged", "", "is-wait")) + `<div class="tp-card__name">Would refuse</div><div class="tp-card__rows">` +
      row("Request", "Open Support project") + row("Result", "Allowed. Nothing refused") + `</div>`,
  },
  {
    id: "refusal", w: { d: 236, p: 228 }, cl: "is-signal", pos: { d: [2.05, -2.05, 0.35], p: [0.3, 0.12, 0.85] }, tilt: { p: -2.5 },
    html: () => head("Enforce", tag("Refused", "", "is-signal")) + `<div class="tp-card__name">Request refused</div><div class="tp-card__rows">` +
      row("Request", "Open Support project") + row("Reason", "Not in its projects") + `</div>`,
  },
  {
    id: "scorecard", w: { d: 250, p: 250 }, pos: { d: [0, -0.15, 0.25], p: [0, 0.82, 0.2] },
    end: { d: [0, -0.15, 0.25], p: [0, 0.82, 0.2] },
    html: (n) => head("Scorecard", tag("From records")) + `<div class="tp-card__name">${n.agents[0]}</div><div class="tp-card__rows">` +
      row("Work owed", "12 of 14 delivered", ' data-k="r1"') + row("Quality", "4 of 5 checks passed", ' data-k="r2"') +
      row("Cost", "Unknown", ' data-k="r3" data-h="unknown" class="tp-card__row is-unknown"') + `</div>`,
  },
  {
    id: "rec", w: { d: 236, p: 228 }, pos: { d: [-3.3, -1.5, 0.2], p: [0.3, 0.12, 0.85] }, tilt: { p: -2.5 },
    end: { d: [-3.3, -1.5, 0.2], p: null },
    html: (n) => head("Recommendation") + `<div class="tp-card__name">Pause ${n.agents[0]}</div><div class="tp-card__rows">` +
      row("Why", "2 owed tasks not delivered") + row("From", n.cos) + row("Decision", `<span class="tp-wait">A person's</span>`) + `</div>`,
  },
];

/* lines join card centres (the card layer sits above the canvas, so each line seems to leave the card's edge) */
interface LineSpec {
  id: string;
  a: string;
  b: string;
  bend?: { d?: [number, number]; p?: [number, number] }; /* control point offset from the midpoint */
  dashed?: boolean;
  /* draw-on window [t0, t1] (a pulse rides it from a to b), the opacity it settles at, and when it fades */
  draw: (at: At) => [number, number];
  out?: (at: At) => number;
  rest?: number;
  reach?: number; /* draw only this fraction of the way (a request stopped by the server) */
  signalAt?: (at: At) => number; /* turn to the refusal colour from this time */
  pulse?: boolean;
}
type At = (step: string, sec?: number) => number;

const LINES: LineSpec[] = [
  { id: "you-cos", a: "you", b: "cos", bend: { d: [-0.6, 0.5], p: [0, 0.35] }, draw: (at) => [at("brief", 0.25), at("brief", 1.05)], rest: 0.5, pulse: true },
  { id: "cos-plan", a: "cos", b: "plan", draw: (at) => [at("brief", 1.05), at("brief", 1.45)], out: (at) => at("profile", 0.1), pulse: true },
  { id: "you-plan", a: "you", b: "plan", bend: { d: [0, -0.2], p: [-0.5, 0] }, draw: (at) => [at("confirm", 0.2), at("confirm", 0.85)], out: (at) => at("profile", 0.1), pulse: true },
  { id: "plan-research", a: "plan", b: "research", bend: { p: [-0.3, 0] }, draw: (at) => [at("confirm", 0.8), at("confirm", 1.2)], out: (at) => at("profile", 0.1), rest: 0.6 },
  { id: "plan-sales", a: "plan", b: "sales", draw: (at) => [at("confirm", 0.9), at("confirm", 1.3)], out: (at) => at("profile", 0.1), rest: 0.6 },
  { id: "plan-support", a: "plan", b: "support", draw: (at) => [at("confirm", 1.0), at("confirm", 1.4)], out: (at) => at("profile", 0.1), rest: 0.6 },
  { id: "cos-hire", a: "cos", b: "hire", dashed: true, bend: { d: [-1.0, 0.3], p: [1.3, 0] }, draw: (at) => [at("confirm", 1.55), at("confirm", 2.05)], out: (at) => at("profile", 0.1), pulse: true },
  { id: "hire-you", a: "hire", b: "you", dashed: true, bend: { d: [-0.3, 0], p: [-1.4, 0] }, draw: (at) => [at("confirm", 2.05), at("confirm", 2.5)], out: (at) => at("profile", 0.1) },
  { id: "subject-research", a: "plan", b: "research", bend: { p: [-0.25, 0] }, draw: (at) => [at("profile", 0.2), at("profile", 0.7)], rest: 0.6 },
  { id: "you-subject", a: "you", b: "plan", bend: { d: [0, -0.2], p: [-0.5, 0] }, draw: (at) => [at("profile", 0.35), at("profile", 0.95)], rest: 0.45, pulse: true },
  { id: "you-proposal", a: "you", b: "proposal", bend: { d: [-0.3, 0], p: [-1.2, 0] }, draw: (at) => [at("proposal", 1.0), at("proposal", 1.7)], out: (at) => at("rules", 0.1), pulse: true },
  { id: "proposal-subject", a: "proposal", b: "plan", bend: { d: [0.2, -0.4] }, draw: (at) => [at("proposal", 1.75), at("proposal", 2.2)], out: (at) => at("rules", 0.1), pulse: true },
  { id: "req-shadow", a: "research", b: "support", dashed: true, bend: { d: [1.9, 0], p: [0, -1.5] }, draw: (at) => [at("shadow", 0.25), at("shadow", 1.05)], out: (at) => at("enforce", 0.15), pulse: true },
  { id: "req-enforce", a: "research", b: "support", bend: { d: [1.9, 0], p: [0, -1.5] }, reach: 0.5, draw: (at) => [at("enforce", 0.25), at("enforce", 0.8)], signalAt: (at) => at("enforce", 0.8), out: (at) => at("reachable", 0.3) },
  { id: "research-you", a: "research", b: "you", bend: { d: [0, 3.0], p: [-1.7, 0] }, draw: (at) => [at("reachable", 0.25), at("reachable", 1.35)], out: (at) => at("scorecard", 0.2), pulse: true },
  { id: "subject-cos", a: "plan", b: "cos", draw: (at) => [at("recommend", 0.2), at("recommend", 0.85)], rest: 0.5, pulse: true },
  { id: "cos-rec", a: "cos", b: "rec", bend: { d: [-1.2, 0.4], p: [1.3, 0] }, draw: (at) => [at("recommend", 0.85), at("recommend", 1.3)], rest: 0.5, pulse: true },
  { id: "rec-you", a: "rec", b: "you", bend: { d: [-0.3, 0], p: [-1.4, 0] }, draw: (at) => [at("people", 0.2), at("people", 1.05)], rest: 0.6, pulse: true },
];

/* an extra pulse on an existing line, running from b to a (records flowing into the scorecard) */
const BACK_PULSES: Array<{ line: string; at: (at: At) => [number, number] }> = [
  { line: "subject-research", at: (at) => [at("scorecard", 0.2), at("scorecard", 0.75)] },
];

/* which cards each caption line is about: the camera fits them, per layout */
const FOCUS: Record<string, { d: string[]; p: string[] }> = {
  brief: { d: ["you", "cos", "plan"], p: ["you", "cos", "plan"] },
  confirm: { d: ["you", "cos", "plan", "research", "sales", "support", "hire"], p: ["plan", "research", "sales", "support"] },
  profile: { d: ["you", "plan", "research"], p: ["plan", "research", "sales"] },
  proposal: { d: ["you", "cos", "plan", "proposal"], p: ["you", "cos", "plan"] },
  rules: { d: ["plan", "research", "sales", "support"], p: ["plan", "research", "sales"] },
  shadow: { d: ["plan", "research", "support", "log", "req"], p: ["plan", "research", "support", "req"] },
  enforce: { d: ["plan", "research", "support", "log", "req"], p: ["plan", "research", "support", "req"] },
  reachable: { d: ["you", "cos", "research", "plan", "arc"], p: ["you", "cos", "research", "arc"] },
  scorecard: { d: ["plan", "research", "sales", "support"], p: ["plan", "research", "sales"] },
  unknown: { d: ["plan"], p: ["plan"] },
  recommend: { d: ["cos", "plan", "rec"], p: ["cos", "plan"] },
  people: { d: ["you", "cos", "plan", "research", "rec"], p: ["you", "cos", "plan", "research"] },
  end: { d: ["you", "cos", "plan", "research", "sales", "support", "rec"], p: ["you", "cos", "plan", "research", "sales", "support"] },
};
/* extra points the camera must keep in frame (curves that leave the cards) */
const EXTRA: Record<string, { d: XYZ[]; p: XYZ[] }> = {
  req: { d: [[5.75, -0.4, 0]], p: [[0, -2.35, 0]] },
  arc: { d: [[0, 3.05, 0]], p: [[-1.85, 0.8, 0]] },
};
const VIEW: Record<string, { az: number; el: number }> = {
  brief: { az: -7, el: 6 }, confirm: { az: 4, el: 7 }, profile: { az: -4, el: 5 }, proposal: { az: -8, el: 7 },
  rules: { az: 7, el: 6 }, shadow: { az: 9, el: 8 }, enforce: { az: 6, el: 7 }, reachable: { az: -3, el: 6 },
  scorecard: { az: 5, el: 5 }, unknown: { az: 2, el: 4 }, recommend: { az: -6, el: 6 }, people: { az: -2, el: 7 },
  end: { az: 0, el: 10 },
};

const SLOT = new Set(["plan", "profile", "access", "scorecard"]);
const TRANSIENT = new Set(["hire", "proposal", "log", "refusal", "rec"]);

interface StepT { id: string; ch: number; s: number; d: number }
interface CardObj { spec: CardSpec; c: Card; keys: Map<string, HTMLElement[]>; hl: Map<string, HTMLElement[]>; h: { d: number; p: number } }
interface LineObj { spec: LineSpec; line: FatLine; head: Mark | null; t0: number; t1: number; tOut: number; tSignal: number; pts: THREE.Vector3[] }

export default function createCards(): Scene {
  let S!: Stage;
  let P = {} as Palette;
  let story!: Story;
  let total = 1, tEnd = 1, small = false;
  let rig!: ReturnType<typeof cameraRig>;
  let poseCache: { key: string; poses: Record<string, Pose> } | null = null;
  let barrier!: Mark;
  const steps: StepT[] = [];
  const cards = new Map<string, CardObj>();
  const lines: LineObj[] = [];
  const back: Array<{ L: LineObj; t0: number; t1: number; head: Mark }> = [];
  const paint: Array<() => void> = [];
  /* when each card is on stage: [in, out] (absolute seconds); filled in init */
  const shows = new Map<string, Array<[number, number]>>();
  const keyWins = new Map<string, [number, number]>();
  const hlWins = new Map<string, [number, number]>();
  const focusWin = new Map<string, number>();
  const tmpA = new V3(), tmpB = new V3(), tmpC = new V3(), tmpP = new V3();
  const L = (): Layout => (small ? "p" : "d");

  const at: At = (id, sec = 0) => {
    const st = steps.find((x) => x.id === id);
    return st ? st.s + sec : 0;
  };

  /* ---------- timing: when cards, tags and highlights are on ---------- */
  function schedule() {
    const NEVER = 1e9;
    const set = (id: string, ...w: Array<[number, number]>) => shows.set(id, w);
    set("you", [-1, NEVER]);
    set("cos", [-1, NEVER]);
    set("plan", [at("brief", 1.3), at("profile", 0.15)]);
    set("hire", [at("confirm", 2.0), at("profile", 0.15)]);
    set("research", [at("confirm", 0.95), NEVER]);
    set("sales", [at("confirm", 1.1), NEVER]);
    set("support", [at("confirm", 1.25), NEVER]);
    set("profile", [at("profile", 0.2), at("rules", 0.2)], [tEnd + 0.35, NEVER]);
    set("proposal", [at("proposal", 0.25), small ? at("proposal", 2.55) : at("rules", 0.1)]);
    set("access", [at("rules", 0.2), at("scorecard", 0.2)], [tEnd + 0.2, NEVER]);
    set("log", [at("shadow", 1.0), at("enforce", 0.2)]);
    set("refusal", [at("enforce", 1.0), at("reachable", 0.3)]);
    set("scorecard", [at("scorecard", 0.25), NEVER]);
    set("rec", [at("recommend", 0.95), small ? tEnd + 0.1 : NEVER]);
    const k = (key: string, a: number, b = NEVER) => keyWins.set(key, [a, b]);
    k("reached", at("reachable", 1.3), at("scorecard", 0.1));
    k("decide", at("people", 1.05));
    k("plans", -1, at("recommend", 0.15));
    k("pm", at("recommend", 0.15));
    k("draft", -1, at("confirm", 0.85));
    k("confirmed", at("confirm", 0.85));
    k("active", at("profile", 0), at("people", 1.0));
    k("notpaused", at("people", 1.0));
    k("v1", -1, at("proposal", 1.9));
    k("v2", at("proposal", 1.9));
    k("job1", -1, at("proposal", 1.9));
    k("job2", at("proposal", 1.9));
    k("pwait", -1, at("proposal", 1.7));
    k("pok", at("proposal", 1.7));
    k("mshadow", at("shadow", 0.1), at("enforce", 0.1));
    k("menforce", at("enforce", 0.1));
    k("r1", at("scorecard", 0.55));
    k("r2", at("scorecard", 0.8));
    k("r3", at("scorecard", 1.05));
    hlWins.set("unknown", [at("unknown", 0.05), at("recommend", 0)]);
    /* the newest card wears the accent border for a moment, then settles */
    for (const id of ["plan", "profile", "proposal", "access", "log", "scorecard", "rec"]) focusWin.set(id, shows.get(id)![0][0]);
  }

  /* ---------- build ---------- */
  function build() {
    for (const spec of CARDS) {
      const c = card(spec.html(story.names), spec.cl ?? "", spec.w.d);
      const keys = new Map<string, HTMLElement[]>();
      c.el.querySelectorAll<HTMLElement>("[data-k]").forEach((e) => {
        const k = e.dataset.k!;
        keys.set(k, [...(keys.get(k) ?? []), e]);
      });
      const hl = new Map<string, HTMLElement[]>();
      c.el.querySelectorAll<HTMLElement>("[data-h]").forEach((e) => {
        const k = e.dataset.h!;
        hl.set(k, [...(hl.get(k) ?? []), e]);
      });
      S.cardScene.add(c.obj);
      cards.set(spec.id, { spec, c, keys, hl, h: { d: 1, p: 1 } });
    }
    for (const spec of LINES) {
      const pts = Array.from({ length: 33 }, () => new V3());
      const line = fatLine(S, pts, { width: 1.5, dashed: !!spec.dashed, ro: 3 });
      line.frustumCulled = false;
      const headM = spec.pulse ? mark(S, { shape: spec.dashed ? "ring" : "disc", px: spec.dashed ? 10 : 8, border: 2, halo: spec.dashed ? 0 : 5, ro: 14 }) : null;
      S.scene.add(line);
      if (headM) S.scene.add(headM.mesh);
      const [t0, t1] = spec.draw(at);
      const LO: LineObj = { spec, line, head: headM, t0, t1, tOut: spec.out ? spec.out(at) : 1e9, tSignal: spec.signalAt ? spec.signalAt(at) : 1e9, pts };
      lines.push(LO);
      paint.push(() => headM?.paint(spec.dashed ? P.fg2 : P.accent, spec.dashed ? P.surface2 : P.accent));
    }
    for (const bp of BACK_PULSES) {
      const LO = lines.find((x) => x.spec.id === bp.line)!;
      const headM = mark(S, { shape: "disc", px: 8, halo: 5, ro: 14 });
      S.scene.add(headM.mesh);
      const [t0, t1] = bp.at(at);
      back.push({ L: LO, t0, t1, head: headM });
      paint.push(() => headM.paint(P.accent));
    }
    barrier = mark(S, { shape: "ring", px: 16, border: 2.5, halo: 4, ro: 15 });
    S.scene.add(barrier.mesh);
    paint.push(() => barrier.paint(P.signal, P.surface2));
  }

  /* card heights in world units, per layout. Measured lazily (the camera asks), and again after a resize
     or once web fonts land; a card that has not laid out yet reads 0 and triggers another try. */
  let measured = false;
  function ensureMeasured() {
    if (measured) return;
    measure();
    measured = [...cards.values()].every((C) => C.h.d > 0.41 && C.h.p > 0.41);
    poseCache = null;
  }
  function measure() {
    const box = document.createElement("div");
    box.className = "tp-measure";
    box.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden";
    S.root.appendChild(box);
    for (const C of cards.values()) {
      for (const lay of ["d", "p"] as Layout[]) {
        const clone = C.c.el.cloneNode(true) as HTMLElement;
        clone.style.width = C.spec.w[lay] + "px";
        clone.style.opacity = "1";
        clone.style.transform = "none";
        box.appendChild(clone);
        C.h[lay] = Math.max(40, clone.offsetHeight) * PX;
        clone.remove();
      }
    }
    box.remove();
  }

  function basePos(id: string, lay: Layout, out: THREE.Vector3) {
    const p = cards.get(id)!.spec.pos[lay];
    return out.set(p[0], p[1], p[2]);
  }

  /* ---------- camera ---------- */
  function poses(): Record<string, Pose> {
    ensureMeasured();
    const key = S.w + "x" + S.h + L();
    if (poseCache && poseCache.key === key) return poseCache.poses;
    /* never magnify a card past ~1.15x: CSS3D rasterizes at CSS size, so more would blur the text */
    const tanH = Math.tan((S.camera.fov * DEG) / 2);
    const minDist = (PX * S.h) / (2 * tanH * (small ? 1.12 : 1.15));
    const lay = L();
    const out: Record<string, Pose> = {};
    for (const step of Object.keys(FOCUS)) {
      const pts: THREE.Vector3[] = [];
      for (const id of FOCUS[step][lay]) {
        if (EXTRA[id]) {
          for (const e of EXTRA[id][lay]) pts.push(new V3(...e));
          continue;
        }
        const C = cards.get(id)!;
        const p = step === "end" && C.spec.end?.[lay] ? (C.spec.end[lay] as XYZ) : C.spec.pos[lay];
        const w = C.spec.w[lay] * PX, h = C.h[lay];
        for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) pts.push(new V3(p[0] + sx * w, p[1] + sy * h, p[2]));
      }
      const bb = new THREE.Box3().setFromPoints(pts);
      const target = bb.getCenter(new V3());
      const v = VIEW[step];
      /* leave room for the chapter chips at the top: aim a touch above the centre */
      target.y += small ? 0.12 : 0.1;
      const m: [number, number] = small ? [0.9, 0.8] : [0.88, 0.78];
      const dist = Math.max(minDist, fitDistance(S.camera, target, orbitDir(v.az, v.el), pts, m));
      out[step] = { x: target.x, y: target.y, z: target.z, dist, el: v.el, az: v.az };
    }
    poseCache = { key, poses: out };
    return out;
  }
  function buildRig() {
    const keys: CamKey[] = [];
    for (const st of steps) {
      const id = st.ch < 0 ? "end" : st.id;
      const t = st.ch < 0 ? st.s + 0.15 : st.s - 0.15;
      const get = () => poses()[id];
      keys.push({ t, dur: st.ch < 0 ? 1.5 : 1.3, target: () => { const p = get(); return [p.x, p.y, p.z]; }, dist: () => get().dist, el: () => get().el, az: () => get().az });
    }
    rig = cameraRig(S.camera, keys, { total, seam: 0.8 });
  }

  /* ---------- contract ---------- */
  function init(ctx: SceneInit) {
    story = ctx.story;
    small = ctx.small;
    let acc = 0;
    for (const st of story.steps) {
      steps.push({ id: st.id, ch: st.ch, s: acc, d: st.dur });
      acc += st.dur;
    }
    total = acc;
    const end = steps.find((st) => st.ch < 0);
    tEnd = end ? end.s : total;
    S = createStage(ctx.host, { dpr: ctx.dpr, cards: true, labels: false, fov: 30 });
    schedule();
    build();
    buildRig();
    theme(ctx.colors);
    resize(ctx.w, ctx.h);
    /* web fonts change card heights: re-measure once they are in */
    void document.fonts?.ready.then(() => {
      measured = false;
    });
  }

  function cardAlpha(id: string, T: number): { a: number; flip: number } {
    let a = 0, flip = 0;
    for (const [tin, tout] of shows.get(id) ?? []) {
      const i = ramp(T, tin, tin + 0.5), o = ramp(T, tout, tout + 0.45);
      const k = Math.min(i, 1 - o);
      if (k > a) {
        a = k;
        flip = i < 1 ? -(1 - eout(i)) : eio(o); /* flip in from the left, out to the right */
      }
    }
    return { a, flip };
  }

  /* how much card `id` is in focus at T (0..1), blended across the start of each step */
  function focusOf(id: string, T: number, lay: Layout): number {
    if (TRANSIENT.has(id)) return 1; /* transient cards only show while they matter */
    const key = SLOT.has(id) ? "plan" : id;
    let i = 0;
    while (i < steps.length - 1 && T >= steps[i + 1].s) i++;
    const cur = steps[i], prev = steps[(i + steps.length - 1) % steps.length];
    const inF = (st: StepT) => (FOCUS[st.ch < 0 ? "end" : st.id][lay].includes(key) ? 1 : 0);
    return lerp(inF(prev), inF(cur), eio(ramp(T, cur.s - 0.15, cur.s + 0.7)));
  }

  function frame(s: SceneState) {
    const T = s.t;
    const lay = L();
    const endK = eio(ramp(T, tEnd + 0.1, tEnd + 1.4));
    const dimTo = lay === "p" ? 0.05 : 0.16;

    for (const [id, C] of cards) {
      const { a, flip } = cardAlpha(id, T);
      const ghost = id === "hire" ? 0.9 : 1;
      const f = focusOf(id, T, lay);
      C.c.set(a * ghost * lerp(dimTo, 1, f));
      if (a <= 0.01) continue;
      const base = basePos(id, lay, tmpA);
      const endP = C.spec.end?.[lay];
      if (endP && endK > 0) base.lerp(tmpB.set(endP[0], endP[1], endP[2]), endK);
      C.c.obj.position.copy(base);
      C.c.obj.position.z += -0.35 * Math.abs(flip) - 0.7 * (1 - f);
      C.c.obj.rotation.set(0, flip * 72 * DEG, (C.spec.tilt?.[lay] ?? 0) * DEG);
      const fw = focusWin.get(id);
      cls(C.c.el, "is-focus", fw != null && T >= fw + 0.15 && T < fw + 2.6 && endK < 0.5);
      for (const [k, els] of C.keys) {
        const w = keyWins.get(k);
        if (!w) continue;
        const v = Math.min(ramp(T, w[0], w[0] + 0.3), 1 - ramp(T, w[1], w[1] + 0.3));
        for (const e of els) sty(e, "opacity", v.toFixed(3));
      }
      for (const [k, els] of C.hl) {
        const w = hlWins.get(k)!;
        for (const e of els) cls(e, "is-hl", T >= w[0] && T < w[1]);
      }
    }

    for (const LO of lines) {
      const { spec } = LO;
      /* the endpoints follow the cards ("plan" in a line spec means whichever card holds the middle slot) */
      const aId = spec.a === "plan" ? activeSlot(T) : spec.a, bId = spec.b === "plan" ? activeSlot(T) : spec.b;
      cardPos(aId, lay, endK, tmpA);
      cardPos(bId, lay, endK, tmpB);
      const bend = spec.bend?.[lay] ?? [0, 0];
      tmpC.copy(tmpA).add(tmpB).multiplyScalar(0.5);
      tmpC.x += bend[0];
      tmpC.y += bend[1];
      tmpC.z = Math.max(tmpA.z, tmpB.z) - 0.05;
      setLinePointsFromCurve(LO.line, LO.pts, tmpA, tmpC, tmpB);
      const draw = ramp(T, LO.t0, LO.t1);
      const reach = spec.reach ?? 1;
      const outK = ramp(T, LO.tOut, LO.tOut + 0.45);
      const ends = Math.min(focusOf(aId, T, lay), focusOf(bId, T, lay));
      const fade = (1 - outK) * (1 - endK * (spec.rest ? 0.4 : 1)) * lerp(0.25, 1, ends);
      drawSegs(LO.line, eout(draw) * reach);
      LO.line.visible = draw > 0.001 && fade > 0.01;
      const settle = ramp(T, LO.t1 + 0.2, LO.t1 + 1.2);
      const sig = ramp(T, LO.tSignal, LO.tSignal + 0.15);
      const col = LO.line.material.color;
      if (spec.dashed) col.copy(P.fg2);
      else col.copy(P.accent).lerp(P.fg3, settle);
      if (sig > 0) col.lerp(P.signal, sig);
      LO.line.material.opacity = lerp(1, spec.rest ?? 0.55, settle) * fade;
      LO.line.material.linewidth = lerp(1.75, 1.1, settle);
      if (LO.head) {
        LO.head.set(win(T, LO.t0, LO.t1 + 0.1, 0.1, 0.2) * fade);
        curvePoint(tmpA, tmpC, tmpB, eio(draw) * reach, LO.head.mesh.position);
      }
      /* the enforce request: it stops at the server's boundary and comes back refused */
      if (spec.reach != null) {
        curvePoint(tmpA, tmpC, tmpB, reach, tmpP);
        const on = ramp(T, LO.tSignal, LO.tSignal + 0.35);
        barrier.mesh.position.copy(tmpP);
        barrier.set(on * fade, 0.35 + 0.65 * backOut(on));
        const bk = ramp(T, LO.tSignal, LO.tSignal + 0.5);
        if (LO.head) {
          const goA = win(T, LO.t0, LO.t1, 0.1, 0.05);
          const goB = win(T, LO.tSignal, LO.tSignal + 0.6, 0.05, 0.15);
          LO.head.set(Math.max(goA, goB) * fade);
          if (T >= LO.tSignal) curvePoint(tmpA, tmpC, tmpB, reach * (1 - eout(bk)), LO.head.mesh.position);
          LO.head.paint(T >= LO.tSignal ? P.signal : P.accent);
        }
      }
    }
    for (const bp of back) {
      const u = ramp(T, bp.t0, bp.t1);
      bp.head.set(win(T, bp.t0, bp.t1 + 0.1, 0.1, 0.2));
      const LO = bp.L;
      cardPos(activeSlot(T), lay, endK, tmpA);
      cardPos(LO.spec.b, lay, endK, tmpB);
      const bend = LO.spec.bend?.[lay] ?? [0, 0];
      tmpC.copy(tmpA).add(tmpB).multiplyScalar(0.5);
      tmpC.x += bend[0];
      tmpC.y += bend[1];
      curvePoint(tmpA, tmpC, tmpB, 1 - eio(u), bp.head.mesh.position);
    }

    rig.apply(rig.poseAt(T), T, 1 - endK * 0.6);
    S.setOpacity(Math.min(ramp(T, 0, 0.45), 1 - ramp(T, total - 0.55, total)));
    S.render();
  }

  /* which subject card holds the middle slot at time T */
  function activeSlot(T: number): string {
    if (T < at("profile", 0.15)) return "plan";
    if (T < at("rules", 0.2)) return "profile";
    if (T < at("scorecard", 0.2)) return "access";
    return "scorecard";
  }
  function cardPos(id: string, lay: Layout, endK: number, out: THREE.Vector3) {
    const C = cards.get(id)!;
    const p = C.spec.pos[lay];
    out.set(p[0], p[1], p[2]);
    const e = C.spec.end?.[lay];
    if (e && endK > 0) out.lerp(tmpP.set(e[0], e[1], e[2]), endK);
    return out;
  }
  function curvePoint(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, s: number, out: THREE.Vector3) {
    const u = clamp(s), k0 = (1 - u) * (1 - u), k1 = 2 * (1 - u) * u, k2 = u * u;
    return out.set(k0 * a.x + k1 * c.x + k2 * b.x, k0 * a.y + k1 * c.y + k2 * b.y, k0 * a.z + k1 * c.z + k2 * b.z);
  }

  function resize(w: number, h: number) {
    small = w < 560;
    S.camera.fov = small ? 34 : 30;
    S.setSize(w, h);
    S.root.classList.toggle("is-small", small);
    for (const C of cards.values()) C.c.el.style.width = C.spec.w[L()] + "px";
    poseCache = null;
    measured = false;
    /* the timing of phone-only exits depends on the layout */
    shows.clear();
    keyWins.clear();
    hlWins.clear();
    focusWin.clear();
    schedule();
  }

  function theme(colors: SceneColors) {
    P = palette(colors);
    paint.forEach((f) => f());
  }

  function dispose() {
    S?.dispose();
  }

  return { init, frame, resize, theme, dispose };
}
