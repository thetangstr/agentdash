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

// AgentDash (AGE-48 Phase 2): editable fields of a proposed plan. Callers
// PATCH a subset; the server merges them into `proposalPayload` while the
// plan is still in `status='proposed'`. Approving freezes the payload, so
// after approve/reject the PATCH endpoint 422s.
export const updateAgentPlanProposalSchema = z
  .object({
    rationale: z.string().min(1).optional(),
    proposedAgents: z.array(proposedAgentSchema).min(1).optional(),
    proposedPlaybooks: z.array(proposedPlaybookSchema).optional(),
    budget: proposedBudgetSchema.optional(),
    kpis: z.array(proposedKpiSchema).optional(),
    // Structured sub-goal suggestions the UI lets the operator tweak. Kept
    // permissive (title + optional description + optional level) so a later
    // PR can extend the shape without breaking the API.
    subGoals: z
      .array(
        z.object({
          title: z.string().min(1),
          description: z.string().optional(),
          level: z.enum(["company", "team", "agent", "task"]).optional(),
        }),
      )
      .optional(),
    // The user's decisionNote field — mirrors the one on approve — so the UI
    // can stash an edit rationale while the plan is still proposed.
    decisionNote: z.string().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required to update a plan proposal",
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

// AgentDash: Chief of Staff goal-interview payload (AGE-41). The interview
// conductor collects structured answers from the operator; the dynamic plan
// generator consumes them as the primary signal. All fields optional so the
// generator can also run from partial interviews (e.g., interrupted onboarding).
export const goalInterviewPayloadSchema = z.object({
  // Archetype hint from the interview UI. Generator may override if the
  // answers point to a different shape of work.
  archetype: agentPlanArchetypeSchema.optional(),
  // The operator's restatement of the goal in their own words.
  goalStatement: z.string().min(1).optional(),
  // Why this outcome matters — used to ground rationale.
  whyNow: z.string().optional(),
  // Target horizon in days (e.g., 30 / 60 / 90).
  horizonDays: z.number().int().positive().optional(),
  // Quantitative target + unit (e.g., 50 meetings / 30 days).
  targetValue: z.number().optional(),
  targetUnit: z.string().optional(),
  // Operator-reported current baseline for the same metric.
  baselineValue: z.number().optional(),
  // Monthly budget ceiling the operator is willing to spend on this goal.
  monthlyBudgetUsd: z.number().nonnegative().optional(),
  // Free-form constraints (e.g., "no cold-calling", "enterprise only").
  constraints: z.array(z.string()).default([]),
  // Which channels/systems the team can use (email, linkedin, hubspot, …).
  channels: z.array(z.string()).default([]),
  // Industry self-description (SaaS, B2B fintech, etc.).
  industry: z.string().optional(),
  // Company size bucket (solo / 2-10 / 11-50 / 51-200 / 201+).
  companySize: z.string().optional(),
  // Known blockers from the operator's perspective.
  blockers: z.array(z.string()).default([]),
  // Anything else the interview surfaced.
  extra: z.record(z.string(), z.unknown()).optional(),
});

export type GoalInterviewPayload = z.infer<typeof goalInterviewPayloadSchema>;

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
export type UpdateAgentPlanProposal = z.infer<typeof updateAgentPlanProposalSchema>;
