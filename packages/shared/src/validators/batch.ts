import { z } from "zod";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "../constants.js";
import { BATCH_MAX_RECORDS_UI, BATCH_RECONCILE_VERDICTS } from "../batch.js";

/**
 * AgentDash admin powers, part 2: request bodies of the batch routes. The
 * `change` is parsed again by the kind's own schema (below), so this only
 * fixes the envelope.
 */
export const batchPreviewSchema = z.object({
  kind: z.string().trim().min(1).max(64),
  ids: z
    .array(z.string().trim().min(1).max(200))
    .min(1, "Pick at least one record.")
    .max(BATCH_MAX_RECORDS_UI, `A batch holds at most ${BATCH_MAX_RECORDS_UI} records.`),
  change: z.record(z.string(), z.unknown()),
}).strict();
export type BatchPreviewRequest = z.infer<typeof batchPreviewSchema>;

export const batchConfirmSchema = z.object({
  handle: z.string().trim().min(16).max(200),
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type BatchConfirmRequest = z.infer<typeof batchConfirmSchema>;

export const batchReconcileSchema = z.object({
  verdict: z.enum(BATCH_RECONCILE_VERDICTS),
  note: z.string().trim().max(1000).optional(),
}).strict();
export type BatchReconcileRequest = z.infer<typeof batchReconcileSchema>;

/**
 * Kind `issue.update`: the fields one batch may set on each issue, sent to
 * `PATCH /api/issues/:id` exactly as a person editing that issue would send
 * them. `assignee: null` unassigns; `projectId: null` takes the issue out of
 * its project. Labels are added or removed: the preview turns them into each
 * issue's full label set.
 */
export const issueUpdateBatchChangeSchema = z.object({
  status: z.enum(ISSUE_STATUSES).optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  assignee: z
    .union([
      z.object({ agentId: z.guid() }).strict(),
      z.object({ userId: z.string().trim().min(1).max(200) }).strict(),
    ])
    .nullable()
    .optional(),
  projectId: z.guid().nullable().optional(),
  addLabelIds: z.array(z.guid()).max(50).optional(),
  removeLabelIds: z.array(z.guid()).max(50).optional(),
}).strict().refine(
  (value) =>
    value.status !== undefined || value.priority !== undefined || value.assignee !== undefined
    || value.projectId !== undefined || (value.addLabelIds?.length ?? 0) > 0 || (value.removeLabelIds?.length ?? 0) > 0,
  "Choose at least one change.",
).refine(
  (value) => !(value.addLabelIds ?? []).some((id) => (value.removeLabelIds ?? []).includes(id)),
  "A label cannot be added and removed in the same change.",
);
export type IssueUpdateBatchChange = z.infer<typeof issueUpdateBatchChangeSchema>;

/**
 * Kinds `approval.approve` and `approval.reject`: decide several approvals
 * the person may decide, with one optional shared note, through
 * `POST /api/approvals/:id/approve|reject`. "Request changes" is not a batch
 * kind: each request for changes needs its own note.
 */
export const approvalDecisionBatchChangeSchema = z.object({
  decisionNote: z.string().trim().max(2000).optional(),
}).strict();
export type ApprovalDecisionBatchChange = z.infer<typeof approvalDecisionBatchChangeSchema>;

/** Kinds `agent.pause` and `agent.resume`: no options. */
export const agentPauseResumeBatchChangeSchema = z.object({}).strict();
export type AgentPauseResumeBatchChange = z.infer<typeof agentPauseResumeBatchChangeSchema>;

/**
 * Kind `agent.set_model`: the model id, sent as `{adapterConfig: {model}}`
 * (the route merges it into the agent's adapter configuration). Only the
 * model is ever stored in a batch row.
 */
export const agentSetModelBatchChangeSchema = z.object({
  model: z.string().trim().min(1).max(200),
}).strict();
export type AgentSetModelBatchChange = z.infer<typeof agentSetModelBatchChangeSchema>;

/** Kind `agent.transfer_steward`: the new steward and the reason the stewardship record keeps. */
export const agentTransferStewardBatchChangeSchema = z.object({
  userId: z.string().trim().min(1).max(256),
  transferReason: z.string().trim().min(1).max(500),
}).strict();
export type AgentTransferStewardBatchChange = z.infer<typeof agentTransferStewardBatchChangeSchema>;

/** Kinds `routine.archive`, `routine.delete` and `label.delete`: no options. */
export const noOptionsBatchChangeSchema = z.object({}).strict();
export type NoOptionsBatchChange = z.infer<typeof noOptionsBatchChangeSchema>;

/** Kind `label.update`: rename (one label) or recolor (any number). */
export const labelUpdateBatchChangeSchema = z.object({
  name: z.string().trim().min(1).max(48).optional(),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value").optional(),
}).strict().refine((value) => value.name !== undefined || value.color !== undefined, "Change the name or the color.");
export type LabelUpdateBatchChange = z.infer<typeof labelUpdateBatchChangeSchema>;
