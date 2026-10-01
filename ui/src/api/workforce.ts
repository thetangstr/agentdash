import type { WorkforceBrief, WorkforceEnrollment, WorkforceFactProposal, WorkforceReadiness, WorkforceTemplate, Issue } from '@paperclipai/shared';
import { api } from './client';
const base = (companyId: string) => `/companies/${companyId}/workforce`;
export const workforceKeys = { all: (companyId: string) => ['workforce', companyId] as const, brief: (companyId: string) => ['workforce', companyId, 'brief'] as const, enrollment: (companyId: string, agentId: string) => ['workforce', companyId, agentId, 'enrollment'] as const, readiness: (companyId: string, agentId: string) => ['workforce', companyId, agentId, 'readiness'] as const };
export const workforceApi = {
  templates: (c: string) => api.get<WorkforceTemplate[]>(`${base(c)}/templates`),
  brief: (c: string) => api.get<WorkforceBrief>(`${base(c)}/brief`),
  saveBrief: (c: string, body: Pick<WorkforceBrief, 'sources' | 'facts'> & { expectedRevision: number }) => api.put<WorkforceBrief>(`${base(c)}/brief`, body),
  proposals: (c: string) => api.get<WorkforceFactProposal[]>(`${base(c)}/proposals`),
  review: (c: string, id: string, decision: 'approve' | 'reject', expectedRevision: number) => api.post<WorkforceFactProposal>(`${base(c)}/proposals/${id}/review`, { decision, expectedRevision }),
  enrollment: (c: string, a: string) => api.get<WorkforceEnrollment | null>(`${base(c)}/agents/${a}/enrollment`),
  enroll: (c: string, a: string, templateId: string) => api.post<WorkforceEnrollment>(`${base(c)}/agents/${a}/enrollment`, { templateId }),
  updateTargets: (c: string, a: string, body: { objective?: string; metrics?: string[]; goalId?: string | null }) => api.patch<WorkforceEnrollment>(`${base(c)}/agents/${a}/enrollment`, body),
  readiness: (c: string, a: string) => api.get<WorkforceReadiness | null>(`${base(c)}/agents/${a}/readiness`),
  start: (c: string, a: string) => api.post<Issue>(`${base(c)}/agents/${a}/first-job`, {}),
  retrySkills: (c: string, a: string) => api.post<WorkforceEnrollment>(`${base(c)}/agents/${a}/install-skills`, {}),
};

// AgentDash: safe recovery metadata has a separate cache and never masquerades as an interaction.
export const questionRecoveryKeys = {
  all: (companyId: string, issueId: string) => ['question-recovery', companyId, issueId] as const,
  list: (companyId: string, issueId: string, cursor?: string) => ['question-recovery', companyId, issueId, 'list', cursor ?? null] as const,
};
export const questionRecoveryApi = {
  list: (issueId: string, options: { interactionId?: string; cursor?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.interactionId) params.set('interactionId', options.interactionId);
    const query = params.toString();
    return api.get<import('@paperclipai/shared').QuestionRecoveryList>(`/issues/${issueId}/question-recovery${query ? `?${query}` : ''}`);
  },
  cancel: (issueId: string, interactionId: string, expectedUpdatedAt: string) => api.post<import('@paperclipai/shared').QuestionRecoveryReceipt>(`/issues/${issueId}/question-recovery/${interactionId}/cancel`, { expectedUpdatedAt }),
  replace: (issueId: string, interactionId: string) => api.post<import('@paperclipai/shared').AskUserQuestionsInteraction>(`/issues/${issueId}/question-recovery/${interactionId}/replace`, {}),
};
