/**
 * LANES: the "time axis" treatment of the How it works story.
 *
 * Time runs into depth. AgentDash is the axis in the middle: every request, approval and refusal lands
 * on it as a ring, so the record grows behind the present moment. You sit on the people side; the Chief
 * of Staff and an agent (Research) are lanes on the agent side. Requests are arcs between lanes. The
 * agent's lane starts only when the plan is confirmed. An out-of-scope request passes as a dashed ghost
 * in shadow mode (logged, nothing refused) and bounces off the axis in enforce mode, with the reason.
 *
 * Every element is a function of story time (frame(s) reads s.t only), so seeks, pauses, loops and
 * ?t= captures are exact.
 */
import {
  THREE, DEG, ramp, win, lerp, eio, eout, sine, backOut, esc, cls,
  createStage, palette, fatLine, drawOn, drawSegs, arcPoints, pointAlong, mark, label, cameraRig, orbitDir, fitDistance,
  type Stage, type Palette, type FatLine, type Mark, type Label, type CamKey, type Pose,
} from "../kit";
import type { Scene, SceneColors, SceneInit, SceneState } from "../player";
import type { Story } from "../story";

const V3 = THREE.Vector3;
const V = 0.8; /* world units per story second along the axis */
const zT = (T: number) => -V * T;

type LaneId = "you" | "hub" | "cos" | "agent";
const LANE_X: Record<LaneId, number> = { you: -2.5, hub: 0, cos: 1.65, agent: 3.3 };
const CX = (LANE_X.you + LANE_X.agent) / 2;

interface ArcSpec { step: string; at: number; dur: number; from: LaneId; to: LaneId; chip?: string; ghost?: boolean; signal?: boolean; lift?: number }
/* side: which side of the axis the label sits on; requests from people land left, from agents right */
interface NodeSpec { step: string; at: number; lane?: LaneId; name: string; meta?: string; metaSmall?: string; kind?: "solid" | "ghost" | "refuse"; keep?: boolean; life?: number; side?: "l" | "r"; card?: (names: Story["names"]) => string }

/* the storyboard's visual events, in seconds from the start of each step: main events land in the first half */
const ARCS: ArcSpec[] = [
  { step: "brief", at: 0.25, dur: 1.0, from: "you", to: "cos", chip: "about the business" },
  { step: "brief", at: 1.35, dur: 0.7, from: "cos", to: "hub" },
  { step: "confirm", at: 0.2, dur: 0.8, from: "you", to: "hub", chip: "confirm" },
  { step: "confirm", at: 1.45, dur: 0.75, from: "cos", to: "hub", ghost: true, chip: "hire beyond the plan" },
  { step: "profile", at: 0.2, dur: 0.8, from: "you", to: "hub", chip: "writes the job" },
  { step: "profile", at: 1.15, dur: 0.6, from: "hub", to: "agent" },
  { step: "proposal", at: 1.05, dur: 0.7, from: "you", to: "hub", chip: "approve" },
  { step: "proposal", at: 1.95, dur: 0.6, from: "hub", to: "agent" },
  { step: "rules", at: 0.2, dur: 0.8, from: "you", to: "hub", chip: "see · do · talk to" },
  { step: "shadow", at: 0.25, dur: 0.8, from: "agent", to: "hub", ghost: true, chip: "open Support project" },
  { step: "shadow", at: 1.1, dur: 0.6, from: "hub", to: "agent", ghost: true },
  { step: "enforce", at: 0.25, dur: 0.75, from: "agent", to: "hub", chip: "open Support project" },
  { step: "enforce", at: 1.0, dur: 0.6, from: "hub", to: "agent", signal: true, lift: 0.18 },
  { step: "reachable", at: 0.25, dur: 1.1, from: "agent", to: "you", chip: "to its accountable person" },
  { step: "scorecard", at: 0.2, dur: 0.7, from: "agent", to: "hub", chip: "records" },
  { step: "recommend", at: 0.2, dur: 0.7, from: "hub", to: "cos", chip: "reads scorecards" },
  { step: "recommend", at: 1.0, dur: 0.7, from: "cos", to: "hub" },
  { step: "people", at: 0.2, dur: 0.9, from: "hub", to: "you", chip: "for your decision" },
];

const SCORE_CARD = () =>
  '<b>Scorecard</b><span class="tp-sc">' +
  '<span class="tp-sc-r"><i>Work owed</i><em>12 of 14 delivered</em></span>' +
  '<span class="tp-sc-r"><i>Quality</i><em>4 of 5 checks passed</em></span>' +
  '<span class="tp-sc-r is-unknown"><i>Cost</i><em>Unknown</em></span></span>';

const NODES: NodeSpec[] = [
  { step: "brief", at: 2.05, name: "Team plan", meta: "draft", side: "r" },
  { step: "confirm", at: 1.0, name: "Plan confirmed", meta: "by You", keep: true },
  { step: "confirm", at: 2.2, name: "New hire", meta: "waits for your approval", metaSmall: "waits for you", kind: "ghost", side: "r" },
  { step: "profile", at: 1.0, name: "Profile v1", meta: "written by You" },
  { step: "proposal", at: 0.3, name: "Proposed change", meta: "not applied", kind: "ghost", side: "r" },
  { step: "proposal", at: 1.75, name: "Approved", meta: "v2 applies", keep: true },
  { step: "rules", at: 1.0, name: "Access rules", meta: "set by a person" },
  { step: "shadow", at: 1.05, name: "Would refuse", meta: "logged · nothing refused", metaSmall: "nothing refused", kind: "ghost", side: "r" },
  { step: "enforce", at: 1.0, name: "Refused", meta: "not in its projects", kind: "refuse", keep: true, side: "r" },
  { step: "reachable", at: 1.35, lane: "you", name: "Reached You", meta: "always reachable" },
  { step: "scorecard", at: 0.95, name: "Scorecard", card: SCORE_CARD, life: 10 },
  { step: "recommend", at: 1.7, name: "Recommendation", meta: "pause Research", kind: "ghost", side: "r" },
  { step: "people", at: 1.1, lane: "you", name: "Your decision", meta: "waiting", kind: "ghost", keep: true },
];

interface StepT { id: string; ch: number; s: number; d: number }
interface ArcObj { t0: number; t1: number; g: THREE.Group; line: FatLine; head: Mark; chip: Label | null; pts: THREE.Vector3[]; ghost: boolean; signal: boolean }
interface NodeObj { T: number; ring: Mark; rip: THREE.LineLoop; lb: Label; keep: boolean; life: number; kind: string; lane: LaneId; meta: HTMLElement | null; metaD: string; metaP: string; side: string; home: "l" | "r"; w: number; h: number }
interface LaneObj { id: LaneId; x: number; from: number; lane: FatLine; head: Mark; tag: Label }

export default function createLanes(): Scene {
  let S!: Stage;
  let P = {} as Palette;
  let story!: Story;
  let total = 1, tRec = 1, tEnd = 1, small = false;
  let rig!: ReturnType<typeof cameraRig>;
  let endCache: { key: string; p: Pose } | null = null;
  let axisAll!: FatLine, axisLit!: FatLine, ticks!: THREE.LineSegments;
  let modeShadow!: Label, modeEnforce!: Label, roleTag!: Label, active!: Label, notPaused!: Label;
  let tAgent = 0, tShadow = 0, tEnforce = 0, tRecommend = 0, tPeople = 0, tUnknown0 = 0, tUnknown1 = 0;
  let scoreRow: HTMLElement | null = null;
  const proj = new THREE.Vector3();
  const steps: StepT[] = [];
  const paint: Array<() => void> = [];
  const lanes: Partial<Record<LaneId, LaneObj>> = {};
  const arcs: ArcObj[] = [];
  const nodes: NodeObj[] = [];
  const SQ = () => (small ? 0.7 : 1); /* phone: lanes draw in toward the axis so every party fits */
  const at = (id: string, sec = 0) => {
    const st = steps.find((x) => x.id === id);
    return st ? st.s + sec : 0;
  };
  const rippleGeom = new THREE.BufferGeometry().setFromPoints(
    Array.from({ length: 65 }, (_, i) => {
      const a = (i / 64) * Math.PI * 2;
      return new V3(Math.cos(a), 0, Math.sin(a));
    }),
  );

  /* ---------- build ---------- */
  function build() {
    const sc = S.scene;
    const A = (T: number) => new V3(0, 0, zT(T));
    axisAll = fatLine(S, [A(-1.2), A(total + 2)], { width: 1, ro: 1 });
    axisLit = fatLine(S, [A(0), A(tRec)], { width: 2.25, reveal: true, ro: 2 });
    const seg: number[] = [];
    for (let s = 0; s <= Math.ceil(tRec); s++) {
      const w = s % 5 ? 0.1 : 0.24;
      seg.push(-w, 0, zT(s), w, 0, zT(s));
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
    ticks = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ transparent: true, depthTest: false }));
    sc.add(axisAll, axisLit, ticks);
    paint.push(() => {
      axisAll.material.color.copy(P.line);
      axisLit.material.color.copy(P.accent);
      (ticks.material as THREE.LineBasicMaterial).color.copy(P.line);
    });

    const names = story.names;
    const laneDefs: Array<{ id: LaneId; name: string; from: number; shape: "ring" | "square" | "disc" }> = [
      { id: "you", name: names.you, from: 0, shape: "ring" },
      { id: "hub", name: story.brand, from: 0, shape: "disc" },
      { id: "cos", name: names.cos, from: 0, shape: "square" },
      { id: "agent", name: names.agents[0], from: tAgent, shape: "square" },
    ];
    for (const d of laneDefs) {
      const x = LANE_X[d.id];
      const lane = fatLine(S, [new V3(x, 0, zT(d.from)), new V3(x, 0, zT(tRec))], { width: d.id === "hub" ? 0.01 : 1.25, reveal: true, ro: 2 });
      const head = d.id === "hub"
        ? mark(S, { shape: "disc", px: 10, halo: 6, ro: 15 })
        : mark(S, { shape: d.shape, px: 13, border: 2.5, halo: 4, ro: 12 });
      const tag = label("<b>" + esc(d.name) + "</b>", "plain" + (d.id === "hub" ? " accent" : ""));
      sc.add(lane, head.mesh, tag.obj);
      lanes[d.id] = { id: d.id, x, from: d.from, lane, head, tag };
      paint.push(() => {
        lane.material.color.copy(P.fg3);
        if (d.id === "hub") head.paint(P.accent);
        else head.paint(P.fg, P.surface2);
      });
    }
    /* small status notes beside the lane heads (placed per layout in placeLabels) */
    const note = (html: string, extra = "") => {
      const l = label(html, "small " + extra);
      sc.add(l.obj);
      return l;
    };
    modeShadow = note("mode: <b>shadow</b>");
    modeEnforce = note("mode: <b>enforce</b>", "accent");
    roleTag = note("performance manager");
    active = note("active");
    notPaused = note("<b>active · not paused</b>", "accent");

    for (const a of ARCS) mkArc(a);
    for (const n of NODES) mkNode(n);
  }

  function mkArc(spec: ArcSpec) {
    const t0 = at(spec.step, spec.at), t1 = t0 + spec.dur;
    const g = new THREE.Group();
    S.scene.add(g);
    const a = new V3(LANE_X[spec.from], 0, 0), b = new V3(LANE_X[spec.to], 0, 0);
    const pts = arcPoints(a, b, spec.lift ?? 0.4 + 0.13 * Math.abs(b.x - a.x));
    const line = fatLine(S, pts, { width: 1.75, reveal: !spec.ghost, dashed: !!spec.ghost, ro: 4 });
    const head = mark(S, { shape: spec.ghost ? "ring" : "disc", px: spec.ghost ? 9 : 7, border: 2, halo: spec.ghost ? 0 : 5, ro: 14 });
    g.add(line, head.mesh);
    let chip: Label | null = null;
    if (spec.chip) {
      chip = label(esc(spec.chip), "to-u" + (spec.ghost ? " ghost" : ""));
      chip.obj.center.set(0.5, 1);
      g.add(chip.obj);
    }
    paint.push(() => {
      if (spec.signal) head.paint(P.signal);
      else if (spec.ghost) head.paint(P.fg2, P.surface2);
      else head.paint(P.accent);
    });
    arcs.push({ t0, t1, g, line, head, chip, pts, ghost: !!spec.ghost, signal: !!spec.signal });
  }

  function mkNode(spec: NodeSpec) {
    const T = at(spec.step, spec.at);
    const lane = spec.lane ?? "hub";
    const x = LANE_X[lane];
    const z = zT(T);
    const kind = spec.kind ?? "solid";
    const ring = mark(S, { shape: kind === "refuse" ? "square" : "ring", px: spec.keep ? 17 : 15, border: 2.5, halo: kind === "ghost" ? 0 : 4.5, ro: 13 });
    ring.dash(kind === "ghost");
    ring.mesh.position.set(x, 0, z);
    const rip = new THREE.LineLoop(rippleGeom, new THREE.LineBasicMaterial({ transparent: true, depthTest: false }));
    rip.position.set(x, 0, z);
    const html = spec.card
      ? spec.card(story.names)
      : "<b>" + esc(spec.name) + "</b>" + (spec.meta ? '<span class="ts">' + esc(spec.meta) + "</span>" : "");
    const lb = label(html, (spec.card ? "card " : "") + (kind === "ghost" ? "ghost " : kind === "refuse" ? "signal " : ""));
    lb.obj.position.set(x, 0, z);
    if (spec.card) scoreRow = lb.el.querySelector<HTMLElement>(".is-unknown");
    S.scene.add(ring.mesh, rip, lb.obj);
    paint.push(() => {
      if (kind === "refuse") {
        ring.paint(P.signal, P.surface2);
        (rip.material as THREE.LineBasicMaterial).color.copy(P.signal);
      } else if (kind === "ghost") {
        ring.paint(P.fg3, P.surface2);
        (rip.material as THREE.LineBasicMaterial).color.copy(P.fg3);
      } else {
        ring.paint(P.accent, P.surface2);
        (rip.material as THREE.LineBasicMaterial).color.copy(P.accent);
      }
    });
    nodes.push({ T, ring, rip, lb, keep: !!spec.keep, life: spec.life ?? 7, kind, lane,
      meta: lb.el.querySelector<HTMLElement>(".ts"), metaD: spec.meta ?? "", metaP: spec.metaSmall ?? spec.meta ?? "", side: "l", home: spec.side ?? "l", w: 0, h: 0 });
  }

  /* where a label sits relative to its anchor: l / r / u (above) / d (below), with u2 / d2 one row further */
  const SIDES = ["to-l", "to-r", "to-u", "to-d", "to-u2", "to-u3", "to-d2"];
  function place(l: Label, side: "l" | "r" | "u" | "d" | "u2" | "u3" | "d2") {
    l.el.classList.remove(...SIDES);
    l.el.classList.add("to-" + side);
    if (side === "l") l.obj.center.set(1, 0.5);
    else if (side === "r") l.obj.center.set(0, 0.5);
    else if (side === "u" || side === "u2" || side === "u3") l.obj.center.set(0.5, 1);
    else l.obj.center.set(0.5, 0);
  }
  /* node labels sit on the people side of the axis (left); on a phone the lane names stagger above and
     below their heads so four names fit, and the scorecard card hangs below its ring */
  function placeLabels() {
    for (const N of nodes) {
      const isCard = N.lb.el.classList.contains("card");
      N.side = N.lane === "you" ? "r" : isCard && small ? "d" : N.home;
      place(N.lb, N.side as "l" | "r" | "d");
      if (N.meta) N.meta.textContent = small ? N.metaP : N.metaD;
      N.w = N.h = 0; /* re-measured on the next visible frame */
    }
    notPaused.el.innerHTML = small ? "<b>not paused</b>" : "<b>active · not paused</b>";
    place(lanes.you!.tag, "u");
    place(lanes.hub!.tag, "u");
    place(lanes.agent!.tag, "u");
    /* phone: the Chief of Staff's name sits one row up, so the four names never touch, and the space right
       of the axis stays free for the labels of requests that come from agents */
    place(lanes.cos!.tag, small ? "u2" : "u");
    place(modeShadow, "d");
    place(modeEnforce, "d");
    place(roleTag, small ? "u3" : "d");
    place(active, "d");
    place(notPaused, "d");
  }

  /* ---------- camera: one key per step, following the present; the end step cranes out ---------- */
  function followDist() {
    const tanH = Math.tan((S.camera.fov * DEG) / 2), aspect = S.w / S.h;
    const half = ((LANE_X.agent - LANE_X.you) / 2 + (small ? 0.7 : 1.4)) * SQ();
    return Math.max(small ? 8 : 7.6, half / (tanH * aspect));
  }
  function endPose(): Pose {
    const key = S.w + "x" + S.h;
    if (endCache && endCache.key === key) return endCache.p;
    const narrow = S.w / S.h < 1.2, az = narrow ? 14 : 38, el = narrow ? 46 : 34;
    const target = new V3(CX * SQ(), 0.3, zT(tRec * 0.5));
    const X0 = (LANE_X.you - 0.9) * SQ(), X1 = (LANE_X.agent + 0.9) * SQ();
    const pts = [new V3(X0, 0, zT(-0.5)), new V3(X1, 0, zT(-0.5)), new V3(X0, 0, zT(tRec)), new V3(X1, 0, zT(tRec)), new V3(CX * SQ(), 1, zT(tRec))];
    const p: Pose = { x: target.x, y: target.y, z: target.z, dist: fitDistance(S.camera, target, orbitDir(az, el), pts, narrow ? [0.86, 0.72] : 0.84), el, az };
    endCache = { key, p };
    return p;
  }
  function buildRig() {
    const AZ = [-6, 5, -3, 7, -5, 4], EL = [23, 26, 21, 25, 27, 23];
    /* how far behind the present each step aims; "unknown" looks back at the scorecard that just landed */
    const BACK: Record<string, number> = { unknown: 5.2 };
    const keys: CamKey[] = [];
    steps.forEach((st, i) => {
      if (st.ch < 0) return;
      /* aim a little into the past, so the steps that just landed sit mid-frame and the present reads as "ahead" */
      const back = BACK[st.id] ?? 2.2;
      keys.push({ t: st.s - 0.1, dur: 1.7, target: (T) => [CX * SQ(), 0.25, zT(Math.min(T, tRec)) + back], dist: followDist, el: EL[i % 6], az: AZ[i % 6] });
    });
    if (tEnd < total) {
      keys.push({ t: tEnd + 0.2, dur: 1.4, target: () => { const p = endPose(); return [p.x, p.y, p.z]; }, dist: () => endPose().dist, el: () => endPose().el, az: () => endPose().az });
    }
    rig = cameraRig(S.camera, keys, { total, seam: 0.75 });
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
    tRec = tEnd;
    tAgent = at("confirm", 1.0);
    tShadow = at("shadow", 0.1);
    tEnforce = at("enforce", 0.1);
    tRecommend = at("recommend", 0.1);
    tPeople = at("people", 1.0);
    tUnknown0 = at("unknown", 0.05);
    tUnknown1 = at("recommend", 0);
    S = createStage(ctx.host, { dpr: ctx.dpr });
    build();
    buildRig();
    theme(ctx.colors);
    resize(ctx.w, ctx.h);
  }

  function frame(s: SceneState) {
    const T = s.t, now = Math.min(T, tRec), zN = zT(now);
    const endK = eio(ramp(T, tEnd + 0.1, tEnd + 1.4));
    const behind = (t: number) => Math.max(endK, 1 - ramp(now - t, 12, 18)); /* the far record thins out while we follow */

    drawOn(axisLit, now / tRec);
    for (const id of Object.keys(lanes) as LaneId[]) {
      const L = lanes[id]!;
      const born = ramp(T, L.from, L.from + 0.45);
      const len = (now - L.from) / (tRec - L.from);
      if (id === "hub") L.lane.visible = false;
      else drawOn(L.lane, born > 0 ? Math.max(0.0015, len) : 0);
      L.head.mesh.position.set(L.x, 0, zN);
      L.head.set(id === "hub" ? 1 - endK * 0.5 : born, id === "hub" ? 1 : 0.35 + 0.65 * backOut(born));
      L.tag.obj.position.set(L.x, 0, zN);
      L.tag.set(born * (1 - endK));
    }
    const hubX = LANE_X.hub, cosX = LANE_X.cos, agX = LANE_X.agent;
    modeShadow.obj.position.set(hubX, 0, zN);
    modeEnforce.obj.position.set(hubX, 0, zN);
    modeShadow.set(win(T, tShadow, tEnforce, 0.35, 0.3) * (1 - endK));
    modeEnforce.set(ramp(T, tEnforce, tEnforce + 0.35) * (1 - endK));
    roleTag.obj.position.set(cosX, 0, zN);
    roleTag.set(ramp(T, tRecommend, tRecommend + 0.4) * (1 - endK));
    active.obj.position.set(agX, 0, zN);
    notPaused.obj.position.set(agX, 0, zN);
    const np = ramp(T, tPeople, tPeople + 0.4) * (1 - endK);
    notPaused.set(np);
    active.set(ramp(T, at("profile", 0), at("profile", 0.5)) * (1 - np) * (1 - endK));

    for (const M of arcs) {
      if (T < M.t0) {
        M.g.visible = false;
        continue;
      }
      M.g.visible = true;
      const u = ramp(T, M.t0, M.t1), e = sine(u);
      M.g.position.z = zT(Math.min(T, M.t1)); /* in flight it rides the present; once landed it stays on the record */
      if (M.ghost) drawSegs(M.line, e);
      else drawOn(M.line, e);
      const rec = ramp(T, M.t1 + 0.15, M.t1 + 1.1);
      const base = M.signal ? P.signal : M.ghost ? P.fg2 : P.accent;
      M.line.material.color.copy(base).lerp(P.fg3, rec);
      M.line.material.linewidth = lerp(1.75, 1, rec);
      M.line.material.opacity = lerp(M.ghost ? 0.85 : 1, 0.45, rec) * behind(M.t1);
      pointAlong(M.pts, e, M.head.mesh.position);
      M.head.set(win(T, M.t0, M.t1 + 0.12, 0.1, 0.2));
      /* the chip shows mid-flight, clear of the labels at either end */
      if (M.chip) {
        M.chip.obj.position.copy(M.head.mesh.position);
        M.chip.set(Math.min(ramp(u, 0.12, 0.28), 1 - ramp(u, 0.78, 0.94)) * (1 - endK));
      }
    }

    for (const N of nodes) {
      const on = ramp(T, N.T, N.T + 0.4);
      N.ring.set(on * behind(N.T), 0.35 + 0.65 * backOut(on));
      const u = ramp(T, N.T, N.T + 1.15);
      N.rip.visible = u > 0 && u < 1 && N.kind !== "ghost";
      if (N.rip.visible) {
        const k = lerp(0.1, N.keep ? 0.85 : 0.6, eout(u));
        N.rip.scale.set(k, 1, k);
        (N.rip.material as THREE.LineBasicMaterial).opacity = (1 - u) * 0.8;
      }
      let a = ramp(T, N.T + 0.12, N.T + 0.5) * (1 - ramp(now - N.T, N.life, N.life + 1.5)); /* only recent labels */
      if (N.keep) a = Math.max(a * (1 - endK), endK * ramp(T, tEnd + 0.8, tEnd + 1.4));
      else a *= 1 - endK;
      N.lb.set(a);
    }
    if (scoreRow) cls(scoreRow, "is-hl", T >= tUnknown0 && T < tUnknown1);

    rig.apply(rig.poseAt(T), T, 1 - endK * 0.7);
    /* a label fades as its box nears the stage's side or bottom edge, so none is cut in half */
    for (const N of nodes) {
      if (!N.lb.obj.visible) continue;
      if (!N.w) {
        N.w = N.lb.el.offsetWidth; /* 0 until the label has been displayed once */
        N.h = N.lb.el.offsetHeight;
        if (!N.w) continue;
      }
      proj.set(N.lb.obj.position.x * SQ(), 0, N.lb.obj.position.z).project(S.camera);
      const sx = ((proj.x + 1) / 2) * S.w, sy = ((1 - proj.y) / 2) * S.h;
      const left = N.side === "l" ? sx - 14 - N.w : N.side === "r" ? sx + 14 : sx - N.w / 2;
      const bottom = N.side === "d" ? sy + 14 + N.h : sy + N.h / 2;
      const edge = Math.min(ramp(left, -2, 10), 1 - ramp(left + N.w, S.w - 10, S.w + 2), 1 - ramp(bottom, S.h - 14, S.h + 2));
      if (edge < 1) N.lb.set(Number(N.lb.el.style.opacity || 1) * edge);
    }
    S.setOpacity(Math.min(ramp(T, 0, 0.45), 1 - ramp(T, total - 0.55, total))); /* the loop seam: settle out, settle in */
    S.render();
  }

  function resize(w: number, h: number) {
    small = w < 560;
    S.camera.fov = small ? 36 : 30;
    S.setSize(w, h);
    S.scene.scale.x = SQ();
    S.root.classList.toggle("is-small", small);
    endCache = null;
    placeLabels();
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
