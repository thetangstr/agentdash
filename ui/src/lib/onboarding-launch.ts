import type { Goal } from "@paperclipai/shared";

export const ONBOARDING_PROJECT_NAME = "Onboarding";

function goalCreatedAt(goal: Goal) {
  const createdAt = goal.createdAt instanceof Date ? goal.createdAt : new Date(goal.createdAt);
  return Number.isNaN(createdAt.getTime()) ? 0 : createdAt.getTime();
}

function pickEarliestGoal(goals: Goal[]) {
  return [...goals].sort((a, b) => goalCreatedAt(a) - goalCreatedAt(b))[0] ?? null;
}

export function selectDefaultCompanyGoalId(goals: Goal[]): string | null {
  const companyGoals = goals.filter((goal) => goal.level === "company");
  const rootGoals = companyGoals.filter((goal) => !goal.parentId);
  const activeRootGoals = rootGoals.filter((goal) => goal.status === "active");

  return (
    pickEarliestGoal(activeRootGoals)?.id ??
    pickEarliestGoal(rootGoals)?.id ??
    pickEarliestGoal(companyGoals)?.id ??
    null
  );
}

export function buildOnboardingProjectPayload(goalId: string | null) {
  return {
    name: ONBOARDING_PROJECT_NAME,
    status: "in_progress" as const,
    ...(goalId ? { goalIds: [goalId] } : {}),
  };
}

/**
 * AgentDash (scan 2, E2): the wizard's tasks are created parked, in `backlog`.
 *
 * The launch screen promises that nothing runs until the owner says so. `todo`
 * cannot keep that promise: the worker contract (default AGENTS.md) defines
 * `todo` as "start now", creating a `todo` issue wakes its assignee at once,
 * the heartbeat timer counts an assigned `todo` as work, and any other run of
 * the same agent finds it in its inbox. `backlog` means "parked until someone
 * moves it": no wake on create, not in the agent's inbox, not wakeworthy. The
 * issue page's Start button moves it to `todo`, and that transition wakes the
 * assignee.
 */
export const ONBOARDING_TASK_STATUS = "backlog" as const;

export function buildOnboardingIssuePayload(input: {
  title: string;
  description: string;
  assigneeAgentId: string;
  projectId: string;
  goalId: string | null;
}) {
  const title = input.title.trim();
  const description = input.description.trim();

  return {
    title,
    ...(description ? { description } : {}),
    assigneeAgentId: input.assigneeAgentId,
    projectId: input.projectId,
    ...(input.goalId ? { goalId: input.goalId } : {}),
    status: ONBOARDING_TASK_STATUS,
  };
}
