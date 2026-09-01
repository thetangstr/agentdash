interface BillingConfig {
  proPriceId: string;
  trialDays: number;
  publicBaseUrl: string;
}

interface CompaniesAdapter {
  getById: (id: string) => Promise<{
    id: string;
    name: string;
    stripeCustomerId?: string | null;
    planTier?: string | null;
    planSeatsPaid?: number | null;
    planPeriodEnd?: Date | null;
  } | null>;
  update: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
}

interface Deps {
  stripe: any;
  companies: CompaniesAdapter;
  config: BillingConfig;
}

export function billingService(deps: Deps) {
  return {
    createCheckoutSession: async (companyId: string) => {
      const company = await deps.companies.getById(companyId);
      if (!company) throw new Error("Company not found");
      let customerId = company.stripeCustomerId ?? null;
      if (!customerId) {
        const customer = await deps.stripe.customers.create({
          name: company.name,
          metadata: { companyId },
        });
        customerId = customer.id;
        await deps.companies.update(companyId, { stripeCustomerId: customerId });
      }
      const session = await deps.stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: deps.config.proPriceId, quantity: 1 }],
        // Stripe Checkout in subscription mode collects a card by DEFAULT.
        // Without this flag the "no card required" promise on the pricing page,
        // the terms page, the billing button and CLAUDE.md is false, and a
        // design partner who is not meant to pay yet is asked for a card before
        // they can reach the product.
        //
        // This pairs with `missing_payment_method: "cancel"` below, which is
        // only meaningful once a card can legitimately be absent: together they
        // mean "start with no card, and end the subscription at trial expiry
        // rather than silently converting it into a charge."
        payment_method_collection: "if_required",
        subscription_data: {
          trial_period_days: deps.config.trialDays,
          trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
          metadata: { companyId },
        },
        success_url: `${deps.config.publicBaseUrl}/billing?session=success`,
        cancel_url: `${deps.config.publicBaseUrl}/billing?session=cancel`,
      });
      return { url: session.url };
    },

    createPortalSession: async (companyId: string) => {
      const company = await deps.companies.getById(companyId);
      if (!company?.stripeCustomerId) throw new Error("No Stripe customer for this company");
      const session = await deps.stripe.billingPortal.sessions.create({
        customer: company.stripeCustomerId,
        return_url: `${deps.config.publicBaseUrl}/billing`,
      });
      return { url: session.url };
    },

    getStatus: async (companyId: string) => {
      const c = await deps.companies.getById(companyId);
      if (!c) throw new Error("Company not found");
      return {
        tier: c.planTier ?? "free",
        seatsPaid: c.planSeatsPaid ?? 0,
        periodEnd: c.planPeriodEnd ?? null,
      };
    },
  };
}
