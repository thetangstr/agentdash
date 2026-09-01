import type { Approval, ApprovalComment, Issue } from "@paperclipai/shared";
import { api } from "./client";

/**
 * AgentDash-MK requires every approval decision to carry the revision the
 * decider was shown, an idempotency key, and a channel. `revision` MUST come
 * from the approval that was rendered — re-reading it here would defeat the
 * stale-card protection it exists to provide, since a stale button would
 * silently pick up the current revision and succeed.
 *
 * When the caller does not supply a revision the metadata is omitted entirely,
 * which is exactly the pre-existing contract that `default`-profile companies
 * still accept.
 */
export interface ApprovalDecisionOptions {
  decisionNote?: string | null;
  revision?: number;
}

/**
 * `crypto.randomUUID` is secure-context-only and absent on older Safari, so an
 * unguarded call would throw before any request is made — killing every approve
 * and reject button when AgentDash is served over plain HTTP. Matches the
 * fallback convention already used elsewhere in this app.
 */
function newDecisionKey() {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `web-${randomUuid}`;
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function decisionBody(options?: ApprovalDecisionOptions) {
  const body: Record<string, unknown> = { decisionNote: options?.decisionNote };
  if (typeof options?.revision === "number") {
    body.revision = options.revision;
    body.idempotencyKey = newDecisionKey();
    body.channel = "web";
  }
  return body;
}

export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    api.get<Approval[]>(
      `/companies/${companyId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/companies/${companyId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  approve: (id: string, options?: ApprovalDecisionOptions) =>
    api.post<Approval>(`/approvals/${id}/approve`, decisionBody(options)),
  reject: (id: string, options?: ApprovalDecisionOptions) =>
    api.post<Approval>(`/approvals/${id}/reject`, decisionBody(options)),
  requestRevision: (id: string, options?: ApprovalDecisionOptions) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, {
      decisionNote: options?.decisionNote,
    }),
  /** Owner/admin emergency override — always requires a stated reason. */
  override: (
    id: string,
    data: { decision: "approved" | "rejected"; overrideReason: string; revision?: number },
  ) =>
    api.post<Approval>(`/approvals/${id}/override`, {
      decision: data.decision,
      overrideReason: data.overrideReason,
      ...(typeof data.revision === "number"
        ? { revision: data.revision, idempotencyKey: newDecisionKey(), channel: "web" }
        : {}),
    }),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
};
