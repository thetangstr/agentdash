interface Deps {
  companies: { listExpiredTrials: () => Promise<any[]> };
  stripe: any;
  sync: { onSubscriptionUpdated: (sub: any) => Promise<void> };
}

export function billingReconcile(deps: Deps) {
  return {
    run: async () => {
      const expired = await deps.companies.listExpiredTrials();
      for (const c of expired) {
        if (!c.stripeSubscriptionId) continue;
        try {
          const sub = await deps.stripe.subscriptions.retrieve(c.stripeSubscriptionId);
          await deps.sync.onSubscriptionUpdated(sub);
        } catch {
          // Best-effort. Continue with the next company.
        }
      }
    },
  };
}
