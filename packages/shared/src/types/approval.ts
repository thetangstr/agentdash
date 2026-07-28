import type { ApprovalStatus, ApprovalType } from "../constants.js";

export interface Approval {
  id: string;
  companyId: string;
  type: ApprovalType;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  // AgentDash-MK decision provenance. `revision` is required on every decision
  // in an `agentdash_mk` company and must match what the decider was shown, so
  // clients have to be able to read it back off the approval.
  revision: number;
  decisionChannel: string | null;
  decisionIdempotencyKey: string | null;
  decisionActorRole: string | null;
  overrideReason: string | null;
  expiresAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalComment {
  id: string;
  companyId: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}
