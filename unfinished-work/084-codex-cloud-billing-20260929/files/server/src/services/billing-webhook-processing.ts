// AgentDash (SC-8): ledger claim and entitlement update commit together.
// Original signed events remain the audit; subscription entitlements use current Stripe state.
import { companies, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { companyService } from "./companies.js";
import { entitlementSync } from "./entitlement-sync.js";
import { stripeWebhookLedger } from "./stripe-webhook-ledger.js";

export function billingWebhookProcessing(db: Db, opts: {
  stripe: any;
  boxSlug?: string;
  onTierDowngrade?: (input: { companyId: string; from: string; to: string }) => Promise<void>;
  onTrialWillEnd?: (input: { companyId: string; trialEndAt: Date | null }) => Promise<void>;
}) {
  return {
    async dispatch(event: any) {
      const deferred: Array<() => Promise<void>> = [];
      await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        // Stripe retries instead of occupying the box's pool behind a stalled delivery.
        await tx.execute(sql`set local lock_timeout = '2000ms'`);
        const service = companyService(tx);
        const sync = entitlementSync({
          companies: {
            findByStripeSubscriptionId: (id) => service.findByStripeSubscriptionId(id),
            findByStripeCustomerId: (id) => service.findByStripeCustomerId(id),
            getById: async (id) => { const row = await service.getById(id); return row ? { id: row.id, planTier: row.planTier ?? "free" } : null; },
            update: async (id, patch) => { const row = await service.update(id, patch); if (!row) throw new Error("Stripe entitlement company disappeared"); return row; },
          },
          ledger: stripeWebhookLedger(tx),
          retrieveSubscription: async (id) => {
            const raw = event.data?.object;
            const customer = typeof raw?.customer === "string" ? raw.customer : raw?.customer?.id;
            const company = (await service.findByStripeSubscriptionId(id)) ?? (customer ? await service.findByStripeCustomerId(customer) : null);
            if (!company) throw new Error("Stripe subscription has no local company");
            // Serialize provider reads and writes for different event IDs too:
            // a slower old read cannot overwrite a newer cancellation.
            const [locked] = await tx.select().from(companies).where(eq(companies.id, company.id)).for("update");
            if (!locked || !locked.stripeCustomerId || locked.stripeCustomerId !== customer) throw new Error("Stripe local customer routing mismatch");
            if (!opts.stripe.subscriptions?.retrieve) throw new Error("Stripe subscription retrieval unavailable");
            let current;
            try { current = await opts.stripe.subscriptions.retrieve(id, { timeout: 5_000, maxNetworkRetries: 0 }); }
            catch { throw new Error("Stripe subscription retrieval failed"); }
            const currentCustomer = typeof current?.customer === "string" ? current.customer : current?.customer?.id;
            if (current?.id !== id || currentCustomer !== locked.stripeCustomerId || current.metadata?.companyId !== locked.id
              || (opts.boxSlug && current.metadata?.box_slug !== opts.boxSlug)) throw new Error("Stripe current subscription routing mismatch");
            return current;
          },
          onTierDowngrade: opts.onTierDowngrade ? async (input) => { deferred.push(() => opts.onTierDowngrade!(input)); } : undefined,
          onTrialWillEnd: opts.onTrialWillEnd ? async (input) => { deferred.push(() => opts.onTrialWillEnd!(input)); } : undefined,
        });
        await sync.dispatch(event);
      });
      // No chat/email escapes a transaction that later rolls back. Existing
      // notifier best-effort semantics remain independent of entitlement success.
      for (const notify of deferred) { try { await notify(); } catch { /* best effort */ } }
    },
  };
}
