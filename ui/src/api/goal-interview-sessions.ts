// AgentDash (AGE-50 Phase 2): UI client for interview-session lifecycle.
// Mirrors `GoalInterviewSessionRow` from
// server/src/services/goal-interview-sessions.ts.

import { api } from "./client";

export interface GoalInterviewSession {
  id: string;
  companyId: string;
  goalId: string;
  conversationId: string | null;
  startedByUserId: string | null;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;
  abandonedAt: string | null;
}

export const goalInterviewSessionsApi = {
  latest: (companyId: string, goalId: string) =>
    api.get<GoalInterviewSession | null>(
      `/companies/${companyId}/goals/${goalId}/interview-sessions/latest`,
    ),
  startOrResume: (companyId: string, goalId: string) =>
    api.post<GoalInterviewSession>(
      `/companies/${companyId}/goals/${goalId}/interview-sessions`,
      {},
    ),
};
