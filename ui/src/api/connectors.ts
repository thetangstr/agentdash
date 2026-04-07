import { api } from "./client";

export interface Connector {
  id: string;
  companyId: string;
  provider: string;
  displayName: string;
  status: "connected" | "disconnected" | "error";
  credentialMode: string;
  scopes: string[];
  connectedBy: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectResult {
  provider: string;
  status: string;
  redirectUrl?: string;
  message?: string;
}

export const connectorsApi = {
  list: (companyId: string) =>
    api.get<Connector[]>(`/companies/${companyId}/connectors`),
  connect: (companyId: string, provider: string) =>
    api.post<ConnectResult>(
      `/companies/${companyId}/connectors/${provider}/connect`,
      {},
    ),
  disconnect: (companyId: string, connectorId: string) =>
    api.delete<Connector>(
      `/companies/${companyId}/connectors/${connectorId}`,
    ),
};
