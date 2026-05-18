import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  materializeOnboardingStarterWork,
  ONBOARDING_STARTER_WORK_ORIGIN_KIND,
  onboardingStarterWorkOriginId,
} from "../services/materialize-onboarding-starter-work.ts";

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
  publishPluginDomainEvent: vi.fn(),
}));

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const COS_AGENT_ID = "33333333-3333-3333-3333-333333333333";
const LEAD_AGENT_ID = "44444444-4444-4444-4444-444444444444";
const SHORT_GOAL_ID = "55555555-5555-5555-5555-555555555555";
const LONG_GOAL_ID = "66666666-6666-6666-6666-666666666666";

function makeDeps() {
  return {
    projects: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async (companyId: string, data: any) => ({
        id: "project-1",
        companyId,
        ...data,
      })),
    },
    issues: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async (companyId: string, data: any) => ({
        id: "issue-1",
        identifier: "AGD-1",
        companyId,
        ...data,
      })),
    },
  };
}

const plan = {
  rationale: "Build a repeatable onboarding motion.",
  agents: [
    {
      role: "implementation_coordinator",
      name: "Piper",
      adapterType: "codex_local",
      responsibilities: ["Coordinate three pilot customers"],
      kpis: ["Three pilots onboarded"],
    },
  ],
  alignmentToShortTerm: "Launch an AI-assisted SOC 2 onboarding product in 90 days.",
  alignmentToLongTerm: "Build an AI operations team that can run customer onboarding.",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("materializeOnboardingStarterWork", () => {
  it("creates a starter project and issue linked to the onboarding goal", async () => {
    const deps = makeDeps();

    const result = await materializeOnboardingStarterWork(deps as any)({
      companyId: COMPANY_ID,
      conversationId: CONVERSATION_ID,
      cosAgentId: COS_AGENT_ID,
      createdAgentIds: [LEAD_AGENT_ID],
      goalIds: {
        shortTermGoalId: SHORT_GOAL_ID,
        longTermGoalId: LONG_GOAL_ID,
      },
      plan,
    });

    expect(result).toEqual({
      projectId: "project-1",
      issueId: "issue-1",
      alreadyMaterialized: false,
    });
    expect(deps.projects.create).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        name: "SOC 2 onboarding launch",
        goalId: SHORT_GOAL_ID,
        goalIds: [SHORT_GOAL_ID, LONG_GOAL_ID],
        leadAgentId: LEAD_AGENT_ID,
        definitionOfDone: expect.objectContaining({
          summary: expect.stringContaining("Launch an AI-assisted SOC 2 onboarding product"),
          criteria: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining("pilot customers") }),
          ]),
        }),
      }),
    );
    expect(deps.issues.create).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        projectId: "project-1",
        goalId: SHORT_GOAL_ID,
        status: "backlog",
        assigneeAgentId: LEAD_AGENT_ID,
        createdByAgentId: COS_AGENT_ID,
        title: "Prepare the first pilot onboarding plan",
        originKind: ONBOARDING_STARTER_WORK_ORIGIN_KIND,
        originId: onboardingStarterWorkOriginId(CONVERSATION_ID),
        definitionOfDone: expect.objectContaining({
          criteria: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining("Founder time") }),
          ]),
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        actorType: "agent",
        actorId: COS_AGENT_ID,
        action: "onboarding_starter_work_created",
        entityType: "issue",
        entityId: "issue-1",
      }),
    );
  });

  it("is idempotent when the starter issue already exists", async () => {
    const deps = makeDeps();
    deps.issues.list.mockResolvedValue([
      {
        id: "existing-issue",
        projectId: "existing-project",
        originKind: ONBOARDING_STARTER_WORK_ORIGIN_KIND,
        originId: onboardingStarterWorkOriginId(CONVERSATION_ID),
      },
    ]);

    const result = await materializeOnboardingStarterWork(deps as any)({
      companyId: COMPANY_ID,
      conversationId: CONVERSATION_ID,
      cosAgentId: COS_AGENT_ID,
      createdAgentIds: [LEAD_AGENT_ID],
      goalIds: {
        shortTermGoalId: SHORT_GOAL_ID,
        longTermGoalId: LONG_GOAL_ID,
      },
      plan,
    });

    expect(result).toEqual({
      projectId: "existing-project",
      issueId: "existing-issue",
      alreadyMaterialized: true,
    });
    expect(deps.projects.create).not.toHaveBeenCalled();
    expect(deps.issues.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
