import { describe, expect, it } from "vitest";
import {
  evaluationContractV1Schema,
  evaluationContractV2Schema,
  evaluationContractVersionOf,
  type AgentOperatingProfileV1,
} from "@paperclipai/shared";
import { agentContractSourceId, buildAgentContractV2 } from "../services/evaluation/agent-contract.js";
import type { EvaluationEventRow } from "../services/evaluation/ledger.js";
import { cardHash, scoreMilestone } from "../services/evaluation/scoring/card.js";
import { A, at, CO, ev, evidenced, FOUNDER, G, I1, I2, iso, P, ref, roster } from "./helpers/evaluation-fixtures.js";

// AgentDash: Agent Performance Management gate 2 (P2.4) — milestone isolation.
// An agent contract (`contract.declared` with a v2 payload, source `agent:<id>`)
// shares the ledger with milestone contracts. It must never count as a version
// of a milestone contract, valid or invalid, so every milestone card scored
// from a window that contains one is byte-for-byte the card scored without it.

const REVISION = "00000000-0000-4000-8000-0000000000d1";
const TRIGGER = "00000000-0000-4000-8000-0000000000f1";

function profile(): AgentOperatingProfileV1 {
  return {
    profileVersion: 1,
    identity: {
      name: "Builder",
      title: "Engineer",
      summary: "Ships the launch work.",
      audience: "The founder",
      style: { tone: "Plain", uncertaintyRule: "Say what is unknown" },
    },
    responsibilities: [
      {
        key: "weekly-report",
        title: "Weekly report",
        outcome: "The founder sees progress every Monday",
        stakeholders: [{ userId: FOUNDER, need: "A Monday summary" }],
        obligation: { kind: "routine", routineTriggerId: TRIGGER },
        deliverable: { what: "A one-page report", destination: "The launch issue" },
        escalation: { toUserId: FOUNDER, when: "Data is missing" },
        performance: {
          // Same criterion id as the milestone contract's: a different subject, so a different criterion.
          criteria: [{ id: "k1", text: "an independent verdict passed", check: { kind: "record", record: "verdict.passed" }, source: "human" }],
          coverage: ["deliverable_shipped"],
          deadline: { kind: "after_trigger", hours: 4 },
          outcomeLinks: [{ goalId: G }],
          expectedHumanSteps: ["sign_off"],
          judges: { automated: ["harness"] },
          thresholds: null,
        },
      },
    ],
    knowledge: [],
    skills: [],
    access: {},
    rhythm: { timezone: "UTC", reportTo: { userId: FOUNDER } },
  } as AgentOperatingProfileV1;
}

function milestoneContract(h: number): EvaluationEventRow {
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
        acceptanceCriteria: [{ id: "k1", text: "an independent verdict passed", check: { kind: "record", record: "verdict.passed" }, source: "human" }],
        definitionOfDone: null,
        requiredEvidence: ["dod_present", "neutral_verdict", "delivery_ref", "ci_green", "independent_review"],
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

/** The ledger row `declareAgentContract` writes, as the fixture helper would carry it. */
function agentContractEvent(h: number): EvaluationEventRow {
  const contract = buildAgentContractV2({ companyId: CO, agentId: A, profileRevisionId: REVISION, body: profile(), accountableUserId: FOUNDER });
  return ev({
    type: "contract.declared",
    time: at(h),
    actor: ["user", FOUNDER],
    projectId: null,
    goalId: null,
    sourceTable: "evaluation_contracts",
    sourceId: agentContractSourceId(A),
    payload: { contract, companyId: CO },
  });
}

const scoreAt = (window: EvaluationEventRow[], throughSeq: number) => scoreMilestone(window, ref, throughSeq, CO, { fallbackOpen: true });

describe("agent contracts leave milestone cards unchanged", () => {
  it("the agent contract is a v2 payload that the milestone (v1) schema would have rejected", () => {
    const event = agentContractEvent(9);
    expect(evaluationContractVersionOf(event.payload)).toBe("v2");
    const inner = (event.payload as { contract: unknown }).contract;
    expect(evaluationContractV2Schema.safeParse(inner).success).toBe(true);
    // Without the resolver's skip this is exactly an "invalid milestone contract version".
    expect(evaluationContractV1Schema.safeParse(inner).success).toBe(false);
  });

  it("with a declared milestone contract: the card is identical, the milestone contract stays the declared version", () => {
    const declared = milestoneContract(-1);
    const base = [
      ...roster(),
      declared,
      ...evidenced(I1),
      ...evidenced(I2, 10),
      ev({ type: "issue.comment_added", time: at(13), actor: ["user", FOUNDER], issueId: I2, payload: { commentId: "human-1", reopened: false } }),
    ];
    const agentContract = agentContractEvent(9); // later than the milestone declaration, inside the window
    const throughSeq = Number(agentContract.seq);
    const without = scoreAt(base, throughSeq);
    const withAgent = scoreAt([...base, agentContract], throughSeq);

    expect(cardHash(withAgent)).toBe(cardHash(without));
    expect(JSON.stringify(withAgent)).toBe(JSON.stringify(without));
    expect(withAgent.contract.source).toBe("declared");
    expect(withAgent.contract.eventId).toBe(declared.id);
    expect(withAgent.contract.invalidVersions).toBe(0);
    expect(withAgent.contract.criteriaCount).toBe(1);
  });

  it("without a milestone contract: the card is identical and the contract stays derived", () => {
    const base = [
      ...roster(),
      ...evidenced(I1),
      ev({ type: "issue.comment_added", time: at(13), actor: ["user", FOUNDER], issueId: I1, payload: { commentId: "human-2", reopened: false } }),
    ];
    const agentContract = agentContractEvent(2);
    const throughSeq = Number(agentContract.seq);
    const without = scoreAt(base, throughSeq);
    const withAgent = scoreAt([...base, agentContract], throughSeq);

    expect(cardHash(withAgent)).toBe(cardHash(without));
    expect(withAgent.contract.source).toBe("derived");
    expect(withAgent.contract.invalidVersions).toBe(0);
  });

  it("a malformed contract payload still counts as an invalid version (V1 behaviour unchanged)", () => {
    const garbage = ev({ type: "contract.declared", time: at(-2), actor: ["user", FOUNDER], sourceTable: "evaluation_contracts", sourceId: `project:${P}`, payload: { contract: { nope: true } } });
    const agentContract = agentContractEvent(3);
    const window = [...roster(), garbage, milestoneContract(-1), ...evidenced(I1), agentContract];
    const card = scoreAt(window, Math.max(...window.map((e) => Number(e.seq))));
    expect(card.contract.invalidVersions).toBe(1);
    expect(card.contract.source).toBe("declared");
  });
});
