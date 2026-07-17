import { api } from "./client";

export type Mandate = {
  id: string;
  companyId: string;
  grantorAgentId: string;
  granteeAgentId: string;
  scope: string[];
  permissionKey: string;
  spendCapCents: number;
  expiresAt: string;
  status: string;
  ccLedgerId: string | null;
  ccBlockHeight: number | null;
  ccScheme: string | null;
  ccAnchoredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateMandateBody = {
  grantorAgentId: string;
  granteeAgentId: string;
  scope: string[];
  permissionKey: string;
  spendCapCents: number;
  expiresAt: string;
};

export const mandatesApi = {
  list: (companyId: string, granteeAgentId?: string) =>
    api.get<Mandate[]>(
      `/companies/${companyId}/mandates${granteeAgentId ? `?granteeAgentId=${granteeAgentId}` : ""}`,
    ),
  create: (companyId: string, body: CreateMandateBody) =>
    api.post<Mandate>(`/companies/${companyId}/mandates`, body),
};
