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
 * them. `assignee: null` unassigns. Labels and project join in part 3.
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
}).strict().refine(
  (value) => value.status !== undefined || value.priority !== undefined || value.assignee !== undefined,
  "Choose at least one change.",
);
export type IssueUpdateBatchChange = z.infer<typeof issueUpdateBatchChangeSchema>;
