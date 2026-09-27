import { api } from "./client";

export interface BillingStatus {
  tier: string;
  seatsPaid: number;
  periodEnd: string | null;
  // AgentDash (GH #790): whether Stripe is configured on this instance.
  // Absent on pre-flag servers — treat missing as configured so nothing hides.
  configured?: boolean;
}

export const billingApi = {
  status: (companyId: string) =>
    api.get<BillingStatus>(`/billing/status?companyId=${encodeURIComponent(companyId)}`),
  startCheckout: (companyId: string) =>
    api.post<{ url: string }>("/billing/checkout-session", { companyId }),
  openPortal: (companyId: string) =>
    api.post<{ url: string }>("/billing/portal-session", { companyId }),
};
