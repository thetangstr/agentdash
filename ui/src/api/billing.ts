// AgentDash: Billing API client
// Thin wrappers for Stripe Checkout and Customer Portal session creation.

import { api } from "./client";

export interface CheckoutResponse {
  url: string;
}

export interface PortalResponse {
  url: string;
}

export const billingApi = {
  createCheckoutSession: (companyId: string, targetTier: "pro" | "enterprise") =>
    api.post<CheckoutResponse>(`/companies/${companyId}/billing/checkout-session`, {
      targetTier,
    }),

  createPortalSession: (companyId: string) =>
    api.post<PortalResponse>(`/companies/${companyId}/billing/portal-session`, {}),
};
