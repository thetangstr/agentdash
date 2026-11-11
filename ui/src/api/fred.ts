// AgentDash: Fred's company-scoped setup never dispatches work; start is explicit.
import type { FredBriefInput, FredSetupInput, FredStartInput, FredWorkspace } from "@paperclipai/shared";
import { api } from "./client";

export const fredKeys = {
  workspace: (companyId: string) => ["fred", companyId] as const,
};
const path = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/fred`;
export const fredApi = {
  workspace: (companyId: string) => api.get<FredWorkspace>(path(companyId)),
  setup: (companyId: string, input: FredSetupInput) => api.post<FredWorkspace>(`${path(companyId)}/setup`, input),
  saveBrief: (companyId: string, input: FredBriefInput) => api.put<FredWorkspace>(`${path(companyId)}/brief`, input),
  start: (companyId: string, input: FredStartInput) => api.post<FredWorkspace>(`${path(companyId)}/start`, input),
};
