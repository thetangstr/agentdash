import type { Db } from "@paperclipai/db";
import type {
  AgentPlanProposalV1Payload,
  DefinitionOfDone,
} from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";

export const ONBOARDING_STARTER_WORK_ORIGIN_KIND = "manual";

const STARTER_WORK_SOURCE = "cos_onboarding";

export function onboardingStarterWorkOriginId(conversationId: string) {
  return `${STARTER_WORK_SOURCE}:${conversationId}`;
}

type ProjectLike = {
  id: string;
  description?: string | null;
};

type IssueLike = {
  id: string;
  projectId?: string | null;
  hiddenAt?: Date | string | null;
};

type ProjectWriter = {
  list(companyId: string): Promise<ProjectLike[]>;
  create(companyId: string, data: Record<string, unknown>): Promise<ProjectLike>;
};

type IssueWriter = {
  list(companyId: string, filters?: Record<string, unknown>): Promise<IssueLike[]>;
  create(companyId: string, data: Record<string, unknown>): Promise<IssueLike>;
};

export interface MaterializeOnboardingStarterWorkDeps {
  db?: Db;
  projects: ProjectWriter;
  issues: IssueWriter;
}

export interface MaterializeOnboardingStarterWorkInput {
  companyId: string;
  conversationId: string;
  cosAgentId: string;
  createdAgentIds: string[];
  goalIds: {
    shortTermGoalId: string | null;
    longTermGoalId: string | null;
  };
  plan: AgentPlanProposalV1Payload;
}

export interface MaterializeOnboardingStarterWorkResult {
  projectId: string | null;
  issueId: string | null;
  alreadyMaterialized: boolean;
}

export function materializeOnboardingStarterWork(deps: MaterializeOnboardingStarterWorkDeps) {
  return async (
    input: MaterializeOnboardingStarterWorkInput,
  ): Promise<MaterializeOnboardingStarterWorkResult> => {
    const originId = onboardingStarterWorkOriginId(input.conversationId);
    const existingIssues = await deps.issues.list(input.companyId, {
      originKind: ONBOARDING_STARTER_WORK_ORIGIN_KIND,
      originId,
    });
    const existingIssue = existingIssues.find((issue) => !issue.hiddenAt) ?? existingIssues[0] ?? null;
    if (existingIssue) {
      return {
        projectId: existingIssue.projectId ?? null,
        issueId: existingIssue.id,
        alreadyMaterialized: true,
      };
    }

    const selectedGoalId = input.goalIds.shortTermGoalId ?? input.goalIds.longTermGoalId;
    const goalIds = [
      input.goalIds.shortTermGoalId,
      input.goalIds.longTermGoalId,
    ].filter((id): id is string => Boolean(id));
    const leadAgentId = input.createdAgentIds[0] ?? input.cosAgentId;
    const sourceMarker = `Source: ${originId}`;

    const existingProjects = await deps.projects.list(input.companyId);
    const existingProject =
      existingProjects.find((project) =>
        typeof project.description === "string" && project.description.includes(sourceMarker),
      ) ?? null;

    const project =
      existingProject ??
      await deps.projects.create(input.companyId, {
        name: deriveProjectName(input.plan),
        description: [
          "Starter project created from the Chief of Staff onboarding plan.",
          "",
          `Short-term alignment: ${input.plan.alignmentToShortTerm}`,
          `Long-term alignment: ${input.plan.alignmentToLongTerm}`,
          `Plan rationale: ${input.plan.rationale}`,
          "",
          sourceMarker,
        ].join("\n"),
        status: "backlog",
        leadAgentId,
        goalId: selectedGoalId,
        goalIds,
        definitionOfDone: buildStarterDefinitionOfDone(input.plan),
      });

    const issue = await deps.issues.create(input.companyId, {
      projectId: project.id,
      goalId: selectedGoalId,
      title: deriveIssueTitle(input.plan),
      description: [
        "Created from CoS onboarding so the first visible work item is tied to the user's launch goal.",
        "",
        `Short-term goal: ${input.plan.alignmentToShortTerm}`,
        `Long-term goal: ${input.plan.alignmentToLongTerm}`,
        `Recommended owner: ${describeLead(input.plan)}`,
        "",
        "Initial scope:",
        "- Confirm the first pilot/customer segment.",
        "- Turn the onboarding goal into milestones and owner-visible checkpoints.",
        "- Define what evidence proves the launch path is working.",
        "",
        sourceMarker,
      ].join("\n"),
      status: "backlog",
      priority: "high",
      assigneeAgentId: leadAgentId,
      createdByAgentId: input.cosAgentId,
      originKind: ONBOARDING_STARTER_WORK_ORIGIN_KIND,
      originId,
      originFingerprint: "starter-work",
      definitionOfDone: buildStarterDefinitionOfDone(input.plan),
    });

    try {
      await logActivity((deps.db ?? {}) as Db, {
        companyId: input.companyId,
        actorType: "agent",
        actorId: input.cosAgentId,
        agentId: input.cosAgentId,
        action: "onboarding_starter_work_created",
        entityType: "issue",
        entityId: issue.id,
        details: {
          conversationId: input.conversationId,
          source: STARTER_WORK_SOURCE,
          projectId: project.id,
          goalId: selectedGoalId,
        },
      });
    } catch {
      // Starter work is the user-visible outcome; activity logging is best effort.
    }

    return {
      projectId: project.id,
      issueId: issue.id,
      alreadyMaterialized: false,
    };
  };
}

function deriveProjectName(plan: AgentPlanProposalV1Payload) {
  const text = `${plan.alignmentToShortTerm} ${plan.rationale}`.toLowerCase();
  if (text.includes("soc 2") && text.includes("onboarding")) return "SOC 2 onboarding launch";
  if (text.includes("pilot") && text.includes("onboarding")) return "Pilot onboarding launch";
  if (text.includes("onboarding")) return "Onboarding launch";
  return "First company launch";
}

function deriveIssueTitle(plan: AgentPlanProposalV1Payload) {
  const text = `${plan.alignmentToShortTerm} ${plan.rationale}`.toLowerCase();
  if (text.includes("pilot") || text.includes("onboarding")) {
    return "Prepare the first pilot onboarding plan";
  }
  return "Prepare the first launch plan";
}

function describeLead(plan: AgentPlanProposalV1Payload) {
  const lead = plan.agents[0];
  if (!lead) return "Chief of Staff";
  return `${lead.name} (${lead.role})`;
}

function buildStarterDefinitionOfDone(plan: AgentPlanProposalV1Payload): DefinitionOfDone {
  return {
    summary: `Starter launch work is done when: ${plan.alignmentToShortTerm}`,
    criteria: [
      {
        id: "pilot-customers",
        text: "Target pilot customers and onboarding milestones are identified.",
        done: false,
      },
      {
        id: "workflow-defined",
        text: "Checklist, document request, and follow-up workflow are defined.",
        done: false,
      },
      {
        id: "founder-time",
        text: "Founder time measurement is defined before pilot onboarding starts.",
        done: false,
      },
    ],
  };
}
