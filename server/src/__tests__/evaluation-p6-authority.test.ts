import { describe, expect, it } from "vitest";
import type { ScoredCard } from "../services/evaluation/scoring/types.js";
import { A, at, ev, I1, I2, item, P, R, roster, score, T, verdict } from "./helpers/evaluation-fixtures.js";

// AgentDash: Company Evaluator — P6 "transition of an item you are not assigned to" (rules 6a–6c).
// Regression cases from the first shadow cards (doc/plans/2026-09-07-company-evaluator-authority-calibration.md):
// unauthorized and out-of-scope moves stay detections, moves with missing authority evidence are not judged (6a/6b), and
// the sanctioned-close carve-out (6c) is held for the second milestone's evidence (D-R2) — so a verdict does not yet license a close.

const p6 = (card: ScoredCard, agentId: string) => card.actors.find((a) => a.actorId === agentId)!.metrics.P6!;
const e3On = (card: ScoredCard, issueId: string) => card.exceptions.filter((e) => e.id === "E3" && e.subject.id === issueId);
const move = (issueId: string, h: number, actor: string, from: string | null, to: string) =>
  ev({ type: "issue.transition", time: at(h), actor: ["agent", actor], issueId, payload: { from, to, reopened: false, ...(from == null ? { fromUnknown: true } : {}) } });

describe("P6 authority — transitions by a non-assignee", () => {
  it("held (6c, D-R2): the reviewer closing in_review→done after its own passed verdict is still a detection today", () => {
    const card = score([...roster(), ...item({ id: I1, started: 1, review: 3 }), verdict(I1, 4, R), move(I1, 5, R, "in_review", "done")]);
    expect(p6(card, R).detail.rules).toEqual({ transition_not_assigned: 1 });
    expect(p6(card, R).detail).not.toHaveProperty("authorized");
    expect(e3On(card, I1)).toHaveLength(1);
  });

  it("unauthorized: an agent with no verdict moving another agent's item in_progress→done is a detection", () => {
    const card = score([...roster(), ...item({ id: I1, started: 1 }), move(I1, 2, T, "in_progress", "done")]);
    expect(p6(card, T).detail.rules).toEqual({ transition_not_assigned: 1 });
    expect(e3On(card, I1)).toHaveLength(1);
    expect(e3On(card, I1)[0]!.note).toBe("transition of an unassigned item: moved in_progress→done on an item assigned to another agent");
    expect(card.flags).toContain("E3 present");
  });

  it("out of scope: a verdict on a different item, or a failed verdict, never changes the judgment of a move", () => {
    const other = score([...roster(), ...item({ id: I1, started: 1, review: 3 }), ...item({ id: I2, started: 1, review: 3 }), verdict(I2, 4, R), move(I1, 5, R, "in_review", "done")]);
    expect(p6(other, R).detail.rules).toEqual({ transition_not_assigned: 1 });
    const failed = score([...roster(), ...item({ id: I1, started: 1, review: 3 }), verdict(I1, 4, R, "failed"), move(I1, 5, R, "in_review", "done")]);
    expect(p6(failed, R).detail.rules).toEqual({ transition_not_assigned: 1 });
  });

  it("insufficient evidence: a status write with no recorded previous status is not a transition (6a)", () => {
    // production shape: a PATCH whose `_previous` carried no status (AGE-20 at 05:56Z, AGE-104 at 07:20Z on the first shadow cards)
    const card = score([...roster(), ...item({ id: I1, started: 1, review: 3 }), move(I1, 4, T, null, "in_review")]);
    expect(p6(card, T).detail.rules).toEqual({});
    expect(p6(card, T).detail.insufficient).toEqual({ unknownFrom: 1, ownerUnknown: 0 });
    expect(p6(card, T).value).toBe(0);
    expect(e3On(card, I1)).toHaveLength(0);
    expect(p6(card, T).notes).toContain("1 status write with no recorded previous status: no state change is evidenced, so not judged");
  });

  it("insufficient evidence: an owner known only from a later snapshot is unknown at the time of the move (6b)", () => {
    const window = [
      ...roster(),
      ev({ type: "issue.created", time: at(0), actor: ["user", "local-board"], issueId: I1 }),
      move(I1, 1, T, "todo", "in_progress"),
      // the only snapshot is taken after the move and shows A as assignee — it must not be projected backward
      ev({ type: "issue.snapshot", time: at(2), issueId: I1, sourceTable: "issues", payload: { status: "in_progress", projectId: P, inheritedProjectId: null, goalId: null, assigneeAgentId: A, assigneeUserId: null, labels: [], titleTokens: ["x"], dodCriteria: 0, createdAt: at(0).toISOString(), startedAt: at(1).toISOString(), completedAt: null, cancelledAt: null } }),
    ];
    const card = score(window);
    expect(p6(card, T).detail.rules).toEqual({});
    expect(p6(card, T).detail.insufficient).toEqual({ unknownFrom: 0, ownerUnknown: 1 });
    expect(e3On(card, I1)).toHaveLength(0);
    expect(p6(card, T).notes).toContain("1 move on an item whose owner at the time is not on record: not judged");
    // an assignment recorded before the move makes the owner known again
    const known = score([...window, ev({ type: "issue.assignment_changed", time: at(0.5), actor: ["user", "local-board"], issueId: I1, payload: { fromAgentId: null, toAgentId: A, fromUserId: null, toUserId: null, previousUnknown: false } })]);
    expect(p6(known, T).detail.rules).toEqual({ transition_not_assigned: 1 });
  });

  it("a reopen done→in_review by a non-assignee stays a detection; the assignee's own moves never count", () => {
    const card = score([...roster(), ...item({ id: I1, started: 1, review: 3, done: 5 }), move(I1, 6, T, "done", "in_review"), move(I1, 7, A, "in_review", "in_progress")]);
    expect(p6(card, T).detail.rules).toEqual({ transition_not_assigned: 1 });
    expect(p6(card, A).detail.rules).toEqual({});
    // two E3s on the item: R's unverdicted close from item()'s default actor, and T's reopen
    expect(p6(card, R).detail.rules).toEqual({ transition_not_assigned: 1 });
    expect(e3On(card, I1).map((e) => e.actorAgentId).sort()).toEqual([R, T].sort());
  });
});
