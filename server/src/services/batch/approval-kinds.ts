import { approvalDecisionBatchChangeSchema, BATCH_MAX_RECORDS_UI, BATCH_REASON_CODES, type ApprovalDecisionBatchChange } from "@paperclipai/shared";
import { waitingOnYouService } from "../waiting-on-you.js";
import { approvalAskPhrase, effectsFor } from "../waiting-on-you-rules.js";
import type { BatchKind, BatchKindRecord } from "./kinds.js";

/**
 * AgentDash admin powers, part 3: deciding several approvals at once.
 *
 * Candidates are what the Decisions list shows as waiting on the person with
 * `canDecide` (waitingOnYouService.decisionCandidates, the same scope and the
 * same authority probe). Anything else the person can see is left out as not
 * decidable, with a plain reason. Each decision is sent to
 * `POST /api/approvals/:id/approve|reject` with the revision the preview saw
 * (the route refuses a stale one with 409) and an idempotency key derived
 * from a per-batch secret, so a retried request can never decide twice and
 * nobody can spend the key first. The route
 * re-checks the person's decision authority when each one is sent.
 *
 * "Request changes" is deliberately not a kind: each needs its own note.
 */

type ApprovalRecord = BatchKindRecord & {
  status: string;
  revision: number;
  waitingOnYou: boolean;
  canDecide: boolean;
  /** Used only for the preview's plain consequence line; never stored in before/after. */
  type: string;
  payload: unknown;
};

/**
 * What deciding sets in motion, for the approval types where the decision
 * itself causes something (the route's decision effects). Shown at preview so
 * an "applied" result is read as "the decision was recorded", with these
 * consequences following from it.
 */
function decisionNote(record: ApprovalRecord, decided: "approved" | "rejected"): string | null {
  const approval = { type: record.type, status: record.status, payload: record.payload };
  if (record.type === "hire_agent") {
    return decided === "approved"
      ? `Approving this hires the agent: ${effectsFor(approval, "approve")[0]}`
      : `Rejecting this refuses the hire: ${effectsFor(approval, "reject")[0]}`;
  }
  if (decided !== "approved") return null;
  if (record.type === "budget_override_required") return "Approving this lets spending go past the budget limit it was stopped at.";
  if (record.type === "connector_send") return "Approving this sends the message outside the company through the connector.";
  if (record.type === "agent_profile_change") return "Approving this changes how the agent works (its operating profile).";
  return null;
}

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
          type: candidate.approval.type,
          payload: candidate.approval.payload,
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
      const note = decisionNote(record, decided);
      return { before, after, noop: false, ...(note ? { notes: [note] } : {}) };
    },
    // Only the status is the outcome the person asked for. (Deciding does not
    // change the revision; only a resubmission raises it. The revision stays
    // in `before` as the drift fingerprint and is sent to the route.)
    observe: (record) => ({ status: record.status }),
    // An approval someone else decided first answers 200 with their decision
    // (and an identical replay of our own key answers 200 too): the response
    // names the decision's idempotency key and decider.
    checkResponse(body, { actorUserId, request }) {
      if (!body || typeof body !== "object") return null;
      const response = body as { status?: unknown; decidedByUserId?: unknown; decisionIdempotencyKey?: unknown };
      const ourKey = request.body.idempotencyKey;
      if (typeof response.decisionIdempotencyKey === "string" && response.decisionIdempotencyKey === ourKey) return null;
      if (response.status === decided && typeof response.decidedByUserId === "string" && response.decidedByUserId === actorUserId && response.decisionIdempotencyKey === undefined) return null;
      const already = response.status === "approved" ? "approved" : response.status === "rejected" ? "rejected" : "decided";
      // Nothing was done by this batch: the route returned an earlier decision.
      // The same person deciding on another channel is "already decided", not
      // "someone else".
      if (typeof response.decidedByUserId === "string" && response.decidedByUserId === actorUserId) {
        return { reasonCode: BATCH_REASON_CODES.alreadyDecided, reason: `it was already ${already}, so nothing was done by this batch.` };
      }
      return { reasonCode: BATCH_REASON_CODES.notThisBatchsDecision, reason: `it was already ${already} by someone else, so nothing was done by this batch.` };
    },
    request(record, change, item) {
      const previewedRevision = typeof item.before.revision === "number" ? item.before.revision : record.revision;
      return {
        method: "POST",
        path: `/api/approvals/${record.entityId}/${verb}`,
        body: {
          ...(change.decisionNote ? { decisionNote: change.decisionNote } : {}),
          revision: previewedRevision,
          // Unguessable and stable for this item (runner.ts batchItemIdempotencyKey).
          idempotencyKey: item.idempotencyKey,
          channel: "web",
        },
      };
    },
  };
}

export const approvalApproveBatchKind = decisionKind("approval.approve");
export const approvalRejectBatchKind = decisionKind("approval.reject");
