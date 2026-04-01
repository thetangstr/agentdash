import { api } from "./client";

export interface CrmPipelineStageSummary {
  stage: string | null;
  count: number;
  totalAmountCents: number;
}

export interface CrmPipelineSummary {
  stages: CrmPipelineStageSummary[];
  totalDeals: number;
  totalPipelineValueCents: number;
}

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

export interface CrmDeal {
  id: string;
  companyId: string;
  accountId: string | null;
  contactId: string | null;
  name: string;
  stage: string | null;
  amountCents: string | null;
  currency: string | null;
  closeDate: string | null;
  probability: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  linkedProjectId: string | null;
  linkedIssueId: string | null;
  externalId: string | null;
  externalSource: string | null;
  metadata: Record<string, unknown> | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface HubSpotConfigResponse {
  configured: boolean;
  portalId?: string | null;
  syncEnabled?: boolean;
  accessToken?: string | null;
}

export interface HubSpotSyncResult {
  contacts: number;
  companies: number;
  deals: number;
}

export const crmApi = {
  pipeline: (companyId: string) =>
    api.get<CrmPipelineSummary>(`/companies/${companyId}/crm/pipeline`),
  accounts: (companyId: string) =>
    api.get<CrmAccount[]>(`/companies/${companyId}/crm/accounts`),
  createAccount: (
    companyId: string,
    data: {
      name: string;
      domain?: string | null;
      industry?: string | null;
      size?: string | null;
      stage?: string | null;
    },
  ) => api.post<CrmAccount>(`/companies/${companyId}/crm/accounts`, data),
  deals: (companyId: string) =>
    api.get<CrmDeal[]>(`/companies/${companyId}/crm/deals`),
  createDeal: (
    companyId: string,
    data: {
      name: string;
      accountId?: string | null;
      stage?: string | null;
      amountCents?: string | null;
      currency?: string | null;
      closeDate?: string | null;
      probability?: string | null;
    },
  ) => api.post<CrmDeal>(`/companies/${companyId}/crm/deals`, data),
  leads: (companyId: string) =>
    api.get<CrmLead[]>(`/companies/${companyId}/crm/leads`),
  createLead: (
    companyId: string,
    data: {
      firstName?: string | null;
      lastName?: string | null;
      email?: string | null;
      phone?: string | null;
      company?: string | null;
      title?: string | null;
      source?: string | null;
      status?: string;
      score?: string | null;
    },
  ) => api.post<CrmLead>(`/companies/${companyId}/crm/leads`, data),
  partners: (companyId: string) =>
    api.get<CrmPartner[]>(`/companies/${companyId}/crm/partners`),
  createPartner: (
    companyId: string,
    data: {
      name: string;
      type?: string;
      contactName?: string | null;
      contactEmail?: string | null;
      website?: string | null;
      status?: string;
      tier?: string | null;
    },
  ) => api.post<CrmPartner>(`/companies/${companyId}/crm/partners`, data),
  hubspotConfig: (companyId: string) =>
    api.get<HubSpotConfigResponse>(`/companies/${companyId}/integrations/hubspot/config`),
  saveHubspotConfig: (
    companyId: string,
    data: {
      portalId?: string | null;
      accessToken?: string | null;
      syncEnabled?: boolean;
    },
  ) => api.post<{ success: true }>(`/companies/${companyId}/integrations/hubspot/config`, data),
  syncHubspot: (companyId: string) =>
    api.post<HubSpotSyncResult>(`/companies/${companyId}/integrations/hubspot/sync`, {}),
};
