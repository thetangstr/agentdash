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

export type Attestation = {
  id: string;
  mandateId: string;
  granteeAgentId: string;
  action: string;
  counterpartyDid: string;
  authorized: boolean;
  reason: string | null;
  ledgerId: string | null;
  blockHeight: number | null;
  eventHash: string | null;
  receiptStatus: string;
  escalated: boolean;
  approvalId: string | null;
  createdAt: string;
};

export type RunAttestationBody = {
  mandateId: string;
  action: string;
};

export const mandatesApi = {
  list: (companyId: string, granteeAgentId?: string) =>
    api.get<Mandate[]>(
      `/companies/${companyId}/mandates${granteeAgentId ? `?granteeAgentId=${granteeAgentId}` : ""}`,
    ),
  create: (companyId: string, body: CreateMandateBody) =>
    api.post<Mandate>(`/companies/${companyId}/mandates`, body),
  runAttestation: (companyId: string, body: RunAttestationBody) =>
    api.post<Attestation>(`/companies/${companyId}/mandate-attestations`, body),
  listAttestations: (companyId: string, mandateId?: string) =>
    api.get<Attestation[]>(
      `/companies/${companyId}/mandate-attestations${mandateId ? `?mandateId=${mandateId}` : ""}`,
    ),
};
