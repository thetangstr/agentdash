// AgentDash: Billing service
// Orchestrates Stripe billing flows: checkout sessions, customer portal sessions,
// and webhook event processing with idempotency via billing_events table.

import { eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { billingEvents, companyPlan } from "@agentdash/db";
import type { BillingProvider } from "@agentdash/billing";
import { StripeBillingProvider, tierForPriceId } from "@agentdash/billing";
import type { StripePriceMap } from "@agentdash/billing";
import type { EntitlementsService } from "./entitlements.js";
import type { Tier } from "@agentdash/shared";
import { logger } from "../middleware/logger.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeEventLike = { id: string; type: string; data: { object: Record<string, any> } };

export interface BillingServiceDeps {
  entitlements: EntitlementsService;
  provider: BillingProvider;
  stripeProvider?: StripeBillingProvider;
  webhookSecret?: string;
  priceMap: StripePriceMap;
  /**
   * Optional override for Stripe signature verification. Injected in tests.
   * Defaults to stripeProvider.constructWebhookEvent when available.
   */
  constructWebhookEvent?: (rawBody: Buffer, signature: string, secret: string) => StripeEventLike;
}

export function billingService(db: Db, deps: BillingServiceDeps) {
  const { entitlements, provider, stripeProvider, webhookSecret, priceMap } = deps;

  async function getStripeCustomerId(companyId: string): Promise<string | null> {
    const rows = await db
      .select({ stripeCustomerId: companyPlan.stripeCustomerId })
      .from(companyPlan)
      .where(eq(companyPlan.companyId, companyId))
      .limit(1);
    return rows[0]?.stripeCustomerId ?? null;
  }

  async function createCheckoutSession(companyId: string, targetTier: Tier): Promise<{ url: string }> {
    const result = await provider.createCheckoutSession({ companyId, targetTier });
    if (result.status === "stubbed") {
      throw new Error(result.reason);
    }
    return { url: result.url };
  }

  async function createPortalSession(companyId: string): Promise<{ url: string }> {
    if (!stripeProvider) {
      throw new Error("Stripe billing provider not configured");
    }
    const stripeCustomerId = await getStripeCustomerId(companyId);
    if (!stripeCustomerId) {
      throw new Error("No Stripe customer found for this company");
    }
    return stripeProvider.createPortalSession({ stripeCustomerId });
  }

  async function handleWebhookEvent(
    rawBody: Buffer,
    signature: string,
  ): Promise<{ received: boolean; skipped?: boolean }> {
    // Parse the event — verify signature if we have a webhook secret.
    // In production, an unset webhook secret is a hard error: an unverified
    // webhook is an unauthenticated state-mutation endpoint that anyone could
    // POST to and flip a company's tier. Dev/test gets the unverified fallback
    // so local Stripe CLI fixtures still work.
    let event: StripeEventLike;
    const isProd = process.env.NODE_ENV === "production";

    if (webhookSecret) {
      // Prefer injected constructWebhookEvent (for testing), then fall back to stripeProvider
      const constructFn = deps.constructWebhookEvent
        ?? (stripeProvider as unknown as { constructWebhookEvent?: (raw: Buffer, sig: string, secret: string) => StripeEventLike } | undefined)?.constructWebhookEvent?.bind(stripeProvider);

      if (constructFn) {
        try {
          event = constructFn(rawBody, signature, webhookSecret);
        } catch (err) {
          throw new Error(`Stripe webhook signature verification failed: ${(err as Error).message}`);
        }
      } else if (isProd) {
        throw new Error("[billing] webhookSecret set but no Stripe provider available; refusing unverified webhook in production");
      } else {
        // No Stripe provider but secret is set — log and fall through to JSON parse
        logger.warn("[billing] webhookSecret set but no Stripe provider available; skipping signature verification (non-prod)");
        try {
          event = JSON.parse(rawBody.toString()) as StripeEventLike;
        } catch {
          throw new Error("Invalid webhook payload: cannot parse JSON");
        }
      }
    } else if (isProd) {
      throw new Error("[billing] STRIPE_WEBHOOK_SECRET is required in production; refusing unverified webhook");
    } else {
      logger.warn("[billing] STRIPE_WEBHOOK_SECRET not set — skipping signature verification (dev mode)");
      try {
        event = JSON.parse(rawBody.toString()) as StripeEventLike;
      } catch {
        throw new Error("Invalid webhook payload: cannot parse JSON");
      }
    }

    const stripeEventId = event.id;
    const stripeEventType = event.type;

    // Idempotency gate: insert the billing_events row first and use the unique
    // index on stripe_event_id as the race-safe arbiter. If the row already
    // exists, ON CONFLICT DO NOTHING returns no rows and we skip processing.
    // This is safe under concurrent webhook delivery, which Stripe explicitly
    // does. If processing fails, we update the row's `error` column rather
    // than letting Stripe retry against a missing record.
    const inserted = await db
      .insert(billingEvents)
      .values({
        companyId: null,
        stripeEventId,
        stripeEventType,
        payload: event as unknown as Record<string, unknown>,
        error: null,
      })
      .onConflictDoNothing({ target: billingEvents.stripeEventId })
      .returning({ id: billingEvents.id });

    if (inserted.length === 0) {
      return { received: true, skipped: true };
    }
    const recordId = inserted[0].id;

    let processingError: string | null = null;
    let resolvedCompanyId: string | null = null;
    try {
      resolvedCompanyId = await resolveCompanyId(event);
      await routeWebhookEvent(event, resolvedCompanyId);
    } catch (err) {
      processingError = err instanceof Error ? err.message : String(err);
      logger.error({ err, stripeEventId, stripeEventType }, "[billing] webhook processing error");
    }

    // Patch the resolved company + any error onto the existing record.
    if (resolvedCompanyId !== null || processingError !== null) {
      await db
        .update(billingEvents)
        .set({ companyId: resolvedCompanyId, error: processingError })
        .where(eq(billingEvents.id, recordId));
    }

    if (processingError) {
      throw new Error(`Webhook processing error: ${processingError}`);
    }

    return { received: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function resolveCompanyId(event: { type: string; data: { object: Record<string, any> } }): Promise<string | null> {
    const obj = event.data.object;

    switch (event.type) {
      case "checkout.session.completed": {
        // client_reference_id is our companyId
        return (obj.client_reference_id as string | null | undefined) ?? null;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        // Look up company by stripeCustomerId
        const customerId = obj.customer as string | undefined;
        if (!customerId) return null;
        return lookupCompanyByStripeCustomer(customerId);
      }
      case "invoice.paid":
      case "invoice.payment_failed": {
        const customerId = obj.customer as string | undefined;
        if (!customerId) return null;
        return lookupCompanyByStripeCustomer(customerId);
      }
      default:
        return null;
    }
  }

  async function lookupCompanyByStripeCustomer(stripeCustomerId: string): Promise<string | null> {
    const rows = await db
      .select({ companyId: companyPlan.companyId })
      .from(companyPlan)
      .where(eq(companyPlan.stripeCustomerId, stripeCustomerId))
      .limit(1);
    return rows[0]?.companyId ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function routeWebhookEvent(event: { type: string; data: { object: Record<string, any> } }, companyId: string | null): Promise<void> {
    const obj = event.data.object;

    switch (event.type) {
      case "checkout.session.completed": {
        // Map companyId → stripeCustomerId
        const clientRef = obj.client_reference_id as string | null | undefined;
        const stripeCustomerId = obj.customer as string | null | undefined;
        if (clientRef && stripeCustomerId) {
          await entitlements.setStripeIds(clientRef, stripeCustomerId, null);
        }
        break;
      }

      case "customer.subscription.created": {
        if (!companyId) break;
        const subscriptionId = obj.id as string | undefined;
        const status = (obj.status as string | undefined) ?? "active";
        const items = (obj.items as { data?: Array<{ price?: { id?: string }; current_period_end?: number }> } | undefined)?.data;
        // As of Stripe API 2025-10-28.basil, `current_period_end` lives on each
        // subscription item, not on the subscription root. Fall back to the root
        // for older fixtures / API versions.
        const periodEndUnix =
          (items?.[0]?.current_period_end as number | undefined)
          ?? (obj.current_period_end as number | undefined);
        const currentPeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;

        // Persist stripe IDs and subscription status
        await entitlements.setStripeIds(companyId, null, subscriptionId ?? null);
        await entitlements.setSubscriptionStatus(companyId, status, currentPeriodEnd);

        // Map price → tier
        const priceId = items?.[0]?.price?.id;
        if (priceId) {
          const tier = tierForPriceId(priceMap, priceId);
          if (tier) {
            await entitlements.setTier(companyId, tier);
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        if (!companyId) break;
        const subscriptionId = obj.id as string | undefined;
        const status = (obj.status as string | undefined) ?? null;
        const items = (obj.items as { data?: Array<{ price?: { id?: string }; current_period_end?: number }> } | undefined)?.data;
        const periodEndUnix =
          (items?.[0]?.current_period_end as number | undefined)
          ?? (obj.current_period_end as number | undefined);
        const currentPeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;

        await entitlements.setStripeIds(companyId, null, subscriptionId ?? null);
        await entitlements.setSubscriptionStatus(companyId, status, currentPeriodEnd);

        // Re-map tier if price changed
        const priceId = items?.[0]?.price?.id;
        if (priceId) {
          const tier = tierForPriceId(priceMap, priceId);
          if (tier) {
            await entitlements.setTier(companyId, tier);
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        if (!companyId) break;
        await entitlements.setSubscriptionStatus(companyId, "canceled", null);
        await entitlements.setTier(companyId, "free");
        break;
      }

      case "invoice.paid": {
        if (!companyId) break;
        // Only update if currently past_due
        const rows = await db
          .select({ subscriptionStatus: companyPlan.subscriptionStatus })
          .from(companyPlan)
          .where(eq(companyPlan.companyId, companyId))
          .limit(1);
        if (rows[0]?.subscriptionStatus === "past_due") {
          await entitlements.setSubscriptionStatus(companyId, "active", null);
        }
        break;
      }

      case "invoice.payment_failed": {
        if (!companyId) break;
        await entitlements.setSubscriptionStatus(companyId, "past_due", null);
        break;
      }

      default:
        logger.info({ type: event.type }, "[billing] unhandled webhook event type");
    }
  }

  return { createCheckoutSession, createPortalSession, handleWebhookEvent };
}

export type BillingService = ReturnType<typeof billingService>;
