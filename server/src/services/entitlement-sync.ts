interface CompaniesAdapter {
  findByStripeSubscriptionId: (id: string) => Promise<{ id: string } | null>;
  findByStripeCustomerId: (id: string) => Promise<{ id: string } | null>;
  update: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
}

interface LedgerAdapter {
  record: (eventId: string, eventType: string, payload: any) => Promise<{ inserted: boolean }>;
}

interface Deps {
  companies: CompaniesAdapter;
  ledger: LedgerAdapter;
}

const STATUS_TO_TIER: Record<string, string> = {
  trialing: "pro_trial",
  active: "pro_active",
  past_due: "pro_active",
  unpaid: "pro_canceled",
  canceled: "pro_canceled",
  incomplete: "free",
  incomplete_expired: "free",
};

export function entitlementSync(deps: Deps) {
  async function applyFromSubscription(sub: any) {
    const company =
      (await deps.companies.findByStripeSubscriptionId(sub.id)) ??
      (await deps.companies.findByStripeCustomerId(sub.customer));
    if (!company) throw new Error(`No company for subscription ${sub.id}`);
    const planTier = STATUS_TO_TIER[sub.status] ?? "free";
    const planSeatsPaid = sub.items?.data?.[0]?.quantity ?? 0;
    const planPeriodEnd = new Date((sub.current_period_end ?? 0) * 1000);
    await deps.companies.update(company.id, {
      planTier,
      planSeatsPaid,
      planPeriodEnd,
      stripeSubscriptionId: sub.id,
      stripeCustomerId: sub.customer,
    });
  }

  return {
    onSubscriptionCreated: applyFromSubscription,
    onSubscriptionUpdated: applyFromSubscription,
    onSubscriptionDeleted: applyFromSubscription,
    onInvoicePaid: async (_inv: any) => { /* no-op; subscription.updated follows */ },

    dispatch: async (event: any) => {
      const recorded = await deps.ledger.record(event.id, event.type, event);
      if (!recorded.inserted) return; // duplicate — skip processing
      const obj = event.data?.object;
      switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
          if (obj) await applyFromSubscription(obj);
          return;
        case "invoice.paid":
        case "invoice.payment_failed":
        case "customer.subscription.trial_will_end":
        default:
          return;
      }
    },
  };
}
