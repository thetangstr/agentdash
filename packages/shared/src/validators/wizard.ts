import { z } from "zod";
import { AGENT_ROLES, AGENT_TONES } from "../constants.js";

export const createAgentWizardSchema = z.object({
  purpose: z.string().min(1).max(2000),
  name: z.string().min(1).max(100),
  tone: z.enum(AGENT_TONES),
  role: z.enum([...AGENT_ROLES, "custom"] as const),
  customRole: z.string().max(100).optional(),
  connectors: z.array(z.string()).default([]),
  schedule: z
    .object({
      frequency: z.enum(["every_30m", "hourly", "daily"]),
      cronExpression: z.string().optional(),
    })
    .optional(),
});

export type CreateAgentWizard = z.infer<typeof createAgentWizardSchema>;
