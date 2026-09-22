import { api } from "./client";

/**
 * A steward's own inbox-delivery webhooks. The `me/` scoping mirrors bridge
 * endpoints: register, list and revoke are all for the signed-in person only —
 * pointing somebody else's approvals at a channel they did not choose is the
 * failure mode, not a feature.
 */
export interface StewardWebhook {
  id: string;
  label: string;
  /** Host only. The full URL is a channel-posting secret and never comes back. */
  urlHint: string;
  verifiedAt: string | null;
  lastDeliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export const stewardWebhooksApi = {
  list: (companyId: string) =>
    api.get<{ webhooks: StewardWebhook[] }>(`/companies/${companyId}/me/webhooks`),
  register: (companyId: string, input: { url: string; label?: string }) =>
    api.post<{ id: string; label: string }>(`/companies/${companyId}/me/webhooks`, input),
  revoke: (companyId: string, webhookId: string) =>
    api.post<{ ok: true }>(`/companies/${companyId}/me/webhooks/${webhookId}/revoke`, {}),
};
