interface CompaniesAdapter {
  findByStripeSubscriptionId: (id: string) => Promise<{ id: string; planTier?: string } | null>;
  findByStripeCustomerId: (id: string) => Promise<{ id: string; planTier?: string } | null>;
  // AgentDash (#249): optional read used to detect tier transitions before
  // the update lands, so the notifier below can fire the CoS chat notice
  // only on actual Pro → non-Pro downgrades. When omitted, transition
  // detection is skipped (notifier is never called).
  getById?: (id: string) => Promise<{ id: string; planTier: string } | null>;
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
  // AgentDash (#249): fired AFTER update when the tier transitions from
  // pro_active/pro_trial → pro_canceled/pro_past_due. Best-effort: failures
  // are logged but do not block the entitlement update.
  onTierDowngrade?: (input: {
    companyId: string;
    from: string;
    to: string;
  }) => Promise<void>;
  // AgentDash (#211): fired when Stripe sends customer.subscription.trial_will_end
  // (3 days before trial expiry). Caller fans out in-app notice + email.
  // Best-effort: failures swallowed; the activity-log audit still happens.
  onTrialWillEnd?: (input: {
    companyId: string;
    trialEndAt: Date | null;
  }) => Promise<void>;
}

const PRO_LIVE_TIERS = new Set(["pro_trial", "pro_active"]);
const PRO_DOWNGRADED_TIERS = new Set(["pro_canceled", "pro_past_due"]);

function isProDowngrade(from: string | null | undefined, to: string): boolean {
  if (!from) return false;
  return PRO_LIVE_TIERS.has(from) && PRO_DOWNGRADED_TIERS.has(to);
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

    // AgentDash (#249): read prior tier so we can fire the downgrade
    // notifier if this transition crosses pro-live → downgraded. Only if
    // the caller wired both getById AND onTierDowngrade — otherwise skip
    // transition detection entirely (zero behavior change).
    let priorTier: string | null = null;
    if (deps.companies.getById && deps.onTierDowngrade) {
      try {
        const prior = await deps.companies.getById(company.id);
        priorTier = prior?.planTier ?? null;
      } catch {
        // Best-effort. If the read fails, treat as no prior — which means
        // the notifier will skip-fire (no false downgrade notices).
        priorTier = null;
      }
    }

    await deps.companies.update(company.id, {
      planTier,
      planSeatsPaid,
      planPeriodEnd,
      stripeSubscriptionId: sub.id,
      stripeCustomerId: sub.customer,
    });

    if (deps.onTierDowngrade && isProDowngrade(priorTier, planTier)) {
      try {
        await deps.onTierDowngrade({ companyId: company.id, from: priorTier!, to: planTier });
      } catch {
        // Notifier failures must not interfere with the entitlement update
        // itself. Caller logs as appropriate.
      }
    }
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
    // AgentDash (#169): no longer a no-op. Stripe doesn't guarantee event
    // ordering — for manual invoicing flows, invoice.paid may fire without a
    // follow-up subscription.updated. Refresh local state from the invoice's
    // line-item period info + audit the event. The next subscription.updated
    // (if it arrives) will overwrite — that's the source of truth.
    onInvoicePaid: async (inv: any) => {
      const company = await findCompanyForInvoice(inv ?? {});
      if (!company) return;
      if (deps.activityLog) {
        await deps.activityLog.record(company.id, "stripe.invoice_paid", {
          invoiceId: inv?.id ?? null,
          subscriptionId: inv?.subscription ?? null,
          amountPaid: inv?.amount_paid ?? null,
          periodEnd: inv?.period_end ?? null,
        });
      }
      // Best-effort patch from invoice line-item period (covers the
      // "subscription.updated never fires" failure mode).
      const line = inv?.lines?.data?.[0];
      const periodEndTs = line?.period?.end ?? inv?.period_end ?? null;
      const quantity = line?.quantity ?? null;
      const patch: Record<string, unknown> = {};
      if (typeof periodEndTs === "number" && periodEndTs > 0) {
        patch.planPeriodEnd = new Date(periodEndTs * 1000);
      }
      if (typeof quantity === "number" && quantity >= 0) {
        patch.planSeatsPaid = quantity;
      }
      if (Object.keys(patch).length > 0) {
        await deps.companies.update(company.id, patch);
      }
    },

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

        // AgentDash (#157, #211): customer.subscription.trial_will_end —
        // Stripe sends 3 days before the trial ends. Audit-log the event,
        // then fan out in-app + email notice via the optional onTrialWillEnd
        // notifier. Best-effort: notifier failures swallowed.
        case "customer.subscription.trial_will_end": {
          const company = obj
            ? ((await deps.companies.findByStripeSubscriptionId(obj.id)) ??
               (await deps.companies.findByStripeCustomerId(obj.customer)))
            : null;
          if (!company) return;
          if (deps.activityLog) {
            await deps.activityLog.record(company.id, "stripe.trial_will_end", {
              subscriptionId: obj?.id ?? null,
              trialEnd: obj?.trial_end ?? null,
            });
          }
          if (deps.onTrialWillEnd) {
            const trialEndAt =
              typeof obj?.trial_end === "number" && obj.trial_end > 0
                ? new Date(obj.trial_end * 1000)
                : null;
            try {
              await deps.onTrialWillEnd({ companyId: company.id, trialEndAt });
            } catch {
              // Notifier failures must not 500 the webhook.
            }
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
