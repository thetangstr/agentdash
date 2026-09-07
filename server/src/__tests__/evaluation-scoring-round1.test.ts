import { describe, expect, it } from "vitest";
import { EVALUATION_COMPOSITE_COVERAGE_FLOOR, EVALUATION_COMPOSITE_MAX_CONCENTRATION, EVALUATION_REVIEW_LABEL } from "@paperclipai/shared";
import type { EvaluationEventRow } from "../services/evaluation/ledger.js";
import { scoreMilestone } from "../services/evaluation/scoring/card.js";
import { gatesPass } from "../services/evaluation/scoring/evidence.js";
import { findingEvents } from "../services/evaluation/scorecards.js";
import { COMPOSITE_COVERAGE_FLOOR, COMPOSITE_FORMULA_VERSION, composite } from "../services/evaluation/scoring/composite.js";
import { METRICS_FORMULA_VERSION } from "../services/evaluation/scoring/metrics.js";
import type { MetricResult } from "../services/evaluation/scoring/types.js";
import type { ScoredCard } from "../services/evaluation/scoring/types.js";
import { A, at, CO, commentTwin, ev, evidenced, FOUNDER, G, gates, handoff, I1, I2, iso, item, P, R, ref, roster, score, shuffle, T, verdict } from "./helpers/evaluation-fixtures.js";
import { cardHash, scoreMilestone as scoreCard } from "../services/evaluation/scoring/card.js";

// AgentDash: Company Evaluator — the first independent review of Milestone 2
// (PR #614) found spec deviations; each case here pins the corrected rule.

function declared(h: number, criteria: Array<Record<string, unknown>>, requiredEvidence: string[] = ["dod_present", "neutral_verdict", "delivery_ref", "ci_green", "independent_review"], extra: Record<string, unknown> = {}) {
  return ev({
    type: "contract.declared",
    time: at(h),
    actor: ["user", FOUNDER],
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
        ...extra,
      },
    },
  });
}
const verdictCriterion = { id: "k1", text: "an independent verdict passed", check: { kind: "record", record: "verdict.passed" }, source: "human" };
const perClass = (card: ScoredCard) => card.outcome.O5!.detail.perClass as Record<string, { satisfied: number; failed: number; undecidable: number }>;

describe("round 1 — independence and evidence", () => {
  it("HIGH 1: the project's lead is not independent for the project's own items (§4.2 fuller rule)", () => {
    const window = [
      ...roster().map((e) => (e.eventType === "project.snapshot" ? { ...e, payload: { ...e.payload, leadAgentId: R } } : e)),
      ...item({ id: I1, started: 1, done: 4 }),
      verdict(I1, 3, R), // R leads the project
    ];
    const card = score(window);
    expect(card.exceptions.some((e) => e.id === "E4" && e.note.includes("the project lead reviewed their own project's work"))).toBe(true);
    expect(perClass(card).neutral_verdict.failed).toBe(1);
  });

  it("MEDIUM 5: a synthetic decider leaves independent_review undecidable too (rule 15)", () => {
    const card = score([
      ...roster(),
      ...item({ id: I1, started: 1, done: 4 }),
      ev({ type: "approval.decided", time: at(3), actor: ["user", "local-board"], issueId: I1, sourceTable: "activity_log", payload: { approvalId: "ap1", type: "verdict_escalation", decision: "approved" } }),
    ]);
    expect(perClass(card).independent_review.undecidable).toBe(1);
    expect(perClass(card).independent_review.failed).toBe(0);
  });

  it("MEDIUM 4: a narrowed DoD fails dod_present (§4.1) and still raises E12; a DoD set after leaving backlog fails", () => {
    const narrowed = score([
      ...roster(),
      ...item({ id: I1, started: 1, done: 6, dod: true, dodSetAt: 0 }),
      ev({ type: "issue.dod_set", time: at(3), actor: ["agent", A], issueId: I1, payload: { hasPrevious: true, criteriaCount: 1, previousCriteriaCount: 2, criteriaIds: ["c1"], previousCriteriaIds: ["c1", "c2"] } }),
    ]);
    expect(perClass(narrowed).dod_present.failed).toBe(1);
    expect(narrowed.exceptions.some((e) => e.id === "E12")).toBe(true);
    const late = score([...roster(), ...item({ id: I2, started: 1, review: 2, done: 4 }), ev({ type: "issue.dod_set", time: at(2.5), actor: ["agent", A], issueId: I2, payload: { hasPrevious: false, criteriaCount: 2 } })]);
    expect(perClass(late).dod_present.failed).toBe(1);
  });

  it("MEDIUM 6: reviews inside a concentrated pair weigh as limited evidence for independent_review (rule 19)", () => {
    const B = "00000000-0000-4000-8000-0000000000dd";
    const window = [...roster(), ev({ type: "agent.snapshot", time: at(0), projectId: null, sourceId: B, payload: { agentId: B, name: "Other", status: "idle", reportsTo: null, accountableUserId: FOUNDER } })];
    for (let i = 0; i < 3; i++) {
      const a = `00000000-0000-4000-8000-0000000000${(10 + i).toString().padStart(2, "0")}`;
      const b = `00000000-0000-4000-8000-0000000000${(20 + i).toString().padStart(2, "0")}`;
      window.push(...item({ id: a, started: 1, done: 4, assignee: A }), verdict(a, 3, B));
      window.push(...item({ id: b, started: 1, done: 4, assignee: B }), verdict(b, 3, A));
    }
    const card = score(window);
    expect(card.exceptions.some((e) => e.id === "E14")).toBe(true);
    expect(card.outcome.O5!.detail.limitedReviewItems).toBe(6); // every review came from the pair (the items lack other classes, so none is fully evidenced)
    expect(card.outcome.O5!.notes.some((n) => n.includes("concentrated reviewer pair"))).toBe(true);
  });

  it("LOW 16 / 18: an unattributed verdict is not a self-review; gates without pre_existing_failures named do not satisfy ci_green", () => {
    const card = score([...roster(), ...item({ id: I1, started: 1, done: 4 }), verdict(I1, 3, null, "passed", null)]);
    expect(card.exceptions.filter((e) => e.id === "E4")).toEqual([]);
    expect(gatesPass({ typecheck: "pass", test: "pass", build: "pass" })).toBe(false);
    expect(gatesPass(gates)).toBe(true);
    expect(gatesPass({ typecheck: "pass", test: "fail", build: "pass", pre_existing_failures: [] })).toBe(false);
  });
});

describe("round 1 — contracts", () => {
  it("HIGH 2: a declared contract that waives classes lowers O5 coverage; it never scores 100 (rule 16)", () => {
    const waivedAll = score([...roster(), declared(-1, [], []), ...evidenced(I1)]);
    expect(waivedAll.outcome.O5!.value).toBeNull();
    expect(waivedAll.outcome.O5!.confidence).toBe("insufficient");
    expect(waivedAll.outcome.O5!.breakdown.undecidable[0]!.reason).toMatch(/requires no evidence class/);
    const partial = score([...roster(), declared(-1, [], ["dod_present", "neutral_verdict", "independent_review"]), ...evidenced(I1)]);
    expect((perClass(partial).ci_green as { waived: number }).waived).toBe(1);
    expect(partial.outcome.O5!.value).toBe(1); // judged on the classes the contract requires…
    expect(partial.outcome.O5!.confidence).toBe("low"); // …under the rule-16 cap until the founder accepts the waiver
    expect(partial.outcome.O5!.notes.some((n) => n.includes("waives"))).toBe(true);
    // a complete evidence set but a check-less criterion is a rule-16 exception: capped at limited until accepted
    const weakCriteria = score([...roster(), declared(-1, [{ id: "k2", text: "feels done", source: "human" }]), ...evidenced(I1)]);
    expect(weakCriteria.outcome.O5!.confidence).toBe("low");
    const contractEvent = declared(-1, [{ id: "k2", text: "feels done", source: "human" }]);
    const accepted = score([
      ...roster(),
      contractEvent,
      ev({ type: "evaluation.disposition", time: at(0), actor: ["user", FOUNDER], sourceTable: "evaluation", sourceId: "acc-1", payload: { kind: "contract_exception_accepted", contractEventId: contractEvent.id } }),
      ...evidenced(I1),
    ]);
    expect(accepted.outcome.O5!.confidence).not.toBe("low"); // the cap is lifted once the founder's acceptance is recorded
    expect(accepted.contract.exceptions.some((x) => x.includes("founder acceptance recorded"))).toBe(true);
  });

  it("HIGH 3: rule 17 is per criterion — amending a contract keeps every E1 the original criteria raised", () => {
    const first = declared(-1, [verdictCriterion]);
    const amended = declared(20, [verdictCriterion, { id: "k9", text: "also this", check: { kind: "record", record: "ci.green" }, source: "human" }]);
    // evidenced(I1) gives the company a verdict source (rule 10), so I2's missing verdict is a failure, not undecidable
    const card = score([...roster(), first, ...evidenced(I1), ...item({ id: I2, started: 1, done: 4 }), amended]);
    // I2 still fails k1 (declared before it closed) → its E1 survives the amendment; I1 satisfies k1 but the new k9 is post hoc for it → undecidable, never failed
    expect(card.exceptions.filter((e) => e.id === "E1").length).toBe(1);
    expect(card.outcome.O1!.breakdown).toMatchObject({ satisfied: 0, failed: 1 });
    expect(card.outcome.O1!.breakdown.undecidable[0]!.reason).toMatch(/declared after this item closed/);
    // the new criterion alone is post hoc for the already-closed item
    const onlyNew = score([...roster(), ...item({ id: I2, started: 1, done: 4 }), declared(20, [{ id: "k9", text: "also this", check: { kind: "record", record: "ci.green" }, source: "human" }])]);
    expect(onlyNew.outcome.O1!.breakdown.undecidable[0]!.reason).toMatch(/declared after this item closed/);
  });

  it("MEDIUM 11: O2 uses the project's target date when the contract has none", () => {
    const window = [
      ...roster().map((e) => (e.eventType === "project.snapshot" ? { ...e, payload: { ...e.payload, targetDate: "2026-08-10" } } : e)),
      declared(-1, [verdictCriterion]),
      ...item({ id: I1, started: 1, done: 4 }),
      ev({ type: "agent.snapshot", time: at(300), projectId: null, sourceId: R, payload: { agentId: R, name: "Reviewer", status: "idle", reportsTo: null, accountableUserId: FOUNDER } }),
    ];
    const card = score(window);
    expect(card.outcome.O2!.n).toBe(1);
    expect(card.outcome.O2!.detail.targetDate).toBe("2026-08-10");
    expect(card.outcome.O2!.breakdown.failed).toBe(1); // open past its target
  });
});

describe("round 1 — card and metrics", () => {
  it("MEDIUM 7: the evaluator's own findings never inflate the blind window or the digest", () => {
    const base = [...roster(), ...item({ id: I1, started: 1, done: 4 })];
    const before = score(base);
    const withFinding = [
      ...base,
      ev({ type: "evaluation.finding", time: at(-24 * 90), ingest: at(5), actor: ["evaluator", null], sourceTable: "evaluation", sourceId: "E1:issue:x", payload: { id: "E1" } }),
    ];
    const after = score(withFinding);
    expect(after.maxIngestLagMs).toBe(before.maxIngestLagMs);
    expect(after.eventCount).toBe(before.eventCount);
  });

  it("MEDIUM 9 / 10: O4 is shown, never scored; a zero count is a value, not missing evidence", () => {
    const card = score([...roster(), ...item({ id: I1, started: 1, done: 4 })]);
    expect(card.outcome.O4!.displayOnly).toBe(true);
    expect(card.outcome.O4!.value).toBeNull(); // goal active: nothing imputed
    expect(card.outcomeComposite.excluded.find((x) => x.key === "O4")!.reason).toBe("shown, never scored");
    const p6 = card.actors.find((a) => a.actorId === A)!.metrics.P6!;
    expect(p6.value).toBe(0);
    expect(p6.confidence).not.toBe("insufficient");
    const company = card.actors.find((a) => a.actorType === "company")!;
    expect(company.metrics.P5!.value).toBe(0);
    expect(company.metrics.P2!.value).toBe(0);
  });

  it("MEDIUM 12: a contradicted delivery claim is material; other timestamp contradictions stay routine", () => {
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, done: 6 }),
      handoff(I1, 5, T, "tpm_merge_report", { issue: { id: I1 }, merge_result: "shipped", pr: { number: 1 } }, { claimedTimestamp: iso(-3), timestampClamped: false, timestampSuspicious: true }),
      handoff(I1, 2, A, "builder_to_ci", { issue: { id: I1 }, size: "S", pr: { number: 1 }, branch: "b", regression_gates: gates, labels_applied: [] }, { claimedTimestamp: iso(-3), timestampClamped: false, timestampSuspicious: true }),
    ];
    const e2 = score(window).exceptions.filter((e) => e.id === "E2");
    expect(e2.map((e) => e.severity).sort()).toEqual(["material", "routine"]);
  });

  it("MEDIUM 14: evaluator review items never become successors or blocker citations (rule 12)", () => {
    const parent = "00000000-0000-4000-8000-000000000999";
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, cancelled: 3, parentId: parent }),
      ...item({ id: I2, created: 4, started: 5, done: 8, parentId: parent, labels: [EVALUATION_REVIEW_LABEL], titleTokens: ["ship", "thing", "01"] }),
    ];
    const card = score(window);
    const p9 = card.actors.find((a) => a.actorId === A)!.metrics.P9!;
    expect(p9.detail.successorLinks).toEqual([]);
  });

  it("MEDIUM 15: a finding's version is its identity, not its phrasing", () => {
    const card = score([...roster(), ...item({ id: I1, started: 1 }), ev({ type: "agent.snapshot", time: at(80), projectId: null, sourceId: R, payload: { agentId: R, name: "Reviewer", status: "idle", reportsTo: null, accountableUserId: FOUNDER } })]);
    const e5 = card.exceptions.find((e) => e.id === "E5")!;
    const [a] = findingEvents(CO, ref, { ...card, exceptions: [e5] }, 1);
    const [b] = findingEvents(CO, ref, { ...card, exceptions: [{ ...e5, note: "different words" }] }, 2);
    expect(a!.sourceVersion).toBe(b!.sourceVersion);
    expect(a!.payload!.note).not.toBe(b!.payload!.note);
  });

  it("LOW 17: an E4 raised outside an agent's metrics still flags that agent's composite", () => {
    const card = score([...roster(), ...item({ id: I1, started: 1, done: 4 }), verdict(I1, 3, A)]);
    expect(card.actors.find((a) => a.actorId === A)!.composite!.flags).toContain("E4 present");
  });

});

describe("round 1 — Theo's additions", () => {
  it("contributors follow §3: an agent that commented on an item cannot then review it independently", () => {
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, done: 6 }),
      ev({ type: "issue.comment_added", time: at(2), actor: ["agent", R], issueId: I1, payload: { commentId: "c1", reopened: false } }),
      verdict(I1, 3, R),
    ];
    const card = score(window);
    expect(card.exceptions.some((e) => e.id === "E4" && e.note.includes("the contributor reviewed their own work"))).toBe(true);
    expect(perClass(card).neutral_verdict.failed).toBe(1);
  });

  it("P2 links an escalation to its decision through the approval id, so one decision does not credit two escalations", () => {
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, review: 2, done: 9 }),
      verdict(I1, 3, R, "escalated_to_human"),
      ev({ type: "approval.created", time: at(3.1), actor: ["agent", R], issueId: I1, sourceTable: "activity_log", payload: { approvalId: "ap1", type: "verdict_escalation" } }),
      verdict(I1, 4, R, "escalated_to_human"),
      ev({ type: "approval.created", time: at(4.1), actor: ["agent", R], issueId: I1, sourceTable: "activity_log", payload: { approvalId: "ap2", type: "verdict_escalation" } }),
      ev({ type: "approval.decided", time: at(5), actor: ["user", "eyan"], issueId: I1, sourceTable: "activity_log", payload: { approvalId: "ap1", type: "verdict_escalation", decision: "approved" } }),
    ];
    const p2 = score(window).actors.find((a) => a.actorId === R)!.metrics.P2!;
    expect(p2.n).toBe(2);
    expect(p2.breakdown).toMatchObject({ satisfied: 1, failed: 0 });
    expect(p2.breakdown.undecidable[0]).toMatchObject({ count: 1 });
  });

  it("E9 covers a blocker citation that still stands and a revert not re-shipped, not only reopens", () => {
    const window = [
      ...roster(),
      ...evidenced(I1),
      ...item({ id: I2, created: 9, started: 10 }),
      ev({ type: "issue.blockers_updated", time: at(10), actor: ["agent", A], issueId: I2, payload: { blockedByIssueIds: [I1], previous: [] } }),
      handoff(I1, 12, T, "tpm_merge_report", { issue: { id: I1 }, merge_result: "reverted", pr: { number: 42, base_branch: "main" } }),
      ev({ type: "agent.snapshot", time: at(24 * 9), projectId: null, sourceId: R, payload: { agentId: R, name: "Reviewer", status: "idle", reportsTo: null, accountableUserId: FOUNDER } }),
    ];
    const card = score(window);
    const e9 = card.exceptions.filter((e) => e.id === "E9");
    expect(e9.map((e) => e.note)).toEqual(expect.arrayContaining([expect.stringContaining("still cited seven days later"), expect.stringContaining("not re-shipped")]));
    expect(card.outcome.O3!.detail).toMatchObject({ blockersCiting: 1 });
    expect((card.outcome.O3!.detail.revertTerm as { reverts: number }).reverts).toBe(1);
  });

  it("E14 routes to both actors' managers; E2 for a hash change without activity; E11 emission drop", () => {
    const B = "00000000-0000-4000-8000-0000000000dd";
    const M = "00000000-0000-4000-8000-0000000000ee";
    const window = [
      ...roster(),
      ev({ type: "agent.snapshot", time: at(0), projectId: null, sourceId: B, payload: { agentId: B, name: "Other", status: "idle", reportsTo: M, accountableUserId: FOUNDER } }),
    ];
    for (let i = 0; i < 3; i++) {
      const a = `00000000-0000-4000-8000-0000000000${(10 + i).toString().padStart(2, "0")}`;
      const b = `00000000-0000-4000-8000-0000000000${(20 + i).toString().padStart(2, "0")}`;
      window.push(...item({ id: a, started: 1, done: 4, assignee: A }), verdict(a, 3, B));
      window.push(...item({ id: b, started: 1, done: 4, assignee: B }), verdict(b, 3, A));
    }
    const e14 = score(window).exceptions.find((e) => e.id === "E14")!;
    expect(e14.routing.managerAgentIds).toEqual([R, M].sort()); // A → R, B → M
    // rule 13: a second snapshot with a new hash and no activity within five minutes
    const hashWindow = [
      ...roster(),
      ...item({ id: I1, started: 1, done: 4 }),
      ev({ type: "issue.snapshot", time: at(30), issueId: I1, sourceTable: "issues", payload: { status: "done", projectId: P, assigneeAgentId: A, labels: [], titleTokens: ["ship"], contentHash: "changed", createdAt: iso(0) } }),
    ];
    expect(score(hashWindow).exceptions.some((e) => e.id === "E2" && e.note.includes("no control-plane activity"))).toBe(true);
    // rule 10 / E11: five weeks of an agent's activity, the last week under half the baseline
    const drop: EvaluationEventRow[] = [...roster(), ...item({ id: I2, started: 1 })];
    const asOfHour = 24 * 7 * 6;
    for (let week = 1; week <= 4; week++) for (let k = 0; k < 8; k++) drop.push(ev({ type: "issue.comment_added", time: at(asOfHour - week * 24 * 7 - k), actor: ["agent", A], issueId: I2, payload: { commentId: `w${week}k${k}`, reopened: false } }));
    drop.push(ev({ type: "issue.comment_added", time: at(asOfHour - 2), actor: ["agent", A], issueId: I2, payload: { commentId: "recent", reopened: false } }));
    drop.push(ev({ type: "issue.comment_added", time: at(asOfHour - 24 * 7 * 5 - 1), actor: ["agent", A], issueId: I2, payload: { commentId: "first", reopened: false } }));
    drop.push(ev({ type: "agent.snapshot", time: at(asOfHour), projectId: null, sourceId: R, payload: { agentId: R, name: "Reviewer", status: "idle", reportsTo: null, accountableUserId: FOUNDER } }));
    const e11 = score(drop).exceptions.filter((e) => e.id === "E11");
    expect(e11.length).toBe(1);
    expect(e11[0]!.subject.id).toBe(A);
  });

  it("goal-as-milestone membership, and answering a question is not an intervention", () => {
    const goalRef = { kind: "goal" as const, id: G };
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, done: 4, project: null }), // goal only
      ...item({ id: I2, started: 1, done: 4 }), // has a project: not a goal-milestone member
      ev({ type: "interaction.changed", time: at(2), actor: ["user", "local-board"], issueId: I1, projectId: null, sourceTable: "issue_thread_interactions", payload: { interactionId: "q1", kind: "ask_user_questions", status: "answered", createdAt: iso(1.5), pendingMs: 1800000 } }),
    ];
    const card = scoreMilestone(window, goalRef, 999, CO, { fallbackOpen: true });
    expect(card.membership.items).toBe(1);
    const p1 = card.actors.find((a) => a.actorId === A)!.metrics.P1!;
    expect(p1.detail.interventions).toBe(0);
    expect(p1.value).toBe(1);
  });

  it("P2 shows rubric dimensions from independent verdicts on the agent's items", () => {
    const window = [...roster(), ...item({ id: I1, started: 1, done: 4 }), verdict(I1, 3, R)];
    const p2 = score(window).actors.find((a) => a.actorId === A)!.metrics.P2!;
    expect(p2.detail.rubricDimensions).toEqual({ correctness: { mean: 4, n: 1 } });
  });
});

describe("round 2 — verification findings", () => {
  it("HIGH 1: a handoff comment's activity twin does not make the reviewer a contributor; an ordinary pre-verdict comment still does", () => {
    const clean = score([...roster(), ...evidenced(I1)]); // evidenced() carries the twins
    expect(clean.outcome.O5!.value).toBe(1);
    expect(clean.exceptions.filter((e) => e.id === "E4")).toEqual([]);
    const chatty = score([
      ...roster(),
      ...item({ id: I2, started: 1, done: 6 }),
      ev({ type: "issue.comment_added", time: at(2), actor: ["agent", R], issueId: I2, payload: { commentId: "plain-comment", reopened: false } }),
      verdict(I2, 3, R),
    ]);
    expect(chatty.exceptions.some((e) => e.id === "E4")).toBe(true);
  });

  it("HIGH 2: rule 17 keys a criterion on its id and its check — rewriting the check under the same id is a new declaration, rewording the text is not", () => {
    const first = declared(-1, [verdictCriterion]);
    const reworded = declared(20, [{ ...verdictCriterion, text: "an independent verdict has passed" }]);
    const kept = score([...roster(), first, ...evidenced(I1), ...item({ id: I2, started: 1, done: 4 }), reworded]);
    expect(kept.exceptions.filter((e) => e.id === "E1").length).toBe(1); // a typo fix erases nothing
    const rewritten = declared(20, [{ id: "k1", text: "a DoD is present", check: { kind: "record", record: "dod.present" }, source: "human" }]);
    const card = score([...roster(), first, ...evidenced(I1), ...item({ id: I2, started: 1, done: 4 }), rewritten]);
    // the rewritten k1 is post hoc for both closed items; the original k1's verdict check no longer applies (the document was replaced)
    expect(card.outcome.O1!.breakdown.failed).toBe(0);
    expect(card.outcome.O1!.breakdown.undecidable[0]!.reason).toMatch(/declared after this item closed/);
    expect(card.exceptions.filter((e) => e.id === "E1")).toEqual([]);
    // and the honest amendment (same id, same check) keeps the original time
    const honest = declared(20, [verdictCriterion, { id: "k9", text: "also this", check: { kind: "record", record: "ci.green" }, source: "human" }]);
    const amended = score([...roster(), first, ...evidenced(I1), ...item({ id: I2, started: 1, done: 4 }), honest]);
    expect(amended.exceptions.filter((e) => e.id === "E1").length).toBe(1);
  });

  it("MEDIUM 3: under a partial waiver items are judged on the required classes — 8 of 10 with a DoD is 0.8, capped at limited evidence", () => {
    const window = [...roster(), declared(-1, [], ["dod_present"])];
    for (let i = 0; i < 10; i++) {
      const id = `00000000-0000-4000-8000-0000000003${i.toString().padStart(2, "0")}`;
      window.push(...item({ id, started: 1, done: 4, dod: i < 8, dodSetAt: i < 8 ? 0 : undefined }));
    }
    const card = score(window);
    expect(card.outcome.O5!.breakdown).toMatchObject({ satisfied: 8, failed: 2 });
    expect(card.outcome.O5!.value).toBe(0.8);
    expect(card.outcome.O5!.confidence).toBe("low");
    // a contract that requires no class at all decides nothing
    const none = score([...roster(), declared(-1, [], []), ...evidenced(I1)]);
    expect(none.outcome.O5!.value).toBeNull();
    // O1 over decidables: 1 satisfied of 2 decidable with a third undecidable (closed before the criteria were declared) is 0.5 at coverage 2/3
    const o1 = score([...roster(), declared(-1, [verdictCriterion]), ...evidenced(I1), ...item({ id: I2, started: 1, done: 4 }), ...item({ id: "00000000-0000-4000-8000-000000000103", created: -5, started: -4, done: -2 })]);
    expect(o1.outcome.O1!.value).toBe(0.5);
    expect(o1.outcome.O1!.coverage).toBe(0.667);
  });

  it("MEDIUM 4: a verdict recorded before its author took the item over cannot certify the close", () => {
    const window = [
      ...roster(),
      ...item({ id: I1, started: 3, done: 8, assignee: T }),
      verdict(I1, 1, R), // pre-emptive
      ev({ type: "issue.assignment_changed", time: at(2), actor: ["user", "local-board"], issueId: I1, payload: { fromAgentId: T, toAgentId: R, fromUserId: null, toUserId: null, previousUnknown: false } }),
      ev({ type: "run.finished", time: at(4), actor: ["agent", R], issueId: I1, sourceTable: "heartbeat_runs", sourceId: "r-pre", payload: { runId: "r-pre", agentId: R, status: "succeeded", durationMs: 1000, usagePresent: false } }),
    ];
    const card = score(window);
    expect(card.exceptions.some((e) => e.id === "E4" && e.note.includes("went on to contribute"))).toBe(true);
    expect(perClass(card).neutral_verdict.failed).toBe(1);
  });

  it("MEDIUM 5: E11, E14 and the metering E7 are dated by their last fact, so a later snapshot does not re-mint them", () => {
    const B = "00000000-0000-4000-8000-0000000000dd";
    const base = [...roster(), ev({ type: "agent.snapshot", time: at(0), projectId: null, sourceId: B, payload: { agentId: B, name: "Other", status: "idle", reportsTo: null, accountableUserId: FOUNDER } })];
    for (let i = 0; i < 3; i++) {
      const a = `00000000-0000-4000-8000-0000000000${(10 + i).toString().padStart(2, "0")}`;
      const b = `00000000-0000-4000-8000-0000000000${(20 + i).toString().padStart(2, "0")}`;
      base.push(...item({ id: a, started: 1, done: 4, assignee: A }), verdict(a, 3, B));
      base.push(...item({ id: b, started: 1, done: 4, assignee: B }), verdict(b, 3, A));
    }
    const later = [...base, ev({ type: "agent.snapshot", time: at(24 * 30), projectId: null, sourceId: R, payload: { agentId: R, name: "Reviewer", status: "idle", reportsTo: null, accountableUserId: FOUNDER } })];
    const e14a = score(base).exceptions.find((e) => e.id === "E14")!;
    const e14b = score(later).exceptions.find((e) => e.id === "E14")!;
    expect(e14a.raisedAt).toBe(e14b.raisedAt);
    const [fa] = findingEvents(CO, ref, { ...score(base), exceptions: [e14a] }, 1);
    const [fb] = findingEvents(CO, ref, { ...score(later), exceptions: [e14b] }, 2);
    expect(fa!.sourceVersion).toBe(fb!.sourceVersion);
  });

  it("MEDIUM 6 / 7: acceptance by a synthetic identity does not lift the rule-16 cap; an invalid contract version caps nothing", () => {
    const weak = declared(-1, [{ id: "k2", text: "feels done", source: "human" }]);
    const synthetic = score([
      ...roster(),
      weak,
      ev({ type: "evaluation.disposition", time: at(0), actor: ["user", "local-board"], sourceTable: "evaluation", sourceId: "acc-s", payload: { kind: "contract_exception_accepted", contractEventId: weak.id } }),
      ...evidenced(I1),
    ]);
    expect(synthetic.outcome.O5!.confidence).toBe("low");
    const garbage = ev({ type: "contract.declared", time: at(-2), actor: ["user", FOUNDER], sourceTable: "evaluation_contracts", sourceId: `project:${P}`, payload: { contract: { nope: true } } });
    const card = score([...roster(), garbage, declared(-1, [verdictCriterion]), ...evidenced(I1)]);
    expect(card.contract.invalidVersions).toBe(1);
    expect(card.outcome.O5!.confidence).not.toBe("low");
    expect(card.markers).not.toContain("contract exception — founder acceptance required");
  });

  it("untested fixes: the removed `no start` disjunct, and the lag marker stays off a retrospective", () => {
    // an item that never entered in_progress, with a DoD set after it left backlog: failed, not satisfied
    const late = score([...roster(), ...item({ id: I2, review: 2, done: 4 }), ev({ type: "issue.transition", time: at(1), actor: ["agent", A], issueId: I2, payload: { from: "backlog", to: "todo", reopened: false } }), ev({ type: "issue.dod_set", time: at(3), actor: ["agent", A], issueId: I2, payload: { hasPrevious: false, criteriaCount: 2 } })]);
    expect(perClass(late).dod_present.failed).toBe(1);
    // every event in the window was ingested 40 days after the facts: a backfilled retrospective
    const retro = score([...roster(), ...item({ id: I1, started: 1, done: 4 })].map((e) => ({ ...e, ingestTime: at(24 * 40) })));
    expect(retro.markers).toContain("scored retrospectively — confidence capped at adequate");
    expect(retro.markers).not.toContain("records lag events by more than a day in this window (see maxIngestLagMs)");
  });

  it("determinism over the richest window: shuffled input yields the same bytes", () => {
    const B = "00000000-0000-4000-8000-0000000000dd";
    const M = "00000000-0000-4000-8000-0000000000ee";
    const window = [...roster(), ev({ type: "agent.snapshot", time: at(0), projectId: null, sourceId: B, payload: { agentId: B, name: "Other", status: "idle", reportsTo: M, accountableUserId: FOUNDER } }), ...evidenced(I1)];
    for (let i = 0; i < 3; i++) {
      const a = `00000000-0000-4000-8000-0000000000${(10 + i).toString().padStart(2, "0")}`;
      const b = `00000000-0000-4000-8000-0000000000${(20 + i).toString().padStart(2, "0")}`;
      window.push(...item({ id: a, started: 1, done: 4, assignee: A }), verdict(a, 3, B));
      window.push(...item({ id: b, started: 1, done: 4, assignee: B }), verdict(b, 3, A));
    }
    const cut = Math.max(...window.map((e) => Number(e.seq)));
    const one = scoreCard(window, ref, cut, CO, { fallbackOpen: true });
    expect(cardHash(scoreCard(shuffle(window), ref, cut, CO, { fallbackOpen: true }))).toBe(cardHash(one));
    expect(one.exceptions.some((e) => e.id === "E14")).toBe(true);
  });
});

describe("round 3 — verification findings", () => {
  it("HIGH 1: the reviewer's own reviewer_to_tpm handoff (and its twin) is a review-class act, not a later contribution", () => {
    const card = score([...roster(), ...evidenced(I1)]); // evidenced() now carries the full MAW chain
    expect(card.outcome.O5!.value).toBe(1);
    expect(card.exceptions.filter((e) => e.id === "E4")).toEqual([]);
    // the only E3 is the fixture's reviewer closing the item (the known transition-of-unassigned rule), never a self-review
    expect(card.exceptions.filter((e) => e.id === "E3" && !e.note.startsWith("transition of an unassigned item"))).toEqual([]);
  });

  it("MEDIUM 5: the close-time set is work-changing acts only — a comment after the verdict is not a later contribution, a run is", () => {
    const thanks = score([...roster(), ...evidenced(I1), ev({ type: "issue.comment_added", time: at(7.5), actor: ["agent", R], issueId: I1, payload: { commentId: "thanks", reopened: false } })]);
    expect(thanks.exceptions.filter((e) => e.id === "E4")).toEqual([]);
    const implemented = score([...roster(), ...evidenced(I1), ev({ type: "run.finished", time: at(7.5), actor: ["agent", R], issueId: I1, sourceTable: "heartbeat_runs", sourceId: "r-late", payload: { runId: "r-late", agentId: R, status: "succeeded", durationMs: 1000, usagePresent: false } })]);
    expect(implemented.exceptions.some((e) => e.id === "E4" && e.note.includes("went on to contribute"))).toBe(true);
  });

  it("MEDIUM 6: a twin without a comment id is still skipped when a review-class handoff by the same actor is within the tolerance", () => {
    const window = [...roster(), ...item({ id: I1, started: 1, done: 8 }), handoff(I1, 5, R, "tester_to_reviewer", { issue: { id: I1 }, verdict: "pass", regression_gates: gates, labels_applied: [] }), ev({ type: "issue.comment_added", time: at(5.01), actor: ["agent", R], issueId: I1, payload: { commentId: null, reopened: false } }), verdict(I1, 6, R)];
    expect(score(window).exceptions.filter((e) => e.id === "E4")).toEqual([]);
  });

  it("MEDIUM 4: composites weight each metric by its coverage", () => {
    const m = (key: MetricResult["key"], value: number, coverage: number): MetricResult => ({ key, name: key, value, unit: "", n: 10, coverage, confidence: "low", confidenceLabel: "", breakdown: { satisfied: 0, failed: 0, undecidable: [] }, headline: "", formulaVersion: "t", evidenceRefs: [], evidenceRefCount: 0, tiers: ["T0"], lowerIsBetter: false, displayOnly: false, detail: {}, notes: [] });
    // O1 = 100 at weight 0.4×0.2 = 0.08; O5 = 0 at weight 0.15×1 = 0.15 → the included weight rests on only 42% decidable records: withheld
    const thin = composite("outcome", { O1: m("O1", 1, 0.2), O5: m("O5", 0, 1) }, []);
    expect(thin.score).toBeNull();
    expect(thin.coverage).toBe(0.418);
    expect(thin.guard).toMatchObject({ satisfied: false, coverageFloor: 0.5 });
    expect(thin.guard.reason).toMatch(/42% of the decidable records/);
    expect(thin.included.map((i) => i.coverage)).toEqual([0.2, 1]);
    // above the floor the weighting applies: O1 = 100 at 0.4×0.8 = 0.32, O5 = 0 at 0.15×1 = 0.15 → 32/0.47 ≈ 68.1, not the unweighted 72.7
    const solid = composite("outcome", { O1: m("O1", 1, 0.8), O5: m("O5", 0, 1) }, []);
    expect(solid.score).toBe(68.1);
    expect(solid.coverage).toBe(0.855);
  });

  it("LOW 9 / 10: E11 and the metering E7 are dated by their last fact; acceptance by a real but non-accountable human does not lift the cap", () => {
    const drop: EvaluationEventRow[] = [...roster(), ...item({ id: I2, started: 1 })];
    const asOfHour = 24 * 7 * 6;
    for (let week = 1; week <= 4; week++) for (let k = 0; k < 8; k++) drop.push(ev({ type: "issue.comment_added", time: at(asOfHour - week * 24 * 7 - k), actor: ["agent", A], issueId: I2, payload: { commentId: `w${week}k${k}`, reopened: false } }));
    drop.push(ev({ type: "issue.comment_added", time: at(asOfHour - 24 * 7 * 5 - 1), actor: ["agent", A], issueId: I2, payload: { commentId: "first", reopened: false } }));
    const later = [...drop, ev({ type: "agent.snapshot", time: at(asOfHour + 24 * 3), projectId: null, sourceId: R, payload: { agentId: R, name: "Reviewer", status: "idle", reportsTo: null, accountableUserId: FOUNDER } })];
    const e11a = score([...drop, ev({ type: "agent.snapshot", time: at(asOfHour), projectId: null, sourceId: R, payload: { agentId: R, name: "Reviewer", status: "idle", reportsTo: null, accountableUserId: FOUNDER } })]).exceptions.find((e) => e.id === "E11");
    const e11b = score(later).exceptions.find((e) => e.id === "E11");
    expect(e11a && e11b && e11a.raisedAt === e11b.raisedAt).toBe(true);
    const runs: EvaluationEventRow[] = [];
    for (let i = 0; i < 5; i++) runs.push(ev({ type: "run.finished", time: at(1 + i), actor: ["agent", A], issueId: I1, sourceTable: "heartbeat_runs", sourceId: `u${i}`, payload: { runId: `u${i}`, agentId: A, status: "succeeded", durationMs: 60_000, usagePresent: false } }));
    const e7a = score([...roster(), ...item({ id: I1, started: 1, done: 8 }), ...runs]).exceptions.find((e) => e.id === "E7")!;
    const e7b = score([...roster(), ...item({ id: I1, started: 1, done: 8 }), ...runs, ev({ type: "agent.snapshot", time: at(24 * 20), projectId: null, sourceId: R, payload: { agentId: R, name: "Reviewer", status: "idle", reportsTo: null, accountableUserId: FOUNDER } })]).exceptions.find((e) => e.id === "E7")!;
    expect(e7a.raisedAt).toBe(e7b.raisedAt);
    const weak = declared(-1, [{ id: "k2", text: "feels done", source: "human" }]);
    const other = score([...roster(), weak, ev({ type: "evaluation.disposition", time: at(0), actor: ["user", "someone-else"], sourceTable: "evaluation", sourceId: "acc-o", payload: { kind: "contract_exception_accepted", contractEventId: weak.id } }), ...evidenced(I1)]);
    expect(other.outcome.O5!.confidence).toBe("low");
  });
});

/** A source-poor deployment: done items with verdicts, some with acceptance criteria, no handoffs and no delivery references. */
function sourcePoor(count: number, withDod: number): EvaluationEventRow[] {
  const window: EvaluationEventRow[] = [...roster()];
  for (let i = 0; i < count; i++) {
    const id = `00000000-0000-4000-8000-0000000004${i.toString().padStart(2, "0")}`;
    window.push(...item({ id, started: 1, done: 6, dod: i < withDod, dodSetAt: i < withDod ? 0 : undefined }), verdict(id, 4, R));
  }
  return window;
}

describe("round 4 — verification findings", () => {
  /** The D4 reality: no GitHub adapter, no structured gates, no merge reports — ci_green and delivery_ref undecidable for every item. */
  it("HIGH 1: on a source-poor deployment O5 is judged on the decidable required classes; waiving the undecidable ones changes neither value nor coverage", () => {
    const byDefault = score(sourcePoor(10, 8));
    expect(byDefault.outcome.O5!.value).toBe(0.8);
    expect(byDefault.outcome.O5!.coverage).toBe(0.6); // 3 of 5 default classes decidable per item
    expect(byDefault.outcome.O5!.breakdown).toMatchObject({ satisfied: 8, failed: 2 });
    const waived = score([...sourcePoor(10, 8), declared(-1, [], ["dod_present", "neutral_verdict", "independent_review"])]);
    expect(waived.outcome.O5!.value).toBe(0.8);
    expect(waived.outcome.O5!.coverage).toBe(0.6); // waived classes lower coverage exactly like undecidable ones
    expect(waived.outcome.O5!.confidence).toBe("low"); // and the waiver is a rule-16 exception until accepted
    const defaultWeight = byDefault.outcomeComposite.included.find((i) => i.key === "O5")?.coverage ?? null;
    const waivedWeight = waived.outcomeComposite.included.find((i) => i.key === "O5")?.coverage ?? null;
    expect(waivedWeight).toBe(defaultWeight);
  });

  it("MEDIUM 4: a reviewer's own comment that carries an id and matches no review handoff still disqualifies, however close in time", () => {
    const window = [
      ...roster(),
      ...item({ id: I1, started: 1, done: 8 }),
      ev({ type: "issue.comment_added", time: at(5), actor: ["agent", R], issueId: I1, payload: { commentId: "directive", reopened: false } }),
      handoff(I1, 5.03, R, "tester_to_reviewer", { issue: { id: I1 }, verdict: "pass", regression_gates: gates, labels_applied: [] }),
      commentTwin(I1, 5.03, R),
      verdict(I1, 6, R),
    ];
    expect(score(window).exceptions.some((e) => e.id === "E4")).toBe(true);
  });

  it("LOW 5 / 7: a DoD edit after the verdict is a later contribution; P6 is capped at limited evidence while refusals are unrecorded", () => {
    const window = [...roster(), ...evidenced(I1), ev({ type: "issue.dod_set", time: at(7.2), actor: ["agent", R], issueId: I1, payload: { hasPrevious: true, criteriaCount: 2, previousCriteriaCount: 2, criteriaIds: ["c1", "c2"], previousCriteriaIds: ["c1", "c2"] } })];
    const card = score(window);
    expect(card.exceptions.some((e) => e.id === "E4" && e.note.includes("went on to contribute"))).toBe(true);
    const p6 = card.actors.find((a) => a.actorId === A)!.metrics.P6!;
    expect(p6.confidence).toBe("low");
    expect(p6.notes.some((n) => n.includes("blind"))).toBe(true);
  });

  it("MEDIUM 2: the formula version moved with the arithmetic", () => {
    expect(score([...roster(), ...evidenced(I1)]).formulaVersion).toBe("m2-score/8");
  });
});

describe("round 5 — verification findings", () => {
  /** The first shadow company as the ledger sees it: done items with no acceptance criteria, no verdicts, no delivery references, PM handoffs only. */
  function shadowBaseline(count: number): EvaluationEventRow[] {
    const window: EvaluationEventRow[] = [...roster()];
    for (let i = 0; i < count; i++) {
      const id = `00000000-0000-4000-8000-0000000005${i.toString().padStart(2, "0")}`;
      window.push(...item({ id, started: 1, done: 6 }), handoff(id, 0.5, A, "pm_to_builder", { issue: { id }, size: "S", acceptance: [] }));
    }
    return window;
  }

  it("MEDIUM 1: O3's coverage is what its terms can observe, and a composite one metric would carry alone is withheld and names it", () => {
    const card = score(shadowBaseline(12));
    const o3 = card.outcome.O3!;
    expect(o3.value).toBe(0); // no consequences recorded — true, and not a score
    expect(o3.coverage).toBe(0.667); // two T0 terms observable, the revert term for 0 of 12 delivered items
    expect(o3.notes.some((n) => n.includes("observable for 0% of delivered items"))).toBe(true);
    expect(card.outcomeComposite.score).toBeNull();
    expect(card.outcomeComposite.guard.satisfied).toBe(false);
    expect(card.outcomeComposite.guard.reason).toMatch(/^Downstream risk index alone would supply \d+% of the score; no single metric may supply more than 75%$/);
    expect(card.outcomeComposite.guard.reasons.some((r) => r.startsWith("the included metrics rest on"))).toBe(true); // the floor fails here too, and both are reported
    expect(card.outcomeComposite.guard.maxConcentration).toBe(EVALUATION_COMPOSITE_MAX_CONCENTRATION);
    // with delivery evidence on every item, O3 observes all three terms again
    const delivered = score([...roster(), ...evidenced(I1), ...evidenced(I2)]);
    expect(delivered.outcome.O3!.coverage).toBe(1);
  });

  it("MEDIUM 1 (unit): the concentration guard is independent of the coverage floor", () => {
    const m = (key: string, coverage: number, value: number): MetricResult => ({ key: key as MetricResult["key"], name: key, unit: "u", value, n: 10, coverage, confidence: "high", headline: "", notes: [], breakdown: {}, detail: {}, lowerIsBetter: false, t: "T0" } as unknown as MetricResult);
    const balanced = composite("outcome", { O1: m("O1", 1, 0.5), O3: m("O3", 1, 0), O5: m("O5", 1, 0.5) }, []);
    expect(balanced.guard.satisfied).toBe(true);
    expect(balanced.guard.reasons).toEqual([]); // always an array, so a renderer can iterate it blind
    expect(balanced.guard.reason).toBeUndefined();
    expect(balanced.guard.concentration).toBeLessThanOrEqual(EVALUATION_COMPOSITE_MAX_CONCENTRATION);
    // §5.3's two-metric minimum must stay reachable for every pair that includes O1: O1 + O5 at full coverage is 72.7%
    const o1o5 = composite("outcome", { O1: m("O1", 1, 0.5), O5: m("O5", 1, 0.5) }, []);
    expect(o1o5.guard.satisfied).toBe(true);
    expect(o1o5.score).not.toBeNull();
    // one included metric reports the missing evidence only — never the tautological 100% concentration
    const lone = composite("outcome", { O5: m("O5", 1, 0.5) }, []);
    expect(lone.guard.reasons).toEqual(["fewer than 2 metrics have evidence"]);
    // O3 at full coverage against O5 at 0.9: composite coverage 0.96 clears the floor, yet O3 carries 60% — allowed; at O5 0.4 it carries 77% — withheld
    const shared = composite("outcome", { O3: m("O3", 1, 0), O5: m("O5", 0.9, 0.5) }, []);
    expect(shared.coverage).toBeGreaterThanOrEqual(EVALUATION_COMPOSITE_COVERAGE_FLOOR);
    expect(shared.guard.satisfied).toBe(true);
    const lopsided = composite("outcome", { O3: m("O3", 1, 0), O5: m("O5", 0.4, 0.5) }, []);
    expect(lopsided.coverage).toBeGreaterThanOrEqual(EVALUATION_COMPOSITE_COVERAGE_FLOOR); // the floor alone would let it through
    expect(lopsided.guard.satisfied).toBe(false);
    expect(lopsided.guard.reasons).toEqual([expect.stringMatching(/^Downstream risk index alone would supply 77%/)]);
    expect(lopsided.score).toBeNull();
  });

  it("MEDIUM 2: a company whose only handoffs are PM briefs has no review source — independent_review is undecidable there, not failed", () => {
    const none = score(shadowBaseline(4));
    const cls = (c: ScoredCard) => perClass(c).independent_review;
    expect(cls(none)).toMatchObject({ satisfied: 0, failed: 0, undecidable: 4 });
    // one tester handoff anywhere in the company makes the class decidable for every item
    const withReviewHandoff = score([...shadowBaseline(4), handoff(I1, 3, R, "tester_to_reviewer", { issue: { id: I1 }, verdict: "pass", regression_gates: gates, labels_applied: [] })]);
    expect(cls(withReviewHandoff).undecidable).toBe(0);
    expect(cls(withReviewHandoff).failed).toBe(4);
  });

  it("LOW 3 / 4: the composite floor lives in shared next to the other guard constants, and both formula versions moved with the arithmetic", () => {
    expect(COMPOSITE_COVERAGE_FLOOR).toBe(EVALUATION_COMPOSITE_COVERAGE_FLOOR);
    expect(COMPOSITE_FORMULA_VERSION).toBe("composite/6");
    expect(METRICS_FORMULA_VERSION).toBe("metrics/5");
  });

  it("suggestion: an accepted waiver lifts O5's confidence cap but restores no weight", () => {
    const card = score([...sourcePoor(10, 8), declared(-1, [], ["dod_present", "neutral_verdict", "independent_review"])]);
    expect(card.outcome.O5!.notes.some((n) => n.includes("lifts the confidence cap but does not restore weight"))).toBe(true);
  });
});
