import { z } from "zod";

// AgentDash: Pipelines
export const pipelineStageSchema = z.object({
  name: z.string().min(1),
  order: z.number().int().nonnegative(),
  agentId: z.string().uuid().optional(),
});

export const createPipelineSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  stages: z.array(pipelineStageSchema).optional(),
});

export const updatePipelineSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  stages: z.array(pipelineStageSchema).optional(),
});

export const startPipelineRunSchema = z.object({
  inputData: z.record(z.unknown()).optional(),
});

export type CreatePipeline = z.infer<typeof createPipelineSchema>;
export type UpdatePipeline = z.infer<typeof updatePipelineSchema>;
export type StartPipelineRun = z.infer<typeof startPipelineRunSchema>;
