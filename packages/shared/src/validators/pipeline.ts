import { z } from "zod";

// AgentDash: Pipeline stage definition
export const pipelineStageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["agent", "hitl_gate", "merge"]),
  agentId: z.string().uuid().optional(),
  scopedInstruction: z.string().min(1),
  stateMapping: z.record(z.string()).optional(),
  timeoutMinutes: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  mergeStrategy: z.enum(["all", "any"]).optional(),
  mergeTimeout: z.number().int().positive().optional(),
  hitlInstructions: z.string().optional(),
  hitlTimeoutHours: z.number().positive().optional(),
});

// AgentDash: Pipeline edge definition
export const pipelineEdgeSchema = z.object({
  id: z.string().min(1),
  fromStageId: z.string().min(1),
  toStageId: z.string().min(1),
  condition: z.string().optional(),
});

// AgentDash: Pipeline defaults
export const pipelineDefaultsSchema = z.object({
  stageTimeoutMinutes: z.number().int().positive().default(30),
  hitlTimeoutHours: z.number().positive().default(72),
  maxSelfHealRetries: z.number().int().min(0).max(10).default(3),
  budgetCapUsd: z.number().positive().optional(),
});

export const createPipelineSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  stages: z.array(pipelineStageSchema).min(1),
  edges: z.array(pipelineEdgeSchema).default([]),
  executionMode: z.enum(["sync", "async"]).default("sync"),
  defaults: pipelineDefaultsSchema.optional(),
});

export const updatePipelineSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  stages: z.array(pipelineStageSchema).min(1).optional(),
  edges: z.array(pipelineEdgeSchema).optional(),
  executionMode: z.enum(["sync", "async"]).optional(),
  defaults: pipelineDefaultsSchema.optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
});

export const startPipelineRunSchema = z.object({
  inputData: z.record(z.unknown()).optional(),
  executionMode: z.enum(["sync", "async"]).optional(),
});

export type CreatePipeline = z.infer<typeof createPipelineSchema>;
export type UpdatePipeline = z.infer<typeof updatePipelineSchema>;
export type StartPipelineRun = z.infer<typeof startPipelineRunSchema>;
