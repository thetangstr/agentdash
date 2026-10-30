import { describe, expect, it } from "vitest";
import {
  EVALUATION_AGENT_RECORD_PREDICATES,
  evaluationAgentCriterionAttestSchema,
  evaluationTypedPredicate,
} from "@paperclipai/shared";
import { parseRecordCheck } from "../services/evaluation/scoring/contract.js";
import { at, CO, ev, FOUNDER, G, I1, iso, item, P, ref, roster, score } from "./helpers/evaluation-fixtures.js";

// AgentDash: Agent Performance Management gate 3, P3.1 freeze — the new shared
// vocabulary must not change milestone scoring: the typed predicates agree with
// the milestone resolver on every name it knows, the new names stay unknown to
// it, and an agent-bound attestation never counts toward a milestone criterion.

const ATTESTER = "person-attester-1";
const AGENT = "00000000-0000-4000-8000-0000000000aa";
const CONTRACT_EVENT = "00000000-0000-4000-8000-0000000000c1";

function declaredAttest() {
  return ev({
    type: "contract.declared",
    time: at(0),
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
        acceptanceCriteria: [{ id: "k1", text: "a named person attests it", check: { kind: "human_attest", attesterUserId: ATTESTER }, source: "human" }],
        definitionOfDone: null,
        requiredEvidence: ["dod_present"],
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

function disposition(payload: Record<string, unknown>) {
  return ev({ type: "evaluation.disposition", time: at(6), actor: ["user", ATTESTER], sourceTable: "evaluation_dispositions", payload });
}

describe("APM gate 3 freeze: milestone scoring unchanged", () => {
  it("typed predicates agree with parseRecordCheck, and the new record names stay unknown to it", () => {
    const pairs: Array<[string, string]> = [
      ["verdict.passed", "verdict.passed"],
      ["pr.merged", "pr.merged"],
      ["ci.green", "ci.green"],
      ["regression_gates.pass", "ci.green"],
      ["dod.present", "dod.present"],
    ];
    for (const [record, kind] of pairs) {
      expect(parseRecordCheck(record).kind).toBe(kind);
      expect(evaluationTypedPredicate({ kind: "record", record })).toMatchObject({ kind: "record", predicate: kind });
    }
    expect(parseRecordCheck("project.status=completed")).toEqual({ kind: "project.status", value: "completed" });
    expect(evaluationTypedPredicate({ kind: "record", record: "project.status=completed" })).toEqual({ kind: "status", subject: "project", value: "completed" });
    for (const record of EVALUATION_AGENT_RECORD_PREDICATES) expect(parseRecordCheck(record).kind).toBe("unknown");
  });

  it("an agent-bound criterion_attest never satisfies a milestone criterion with the same id", () => {
    const base = [...roster(), declaredAttest(), ...item({ id: I1, started: 1, done: 4 })];
    const bound = evaluationAgentCriterionAttestSchema.parse({
      kind: "criterion_attest",
      binding: {
        criterion: { contractEventId: CONTRACT_EVENT, responsibilityKey: "weekly", criterionId: "k1", checkHash: "0123456789abcdef" },
        subjectRef: { kind: "agent", id: AGENT },
        item: { kind: "issue", id: I1 },
      },
      result: "satisfied",
      evidenceRefs: [CONTRACT_EVENT],
    });
    const o1 = (window: typeof base) => score(window).outcome.O1!.breakdown;

    // control: the milestone (V1) attest by the named attester is counted, as today
    const v1 = o1([...base, disposition({ kind: "criterion_attest", criterionId: "k1", issueId: I1, result: "satisfied", evidenceRefs: [CONTRACT_EVENT], milestoneRef: ref })]);
    expect(v1.satisfied).toBe(1);

    // the agent-bound attest is invisible to the milestone matcher
    const agentBound = o1([...base, disposition({ ...bound })]);
    expect(agentBound.satisfied).toBe(0);
    expect(agentBound).toEqual(o1(base));
  });
});
