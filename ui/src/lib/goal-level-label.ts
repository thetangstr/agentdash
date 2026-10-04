import type { GoalLevel } from "@paperclipai/shared";

/**
 * AgentDash (c4-polish): owner-facing names for goal levels. The enum value
 * `task` rendered as "Task" conflated a goal with an issue/task — the product
 * calls one piece of work a "job". Fallback keeps unknown levels readable
 * instead of raw.
 */
export const GOAL_LEVEL_LABELS: Record<GoalLevel, string> = {
  company: "Company",
  team: "Team",
  agent: "Agent",
  task: "Job",
};

export function goalLevelLabel(level: string | null | undefined): string {
  if (!level) return "";
  return GOAL_LEVEL_LABELS[level as GoalLevel] ?? level;
}
