import { describe, expect, it } from "vitest";
import { EVALUATION_AGENT_SOURCE_EVENT_TYPES, EVALUATION_TYPED_ACTIVITY_EVENT_TYPES } from "@paperclipai/shared";
import {
  classifyEvent,
  viewerClassFilter,
  viewerReadsClass,
  type EvaluationViewer,
} from "../services/evaluation/access-class.js";
import { cardHash, FORMULA_VERSION, scoreMilestone } from "../services/evaluation/scoring/card.js";
import { buildTimeline, isMilestoneInput } from "../services/evaluation/scoring/timeline.js";
import { A, at, CO, ev, evidenced, G, I1, I2, item, P, ref, roster, score } from "./helpers/evaluation-fixtures.js";

// AgentDash: Agent Performance Management gate 3 (P3.2) — the pure parts of
// ingest's access classes and the timeline fixes: class precedence, the
// viewer rule (stored class plus the live restricted-project rule), the kept
// issue-less runs/costs/verdicts and snapshot fields, and the proof that the
// milestone card moves only by the declared formula bump.

const RESTRICTED = "11111111-1111-4111-8111-111111111111";
const OPEN = "22222222-2222-4222-8222-222222222222";
const RECEIPT = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";
const ctx = { restrictedProjectIds: new Set([RESTRICTED]) };

function viewer(overrides: Partial<EvaluationViewer> = {}): EvaluationViewer {
  return {
    companyId: CO,
    principal: { type: "board", userId: "user-1" },
    admin: false,
    readableProjectIds: new Set([OPEN]),
    hiddenProjectIds: new Set([RESTRICTED]),
    privateAgentIds: new Set(),
    pairingReceiptIds: new Set(),
    ...overrides,
  };
}

describe("APM gate 3: access classes at ingest", () => {
  it("the most private applicable class wins: pairing > agent > restricted project > company", () => {
    const base = { sourceTable: "agent_corrections", eventType: "assessment.automated" as const, projectId: RESTRICTED };
    expect(classifyEvent({ ...base, pairingReceiptId: RECEIPT, privateAgentId: AGENT }, ctx)).toBe(`private_pairing:${RECEIPT}`);
    expect(classifyEvent({ ...base, eventType: "correction.recorded", privateAgentId: AGENT }, ctx)).toBe(`private_agent:${AGENT}`);
    expect(classifyEvent({ ...base, eventType: "issue.transition" }, ctx)).toBe(`project:${RESTRICTED}`);
    expect(classifyEvent({ ...base, eventType: "issue.transition", projectId: RESTRICTED.toUpperCase() }, ctx)).toBe(`project:${RESTRICTED}`);
    expect(classifyEvent({ ...base, eventType: "issue.transition", projectId: OPEN }, ctx)).toBe("company");
    expect(classifyEvent({ ...base, eventType: "goal.snapshot", projectId: null }, ctx)).toBe("company");
  });

  it("a private record whose id cannot form a class is refused, never widened", () => {
    expect(() => classifyEvent({ sourceTable: "agent_corrections", eventType: "assessment.automated", projectId: null, pairingReceiptId: "nope" }, ctx)).toThrow();
    expect(() => classifyEvent({ sourceTable: "agent_corrections", eventType: "correction.recorded", projectId: null, privateAgentId: "nope" }, ctx)).toThrow();
  });
});

describe("APM gate 3: the viewer rule", () => {
  it("company rows are readable; project rows only for readable projects; private rows only for their readers", () => {
    const v = viewer({ privateAgentIds: new Set([AGENT]), pairingReceiptIds: new Set([RECEIPT]) });
    expect(viewerReadsClass(v, "company")).toBe(true);
    expect(viewerReadsClass(v, `project:${OPEN}`)).toBe(true);
    expect(viewerReadsClass(v, `project:${RESTRICTED}`)).toBe(false);
    expect(viewerReadsClass(v, `private_agent:${AGENT}`)).toBe(true);
    expect(viewerReadsClass(v, `private_pairing:${RECEIPT}`)).toBe(true);
    const outsider = viewer();
    expect(viewerReadsClass(outsider, `private_agent:${AGENT}`)).toBe(false);
    expect(viewerReadsClass(outsider, `private_pairing:${RECEIPT}`)).toBe(false);
    // a deleted project is in neither set: its project rows stay hidden
    expect(viewerReadsClass(outsider, "project:55555555-5555-4555-8555-555555555555")).toBe(false);
  });

  it("an unparseable class is readable by admins only", () => {
    for (const bad of ["", "Company", "project:", "project:ABCDEF12-3456-4789-8ABC-DEF123456789", `private_agent:${AGENT} `, "team:x"]) {
      expect(viewerReadsClass(viewer(), bad)).toBe(false);
      expect(viewerReadsClass(viewer({ admin: true }), bad)).toBe(true);
    }
  });

  it("the live restricted-project rule hides a row stored as company (history before gate 3) for a viewer off the access list", () => {
    const filter = viewerClassFilter(viewer());
    expect(filter({ accessClass: "company", projectId: RESTRICTED })).toBe(false);
    expect(filter({ accessClass: "company", projectId: OPEN })).toBe(true);
    expect(filter({ accessClass: "company", projectId: null })).toBe(true);
    // even a readable private class is hidden when its project is hidden to the viewer
    expect(viewerClassFilter(viewer({ privateAgentIds: new Set([AGENT]) }))({ accessClass: `private_agent:${AGENT}`, projectId: RESTRICTED })).toBe(false);
    expect(viewerClassFilter(viewer({ admin: true }))({ accessClass: "company", projectId: RESTRICTED })).toBe(true);
  });

  it("agent principals read company and readable-project rows, never a private class", () => {
    const agent = viewer({ principal: { type: "agent", agentId: AGENT, evaluator: true } });
    expect(viewerReadsClass(agent, "company")).toBe(true);
    expect(viewerReadsClass(agent, `private_agent:${AGENT}`)).toBe(false);
  });
});

describe("APM gate 3: timeline fixes", () => {
  it("runs and costs with no issue are kept as unattributed work, without setting item-level source presence", () => {
    const window = [
      ev({ type: "run.finished", time: at(1), actor: ["agent", A], projectId: null, payload: { runId: "r1", agentId: A, status: "succeeded", durationMs: 1000, usagePresent: true, inputTokens: 10, outputTokens: 5 } }),
      ev({ type: "cost.recorded", time: at(1), actor: ["agent", A], projectId: null, payload: { costEventId: "c1", agentId: A, heartbeatRunId: "r1", costCents: 7, inputTokens: 10, outputTokens: 5 } }),
    ];
    const tl = buildTimeline(window);
    expect(tl.items.size).toBe(0);
    expect(tl.unattributedRuns).toEqual([expect.objectContaining({ runId: "r1", agentId: A, status: "succeeded", durationMs: 1000 })]);
    expect(tl.unattributedCosts).toEqual([expect.objectContaining({ runId: "r1", agentId: A, costCents: 7 })]);
    expect(tl.sources.runs).toBe(false);
    expect(tl.sources.costEvents).toBe(false);
  });

  it("project- and goal-level verdicts are kept with their scope", () => {
    const window = [
      ev({ type: "verdict.recorded", time: at(2), actor: ["user", "founder-1"], projectId: P, sourceTable: "verdicts", payload: { verdictId: "vp", entityType: "project", outcome: "passed", reviewerAgentId: null, reviewerUserId: "founder-1", verdictProjectId: P, verdictGoalId: null } }),
      ev({ type: "verdict.recorded", time: at(3), actor: ["agent", A], projectId: null, goalId: G, sourceTable: "verdicts", payload: { verdictId: "vg", entityType: "goal", outcome: "failed", reviewerAgentId: A, reviewerUserId: null } }),
    ];
    const tl = buildTimeline(window);
    expect(tl.milestoneVerdicts.map((v) => [v.verdictId, v.entityType, v.outcome, v.projectId, v.goalId])).toEqual([
      ["vp", "project", "passed", P, null],
      ["vg", "goal", "failed", null, G],
    ]);
    expect(tl.sources.verdicts).toBe(false);
  });

  it("goal snapshots carry currentValue/lastUpdatedAt and agent facts carry adapterType/model; earlier snapshots read null", () => {
    const tl = buildTimeline([
      ev({ type: "goal.snapshot", time: at(0), projectId: null, goalId: G, sourceId: G, payload: { goalId: G, title: "Ship", status: "active", metricDefinition: { target: 10, unit: "deals" }, currentValue: 4, lastUpdatedAt: "2026-08-01T09:00:00.000Z" } }),
      ev({ type: "agent.snapshot", time: at(0), projectId: null, sourceId: A, payload: { agentId: A, name: "Builder", adapterType: "claude_local", model: "claude-opus" } }),
      ev({ type: "agent.snapshot", time: at(0), projectId: null, sourceId: AGENT, payload: { agentId: AGENT, name: "Old" } }),
    ]);
    expect(tl.goals.get(G)![0]).toMatchObject({ currentValue: 4, lastUpdatedAt: "2026-08-01T09:00:00.000Z" });
    expect(tl.agents.get(A)).toMatchObject({ adapterType: "claude_local", model: "claude-opus" });
    expect(tl.agents.get(AGENT)).toMatchObject({ adapterType: null, model: null });
  });
});

describe("APM gate 3: milestone cards move only by the declared formula bump", () => {
  const base = () => [...roster(), ...evidenced(I1), ...item({ id: I2, created: 1 })];

  it("the formula version is bumped", () => {
    expect(FORMULA_VERSION).toBe("m2-score/9");
  });

  it("agent-side source events — backfilled with old event times, scoped to the milestone, by agents and people — leave the card byte-identical", () => {
    const window = base();
    const cut = Math.max(...window.map((e) => Number(e.seq)));
    const longAgo = new Date(at(0).getTime() - 120 * 24 * 3_600_000);
    const ingestNow = at(40);
    const agentSide = EVALUATION_AGENT_SOURCE_EVENT_TYPES.map((type, i) =>
      ev({ type, time: longAgo, ingest: ingestNow, actor: i % 2 === 0 ? ["agent", A] : ["user", "steward-1"], issueId: I1, projectId: P, goalId: G, payload: { agentId: A, n: i } }),
    );
    expect(agentSide.every((e) => !isMilestoneInput(e))).toBe(true);
    // the agent-side rows are interleaved below the cut, so the card is scored at the same throughSeq
    const mixed = [...window, ...agentSide].map((e, i) => ({ ...e, seq: i + 1 }));
    const plain = mixed.filter((e) => isMilestoneInput(e));
    const cutMixed = mixed.length;
    expect(cardHash(scoreMilestone(mixed, ref, cutMixed, CO, { fallbackOpen: true }))).toBe(cardHash(scoreMilestone(plain, ref, cutMixed, CO, { fallbackOpen: true })));
    // and nothing about the lag or the actors leaked in
    const card = scoreMilestone(mixed, ref, cutMixed, CO, { fallbackOpen: true });
    expect(card.maxIngestLagMs).toBe(score(window).maxIngestLagMs);
    expect(card.markers).not.toContain("records lag events by more than a day in this window (see the ingest lag on the scorecard)");
    expect(cut).toBeGreaterThan(0);
  });

  it("typed access and routine activity score exactly as the item-less activity.other rows they replaced", () => {
    const window = base();
    const typed = EVALUATION_TYPED_ACTIVITY_EVENT_TYPES.map((type, i) =>
      // ingest now scopes a would-be refusal by the issue in its details: the card still ignores it
      ev({ type, time: at(9 + i), actor: ["agent", A], issueId: I1, projectId: P, sourceTable: "activity_log", payload: { action: type, agentId: A } }),
    );
    const asOther = typed.map((e) => ({ ...e, eventType: "activity.other" as const, projectId: null, payload: { action: e.eventType, entityType: "agent", entityId: A } }));
    const cut = Math.max(...[...window, ...typed].map((e) => Number(e.seq)));
    const withTyped = scoreMilestone([...window, ...typed], ref, cut, CO, { fallbackOpen: true });
    const withOther = scoreMilestone([...window, ...asOther], ref, cut, CO, { fallbackOpen: true });
    expect(cardHash(withTyped)).toBe(cardHash(withOther));
  });

  it("the declared difference: a checkout is now an assignment plus a transition into in_progress (it was activity.other)", () => {
    const I = "00000000-0000-4000-8000-000000000199";
    const created = item({ id: I, created: 0 }); // snapshot todo, no start transition
    const checkoutTime = at(2);
    const before = [
      ...roster(),
      ...created,
      ev({ type: "activity.other", time: checkoutTime, actor: ["agent", A], issueId: I, sourceTable: "activity_log", payload: { action: "issue.checked_out", entityType: "issue", entityId: I } }),
    ];
    const after = [
      ...roster(),
      ...created,
      ev({ type: "issue.assignment_changed", time: checkoutTime, actor: ["agent", A], issueId: I, sourceTable: "activity_log", payload: { fromAgentId: null, toAgentId: A, fromUserId: null, toUserId: null, previousUnknown: true, source: "checkout" } }),
      ev({ type: "issue.transition", time: checkoutTime, actor: ["agent", A], issueId: I, sourceTable: "activity_log", payload: { from: null, fromUnknown: true, to: "in_progress", reopened: false, source: "checkout" } }),
    ];
    const tlBefore = buildTimeline(before).items.get(I)!;
    const tlAfter = buildTimeline(after).items.get(I)!;
    expect(tlBefore.transitions).toHaveLength(0);
    expect(tlBefore.otherActivity.map((o) => o.action)).toEqual(["issue.checked_out"]);
    expect(tlAfter.transitions.map((t) => [t.from, t.to, t.source])).toEqual([[null, "in_progress", "checkout"]]);
    expect(tlAfter.assignments.map((a) => [a.toAgentId, a.previousUnknown])).toEqual([[A, true]]);
    const cardBefore = score(before);
    const cardAfter = score(after);
    expect(cardAfter.byType["issue.transition"]).toBe((cardBefore.byType["issue.transition"] ?? 0) + 1);
    expect(cardAfter.byType["issue.assignment_changed"]).toBe(1);
    expect(cardBefore.byType["activity.other"]).toBe(1);
    expect(cardAfter.byType["activity.other"]).toBeUndefined();
    // the checkout is the item's start now: work started without a definition of done raises E10, which it could not before
    const e10 = (card: typeof cardAfter) => card.exceptions.filter((e) => e.id === "E10" && e.key.includes(I));
    expect(e10(cardBefore)).toHaveLength(0);
    expect(e10(cardAfter)).toHaveLength(1);
    // a checkout's previous status is unknown: P6 never judges such a move a breach (rule 6a), so no E3 appears
    expect(cardAfter.exceptions.some((e) => e.id === "E3")).toBe(false);
    expect(cardAfter.formulaVersion).toBe("m2-score/9");
  });
});
