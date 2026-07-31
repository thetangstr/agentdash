import { api } from "./client";

export interface HubspotConnectionHealth {
  id: string;
  hubId: string | null;
  scopes: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The token is never returned by any of these. `connect` and `rotate` send one
 * and get back only the portal id and the scopes it actually carries.
 */
export const hubspotApi = {
  get: (companyId: string) =>
    api.get<{ connection: HubspotConnectionHealth | null }>(
      `/companies/${companyId}/me/connections/hubspot`,
    ),
  connect: (companyId: string, token: string) =>
    api.post<{ connectionId: string; hubId: string; scopes: string[]; sharedPortalWith: string[] }>(
      `/companies/${companyId}/me/connections/hubspot`,
      { token },
    ),
  recheck: (companyId: string) =>
    api.post<
      | { healthy: true; scopesLost: string[] }
      | { healthy: false; reason: string }
    >(`/companies/${companyId}/me/connections/hubspot/recheck`, {}),
  revoke: (companyId: string) =>
    api.post<{ connectionId: string; revoked: boolean }>(
      `/companies/${companyId}/me/connections/hubspot/revoke`,
      {},
    ),
};
