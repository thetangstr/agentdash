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
