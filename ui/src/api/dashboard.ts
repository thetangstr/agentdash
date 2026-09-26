import type { DashboardSummary, WaitingOnYou, WorkingNow } from "@paperclipai/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  // AgentDash: UX-3 (#784) — Home's blocks.
  workingNow: (companyId: string) => api.get<WorkingNow>(`/companies/${companyId}/dashboard/working-now`),
  /**
   * The same route the assistant's list_pending_decisions calls, so Home and
   * the assistant can never disagree on what is waiting on you.
   */
  waitingOnYou: (companyId: string) =>
    api.get<WaitingOnYou>(`/companies/${companyId}/assistant/pending-decisions`),
};
