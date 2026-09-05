import { describe, expect, it } from "vitest";
import { A, at, ev, I1, item, roster, score, T } from "./helpers/evaluation-fixtures.js";

// AgentDash: Company Evaluator — Milestone 3 scoring interaction: the read-only
// evaluator principal's own refused requests are the §10.2 mechanism working,
// never a company authority breach (P6 / E3).

describe("M3 — evaluator refusals and P6", () => {
  it("a refusal recorded with the read-only reason code is not a P6 detection; other refusals still are", () => {
    const EVALUATOR = "00000000-0000-4000-8000-0000000000e1";
    const window = [
      ...roster(),
      ev({ type: "agent.snapshot", time: at(0), projectId: null, sourceId: EVALUATOR, payload: { agentId: EVALUATOR, name: "Evaluator", role: "evaluator", status: "idle", reportsTo: null, accountableUserId: "founder-1" } }),
      ...item({ id: I1, started: 1, done: 4 }),
      ev({ type: "authz.refused", time: at(2), actor: ["agent", EVALUATOR], issueId: I1, sourceTable: "activity_log", payload: { method: "PATCH", routePath: "/api/issues/:id", reasonCode: "EVALUATOR_READ_ONLY" } }),
      ev({ type: "authz.refused", time: at(3), actor: ["agent", T], issueId: I1, sourceTable: "activity_log", payload: { method: "POST", routePath: "/api/companies/:companyId/verdicts", reasonCode: "NEUTRAL_VALIDATOR_VIOLATION" } }),
    ];
    const card = score(window);
    const evaluatorRow = card.actors.find((a) => a.actorId === EVALUATOR);
    expect(evaluatorRow?.metrics.P6?.n ?? 0).toBe(0);
    expect(card.actors.find((a) => a.actorId === T)!.metrics.P6!.n).toBe(1);
    // one E3 for T's refused request; the fixture's reviewer closing the item is the known transition-of-unassigned detection
    expect(card.exceptions.filter((e) => e.id === "E3" && e.note.includes("refused request")).length).toBe(1);
    expect(card.exceptions.filter((e) => e.id === "E3" && e.note.includes("EVALUATOR_READ_ONLY")).length).toBe(0);
    expect(card.actors.find((a) => a.actorId === A)!.metrics.P6!.n).toBe(0);
    // the evaluator never runs on its own card: no operating row is opened for it by its refusals
    expect(evaluatorRow).toBeUndefined();
  });

  it("the gate's own refusals are not evidence that the company records authority refusals", () => {
    const EVALUATOR = "00000000-0000-4000-8000-0000000000e1";
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, done: 4 }),
      ev({ type: "authz.refused", time: at(2), actor: ["agent", EVALUATOR], issueId: I1, sourceTable: "activity_log", payload: { method: "PATCH", routePath: "/api/issues/:id", reasonCode: "EVALUATOR_READ_ONLY" } }),
    ];
    const card = score(window);
    expect(card.missingSources.some((m) => /authority refusals/.test(m))).toBe(true);
    expect(card.actors.some((a) => a.actorId === EVALUATOR)).toBe(false);
  });
});
