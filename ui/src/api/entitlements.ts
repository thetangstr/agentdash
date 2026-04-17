// AgentDash: Entitlements API client
import { api } from "./client";
import type { Entitlements, Tier } from "@agentdash/shared";

export type { Entitlements, Tier } from "@agentdash/shared";

export const entitlementsApi = {
  get: (companyId: string) =>
    api.get<Entitlements>(`/companies/${companyId}/entitlements`),
  // Admin-only for Phase 2. Phase 3 replaces this with a Stripe webhook.
  setTier: async (companyId: string, tier: Tier): Promise<Entitlements> => {
    const res = await fetch(`/api/companies/${companyId}/entitlements`, {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-AgentDash-Admin": "1",
      },
      body: JSON.stringify({ tier }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(
        (body as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
      );
    }
    return res.json();
  },
};
