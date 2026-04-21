import { api } from "./client";

// AgentDash: Manual KPIs client (AGE-45)

export interface Kpi {
  id: string;
  companyId: string;
  name: string;
  unit: string;
  targetValue: string;
  currentValue: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface KpiCreate {
  name: string;
  unit?: string;
  targetValue: number | string;
  currentValue?: number | string | null;
  priority?: number;
}

export type KpiUpdate = Partial<KpiCreate>;

export const kpisApi = {
  list: (companyId: string) => api.get<Kpi[]>(`/companies/${companyId}/kpis`),
  create: (companyId: string, data: KpiCreate) =>
    api.post<Kpi>(`/companies/${companyId}/kpis`, data),
  update: (companyId: string, id: string, data: KpiUpdate) =>
    api.patch<Kpi>(`/companies/${companyId}/kpis/${id}`, data),
  remove: (companyId: string, id: string) =>
    api.delete<Kpi>(`/companies/${companyId}/kpis/${id}`),
  setValue: (companyId: string, id: string, value: number | string) =>
    api.post<Kpi>(`/companies/${companyId}/kpis/${id}/value`, { value }),
};
