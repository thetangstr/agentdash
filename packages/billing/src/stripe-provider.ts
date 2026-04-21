import Stripe from "stripe";
import type { BillingLogger, BillingProvider, CancelSubscriptionResult, CheckoutSessionResult } from "./index.js";
import type { StripeBillingConfig } from "./stripe-types.js";
import { priceIdForTier } from "./stripe-types.js";
import type { Tier } from "@agentdash/shared";

const defaultLogger: BillingLogger = {
  info: (message, meta) => {
    if (meta) {
      console.log(`[billing:stripe] ${message}`, meta);
    } else {
      console.log(`[billing:stripe] ${message}`);
    }
  },
};

export class StripeBillingProvider implements BillingProvider {
  private readonly stripe: Stripe;
  private readonly config: StripeBillingConfig;
  private readonly logger: BillingLogger;

  constructor(config: StripeBillingConfig, logger: BillingLogger = defaultLogger) {
    this.config = config;
    this.logger = logger;
    // Pin a recent stable API version
    this.stripe = new Stripe(config.secretKey, { apiVersion: "2025-10-28.basil" as Stripe.LatestApiVersion });
  }

  async createCheckoutSession(input: {
    companyId: string;
    targetTier: Tier;
  }): Promise<CheckoutSessionResult> {
    this.logger.info("createCheckoutSession", { companyId: input.companyId, targetTier: input.targetTier });

    const priceId = priceIdForTier(this.config.priceMap, input.targetTier);
    if (!priceId) {
      throw new Error(`No Stripe price ID mapped for tier: ${input.targetTier}`);
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: input.companyId,
      success_url: this.config.successUrl,
      cancel_url: this.config.cancelUrl,
      ...(input.targetTier === "pro"
        ? { subscription_data: { trial_period_days: 7 } }
        : {}),
    });

    if (!session.url) {
      throw new Error("Stripe checkout session created but returned no URL");
    }

    return { status: "redirect", url: session.url };
  }

  /**
   * The BillingProvider interface's cancelSubscription only takes a companyId,
   * but this provider doesn't have db access to look up the stripeSubscriptionId.
   * Use cancelStripeSubscription(stripeSubscriptionId) for actual cancellation;
   * the billing service in server/ is responsible for looking up the ID and calling that method.
   */
  async cancelSubscription(_input: { companyId: string }): Promise<CancelSubscriptionResult> {
    return {
      status: "stubbed",
      reason: "use cancelStripeSubscription with the stripeSubscriptionId from the billing service",
    };
  }

  async syncEntitlement(_input: { companyId: string; tier: Tier }): Promise<void> {
    // No-op: Stripe webhooks are the source of truth for entitlement sync.
  }

  /**
   * Create a Stripe Customer Portal session so the customer can manage their subscription.
   */
  async createPortalSession(input: {
    stripeCustomerId: string;
    returnUrl?: string;
  }): Promise<{ url: string }> {
    this.logger.info("createPortalSession", { stripeCustomerId: input.stripeCustomerId });

    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.stripeCustomerId,
      return_url: input.returnUrl ?? this.config.portalReturnUrl,
    });

    return { url: session.url };
  }

  /**
   * Cancel a Stripe subscription by its subscription ID.
   * The billing service is responsible for providing this ID from the db.
   */
  async cancelStripeSubscription(stripeSubscriptionId: string): Promise<Stripe.Subscription> {
    this.logger.info("cancelStripeSubscription", { stripeSubscriptionId });
    return this.stripe.subscriptions.cancel(stripeSubscriptionId);
  }

  /**
   * Verify a Stripe webhook signature and return the parsed event.
   * Used by the billing service to verify incoming webhook payloads.
   */
  constructWebhookEvent(rawBody: Buffer, signature: string, secret: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
  }
}
