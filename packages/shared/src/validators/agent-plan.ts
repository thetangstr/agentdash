import { z } from "zod";

// AgentDash: Goal-driven workflow — a Plan proposes a team of agents + playbooks
// + budget + KPIs to achieve a business goal. User approves → expansion creates
// the real agents, playbooks, routines, KRs, and budget policies atomically.

export const agentPlanArchetypeSchema = z.enum([
  "revenue",
  "acquisition",
  "cost",
  "support",
  "content",
  "custom",
]);

export const proposedAgentSchema = z.object({
  role: z.string().min(1),
  name: z.string().min(1),
  adapterType: z.string().min(1),
  systemPrompt: z.string().min(1),
  skills: z.array(z.string()).default([]),
  estimatedMonthlyCostUsd: z.number().nonnegative().optional(),
});

export const proposedPlaybookStageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["agent", "hitl_gate", "merge"]),
  agentRole: z.string().min(1).optional(),
  scopedInstruction: z.string().min(1),
});

export const proposedPlaybookTriggerSchema = z.object({
  kind: z.enum(["schedule", "webhook", "manual", "event"]),
  cron: z.string().optional(),
  event: z.string().optional(),
});

export const proposedPlaybookSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  stages: z.array(proposedPlaybookStageSchema).min(1),
  trigger: proposedPlaybookTriggerSchema.optional(),
});

export const proposedBudgetSchema = z.object({
  monthlyCapUsd: z.number().positive(),
  killSwitchAtPct: z.number().int().min(1).max(100).default(100),
  warnAtPct: z.number().int().min(1).max(100).default(80),
});

export const proposedKpiSchema = z.object({
  metric: z.string().min(1),
  baseline: z.number(),
  target: z.number(),
  unit: z.string().min(1),
  horizonDays: z.number().int().positive(),
});

export const agentTeamPlanPayloadSchema = z.object({
  archetype: agentPlanArchetypeSchema,
  rationale: z.string().min(1),
  proposedAgents: z.array(proposedAgentSchema).min(1),
  proposedPlaybooks: z.array(proposedPlaybookSchema).default([]),
  budget: proposedBudgetSchema,
  kpis: z.array(proposedKpiSchema).default([]),
});

export const createAgentPlanSchema = z.object({
  goalId: z.string().uuid(),
  archetype: agentPlanArchetypeSchema,
  rationale: z.string().min(1).optional(),
  payload: agentTeamPlanPayloadSchema,
  proposedByAgentId: z.string().uuid().optional(),
});

export const approveAgentPlanSchema = z.object({
  decisionNote: z.string().optional(),
});

export const rejectAgentPlanSchema = z.object({
  decisionNote: z.string().min(1),
});

export const listAgentPlansQuerySchema = z.object({
  goalId: z.string().uuid().optional(),
  status: z.enum(["proposed", "approved", "rejected", "expanded"]).optional(),
});

export type AgentPlanArchetype = z.infer<typeof agentPlanArchetypeSchema>;
export type ProposedAgent = z.infer<typeof proposedAgentSchema>;
export type ProposedPlaybook = z.infer<typeof proposedPlaybookSchema>;
export type ProposedBudget = z.infer<typeof proposedBudgetSchema>;
export type ProposedKpi = z.infer<typeof proposedKpiSchema>;
export type AgentTeamPlanPayload = z.infer<typeof agentTeamPlanPayloadSchema>;
export type CreateAgentPlan = z.infer<typeof createAgentPlanSchema>;
export type ApproveAgentPlan = z.infer<typeof approveAgentPlanSchema>;
export type RejectAgentPlan = z.infer<typeof rejectAgentPlanSchema>;
export type ListAgentPlansQuery = z.infer<typeof listAgentPlansQuerySchema>;
