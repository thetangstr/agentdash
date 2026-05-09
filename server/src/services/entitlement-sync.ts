interface CompaniesAdapter {
  findByStripeSubscriptionId: (id: string) => Promise<{ id: string } | null>;
  findByStripeCustomerId: (id: string) => Promise<{ id: string } | null>;
  update: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
}

interface LedgerAdapter {
  record: (eventId: string, eventType: string, payload: any) => Promise<{ inserted: boolean }>;
}

interface ActivityLogAdapter {
  record: (companyId: string, action: string, details: Record<string, unknown>) => Promise<void>;
}

interface Deps {
  companies: CompaniesAdapter;
  ledger: LedgerAdapter;
  activityLog?: ActivityLogAdapter;
}

// AgentDash (#157): past_due maps to pro_past_due (NOT pro_active).
// Companies with past_due subscriptions should NOT be in PRO_LIVE — the
// security intent is that failed-payment customers lose Pro features until
// they resolve the payment issue. Stripe will emit customer.subscription.updated
// with status "past_due" when payment fails, which flows through this map.
const STATUS_TO_TIER: Record<string, string> = {
  trialing: "pro_trial",
  active: "pro_active",
  past_due: "pro_past_due",
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

  // AgentDash (#157): look up company by invoice customer/subscription.
  // Invoices carry customerId and optionally subscriptionId.
  async function findCompanyForInvoice(inv: any): Promise<{ id: string } | null> {
    if (inv.subscription) {
      const bySubscription = await deps.companies.findByStripeSubscriptionId(inv.subscription);
      if (bySubscription) return bySubscription;
    }
    if (inv.customer) {
      return deps.companies.findByStripeCustomerId(inv.customer);
    }
    return null;
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

        // AgentDash (#157): invoice.payment_failed — write an audit trail.
        // We do NOT mutate planTier here: Stripe will separately emit
        // customer.subscription.updated with status="past_due", which flows
        // through STATUS_TO_TIER and correctly demotes to "pro_past_due".
        case "invoice.payment_failed": {
          const company = await findCompanyForInvoice(obj ?? {});
          if (company && deps.activityLog) {
            await deps.activityLog.record(company.id, "stripe.payment_failed", {
              invoiceId: obj?.id ?? null,
              attemptCount: obj?.attempt_count ?? null,
              nextPaymentAttempt: obj?.next_payment_attempt ?? null,
            });
          }
          return;
        }

        // AgentDash (#157): customer.subscription.trial_will_end — Stripe sends
        // this 3 days before the trial ends. Write an audit trail so the event
        // is observable; notification delivery is a follow-up (see #157).
        case "customer.subscription.trial_will_end": {
          const company = obj
            ? ((await deps.companies.findByStripeSubscriptionId(obj.id)) ??
               (await deps.companies.findByStripeCustomerId(obj.customer)))
            : null;
          if (company && deps.activityLog) {
            await deps.activityLog.record(company.id, "stripe.trial_will_end", {
              subscriptionId: obj?.id ?? null,
              trialEnd: obj?.trial_end ?? null,
            });
          }
          return;
        }

        case "invoice.paid":
        default:
          return;
      }
    },
  };
}
