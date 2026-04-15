// AgentDash: CRM API client
import { api } from "./client";

export interface CrmAccount {
  id: string;
  companyId: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  stage: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  externalId: string | null;
  externalSource: string | null;
  metadata: Record<string, unknown> | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrmContact {
  id: string;
  companyId: string;
  accountId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  externalId: string | null;
  externalSource: string | null;
  metadata: Record<string, unknown> | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrmDeal {
  id: string;
  companyId: string;
  accountId: string | null;
  name: string;
  stage: string | null;
  amount: number | null;
  currency: string | null;
  closeDate: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const crmApi = {
  // Accounts
  listAccounts: (companyId: string, opts?: { limit?: number; offset?: number; stage?: string; ownerAgentId?: string }) =>
    api.get<CrmAccount[]>(`/companies/${companyId}/crm/accounts${qs({ ...opts })}`),
  getAccount: (companyId: string, id: string) =>
    api.get<CrmAccount>(`/companies/${companyId}/crm/accounts/${id}`),
  createAccount: (companyId: string, data: Partial<CrmAccount>) =>
    api.post<CrmAccount>(`/companies/${companyId}/crm/accounts`, data),
  updateAccount: (companyId: string, id: string, data: Partial<CrmAccount>) =>
    api.patch<CrmAccount>(`/companies/${companyId}/crm/accounts/${id}`, data),

  // Contacts
  listContacts: (companyId: string, opts?: { limit?: number; offset?: number; accountId?: string; ownerAgentId?: string }) =>
    api.get<CrmContact[]>(`/companies/${companyId}/crm/contacts${qs({ ...opts })}`),
  getContact: (companyId: string, id: string) =>
    api.get<CrmContact>(`/companies/${companyId}/crm/contacts/${id}`),
  createContact: (companyId: string, data: Partial<CrmContact>) =>
    api.post<CrmContact>(`/companies/${companyId}/crm/contacts`, data),
  updateContact: (companyId: string, id: string, data: Partial<CrmContact>) =>
    api.patch<CrmContact>(`/companies/${companyId}/crm/contacts/${id}`, data),

  // Deals
  listDeals: (companyId: string, opts?: { limit?: number; offset?: number; accountId?: string; stage?: string }) =>
    api.get<CrmDeal[]>(`/companies/${companyId}/crm/deals${qs({ ...opts })}`),

  // Pipeline
  pipeline: (companyId: string) =>
    api.get<unknown>(`/companies/${companyId}/crm/pipeline`),

  // HubSpot config
  hubspotConfig: async (_companyId: string) => ({ configured: false }),
};
