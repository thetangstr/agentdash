import type { AgentGovernancePolicy } from "@paperclipai/shared";
import { api } from "./client";

/** AgentDash admin powers: named owner ceilings (agentdash_mk companies; 404 elsewhere). */
export interface CeilingTemplate {
  id: string;
  companyId: string;
  name: string;
  ceiling: AgentGovernancePolicy;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export const ceilingTemplatesApi = {
  list: (companyId: string) => api.get<{ templates: CeilingTemplate[] }>(`/companies/${companyId}/ceiling-templates`),
  create: (companyId: string, input: { name: string; ceiling: AgentGovernancePolicy }) =>
    api.post<CeilingTemplate>(`/companies/${companyId}/ceiling-templates`, input),
  update: (companyId: string, templateId: string, input: { name?: string; ceiling?: AgentGovernancePolicy; revision: number }) =>
    api.patch<CeilingTemplate>(`/companies/${companyId}/ceiling-templates/${templateId}`, input),
  remove: (companyId: string, templateId: string) =>
    api.delete<{ id: string; deleted: true }>(`/companies/${companyId}/ceiling-templates/${templateId}`),
};
