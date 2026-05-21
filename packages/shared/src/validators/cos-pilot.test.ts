import { describe, expect, it } from "vitest";
import { isCosPilotProposalPayload } from "./cos-pilot.js";

describe("isCosPilotProposalPayload", () => {
  const valid = {
    rationale: "Start with one Chief of Staff pilot instead of spawning a team.",
    delegationContract: {
      stakeholders: ["CBO", "Sales development lead"],
      goals: ["More qualified RFP submissions", "Reduced admin overhead"],
      preferences: ["Keep humans in the loop for submissions and HR/payroll changes"],
      access: [
        {
          system: "HubSpot",
          purpose: "Find and qualify RFP opportunities",
          mode: "read_only",
          status: "requested",
        },
      ],
      operatingBoundaries: {
        canDo: ["Draft RFP responses", "Prepare admin pilot charters"],
        requiresApproval: ["Submit RFPs", "Change billing, payroll, HR, or recruiting records"],
        neverDo: ["Make employment decisions"],
      },
      telemetry: ["Access used", "Drafts created", "Approval requests", "Time saved estimates"],
    },
    pilotPlan: {
      durationDays: 30,
      projectName: "30-day Chief of Staff pilot",
      heartbeatCadence: "Daily business-day brief",
      successMetrics: [
        { label: "Qualified RFP drafts", target: "3 ready for human review" },
        { label: "CBO/sales lead time saved", target: "8 hours" },
      ],
      workstreams: [
        {
          id: "rfp",
          title: "RFP pipeline",
          outcome: "More qualified municipal RFP submissions drafted for review.",
          weeklySteps: ["Map target municipalities", "Draft one response package"],
        },
      ],
      approvalGates: ["No external submissions without human approval"],
    },
  };

  it("accepts a well-formed CoS pilot proposal payload", () => {
    expect(isCosPilotProposalPayload(valid)).toBe(true);
  });

  it("rejects missing contract, plan, or success metrics", () => {
    expect(isCosPilotProposalPayload({ ...valid, delegationContract: undefined })).toBe(false);
    expect(isCosPilotProposalPayload({ ...valid, pilotPlan: undefined })).toBe(false);
    expect(
      isCosPilotProposalPayload({
        ...valid,
        pilotPlan: { ...valid.pilotPlan, successMetrics: [] },
      }),
    ).toBe(false);
  });

  it("rejects unsafe or malformed access modes", () => {
    expect(
      isCosPilotProposalPayload({
        ...valid,
        delegationContract: {
          ...valid.delegationContract,
          access: [{ ...valid.delegationContract.access[0], mode: "full_access" }],
        },
      }),
    ).toBe(false);
  });

  it("requires explicit approval boundaries", () => {
    expect(
      isCosPilotProposalPayload({
        ...valid,
        delegationContract: {
          ...valid.delegationContract,
          operatingBoundaries: {
            ...valid.delegationContract.operatingBoundaries,
            requiresApproval: [],
          },
        },
      }),
    ).toBe(false);
  });
});
