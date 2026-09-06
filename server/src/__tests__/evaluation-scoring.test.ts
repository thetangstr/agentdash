import { describe, expect, it } from "vitest";
import { EVALUATION_REVIEW_LABEL } from "@paperclipai/shared";
import type { EvaluationEventRow } from "../services/evaluation/ledger.js";
import { cardHash, scoreMilestone } from "../services/evaluation/scoring/card.js";
import { composite, scaleTo100 } from "../services/evaluation/scoring/composite.js";
import { tierFor } from "../services/evaluation/scoring/confidence.js";
import type { MetricResult } from "../services/evaluation/scoring/types.js";

// AgentDash: Company Evaluator — Milestone 2 unit tests on fixture ledgers.
// Spec §5 formulas, §7 tiers, §5.3 composites and guards, §8 anti-gaming
// rules 4, 10–19, §9 exceptions, §3 membership with mid-milestone moves.
// No database: a window is an array of ledger rows.

import { A, at, CO, ev, evidenced, FOUNDER, G, gates, handoff, I1, I2, I3, iso, item, P, P2, R, ref, roster, score, shuffle, T, verdict } from "./helpers/evaluation-fixtures.js";

describe("scoring — determinism and card shape", () => {
  it("the same window in any order yields the same bytes; a different cut differs; values are null at insufficient", () => {
    const window = [...roster(), ...evidenced(I1), ...item({ id: I2, started: 1, done: 4 })];
    const card = score(window);
    expect(cardHash(scoreMilestone(shuffle(window), ref, card.throughSeq, CO, { fallbackOpen: true }))).toBe(cardHash(card));
    expect(cardHash(scoreMilestone(window, ref, card.throughSeq - 1, CO, { fallbackOpen: true }))).not.toBe(cardHash(card));
    expect(card.formulaVersion).toBe("m2-score/7");
    expect(card.state.open).toBe(true); // from the project.snapshot, not the fallback
    expect(card.contract.source).toBe("derived");
    expect(card.markers).toContain("contract derived by the evaluator — confidence capped at adequate");
    expect(card.outcome.O1!.value).toBeNull();
    expect(card.outcome.O1!.confidence).toBe("insufficient");
    expect(card.outcome.O1!.headline).toMatch(/^insufficient evidence/);
    expect(card.excludedMetrics.some((x) => x.key === "O1" && x.scope === "milestone")).toBe(true);
    expect(card.membership).toMatchObject({ items: 2, done: 2 });
  });

  it("the open flag follows the ledger's own roster fact and the fallback only fills a gap", () => {
    const window = [...roster(), ...item({ id: I1, started: 1, done: 4 })];
    const closedWindow = [...window, ev({ type: "project.snapshot", time: at(20), projectId: P, goalId: G, sourceId: P, payload: { projectId: P, name: "Launch", status: "completed", goalId: G } })];
    expect(score(closedWindow).state.open).toBe(false);
    const noRoster = window.filter((e) => e.eventType !== "project.snapshot");
    expect(scoreMilestone(noRoster, ref, 999, CO, { fallbackOpen: false }).state.open).toBe(false);
    expect(scoreMilestone(noRoster, ref, 999, CO, { fallbackOpen: true }).state.open).toBe(true);
  });
});

describe("evidence classes (spec §4.1) and rules 4, 10, 11, 15", () => {
  it("rule 10: a missing record is undecidable only while the company has no source at all; once a source exists it is failed", () => {
    const bare = [...roster(), ...item({ id: I1, started: 1, done: 4 })];
    const c1 = score(bare);
    const perClass1 = (c1.outcome.O5!.detail.perClass as Record<string, { undecidable: number; failed: number }>);
    expect(perClass1.neutral_verdict).toMatchObject({ undecidable: 1, failed: 0 });
    expect(perClass1.ci_green).toMatchObject({ undecidable: 1 });
    expect(c1.missingSources.some((s) => s.startsWith("verdicts"))).toBe(true);
    // a verdict on another item makes the source exist
    const withSource = [...bare, ...item({ id: I2, started: 1, done: 4 }), verdict(I2, 3, R)];
    const c2 = score(withSource);
    const perClass2 = (c2.outcome.O5!.detail.perClass as Record<string, { undecidable: number; failed: number; satisfied: number }>);
    expect(perClass2.neutral_verdict).toMatchObject({ failed: 1, satisfied: 1, undecidable: 0 });
  });

  it("a fully evidenced item satisfies every required class; O5 = 1", () => {
    const card = score([...roster(), ...evidenced(I1)]);
    expect(card.outcome.O5!.value).toBe(1);
    expect(card.outcome.O5!.breakdown).toMatchObject({ satisfied: 1, failed: 0 });
    expect(card.outcome.O5!.tiers).toEqual(["T0", "T2"]);
    expect(card.exceptions.filter((e) => e.id === "E4")).toEqual([]);
  });

  it("rule 4: a passed verdict recorded after done does not satisfy that close", () => {
    const card = score([...roster(), ...item({ id: I1, started: 1, done: 4 }), verdict(I1, 9, R)]);
    const perClass = card.outcome.O5!.detail.perClass as Record<string, { failed: number }>;
    expect(perClass.neutral_verdict.failed).toBe(1);
    expect(card.outcome.O5!.value).toBe(0);
  });

  it("§4.2 / E4: a verdict by the assignee is a violation, never evidence; the card carries the flag", () => {
    const card = score([...roster(), ...item({ id: I1, started: 1, done: 4 }), verdict(I1, 3, A)]);
    const e4 = card.exceptions.filter((e) => e.id === "E4");
    expect(e4.length).toBe(1);
    expect(e4[0]!.severity).toBe("immediate");
    expect(e4[0]!.routing.founderView).toBe(true);
    expect(e4[0]!.routing.managerAgentIds).toEqual([R]); // A reports to R
    expect(e4[0]!.note).toContain("the contributor reviewed their own work");
    expect(card.flags).toContain("E4 present");
    expect((card.outcome.O5!.detail.perClass as Record<string, { failed: number }>).neutral_verdict.failed).toBe(1);
    const p6 = card.actors.find((a) => a.actorId === A)!.metrics.P6!;
    expect(p6.n).toBe(1);
    expect(card.exceptions.some((e) => e.id === "E3")).toBe(true);
  });

  it("rule 15: an approval decided by a synthetic identity never confers independence", () => {
    const card = score([
      ...roster(),
      ...item({ id: I1, started: 1, done: 4 }),
      ev({ type: "approval.decided", time: at(3), actor: ["user", "local-board"], issueId: I1, sourceTable: "activity_log", payload: { approvalId: "ap1", type: "verdict_escalation", decision: "approved" } }),
    ]);
    const perClass = card.outcome.O5!.detail.perClass as Record<string, { undecidable: number }>;
    expect(perClass.neutral_verdict.undecidable).toBe(1);
    expect(card.markers).toContain("synthetic human identities — interventions counted, not attributed");
  });

  it("rule 11 / E12: the DoD that counts is the earliest in force; narrowing after start is material", () => {
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, done: 6, dod: true, dodSetAt: 0 }),
      ev({ type: "issue.dod_set", time: at(3), actor: ["agent", A], issueId: I1, payload: { hasPrevious: true, criteriaCount: 1, previousCriteriaCount: 2, criteriaIds: ["c1"], previousCriteriaIds: ["c1", "c2"], criteriaHashes: ["h1"], previousCriteriaHashes: ["h1", "h2"] } }),
    ];
    const card = score(window);
    const e12 = card.exceptions.filter((e) => e.id === "E12");
    expect(e12.length).toBe(1);
    expect(e12[0]!.note).toMatch(/reduced from 2 to 1|removed/);
    expect(card.markers).toContain("partial records — some sources are absent from this window (see missing sources)");
    // §4.1: a DoD narrowed after leaving backlog never satisfies the class (round 1, MEDIUM 4)
    expect((card.outcome.O5!.detail.perClass as Record<string, { failed: number }>).dod_present.failed).toBe(1);
    // a DoD first set after done fails the class (rule 4)
    const late = score([...roster(), ...item({ id: I2, started: 1, done: 4 }), ev({ type: "issue.dod_set", time: at(5), actor: ["user", "local-board"], issueId: I2, payload: { hasPrevious: false, criteriaCount: 1 } })]);
    expect((late.outcome.O5!.detail.perClass as Record<string, { failed: number }>).dod_present.failed).toBe(1);
  });
});

describe("contracts (spec §4), rules 16 and 17, O1 and E1", () => {
  function declared(h: number, criteria: Array<Record<string, unknown>>, requiredEvidence = ["dod_present", "neutral_verdict", "delivery_ref", "ci_green", "independent_review"]) {
    return ev({
      type: "contract.declared",
      time: at(h),
      actor: ["user", "founder-1"],
      sourceTable: "evaluation_contracts",
      sourceId: `project:${P}`,
      payload: {
        contract: {
          contractVersion: "v1",
          companyId: CO,
          goalId: G,
          parentGoalId: null,
          milestoneRef: ref,
          accountableUserId: FOUNDER,
          leadAgentId: null,
          acceptanceCriteria: criteria,
          definitionOfDone: null,
          requiredEvidence,
          independenceRule: "independence/v1",
          excludedReviewers: [],
          founderLocks: [],
          outcomeTarget: null,
          targetDate: null,
          downstreamRiskAcceptance: null,
          windowStart: iso(0),
          windowEnd: null,
          source: "declared",
        },
      },
    });
  }
  const verdictCriterion = { id: "k1", text: "an independent verdict passed", check: { kind: "record", record: "verdict.passed" }, source: "human" };

  it("a declared record criterion is satisfied by the record, failed without it (E1), and undecidable when declared post hoc (rule 17)", () => {
    const early = score([...roster(), declared(-1, [verdictCriterion]), ...evidenced(I1), ...item({ id: I2, started: 1, done: 4 })]);
    expect(early.contract.source).toBe("declared");
    expect(early.outcome.O1!.breakdown).toMatchObject({ satisfied: 1, failed: 1 });
    expect(early.outcome.O1!.value).toBe(0.5);
    expect(early.outcome.O1!.headline).toBe("satisfied 1 of 2 done; 1 failed");
    const e1 = early.exceptions.filter((e) => e.id === "E1");
    expect(e1.length).toBe(1);
    expect(e1[0]!.subject.id).toBe(I2);
    expect(e1[0]!.routing.accountableUserId).toBe(FOUNDER);
    const posthoc = score([...roster(), ...item({ id: I2, started: 1, done: 4 }), declared(10, [verdictCriterion])]);
    expect(posthoc.outcome.O1!.breakdown.undecidable[0]!).toMatchObject({ count: 1 });
    expect(posthoc.outcome.O1!.breakdown.undecidable[0]!.reason).toMatch(/declared after this item closed/);
    expect(posthoc.outcome.O1!.value).toBeNull();
  });

  it("rule 16: a contract below the engineering default or with check-less criteria is a recorded exception on the card", () => {
    const weak = score([...roster(), declared(-1, [{ id: "k2", text: "feels done", source: "human" }], ["dod_present"]), ...item({ id: I1, started: 1, done: 4 })]);
    expect(weak.contract.exceptions.some((x) => x.includes("omits neutral_verdict"))).toBe(true);
    expect(weak.contract.exceptions.some((x) => x.includes("without a check"))).toBe(true);
    expect(weak.markers).toContain("contract exception — founder acceptance required");
    expect(weak.outcome.O1!.breakdown.undecidable[0]!.reason).toMatch(/unmeasurable/);
  });
});

describe("membership (spec §3), rule 12, rule 18", () => {
  it("an item counts in the milestone it belonged to at its terminal status; evaluator output is excluded", () => {
    const moved = [
      ...roster(),
      ev({ type: "project.snapshot", time: at(0), projectId: P2, sourceId: P2, payload: { projectId: P2, name: "Other", status: "in_progress" } }),
      ...item({ id: I1, started: 1, done: 6, project: P }),
      // I1 moved to P2 before it was done
      ev({ type: "issue.snapshot", time: at(4), issueId: I1, projectId: P2, sourceTable: "issues", payload: { status: "in_review", projectId: P2, inheritedProjectId: null, assigneeAgentId: A, labels: [], titleTokens: ["ship"], createdAt: iso(0), startedAt: iso(1) } }),
      ...item({ id: I2, started: 1, done: 5, labels: [EVALUATION_REVIEW_LABEL] }),
      ...item({ id: I3, started: 1, done: 5 }),
    ];
    const card = score(moved);
    expect(card.membership).toMatchObject({ items: 1, movedOut: 1, excludedEvaluatorItems: 1 });
    const other = scoreMilestone(moved, { kind: "project", id: P2 }, 999, CO, { fallbackOpen: true });
    expect(other.membership).toMatchObject({ items: 1, movedIn: 1 });
  });

  it("rule 18: a cancelled item followed by a successor sharing its parent is rework, not a free cancellation", () => {
    const parent = "00000000-0000-4000-8000-000000000999";
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, cancelled: 3, parentId: parent }),
      ...item({ id: I2, created: 4, started: 5, done: 8, parentId: parent }),
    ];
    const card = score(window);
    const p9 = card.actors.find((a) => a.actorId === A)!.metrics.P9!;
    expect(p9.detail.successorLinks).toEqual([{ cancelled: I1, successor: I2 }]);
    expect(p9.detail.rework).toBe(1);
    expect(p9.value).toBe(1); // one rework event over one delivered item
  });
});

describe("operating metrics", () => {
  it("P1 / E8: human interventions on an agent-owned item; three of them raise E8", () => {
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, review: 5, done: 8 }),
      ev({ type: "issue.transition", time: at(2), actor: ["user", "local-board"], issueId: I1, payload: { from: "in_progress", to: "blocked", reopened: false } }),
      ev({ type: "issue.transition", time: at(3), actor: ["user", "local-board"], issueId: I1, payload: { from: "blocked", to: "in_progress", reopened: false } }),
      ev({ type: "issue.blockers_updated", time: at(4), actor: ["user", "local-board"], issueId: I1, payload: { blockedByIssueIds: [I2], previous: [] } }),
      ...item({ id: I2, created: 0, started: 1, review: 2, done: 3 }),
    ];
    const card = score(window);
    const p1 = card.actors.find((a) => a.actorId === A)!.metrics.P1!;
    expect(p1.n).toBe(2);
    expect(p1.value).toBe(0.5);
    expect(p1.detail.interventions).toBe(3);
    expect(card.exceptions.some((e) => e.id === "E8" && e.subject.id === I1)).toBe(true);
  });

  it("P2: escalation precision through the bridge; P3 / E2: a suspicious payload timestamp is a contradicted claim", () => {
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, review: 2, done: 6 }),
      verdict(I1, 3, R, "escalated_to_human"),
      ev({ type: "approval.decided", time: at(4), actor: ["user", "eyan"], issueId: I1, sourceTable: "activity_log", payload: { approvalId: "ap1", type: "verdict_escalation", decision: "approved" } }),
      handoff(I1, 2, A, "builder_to_ci", { issue: { id: I1 }, size: "S", pr: { number: 1 }, branch: "b", regression_gates: gates, labels_applied: [] }, { claimedTimestamp: iso(-2), timestampClamped: false, timestampSuspicious: true }),
      handoff(I1, 2.5, A, "builder_to_ci", { issue: { id: I1 }, size: "S", pr: { number: 1 }, branch: "b", regression_gates: gates, labels_applied: [] }, { claimedTimestamp: iso(2.49), timestampClamped: false, timestampSuspicious: false }),
    ];
    const card = score(window);
    const reviewer = card.actors.find((a) => a.actorId === R)!;
    expect(reviewer.metrics.P2!.value).toBe(1);
    expect(reviewer.metrics.P2!.n).toBe(1);
    const builder = card.actors.find((a) => a.actorId === A)!;
    expect(builder.metrics.P3!.n).toBe(2);
    expect(builder.metrics.P3!.value).toBe(0.5);
    expect(card.exceptions.filter((e) => e.id === "E2").length).toBe(1);
  });

  it("P4: a handoff missing required fields is malformed; a complete one with a derivable receiver is well-formed", () => {
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, review: 3, done: 6 }),
      handoff(I1, 2, A, "builder_to_ci", { issue: { id: I1 }, pr: { number: 1 } }), // missing size, branch, regression_gates, labels_applied
      handoff(I1, 2.5, A, "builder_to_ci", { issue: { id: I1 }, size: "S", pr: { number: 1 }, branch: "b", regression_gates: gates, labels_applied: [] }),
    ];
    const p4 = score(window).actors.find((a) => a.actorId === A)!.metrics.P4!;
    expect(p4.n).toBe(2);
    expect(p4.value).toBe(0.5);
    expect(Object.keys(p4.detail.failures as Record<string, number>)[0]).toMatch(/payload missing/);
  });

  it("P6 / E3: acting on another agent's item and a logged refusal are detections, immediate", () => {
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, done: 4 }),
      ev({ type: "issue.transition", time: at(2), actor: ["agent", T], issueId: I1, payload: { from: "in_progress", to: "in_review", reopened: false } }),
      ev({ type: "authz.refused", time: at(3), actor: ["agent", T], issueId: I1, sourceTable: "activity_log", payload: { method: "PATCH", routePath: "/api/issues/:id", reasonCode: "NOT_ASSIGNEE" } }),
    ];
    const card = score(window);
    const p6 = card.actors.find((a) => a.actorId === T)!.metrics.P6!;
    expect(p6.detail.rules).toEqual({ authz_refused: 1, transition_not_assigned: 1 });
    expect(p6.n).toBe(2);
    // three E3s: two for T, and one for the reviewer R closing an item it was not assigned to — spec P6 as written; the
    // shadow run will show whether that rule needs a carve-out for the sanctioned review→done step
    expect(card.exceptions.filter((e) => e.id === "E3").length).toBe(3);
    expect(card.actors.find((a) => a.actorId === R)!.metrics.P6!.detail.rules).toEqual({ transition_not_assigned: 1 });
    expect(card.flags).toContain("E3 present");
  });

  it("P8 / E7: a run costing more than three times the agent's median is an anomaly; metering absent on most runs is one too", () => {
    const runs: EvaluationEventRow[] = [];
    const costs: EvaluationEventRow[] = [];
    for (let i = 0; i < 5; i++) {
      const runId = `r${i}`;
      runs.push(ev({ type: "run.finished", time: at(1 + i), actor: ["agent", A], issueId: I1, sourceTable: "heartbeat_runs", sourceId: runId, payload: { runId, agentId: A, status: "succeeded", durationMs: 60_000, usagePresent: false } }));
      costs.push(ev({ type: "cost.recorded", time: at(1 + i), actor: ["agent", A], issueId: I1, sourceTable: "cost_events", sourceId: `c${i}`, payload: { heartbeatRunId: runId, agentId: A, costCents: i === 4 ? 100 : 10 } }));
    }
    const card = score([...roster(), ...item({ id: I1, started: 1, done: 8 }), ...runs, ...costs]);
    const p8 = card.actors.find((a) => a.actorId === A)!.metrics.P8!;
    expect(p8.detail.metered).toBe(5);
    expect(p8.detail.anomalies).toBe(1);
    expect(card.exceptions.filter((e) => e.id === "E7").length).toBe(1);
    const unmetered = score([...roster(), ...item({ id: I2, started: 1, done: 8 }), ...runs.map((r) => ({ ...r, payload: { ...r.payload, issueId: I2 } }))]);
    expect(unmetered.exceptions.some((e) => e.id === "E7" && e.key.endsWith(":metering"))).toBe(true);
  });

  it("P9 / E6: a duplicate by label, and a done→reopen as rework", () => {
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, cancelled: 2, labels: ["duplicate"] }),
      ...item({ id: I2, started: 1, done: 4 }),
      ev({ type: "issue.transition", time: at(5), actor: ["user", "local-board"], issueId: I2, payload: { from: "done", to: "todo", reopened: true, source: "comment" } }),
    ];
    const card = score(window);
    const p9 = card.actors.find((a) => a.actorId === A)!.metrics.P9!;
    expect(p9.detail).toMatchObject({ duplicates: 1, rework: 1 });
    expect(card.exceptions.some((e) => e.id === "E6" && e.subject.id === I1)).toBe(true);
    expect(card.outcome.O3!.detail.reopens).toBe(1);
  });
});

describe("exceptions E5, E10, E13, E14 and the company row", () => {
  it("E5: an in-progress item with no activity, question, approval or human owner for two days is stale", () => {
    const window = [...roster(), ...item({ id: I1, started: 1 }), ev({ type: "agent.snapshot", time: at(80), projectId: null, sourceId: R, payload: { agentId: R, name: "Reviewer", status: "idle", reportsTo: null, accountableUserId: FOUNDER } })];
    const card = score(window);
    expect(card.exceptions.filter((e) => e.id === "E5").map((e) => e.subject.id)).toEqual([I1]);
    // a pending question is a valid waiting path
    const waiting = [...window, ev({ type: "interaction.changed", time: at(2), actor: ["agent", A], issueId: I1, sourceTable: "issue_thread_interactions", payload: { interactionId: "q1", kind: "ask_user_questions", status: "pending", createdAt: iso(2) } })];
    const card2 = score(waiting);
    expect(card2.exceptions.some((e) => e.id === "E5")).toBe(false);
    // and the company row owes the answer once it is older than 48 h
    const company = card2.actors.find((a) => a.actorType === "company")!;
    expect(company.metrics.P2!.value).toBe(1);
  });

  it("E10: an agent-owned item that entered in_progress with no DoD; E13: a withdrawn self-report", () => {
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, done: 4 }),
      ev({ type: "evidence.withdrawn", time: at(5), issueId: I1, sourceTable: "issue_comments", sourceId: "c-gone", payload: { commentId: "c-gone", reason: "comment no longer exists" } }),
    ];
    const card = score(window);
    expect(card.exceptions.some((e) => e.id === "E10" && e.subject.id === I1)).toBe(true);
    const e13 = card.exceptions.filter((e) => e.id === "E13");
    expect(e13.length).toBe(1);
    expect(e13[0]!.severity).toBe("material");
  });

  it("E14: two agents reviewing each other's items more than 80 % of the time", () => {
    const B = "00000000-0000-4000-8000-0000000000dd";
    const window = [...roster(), ev({ type: "agent.snapshot", time: at(0), projectId: null, sourceId: B, payload: { agentId: B, name: "Other", status: "idle", reportsTo: null, accountableUserId: FOUNDER } })];
    for (let i = 0; i < 3; i++) {
      const a = `00000000-0000-4000-8000-0000000000${(10 + i).toString().padStart(2, "0")}`;
      const b = `00000000-0000-4000-8000-0000000000${(20 + i).toString().padStart(2, "0")}`;
      window.push(...item({ id: a, started: 1, done: 4, assignee: A }), verdict(a, 3, B));
      window.push(...item({ id: b, started: 1, done: 4, assignee: B }), verdict(b, 3, A));
    }
    const card = score(window);
    const e14 = card.exceptions.filter((e) => e.id === "E14");
    expect(e14.length).toBe(1);
    expect(e14[0]!.subject.kind).toBe("pair");
  });
});

describe("confidence tiers (spec §7) and composites (spec §5.3)", () => {
  it("one rule for every metric: boundaries at 0.2, 0.5 and 0.8; two tiers for High; caps for derived, retrospective and disagreement", () => {
    expect(tierFor({ coverage: 0.19, tiers: ["T0"] }).tier).toBe("insufficient");
    expect(tierFor({ coverage: 0.2, tiers: ["T0"] }).tier).toBe("low");
    expect(tierFor({ coverage: 0.5, tiers: ["T0"] }).tier).toBe("medium");
    expect(tierFor({ coverage: 0.8, tiers: ["T0"] }).tier).toBe("medium"); // single tier
    expect(tierFor({ coverage: 0.8, tiers: ["T0", "T2"] }).tier).toBe("high");
    expect(tierFor({ coverage: 1, tiers: ["T0", "T2"], derivedContract: true }).tier).toBe("medium");
    expect(tierFor({ coverage: 1, tiers: ["T0", "T2"], retrospective: true }).tier).toBe("medium");
    expect(tierFor({ coverage: 1, tiers: ["T0", "T2"], disagreement: true }).tier).toBe("low");
    expect(tierFor({ coverage: 1, tiers: ["T0", "T2"], byConstruction: true }).tier).toBe("insufficient");
    expect(tierFor({ coverage: 0, tiers: [], emptyPopulation: true }).tier).toBe("insufficient");
  });

  const m = (key: MetricResult["key"], value: number | null, confidence: MetricResult["confidence"], extra: Partial<MetricResult> = {}): MetricResult => ({
    key,
    name: key,
    value,
    unit: "",
    n: 10,
    coverage: 1,
    confidence,
    confidenceLabel: "",
    breakdown: { satisfied: 0, failed: 0, undecidable: [] },
    headline: "",
    formulaVersion: "t",
    evidenceRefs: [],
    evidenceRefCount: 0,
    tiers: ["T0"],
    lowerIsBetter: false,
    displayOnly: false,
    detail: {},
    notes: ["n"],
    ...extra,
  });

  it("renormalised weighted mean over included metrics, inversion where lower is better, guards, lowest tier, flags outside arithmetic", () => {
    const out = composite("outcome", { O1: m("O1", 1, "high"), O3: m("O3", 0.25, "medium", { lowerIsBetter: true }), O5: m("O5", null, "insufficient") }, ["E4 present"]);
    // O1 weight 0.4 → 100; O3 weight 0.2 → 75; renormalised over 0.6
    expect(out.score).toBe(Math.round(((0.4 * 100 + 0.2 * 75) / 0.6) * 10) / 10);
    expect(out.confidence).toBe("medium");
    expect(out.included.map((i) => i.key)).toEqual(["O1", "O3"]);
    expect(out.excluded.find((x) => x.key === "O5")!.reason).toMatch(/insufficient/);
    expect(out.excluded.find((x) => x.key === "O2")!.reason).toBe("not computed");
    expect(out.flags).toEqual(["E4 present"]);
    expect(scaleTo100(m("O3", 0.25, "low", { lowerIsBetter: true }))).toBe(75);
    const guarded = composite("operating", { P1: m("P1", 1, "high"), P2: m("P2", 1, "high") }, []);
    expect(guarded.score).toBeNull();
    expect(guarded.guard).toMatchObject({ minIncluded: 3, satisfied: false, coverageFloor: 0.5 });
    expect(guarded.guard.reason).toMatch(/fewer than 3 metrics/);
    const displayOnly = composite("operating", { P1: m("P1", 1, "high"), P2: m("P2", 1, "high"), P3: m("P3", 1, "low"), P7: m("P7", 5, "high", { displayOnly: true }) }, []);
    expect(displayOnly.score).toBe(100);
    expect(displayOnly.confidence).toBe("low");
    expect(displayOnly.excluded.find((x) => x.key === "P7")!.reason).toBe("shown, never scored");
  });
});
