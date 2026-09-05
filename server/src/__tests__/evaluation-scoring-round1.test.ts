import { describe, expect, it } from "vitest";
import { EVALUATION_REVIEW_LABEL } from "@paperclipai/shared";
import type { EvaluationEventRow } from "../services/evaluation/ledger.js";
import { scoreMilestone } from "../services/evaluation/scoring/card.js";
import { gatesPass } from "../services/evaluation/scoring/evidence.js";
import { findingEvents } from "../services/evaluation/scorecards.js";
import type { ScoredCard } from "../services/evaluation/scoring/types.js";
import { A, at, CO, ev, evidenced, FOUNDER, G, gates, handoff, I1, I2, iso, item, P, R, ref, roster, score, T, verdict } from "./helpers/evaluation-fixtures.js";

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
    expect(waivedAll.outcome.O5!.breakdown.undecidable[0]!.reason).toMatch(/waived by the contract/);
    const partial = score([...roster(), declared(-1, [], ["dod_present", "neutral_verdict", "independent_review"]), ...evidenced(I1)]);
    expect(perClass(partial).ci_green.undecidable).toBe(1);
    expect(partial.outcome.O5!.value).toBeNull(); // every item has an undecidable class
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

  it("MEDIUM 8 (reader): the agent roster version carries the row time so A→B→A stays three facts", async () => {
    const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../services/evaluation/sources.ts", import.meta.url), "utf8"));
    const agentReader = src.slice(src.indexOf("export async function readAgentSnapshots"), src.indexOf("export async function readProjectSnapshots"));
    expect(agentReader).toContain("sourceVersion: `${hash}:${r.cursorTime}`");
    expect(agentReader).toContain("latestSnapshotHashes(tx, companyId, \"agents\"");
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
