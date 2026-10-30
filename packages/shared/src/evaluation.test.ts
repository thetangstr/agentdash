import { describe, expect, it } from "vitest";
import {
  AGENT_CARD_SCORECARD_KIND,
  AGENT_CARD_SECTIONS,
  AGENT_CARD_VERSION,
  AGENT_METRICS_VERSION,
  AGENT_OBLIGATION_BLOCK_STATES,
  AGENT_OBLIGATION_END_STATES,
  EVALUATION_AGENT_RECORD_PREDICATES,
  EVALUATION_COVERAGE_CLASSES,
  EVALUATION_DEFAULT_ACCESS_CLASS,
  EVALUATION_DISPOSITION_KINDS,
  EVALUATION_EVIDENCE_CLASSES,
  EVALUATION_PREDICATE_COVERAGE,
  EVALUATION_RECORD_PREDICATES,
  agentCardReplayInputsSchema,
  agentObligationOccurrenceId,
  evaluationAccessClassSchema,
  evaluationAgentCriterionAttestSchema,
  evaluationAgentDispositionSchema,
  evaluationCriterionRefKey,
  evaluationCriterionRefSchema,
  evaluationDisagreementNotedSchema,
  evaluationTypedPredicate,
  evaluationUseConfirmedSchema,
  formatEvaluationAccessClass,
  isAgentObligationBlockState,
  isEvaluationAccessClass,
  parseEvaluationAccessClass,
} from "./evaluation.js";

// AgentDash: Agent Performance Management gate 3, P3.1 freeze — the shared
// vocabulary (evaluation LLD §3–§12).

const PROJECT = "00000000-0000-4000-8000-0000000000a1";
const AGENT = "00000000-0000-4000-8000-00000000000a";
const RECEIPT = "00000000-0000-4000-8000-0000000000e1";
const ISSUE = "00000000-0000-4000-8000-0000000000b1";
const CONTRACT_EVENT = "00000000-0000-4000-8000-0000000000c1";
const EVENT_A = "00000000-0000-4000-8000-0000000000d1";
const EVENT_B = "00000000-0000-4000-8000-0000000000d2";
const GOAL = "00000000-0000-4000-8000-0000000000f1";
const HASH64 = "a".repeat(64);

const criterion = { contractEventId: CONTRACT_EVENT, responsibilityKey: "weekly-report", criterionId: "c1", checkHash: "0123456789abcdef" };

describe("evaluation access classes", () => {
  it("parses the four canonical classes", () => {
    expect(parseEvaluationAccessClass("company")).toEqual({ kind: "company" });
    expect(parseEvaluationAccessClass(`project:${PROJECT}`)).toEqual({ kind: "project", projectId: PROJECT });
    expect(parseEvaluationAccessClass(`private_pairing:${RECEIPT}`)).toEqual({ kind: "private_pairing", receiptId: RECEIPT });
    expect(parseEvaluationAccessClass(`private_agent:${AGENT}`)).toEqual({ kind: "private_agent", agentId: AGENT });
    expect(EVALUATION_DEFAULT_ACCESS_CLASS).toBe("company");
  });

  it("rejects anything that is not exactly one canonical class", () => {
    for (const bad of [
      "",
      "Company",
      " company",
      "company:",
      "project",
      "project:",
      `project:${PROJECT.toUpperCase()}`,
      `project: ${PROJECT}`,
      `project:${PROJECT}:extra`,
      `project:${PROJECT} `,
      "project:not-a-uuid",
      `private:${AGENT}`,
      `private_agent:${AGENT}x`,
      `:${PROJECT}`,
    ]) {
      expect(parseEvaluationAccessClass(bad), bad).toBeNull();
      expect(isEvaluationAccessClass(bad), bad).toBe(false);
      expect(evaluationAccessClassSchema.safeParse(bad).success, bad).toBe(false);
    }
    for (const notString of [null, undefined, 1, {}, ["company"]]) expect(parseEvaluationAccessClass(notString)).toBeNull();
  });

  it("formats round-trip, lowercasing ids, and refuses a non-uuid id", () => {
    for (const cls of ["company", `project:${PROJECT}`, `private_pairing:${RECEIPT}`, `private_agent:${AGENT}`]) {
      expect(formatEvaluationAccessClass(parseEvaluationAccessClass(cls)!)).toBe(cls);
      expect(evaluationAccessClassSchema.parse(cls)).toBe(cls);
    }
    expect(formatEvaluationAccessClass({ kind: "project", projectId: PROJECT.toUpperCase() })).toBe(`project:${PROJECT}`);
    expect(() => formatEvaluationAccessClass({ kind: "private_agent", agentId: "agent-1" })).toThrow(/needs a uuid/);
  });
});

describe("typed check predicates", () => {
  it("keeps the existing evidence classes and their semantics", () => {
    expect([...EVALUATION_EVIDENCE_CLASSES]).toEqual(["dod_present", "neutral_verdict", "delivery_ref", "ci_green", "independent_review"]);
    for (const cls of EVALUATION_EVIDENCE_CLASSES) expect(EVALUATION_COVERAGE_CLASSES).toContain(cls);
    expect(evaluationTypedPredicate({ kind: "record", record: "pr.merged" })).toEqual({ kind: "record", predicate: "pr.merged", coverage: "delivery_ref" });
    expect(evaluationTypedPredicate({ kind: "record", record: "verdict.passed" })).toMatchObject({ predicate: "verdict.passed", coverage: "neutral_verdict" });
    expect(evaluationTypedPredicate({ kind: "record", record: "ci.green" })).toMatchObject({ predicate: "ci.green", coverage: "ci_green" });
    expect(evaluationTypedPredicate({ kind: "record", record: "regression_gates.pass" })).toMatchObject({ predicate: "ci.green", coverage: "ci_green" });
    expect(evaluationTypedPredicate({ kind: "record", record: "dod.present" })).toMatchObject({ predicate: "dod.present", coverage: "dod_present" });
  });

  it("gives every new check its own predicate and coverage class", () => {
    expect(evaluationTypedPredicate({ kind: "record", record: "deliverable.shipped" })).toEqual({ kind: "record", predicate: "deliverable.shipped", coverage: "deliverable_shipped" });
    expect(evaluationTypedPredicate({ kind: "record", record: "deliverable.checks_passed" })).toMatchObject({ coverage: "independent_check" });
    expect(evaluationTypedPredicate({ kind: "record", record: "deliverable.approved" })).toMatchObject({ coverage: "human_acceptance" });
    expect(evaluationTypedPredicate({ kind: "record", record: "harness.criterion_passed" })).toMatchObject({ coverage: "automated_acceptance" });
    expect(evaluationTypedPredicate({ kind: "record", record: "use.confirmed" })).toMatchObject({ coverage: "use_recorded" });
    expect(evaluationTypedPredicate({ kind: "record", record: "obligation.on_time" })).toEqual({ kind: "record", predicate: "obligation.on_time", coverage: null });
    // A shipped deliverable is a different predicate from a merged PR, never an alias of it.
    expect(evaluationTypedPredicate({ kind: "record", record: "deliverable.shipped" })).not.toMatchObject({ predicate: "pr.merged" });
    expect(new Set(EVALUATION_RECORD_PREDICATES).size).toBe(EVALUATION_RECORD_PREDICATES.length);
    for (const predicate of EVALUATION_RECORD_PREDICATES) {
      const coverage = EVALUATION_PREDICATE_COVERAGE[predicate];
      expect(coverage === null || (EVALUATION_COVERAGE_CLASSES as readonly string[]).includes(coverage)).toBe(true);
    }
    // only the existing predicate reaches delivery_ref
    expect(EVALUATION_RECORD_PREDICATES.filter((p) => EVALUATION_PREDICATE_COVERAGE[p] === "delivery_ref")).toEqual(["pr.merged"]);
    expect(EVALUATION_AGENT_RECORD_PREDICATES).not.toContain("pr.merged");
  });

  it("resolves status, attest, metric, missing and unknown checks", () => {
    expect(evaluationTypedPredicate(undefined)).toEqual({ kind: "none" });
    expect(evaluationTypedPredicate({ kind: "record", record: "project.status=completed" })).toEqual({ kind: "status", subject: "project", value: "completed" });
    expect(evaluationTypedPredicate({ kind: "record", record: "goal.status=achieved" })).toEqual({ kind: "status", subject: "goal", value: "achieved" });
    expect(evaluationTypedPredicate({ kind: "record", record: "pr.opened" })).toEqual({ kind: "unknown", record: "pr.opened" });
    expect(evaluationTypedPredicate({ kind: "record", record: "constructor" })).toEqual({ kind: "unknown", record: "constructor" });
    expect(evaluationTypedPredicate({ kind: "human_attest", attesterUserId: "user-1" })).toEqual({ kind: "human_attest", attesterUserId: "user-1" });
    expect(evaluationTypedPredicate({ kind: "metric", metricKey: `goal:${GOAL}`, target: 10, unit: "deals" })).toEqual({ kind: "goal_metric", goalId: GOAL, target: 10, unit: "deals" });
    expect(evaluationTypedPredicate({ kind: "metric", metricKey: "goal:not-a-uuid", target: 1, unit: "x" })).toMatchObject({ kind: "metric", metricKey: "goal:not-a-uuid" });
    expect(evaluationTypedPredicate({ kind: "metric", metricKey: "nps", target: 50, unit: "points" })).toMatchObject({ kind: "metric", metricKey: "nps" });
  });
});

describe("criterion identity and agent dispositions", () => {
  it("validates the criterion tuple strictly and keys it unambiguously", () => {
    expect(evaluationCriterionRefSchema.safeParse(criterion).success).toBe(true);
    expect(evaluationCriterionRefSchema.safeParse({ ...criterion, checkHash: "0123456789ABCDEF" }).success).toBe(false);
    expect(evaluationCriterionRefSchema.safeParse({ ...criterion, checkHash: "0123" }).success).toBe(false);
    expect(evaluationCriterionRefSchema.safeParse({ ...criterion, extra: true }).success).toBe(false);
    expect(evaluationCriterionRefSchema.safeParse({ ...criterion, contractEventId: "nope" }).success).toBe(false);
    const a = evaluationCriterionRefKey({ ...criterion, responsibilityKey: "a", criterionId: "b|c" });
    const b = evaluationCriterionRefKey({ ...criterion, responsibilityKey: "a|b", criterionId: "c" });
    expect(a).not.toBe(b);
    expect(evaluationCriterionRefKey(criterion)).toBe(evaluationCriterionRefKey({ ...criterion }));
  });

  it("keeps the existing disposition kinds first and in order, then adds the two new ones", () => {
    expect([...EVALUATION_DISPOSITION_KINDS]).toEqual([
      "correction_decided",
      "criterion_attest",
      "contract_exception_accepted",
      "exception_reviewed",
      "exception_missed",
      "shadow_note",
      "use_confirmed",
      "disagreement_noted",
    ]);
  });

  it("binds criterion_attest to the tuple, the agent subject and the item", () => {
    const body = {
      kind: "criterion_attest",
      binding: { criterion, subjectRef: { kind: "agent", id: AGENT }, item: { kind: "issue", id: ISSUE } },
      result: "satisfied",
      evidenceRefs: [EVENT_A],
    };
    const parsed = evaluationAgentDispositionSchema.parse(body);
    expect(parsed.kind).toBe("criterion_attest");
    // no top-level criterionId/issueId: the milestone matcher can never count an agent attest
    expect(parsed).not.toHaveProperty("criterionId");
    expect(parsed).not.toHaveProperty("issueId");
    // the milestone (V1) shape is not an agent attest
    expect(evaluationAgentCriterionAttestSchema.safeParse({ kind: "criterion_attest", criterionId: "c1", issueId: ISSUE, result: "satisfied", evidenceRefs: [EVENT_A], milestoneRef: { kind: "project", id: PROJECT } }).success).toBe(false);
    // the subject must be an agent, the item a known kind, evidence cited
    expect(evaluationAgentCriterionAttestSchema.safeParse({ ...body, binding: { ...body.binding, subjectRef: { kind: "project", id: PROJECT } } }).success).toBe(false);
    expect(evaluationAgentCriterionAttestSchema.safeParse({ ...body, binding: { ...body.binding, item: { kind: "comment", id: ISSUE } } }).success).toBe(false);
    expect(evaluationAgentCriterionAttestSchema.safeParse({ ...body, evidenceRefs: [] }).success).toBe(false);
    expect(evaluationAgentCriterionAttestSchema.safeParse({ ...body, binding: { ...body.binding, criterion: { ...criterion, checkHash: undefined } } }).success).toBe(false);
  });

  it("parses use_confirmed and disagreement_noted", () => {
    const use = evaluationUseConfirmedSchema.parse({ kind: "use_confirmed", subjectRef: { kind: "agent", id: AGENT }, item: { kind: "deliverable_run", id: ISSUE } });
    expect(use.evidenceRefs).toEqual([]);
    expect(evaluationAgentDispositionSchema.safeParse({ ...use, responsibilityKey: "weekly-report", note: "used in the board pack" }).success).toBe(true);
    const disagreement = { kind: "disagreement_noted", subjectRef: { kind: "agent", id: AGENT }, item: { kind: "issue", id: ISSUE }, criterion, judgmentEventIds: [EVENT_A, EVENT_B], note: "harness passed it, the reviewer did not" };
    expect(evaluationDisagreementNotedSchema.safeParse(disagreement).success).toBe(true);
    expect(evaluationDisagreementNotedSchema.safeParse({ ...disagreement, judgmentEventIds: [EVENT_A] }).success).toBe(false);
    expect(evaluationDisagreementNotedSchema.safeParse({ ...disagreement, judgmentEventIds: [EVENT_A, EVENT_A] }).success).toBe(false);
    expect(evaluationDisagreementNotedSchema.safeParse({ ...disagreement, note: undefined }).success).toBe(false);
    expect(evaluationAgentDispositionSchema.safeParse({ kind: "correction_decided", correctionEventId: EVENT_A, decision: "accepted" }).success).toBe(false);
  });
});

describe("owed work vocabulary", () => {
  it("lists the end states and requires evidence only for blocks", () => {
    expect(AGENT_OBLIGATION_END_STATES).toHaveLength(11);
    for (const state of AGENT_OBLIGATION_BLOCK_STATES) {
      expect(AGENT_OBLIGATION_END_STATES).toContain(state);
      expect(isAgentObligationBlockState(state)).toBe(true);
    }
    for (const state of ["cause_unknown", "not_started", "missed", "delivered_on_time"]) expect(isAgentObligationBlockState(state)).toBe(false);
  });

  it("builds occurrence ids whose only free-form part is last", () => {
    expect(agentObligationOccurrenceId({ kind: "scheduled", triggerId: AGENT, scheduledFor: "2026-10-29T09:00:00.000Z" })).toBe(`scheduled:${AGENT}:2026-10-29T09:00:00.000Z`);
    expect(agentObligationOccurrenceId({ kind: "received", triggerId: AGENT, routineRunId: ISSUE })).toBe(`received:${AGENT}:${ISSUE}`);
    expect(agentObligationOccurrenceId({ kind: "deliverable", deliverableId: AGENT, runKey: "2026-W44:board" })).toBe(`deliverable:${AGENT}:2026-W44:board`);
    expect(agentObligationOccurrenceId({ kind: "assigned", issueId: ISSUE, mappingId: EVENT_A })).toBe(`assigned:${ISSUE}:${EVENT_A}`);
    expect(agentObligationOccurrenceId({ kind: "goal", goalId: GOAL, deadline: "2026-12-31" })).toBe(`goal:${GOAL}:2026-12-31`);
  });
});

describe("agent card replay inputs and versions", () => {
  const dependency = (kind: "project" | "goal", id: string, throughSeq = 42) => ({ kind, id, throughSeq, formulaVersion: "m2-score/8", hash: HASH64, fallbackOpen: true });
  const inputs = {
    throughSeq: 42,
    asOf: "2026-10-29T12:00:00.000Z",
    window: { from: "2026-09-29T12:00:00.000Z", to: "2026-10-29T12:00:00.000Z" },
    dependencies: [dependency("goal", GOAL), dependency("project", PROJECT)],
  };

  it("accepts consistent inputs", () => {
    expect(agentCardReplayInputsSchema.parse(inputs)).toEqual(inputs);
    expect(agentCardReplayInputsSchema.safeParse({ ...inputs, dependencies: [] }).success).toBe(true);
  });

  it("refuses a window past asOf, a reversed window, a dependency on another cut, and unsorted or duplicate dependencies", () => {
    expect(agentCardReplayInputsSchema.safeParse({ ...inputs, window: { ...inputs.window, to: "2026-10-29T12:00:01.000Z" } }).success).toBe(false);
    expect(agentCardReplayInputsSchema.safeParse({ ...inputs, window: { from: inputs.window.to, to: inputs.window.from } }).success).toBe(false);
    expect(agentCardReplayInputsSchema.safeParse({ ...inputs, dependencies: [dependency("goal", GOAL, 41)] }).success).toBe(false);
    expect(agentCardReplayInputsSchema.safeParse({ ...inputs, dependencies: [dependency("project", PROJECT), dependency("goal", GOAL)] }).success).toBe(false);
    expect(agentCardReplayInputsSchema.safeParse({ ...inputs, dependencies: [dependency("goal", GOAL), dependency("goal", GOAL)] }).success).toBe(false);
    expect(agentCardReplayInputsSchema.safeParse({ ...inputs, dependencies: [{ ...dependency("goal", GOAL), hash: "abc" }] }).success).toBe(false);
    expect(agentCardReplayInputsSchema.safeParse({ ...inputs, asOf: "yesterday" }).success).toBe(false);
    expect(agentCardReplayInputsSchema.safeParse({ ...inputs, extra: 1 }).success).toBe(false);
  });

  it("pins the version constants and the six sections in question order", () => {
    expect(AGENT_CARD_VERSION).toBe("agent-card/1");
    expect(AGENT_METRICS_VERSION).toBe("agent-metrics/1");
    expect(AGENT_CARD_SCORECARD_KIND).toBe("agent");
    expect([...AGENT_CARD_SECTIONS]).toEqual(["obligations", "quality", "acceptance", "cost", "bounds", "decisions"]);
  });
});
