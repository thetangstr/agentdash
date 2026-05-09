interface Deps {
  stripe: any;
  companies: { getById: (id: string) => Promise<any> };
  counts: { humans: (companyId: string) => Promise<number> };
}

// AgentDash (#157): pro_past_due is intentionally excluded — seat syncing only
// runs for companies actively on Pro (not past-due).
const PRO_LIVE = new Set(["pro_trial", "pro_active"]);

export function seatQuantitySyncer(deps: Deps) {
  return {
    onMembershipChanged: async (companyId: string) => {
      const company = await deps.companies.getById(companyId);
      if (!company?.stripeSubscriptionId || !PRO_LIVE.has(company.planTier)) return;
      const humans = await deps.counts.humans(companyId);
      await deps.stripe.subscriptions.update(company.stripeSubscriptionId, {
        quantity: humans,
        proration_behavior: "create_prorations",
      });
    },
  };
}
