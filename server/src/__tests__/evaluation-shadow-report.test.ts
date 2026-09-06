import { describe, expect, it } from "vitest";
import type { EvaluationShadowMilestoneReport, EvaluationShadowReport } from "@paperclipai/shared";
import { graduate, measureMilestone, type MilestoneMeasureInput } from "../services/evaluation/shadow-report.js";

// AgentDash: Company Evaluator — Milestone 5: the graduation criteria are
// measured, never asserted. Each case here is a way a criterion could have
// read "met" without the evidence, pinned so it cannot.

const REF = { kind: "project" as const, id: "22222222-2222-4222-8222-222222222222" };
const E1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const disp = (sourceId: string, payload: Record<string, unknown>) => ({ sourceId, payload: { ...payload, milestoneRef: REF } });
function input(over: Partial<MilestoneMeasureInput> = {}): MilestoneMeasureInput {
  return {
    ref: REF,
    name: "Launch",
    status: "in_progress",
    versions: 3,
    verified: ["agree", "agree", "formula_changed"],
    latestCard: null,
    findings: [
      { key: "E4:issue:a", severity: "immediate", evidenceRefs: [E1] },
      { key: "E2:issue:b", severity: "material", evidenceRefs: [] },
      { key: "E5:issue:c", severity: "routine", evidenceRefs: [E1] },
      { key: "E5:issue:d", severity: "routine", evidenceRefs: [E1] },
    ],
    dispositions: [],
    reviewItems: [],
    ...over,
  };
}
const evaluator = (over: Partial<EvaluationShadowReport["evaluator"]> = {}): EvaluationShadowReport["evaluator"] => ({ provisioned: true, agentId: "ev", runs: 5, costEvents: 5, costCents: 1234, findingsAuthored: 2, ...over });
const authority = (over: Partial<EvaluationShadowReport["authority"]> = {}): EvaluationShadowReport["authority"] => ({ refusedAttempts: 3, writesOutsideAllowlist: 0, writeActions: { "authz.refused": 3, "evaluation.finding_noted": 2 }, scoredAsActorOn: [], reviewProjectNamedAsMilestone: false, ...over });
const by = (items: ReturnType<typeof graduate>) => Object.fromEntries(items.map((g) => [g.key, g]));

describe("measureMilestone", () => {
  it("precision and recall count material and immediate exceptions only; routine reviews, routine misses and unknown keys are reported beside the ratios", () => {
    const m = measureMilestone(
      input({
        dispositions: [
          disp("review:E4:issue:a", { kind: "exception_reviewed", exceptionKey: "E4:issue:a", verdict: "confirmed" }),
          disp("review:E2:issue:b", { kind: "exception_reviewed", exceptionKey: "E2:issue:b", verdict: "false_positive", reason: "the reviewer joined after the verdict" }),
          disp("review:E5:issue:c", { kind: "exception_reviewed", exceptionKey: "E5:issue:c", verdict: "false_positive" }),
          disp("review:E5:issue:d", { kind: "exception_reviewed", exceptionKey: "E5:issue:d", verdict: "false_positive" }),
          disp("review:E9:issue:zz", { kind: "exception_reviewed", exceptionKey: "E9:issue:zz", verdict: "confirmed" }), // never raised
          disp("missed:1", { kind: "exception_missed", title: "release without notes", severity: "material", description: "x" }),
          disp("missed:2", { kind: "exception_missed", title: "typo", severity: "routine", description: "y" }),
        ],
      }),
    );
    expect(m.reviews).toMatchObject({ confirmed: 1, falsePositive: 1, missed: 1, precision: 0.5, recall: 0.5, routineReviews: 2, unknownKeys: ["E9:issue:zz"] });
    expect(m.reviews.reviewedMaterialKeys).toEqual(["E2:issue:b", "E4:issue:a"]);
    expect(m.reviews.disagreements).toEqual([{ key: "E2:issue:b", reason: "the reviewer joined after the verdict" }]);
  });

  it("the latest verdict per key wins, and material claims are traced over every finding of the run, not the latest card", () => {
    const m = measureMilestone(
      input({
        dispositions: [
          disp("review:E4:issue:a", { kind: "exception_reviewed", exceptionKey: "E4:issue:a", verdict: "false_positive" }),
          disp("review:E4:issue:a", { kind: "exception_reviewed", exceptionKey: "E4:issue:a", verdict: "confirmed" }),
        ],
        latestCard: { exceptions: [], exceptionsTotal: 0 } as never,
      }),
    );
    expect(m.reviews).toMatchObject({ confirmed: 1, falsePositive: 0 });
    expect(m.exceptions).toMatchObject({ raised: 4, materialRaised: 2, materialTraced: 1, latest: { total: 0 } }); // E2:issue:b cites nothing
  });

  it("replay counts formula-changed versions separately and reports how many were replayed", () => {
    const m = measureMilestone(input({ versions: 30, verified: ["agree", "disagree", "formula_changed", "formula_changed"] }));
    expect(m.replay).toEqual({ versions: 30, verified: 4, agree: 1, disagree: 1, formulaChanged: 2, agreementRate: 0.5 });
  });

  it("notes dedupe by source id; immediate items are matched to any finding of the run with the finding's severity", () => {
    const m = measureMilestone(
      input({
        dispositions: [
          disp("note:rescue:x", { kind: "shadow_note", topic: "rescue", text: "founder merged by hand" }),
          disp("note:rescue:x", { kind: "shadow_note", topic: "rescue", text: "founder merged by hand" }),
          disp("note:other:y", { kind: "shadow_note", topic: "constructor", text: "hostile" }),
        ],
        reviewItems: [
          { description: `digest\n<!-- evaluator-key: digest:project:${REF.id}:founder-1 -->`, assigneeUserId: "founder-1" },
          { description: `digest\n<!-- evaluator-key: digest:project:${REF.id}:steward-2 -->`, assigneeUserId: "steward-2" },
          { description: "old immediate\n<!-- evaluator-key: immediate:E2:issue:b -->", assigneeUserId: "founder-1" },
          { description: "other milestone\n<!-- evaluator-key: digest:project:99999999-9999-4999-8999-999999999999:founder-1 -->", assigneeUserId: "founder-1" },
        ],
      }),
    );
    expect(m.notes.rescue).toEqual(["founder merged by hand"]);
    expect(m.messages).toEqual({ digests: 2, digestsPerHuman: { "founder-1": 1, "steward-2": 1 }, immediateItems: 1, immediateSeverities: { material: 1 } });
  });
});

describe("graduate", () => {
  const closed = (over: Partial<EvaluationShadowMilestoneReport> = {}) => ({ ...measureMilestone(input({ status: "completed" })), ...over });

  it("cost is not measurable when the evaluator never ran, when its runs are unmetered, or when no cap is supplied; met only against a cap with metered runs", () => {
    const ms = [closed()];
    expect(by(graduate({ milestones: ms, evaluator: evaluator({ runs: 0, costEvents: 0, costCents: 0 }), authority: authority(), costCapCents: 100 })).cost_reported).toMatchObject({ status: "not_measurable", measured: expect.stringContaining("has not run") });
    expect(by(graduate({ milestones: ms, evaluator: evaluator({ runs: 5, costEvents: 0, costCents: 0 }), authority: authority(), costCapCents: 100 })).cost_reported).toMatchObject({ status: "not_measurable", measured: expect.stringContaining("unmetered, not free") });
    expect(by(graduate({ milestones: ms, evaluator: evaluator(), authority: authority() })).cost_reported.status).toBe("not_measurable");
    expect(by(graduate({ milestones: ms, evaluator: evaluator(), authority: authority(), costCapCents: 2000 })).cost_reported).toMatchObject({ status: "met", measured: expect.stringContaining("$12.34 against a cap of $20.00") });
    expect(by(graduate({ milestones: ms, evaluator: evaluator(), authority: authority(), costCapCents: 1000 })).cost_reported.status).toBe("not_met");
  });

  it("authority is met only when nothing the evaluator wrote reached a route outside its allowlist and it is scored on no card; refusals alone prove nothing", () => {
    const ms = [closed()];
    expect(by(graduate({ milestones: ms, evaluator: evaluator(), authority: authority() })).no_authority_mutation.status).toBe("met");
    expect(by(graduate({ milestones: ms, evaluator: evaluator(), authority: authority({ writesOutsideAllowlist: 1, writeActions: { "issue.updated": 1 } }) })).no_authority_mutation.status).toBe("not_met");
    expect(by(graduate({ milestones: ms, evaluator: evaluator(), authority: authority({ scoredAsActorOn: ["Launch"] }) })).no_authority_mutation).toMatchObject({ status: "not_met", measured: expect.stringContaining("scored as an actor on Launch") });
    expect(by(graduate({ milestones: ms, evaluator: evaluator({ provisioned: false, agentId: null }), authority: authority({ refusedAttempts: 0 }) })).no_authority_mutation.status).toBe("not_measurable");
  });

  it("replay agreement excludes formula-changed versions and says how many were replayed; precision needs real verdicts; the chatter ceiling is not measurable on an empty run", () => {
    const empty = measureMilestone(input({ findings: [], versions: 0, verified: [] }));
    const g = by(graduate({ milestones: [empty], evaluator: evaluator(), authority: authority() }));
    expect(g.replay_agreement.status).toBe("not_measurable");
    expect(g.precision_recall.status).toBe("not_measurable");
    expect(g.chatter_ceiling.status).toBe("not_measurable");
    expect(g.material_claims_traced.status).toBe("not_measurable");
    const real = measureMilestone(
      input({
        versions: 40,
        verified: Array.from({ length: 20 }, (_, i) => (i === 0 ? "disagree" : "agree")),
        dispositions: [
          disp("review:E4:issue:a", { kind: "exception_reviewed", exceptionKey: "E4:issue:a", verdict: "confirmed" }),
          disp("review:E2:issue:b", { kind: "exception_reviewed", exceptionKey: "E2:issue:b", verdict: "confirmed" }),
        ],
        reviewItems: [{ description: `<!-- evaluator-key: digest:project:${REF.id}:founder-1 -->`, assigneeUserId: "founder-1" }],
      }),
    );
    const g2 = by(graduate({ milestones: [real], evaluator: evaluator(), authority: authority() }));
    expect(g2.replay_agreement).toMatchObject({ status: "met", measured: expect.stringContaining("20 of 40 stored versions replayed: 19 agree, 1 disagree") });
    expect(g2.precision_recall).toMatchObject({ status: "met", measured: expect.stringContaining("precision 100%") });
    expect(g2.chatter_ceiling).toMatchObject({ status: "met", measured: expect.stringContaining("digests per milestone: 1") });
    expect(g2.material_claims_traced).toMatchObject({ status: "not_met", measured: "1 of 2 material or immediate exceptions raised over the run cite at least one ledger event" });
  });

  it("two milestones must be distinct and closed before rescues can be judged", () => {
    const one = closed();
    expect(by(graduate({ milestones: [one, one], evaluator: evaluator(), authority: authority() })).no_rescues.status).toBe("not_measurable"); // the same ref twice is one milestone
    const two = closed({ ref: { kind: "project", id: "33333333-3333-4333-8333-333333333333" } });
    expect(by(graduate({ milestones: [one, two], evaluator: evaluator(), authority: authority() })).no_rescues.status).toBe("met");
    const rescued = { ...two, notes: { ...two.notes, rescue: ["founder merged by hand"] } };
    expect(by(graduate({ milestones: [one, rescued], evaluator: evaluator(), authority: authority() })).no_rescues).toMatchObject({ status: "not_met", measured: expect.stringContaining("rescues recorded: 0, 1") });
    expect(by(graduate({ milestones: [one, { ...two, status: "in_progress" }], evaluator: evaluator(), authority: authority() })).no_rescues.status).toBe("not_measurable");
  });

  it("no measured sentence carries a rule number or an enum key", () => {
    const items = graduate({ milestones: [closed()], evaluator: evaluator(), authority: authority(), costCapCents: 5000 });
    for (const g of items) {
      expect(g.measured + " " + g.note, g.key).not.toMatch(/rule \d|§|exception_reviewed|exception_missed|shadow_note|_/);
    }
  });
});
