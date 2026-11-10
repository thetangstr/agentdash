import { approvalDecisionBatchChangeSchema, BATCH_MAX_RECORDS_UI, BATCH_REASON_CODES, type ApprovalDecisionBatchChange } from "@paperclipai/shared";
import { waitingOnYouService } from "../waiting-on-you.js";
import { approvalAskPhrase } from "../waiting-on-you-rules.js";
import type { BatchKind, BatchKindRecord } from "./kinds.js";

/**
 * AgentDash admin powers, part 3: deciding several approvals at once.
 *
 * Candidates are what the Decisions list shows as waiting on the person with
 * `canDecide` (waitingOnYouService.decisionCandidates, the same scope and the
 * same authority probe). Anything else the person can see is left out as not
 * decidable, with a plain reason. Each decision is sent to
 * `POST /api/approvals/:id/approve|reject` with the revision the preview saw
 * (the route refuses a stale one with 409) and an idempotency key bound to
 * the batch item, so a retried request can never decide twice. The route
 * re-checks the person's decision authority when each one is sent.
 *
 * "Request changes" is deliberately not a kind: each needs its own note.
 */

type ApprovalRecord = BatchKindRecord & {
  status: string;
  revision: number;
  waitingOnYou: boolean;
  canDecide: boolean;
};

function approvalLabel(approval: { type: string; payload: unknown }): string {
  const phrase = approvalAskPhrase(approval);
  const text = `Request to ${phrase}`;
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function decisionKind(key: "approval.approve" | "approval.reject"): BatchKind<ApprovalDecisionBatchChange, ApprovalRecord> {
  const decided = key === "approval.approve" ? "approved" : "rejected";
  const verb = key === "approval.approve" ? "approve" : "reject";
  return {
    key,
    entityType: "approval",
    noun: "approval",
    maxPerBatch: BATCH_MAX_RECORDS_UI,
    parseChange: (input) => approvalDecisionBatchChangeSchema.parse(input),
    async load({ db, req, companyId }, ids) {
      const candidates = await waitingOnYouService(db).decisionCandidates(companyId, req.actor as never, ids, req);
      const out = new Map<string, ApprovalRecord>();
      for (const [id, candidate] of candidates) {
        out.set(id, {
          entityType: "approval",
          entityId: id,
          label: approvalLabel(candidate.approval),
          status: candidate.approval.status,
          revision: candidate.approval.revision,
          waitingOnYou: candidate.waitingOnYou,
          canDecide: candidate.canDecide,
        });
      }
      return out;
    },
    describe(record) {
      const before = { status: record.status, revision: record.revision };
      const after = { status: decided, revision: record.revision };
      if (record.status === decided) return { before, after, noop: true };
      if (!record.waitingOnYou) {
        return {
          before, after, noop: false,
          notDecidable: { reasonCode: BATCH_REASON_CODES.notWaitingOnYou, reason: `${record.label} is not waiting on you, so it was left out.` },
        };
      }
      if (!record.canDecide) {
        return {
          before, after, noop: false,
          notDecidable: { reasonCode: BATCH_REASON_CODES.notYoursToDecide, reason: `You cannot decide ${record.label}, so it was left out.` },
        };
      }
      return { before, after, noop: false };
    },
    // The route raises the revision when it decides; only the status is the
    // outcome the person asked for.
    observe: (record) => ({ status: record.status }),
    request(record, change, item) {
      const previewedRevision = typeof item.before.revision === "number" ? item.before.revision : record.revision;
      return {
        method: "POST",
        path: `/api/approvals/${record.entityId}/${verb}`,
        body: {
          ...(change.decisionNote ? { decisionNote: change.decisionNote } : {}),
          revision: previewedRevision,
          idempotencyKey: `batch:${item.itemId}`,
          channel: "web",
        },
      };
    },
  };
}

export const approvalApproveBatchKind = decisionKind("approval.approve");
export const approvalRejectBatchKind = decisionKind("approval.reject");
