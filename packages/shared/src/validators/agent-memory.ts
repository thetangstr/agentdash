import { z } from "zod";
import { AGENT_MEMORY_MAX_LENGTH } from "../types/agent-memory.js";

/**
 * `expectedVersion` is optional in the schema but not in practice: the service
 * rejects a write that omits it when memory already exists. Keeping it optional
 * here lets the FIRST write — where there is no version to name — use the same
 * request shape as every later one.
 */
export const writeAgentMemorySchema = z.object({
  content: z.string().min(1).max(AGENT_MEMORY_MAX_LENGTH),
  expectedVersion: z.number().int().positive().nullable().optional(),
});

export type WriteAgentMemory = z.infer<typeof writeAgentMemorySchema>;
