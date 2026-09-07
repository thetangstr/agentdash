import { describe, expect, it } from "vitest";
import {
  applicableEvents,
  availableActions,
  boardView,
  initialState,
  nextDelay,
  reduce,
  terminalView,
  type DemoState,
} from "./engine";
import { ACTORS, SCENARIOS } from "./scenarios";
import { STEWARD_TOOLS } from "../content/site";

function runUntilStop(state: DemoState): DemoState {
  let s = state;
  for (let i = 0; i < 200 && s.phase === "running"; i++) s = reduce(s, { type: "tick" });
  return s;
}

describe("demo scenarios", () => {
  it("every scenario has exactly one gate, branches for both decisions, and known actors", () => {
    for (const scenario of SCENARIOS) {
      const gates = scenario.events.filter((e) => e.kind === "gate");
      expect(gates, scenario.id).toHaveLength(1);
      for (const decision of ["approve", "reject"] as const) {
        const events = applicableEvents(scenario, decision);
        expect(events.some((e) => e.kind === "deliverable"), `${scenario.id} ${decision}`).toBe(true);
      }
      for (const e of scenario.events) {
        if (e.kind === "comment") expect(ACTORS[e.actor], `${scenario.id} actor ${e.actor}`).toBeDefined();
        if (e.kind === "issue") expect(ACTORS[e.issue.assignee], `${scenario.id} assignee`).toBeDefined();
        if (e.kind === "gate") expect(ACTORS[e.gate.requester]).toBeDefined();
      }
      // Pre-gate events must not be branch-specific: nothing can depend on a
      // decision the visitor has not made yet.
      const gateIndex = scenario.events.findIndex((e) => e.kind === "gate");
      for (const e of scenario.events.slice(0, gateIndex)) {
        expect("when" in e && e.when, `${scenario.id} pre-gate branch`).toBeFalsy();
      }
    }
  });
});

describe("demo engine", () => {
  it("walks idle → proposed → running → gated → running → done", () => {
    let s = reduce(initialState, { type: "pick", scenarioId: "board-update" });
    expect(s.phase).toBe("idle");
    expect(availableActions(s)).toEqual(["send"]);

    s = reduce(s, { type: "send" });
    expect(s.phase).toBe("proposed");
    expect(terminalView(s).some((l) => l.kind === "tool" && l.name === STEWARD_TOOLS.propose)).toBe(true);
    expect(boardView(s).issues).toHaveLength(0);

    s = reduce(s, { type: "confirm" });
    expect(s.phase).toBe("running");
    expect(nextDelay(s)).toBeGreaterThan(0);

    s = runUntilStop(s);
    expect(s.phase).toBe("gated");
    const gated = boardView(s);
    expect(gated.approval?.decision).toBeNull();
    expect(gated.deliverable).toBeNull();
    expect(nextDelay(s)).toBeNull();
    expect(terminalView(s).some((l) => l.kind === "tool" && l.name === STEWARD_TOOLS.sync)).toBe(true);
    expect(availableActions(s)).toEqual(["decide", "reset"]);

    // Ticking while gated changes nothing: the visitor has to decide.
    expect(reduce(s, { type: "tick" })).toEqual(s);

    s = reduce(s, { type: "decide", decision: "approve" });
    expect(s.phase).toBe("running");
    s = runUntilStop(s);
    expect(s.phase).toBe("done");
    const done = boardView(s);
    expect(done.deliverable?.title).toBe("Board update · Monday");
    expect(done.issues.every((i) => i.status === "done")).toBe(true);
    const gateIdx = done.activity.findIndex((l) => l.text.startsWith("requested approval"));
    expect(done.activity[gateIdx + 1]?.text).toContain(STEWARD_TOOLS.decide);
    const terminal = terminalView(s);
    expect(terminal.some((l) => l.kind === "tool" && l.name === STEWARD_TOOLS.decide)).toBe(true);
    expect(terminal.at(-1)).toMatchObject({ kind: "assistant" });
  });

  it("reject takes the other branch and never shows approve-only events", () => {
    let s = reduce(initialState, { type: "pick", scenarioId: "stale-cleanup" });
    s = reduce(reduce(s, { type: "send" }), { type: "confirm" });
    s = runUntilStop(s);
    s = reduce(s, { type: "decide", decision: "reject" });
    s = runUntilStop(s);
    expect(s.phase).toBe("done");
    const view = boardView(s);
    expect(view.deliverable?.title).toContain("parked");
    const texts = view.issues.flatMap((i) => i.comments.map((c) => c.text)).join(" ");
    expect(texts).toContain("Parked");
    expect(texts).not.toContain("IT ticket filed");
  });

  it("ignores out-of-order actions and resets cleanly while keeping the harness choice", () => {
    let s = reduce(initialState, { type: "harness", harness: "codex" });
    expect(reduce(s, { type: "send" })).toEqual(s);
    expect(reduce(s, { type: "confirm" })).toEqual(s);
    expect(reduce(s, { type: "decide", decision: "approve" })).toEqual(s);
    expect(reduce(s, { type: "pick", scenarioId: "nope" })).toEqual(s);
    s = reduce(s, { type: "pick", scenarioId: "recruiting" });
    s = reduce(reduce(s, { type: "send" }), { type: "confirm" });
    s = reduce(s, { type: "reset" });
    expect(s).toEqual({ ...initialState, harness: "codex" });
  });

  it("finishes every scenario on both branches with all issues done", () => {
    for (const scenario of SCENARIOS) {
      for (const decision of ["approve", "reject"] as const) {
        let s = reduce(initialState, { type: "pick", scenarioId: scenario.id });
        s = runUntilStop(reduce(reduce(s, { type: "send" }), { type: "confirm" }));
        expect(s.phase, `${scenario.id} reaches gate`).toBe("gated");
        s = runUntilStop(reduce(s, { type: "decide", decision }));
        expect(s.phase, `${scenario.id} ${decision}`).toBe("done");
        const view = boardView(s);
        expect(view.deliverable, `${scenario.id} ${decision} deliverable`).not.toBeNull();
        expect(view.issues.length).toBeGreaterThan(2);
        expect(view.issues.every((i) => i.status === "done"), `${scenario.id} ${decision} statuses`).toBe(true);
        expect(view.approval?.decision).toBe(decision);
      }
    }
  });
});
