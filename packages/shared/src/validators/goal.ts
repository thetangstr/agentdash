import { z } from "zod";
import { partialWithoutDefaults } from "./zod-object.js";
import { GOAL_LEVELS, GOAL_STATUSES } from "../constants.js";

export const createGoalSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  level: z.enum(GOAL_LEVELS).optional().default("task"),
  status: z.enum(GOAL_STATUSES).optional().default("planned"),
  parentId: z.guid().optional().nullable(),
  ownerAgentId: z.guid().optional().nullable(),
});

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = partialWithoutDefaults(createGoalSchema);

export type UpdateGoal = z.infer<typeof updateGoalSchema>;
