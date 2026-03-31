import { z } from "zod";

export const pipelineStageSchema = z.object({
  order: z.number().int().min(0),
  name: z.string().min(1),
  agentTemplateSlug: z.string().optional(),
  agentId: z.string().uuid().optional(),
  autoAdvance: z.boolean().default(true),
  config: z.record(z.unknown()).optional(),
});

export const createPipelineSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  stages: z.array(pipelineStageSchema).min(1),
});

export type CreatePipeline = z.infer<typeof createPipelineSchema>;

export const updatePipelineSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  stages: z.array(pipelineStageSchema).min(1).optional(),
});

export type UpdatePipeline = z.infer<typeof updatePipelineSchema>;

export const startPipelineRunSchema = z.object({
  triggerIssueId: z.string().uuid(),
  context: z.record(z.unknown()).optional(),
});

export type StartPipelineRun = z.infer<typeof startPipelineRunSchema>;
