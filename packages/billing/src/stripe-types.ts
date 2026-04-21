import type { Tier } from "@agentdash/shared";

// Stripe price ID -> Tier mapping. Configured via env STRIPE_PRICE_MAP as JSON.
export type StripePriceMap = Record<string, Tier>;

export interface StripeBillingConfig {
  secretKey: string;
  webhookSecret?: string;
  priceMap: StripePriceMap;
  // Where Stripe Checkout / Customer Portal redirects back to.
  successUrl: string;
  cancelUrl: string;
  portalReturnUrl: string;
}

// Reverse-lookup: given a tier, find the Stripe price ID. Used at checkout creation.
export function priceIdForTier(priceMap: StripePriceMap, tier: Tier): string | undefined {
  for (const [priceId, mappedTier] of Object.entries(priceMap)) {
    if (mappedTier === tier) return priceId;
  }
  return undefined;
}

// Forward-lookup: given a Stripe price ID, find the tier.
export function tierForPriceId(priceMap: StripePriceMap, priceId: string): Tier | undefined {
  return priceMap[priceId];
}
