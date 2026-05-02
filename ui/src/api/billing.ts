import { api } from "./client";

export interface BillingStatus {
  tier: string;
  seatsPaid: number;
  periodEnd: string | null;
}

export const billingApi = {
  status: (companyId: string) =>
    api.get<BillingStatus>(`/billing/status?companyId=${encodeURIComponent(companyId)}`),
  startCheckout: (companyId: string) =>
    api.post<{ url: string }>("/billing/checkout-session", { companyId }),
  openPortal: (companyId: string) =>
    api.post<{ url: string }>("/billing/portal-session", { companyId }),
};
