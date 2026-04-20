// AgentDash: Action Proposals API client
import { api } from "./client";

export interface ActionProposalLinkedIssue {
  id: string;
  title: string;
}

export interface ActionProposalRequestedByAgent {
  id: string;
  name: string;
}

export interface ActionProposal {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgent: ActionProposalRequestedByAgent | null;
  linkedIssues: ActionProposalLinkedIssue[];
  decisionNote: string | null;
  createdAt: string;
}

export const actionProposalsApi = {
  list: (companyId: string, status: string = "pending") =>
    api.get<ActionProposal[]>(
      `/companies/${companyId}/action-proposals?status=${encodeURIComponent(status)}`,
    ),
  approve: (companyId: string, id: string, decisionNote?: string) =>
    api.post<ActionProposal>(
      `/companies/${companyId}/action-proposals/${id}/approve`,
      { decisionNote },
    ),
  reject: (companyId: string, id: string, decisionNote?: string) =>
    api.post<ActionProposal>(
      `/companies/${companyId}/action-proposals/${id}/reject`,
      { decisionNote },
    ),
};
