import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const APPROVAL_DECISION_CHANNELS = ["web", "telegram", "teams"] as const;
export type ApprovalDecisionChannel = (typeof APPROVAL_DECISION_CHANNELS)[number];

/**
 * Decision metadata is OPTIONAL here on purpose.
 *
 * The plan specifies these as required, but making them required in the schema
 * would break every existing default-profile caller (web UI, CLI, agents) the
 * moment this ships, which contradicts the harder constraint that
 * default-profile behavior must not change. `agentdash_mk` companies require
 * them instead — enforced in the approval-authority service, which is the only
 * layer that knows the company's product profile.
 */
const decisionMetadataShape = {
  revision: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
  channel: z.enum(APPROVAL_DECISION_CHANNELS).optional(),
};

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
  ...decisionMetadataShape,
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

/**
 * Emergency override is a distinct action, not a flag on the ordinary decision:
 * it demands an explicit reason and is surfaced and audited as exceptional.
 */
export const overrideApprovalSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  overrideReason: z.string().trim().min(1).max(2000),
  decisionNote: multilineTextSchema.optional().nullable(),
  ...decisionMetadataShape,
});

export type OverrideApproval = z.infer<typeof overrideApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
