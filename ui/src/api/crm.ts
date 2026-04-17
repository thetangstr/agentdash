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
  contactId?: string | null;
  name: string;
  stage: string | null;
  /**
   * Legacy float-style amount (used by some pages). The backend stores
   * the canonical value in `amountCents` (string of integer cents).
   */
  amount?: number | null;
  amountCents?: string | null;
  currency: string | null;
  closeDate: string | null;
  probability?: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  linkedProjectId?: string | null;
  linkedIssueId?: string | null;
  externalId?: string | null;
  externalSource?: string | null;
  metadata?: Record<string, unknown> | null;
  lastSyncedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewDeal {
  name: string;
  accountId?: string | null;
  contactId?: string | null;
  stage?: string | null;
  amountCents?: string | null;
  currency?: string | null;
  closeDate?: string | null;
  probability?: string | null;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
}

export interface CrmActivity {
  id: string;
  companyId: string;
  accountId: string | null;
  contactId: string | null;
  dealId: string | null;
  activityType: string;
  subject: string | null;
  body: string | null;
  performedByAgentId: string | null;
  performedByUserId: string | null;
  externalId: string | null;
  externalSource: string | null;
  occurredAt: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface CrmLead {
  id: string;
  companyId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  source: string | null;
  status: string;
  score: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  convertedAccountId: string | null;
  convertedContactId: string | null;
  convertedAt: string | null;
  externalId: string | null;
  externalSource: string | null;
  metadata: Record<string, unknown> | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewLead {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  title?: string | null;
  source?: string | null;
  status?: string;
  score?: string | null;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
}

export interface CrmPartner {
  id: string;
  companyId: string;
  name: string;
  type: string;
  contactName: string | null;
  contactEmail: string | null;
  website: string | null;
  status: string;
  tier: string | null;
  referralCount: string | null;
  revenueAttributedCents: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  linkedAccountId: string | null;
  externalId: string | null;
  externalSource: string | null;
  metadata: Record<string, unknown> | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewPartner {
  name: string;
  type?: string;
  contactName?: string | null;
  contactEmail?: string | null;
  website?: string | null;
  status?: string;
  tier?: string | null;
}

export interface CrmPipelineStage {
  stage: string | null;
  count: number;
  totalAmountCents: number;
}

export interface CrmPipelineSummary {
  stages: CrmPipelineStage[];
  totalDeals: number;
  totalPipelineValueCents: number;
}

export type HubspotSyncDirection = "read" | "write" | "bidirectional";

export type HubspotFieldMapping = Record<string, Record<string, string>>;

export interface HubspotConfig {
  configured: boolean;
  portalId?: string;
  syncEnabled?: boolean;
  accessToken?: string | null;
  hasClientSecret?: boolean;
  syncDirection?: HubspotSyncDirection;
  fieldMapping?: HubspotFieldMapping;
}

export interface HubspotSaveConfig {
  accessToken: string;
  portalId?: string | null;
  syncEnabled?: boolean;
  clientSecret?: string;
  syncDirection?: HubspotSyncDirection;
  fieldMapping?: HubspotFieldMapping;
}

export interface HubspotSyncStatus {
  lastSyncAt: string | null;
  lastSyncResult: {
    contacts: { synced: number; created: number; updated: number; errors: number };
    companies: { synced: number; created: number; updated: number; errors: number };
    deals: { synced: number; created: number; updated: number; errors: number };
    activities: { synced: number; created: number; updated: number; errors: number };
  } | null;
  lastSyncError: string | null;
  syncInProgress: boolean;
}

export interface HubspotTestResult {
  ok: boolean;
  error?: string;
}

export interface HubspotSyncSummary {
  contacts: number;
  companies: number;
  deals: number;
  activities: number;
  totalSynced: number;
  totalErrors: number;
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
  accounts: (companyId: string, opts?: { limit?: number; offset?: number; stage?: string; ownerAgentId?: string }) =>
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
  contacts: (companyId: string, opts?: { limit?: number; offset?: number; accountId?: string; ownerAgentId?: string }) =>
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
  deals: (companyId: string, opts?: { limit?: number; offset?: number; accountId?: string; stage?: string }) =>
    api.get<CrmDeal[]>(`/companies/${companyId}/crm/deals${qs({ ...opts })}`),
  getDeal: (companyId: string, id: string) =>
    api.get<CrmDeal>(`/companies/${companyId}/crm/deals/${id}`),
  createDeal: (companyId: string, body: NewDeal) =>
    api.post<CrmDeal>(`/companies/${companyId}/crm/deals`, body),
  updateDeal: (companyId: string, id: string, patch: Partial<CrmDeal>) =>
    api.patch<CrmDeal>(`/companies/${companyId}/crm/deals/${id}`, patch),

  // Activities
  listActivities: (
    companyId: string,
    opts?: { limit?: number; offset?: number; accountId?: string; dealId?: string },
  ) => api.get<CrmActivity[]>(`/companies/${companyId}/crm/activities${qs({ ...opts })}`),
  createActivity: (companyId: string, body: Partial<CrmActivity>) =>
    api.post<CrmActivity>(`/companies/${companyId}/crm/activities`, body),

  // Leads
  listLeads: (companyId: string, opts?: { limit?: number; offset?: number; status?: string; source?: string }) =>
    api.get<CrmLead[]>(`/companies/${companyId}/crm/leads${qs({ ...opts })}`),
  leads: (companyId: string, opts?: { limit?: number; offset?: number; status?: string; source?: string }) =>
    api.get<CrmLead[]>(`/companies/${companyId}/crm/leads${qs({ ...opts })}`),
  getLead: (companyId: string, id: string) =>
    api.get<CrmLead>(`/companies/${companyId}/crm/leads/${id}`),
  createLead: (companyId: string, body: NewLead) =>
    api.post<CrmLead>(`/companies/${companyId}/crm/leads`, body),
  updateLead: (companyId: string, id: string, patch: Partial<CrmLead>) =>
    api.patch<CrmLead>(`/companies/${companyId}/crm/leads/${id}`, patch),
  convertLead: (companyId: string, id: string, body?: { accountId?: string; contactId?: string }) =>
    api.post<CrmLead>(`/companies/${companyId}/crm/leads/${id}/convert`, body ?? {}),

  // Partners
  listPartners: (companyId: string, opts?: { limit?: number; offset?: number; type?: string; status?: string }) =>
    api.get<CrmPartner[]>(`/companies/${companyId}/crm/partners${qs({ ...opts })}`),
  partners: (companyId: string, opts?: { limit?: number; offset?: number; type?: string; status?: string }) =>
    api.get<CrmPartner[]>(`/companies/${companyId}/crm/partners${qs({ ...opts })}`),
  getPartner: (companyId: string, id: string) =>
    api.get<CrmPartner>(`/companies/${companyId}/crm/partners/${id}`),
  createPartner: (companyId: string, body: NewPartner) =>
    api.post<CrmPartner>(`/companies/${companyId}/crm/partners`, body),
  updatePartner: (companyId: string, id: string, patch: Partial<CrmPartner>) =>
    api.patch<CrmPartner>(`/companies/${companyId}/crm/partners/${id}`, patch),

  // Pipeline
  pipeline: (companyId: string) =>
    api.get<CrmPipelineSummary>(`/companies/${companyId}/crm/pipeline`),

  // HubSpot config + sync
  hubspotConfig: (companyId: string) =>
    api.get<HubspotConfig>(`/companies/${companyId}/integrations/hubspot/config`),
  saveHubspotConfig: (companyId: string, body: HubspotSaveConfig) =>
    api.post<{ success: boolean }>(
      `/companies/${companyId}/integrations/hubspot/config`,
      body,
    ),
  disconnectHubspot: (companyId: string) =>
    api.delete<{ success: boolean }>(`/companies/${companyId}/integrations/hubspot/config`),
  testHubspotConnection: (companyId: string) =>
    api.post<HubspotTestResult>(`/companies/${companyId}/integrations/hubspot/test`, {}),
  hubspotSyncStatus: (companyId: string) =>
    api.get<HubspotSyncStatus>(`/companies/${companyId}/integrations/hubspot/sync/status`),
  syncHubspot: async (companyId: string): Promise<HubspotSyncSummary> => {
    const raw = await api.post<{
      contacts: { synced: number };
      companies: { synced: number };
      deals: { synced: number };
      activities: { synced: number };
      totalSynced: number;
      totalErrors: number;
    }>(`/companies/${companyId}/integrations/hubspot/sync`, {});
    return {
      contacts: raw.contacts?.synced ?? 0,
      companies: raw.companies?.synced ?? 0,
      deals: raw.deals?.synced ?? 0,
      activities: raw.activities?.synced ?? 0,
      totalSynced: raw.totalSynced ?? 0,
      totalErrors: raw.totalErrors ?? 0,
    };
  },
};
