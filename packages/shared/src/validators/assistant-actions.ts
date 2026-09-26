import { z } from "zod";

/**
 * AgentDash assistant MCP (M4, GH #679): the request bodies for the gated
 * assistant-action routes under `/api/companies/:id/assistant/actions/*`.
 *
 * These bodies are also constrained by the `bodyFields` allowlist in
 * `assistant-oauth.ts` — keep the two in sync: a field added here and not
 * there is refused in middleware before validation ever runs.
 */

export const assistantPrepareDecisionSchema = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(["approve", "reject", "request_changes"]),
  note: z.string().max(1000).optional().nullable(),
});
export type AssistantPrepareDecision = z.infer<typeof assistantPrepareDecisionSchema>;

export const assistantPrepareHireSchema = z.object({
  role: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(1000),
  /** Optional human-name hint ("Quinn"); the role title is used without one. */
  name: z.string().trim().min(1).max(120).optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
});
export type AssistantPrepareHire = z.infer<typeof assistantPrepareHireSchema>;

export const assistantConfirmActionSchema = z.object({
  handle: z.string().min(1).max(200),
  /**
   * What the person said, in their words — recorded in the activity entry so
   * the audit trail shows what the assistant claimed they agreed to.
   */
  personSaid: z.string().max(280).optional().nullable(),
});
export type AssistantConfirmAction = z.infer<typeof assistantConfirmActionSchema>;

/** "Decisions need a tap" — the only writable per-grant setting. */
export const updateAssistantGrantSchema = z.object({
  decisionsNeedTap: z.boolean(),
});
export type UpdateAssistantGrant = z.infer<typeof updateAssistantGrantSchema>;
