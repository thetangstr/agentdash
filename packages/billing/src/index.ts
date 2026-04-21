import type { Tier } from "@agentdash/shared";
import { StripeBillingProvider } from "./stripe-provider.js";
import type { StripePriceMap } from "./stripe-types.js";

export { StripeBillingProvider } from "./stripe-provider.js";
export type { StripeBillingConfig, StripePriceMap } from "./stripe-types.js";
export { priceIdForTier, tierForPriceId } from "./stripe-types.js";

export type CheckoutSessionResult =
  | { status: "redirect"; url: string }
  | { status: "stubbed"; reason: string };

export type CancelSubscriptionResult =
  | { status: "cancelled" }
  | { status: "stubbed"; reason: string };

export interface BillingProvider {
  createCheckoutSession(input: {
    companyId: string;
    targetTier: Tier;
  }): Promise<CheckoutSessionResult>;
  cancelSubscription(input: {
    companyId: string;
  }): Promise<CancelSubscriptionResult>;
  syncEntitlement(input: { companyId: string; tier: Tier }): Promise<void>;
}

export interface BillingLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
}

const defaultLogger: BillingLogger = {
  info: (message, meta) => {
    if (meta) {
      console.log(`[billing:stub] ${message}`, meta);
    } else {
      console.log(`[billing:stub] ${message}`);
    }
  },
};

export class StubBillingProvider implements BillingProvider {
  private readonly logger: BillingLogger;

  constructor(logger: BillingLogger = defaultLogger) {
    this.logger = logger;
  }

  async createCheckoutSession(input: {
    companyId: string;
    targetTier: Tier;
  }): Promise<CheckoutSessionResult> {
    this.logger.info("createCheckoutSession", input);
    return { status: "stubbed", reason: "billing provider not configured" };
  }

  async cancelSubscription(input: {
    companyId: string;
  }): Promise<CancelSubscriptionResult> {
    this.logger.info("cancelSubscription", input);
    return { status: "stubbed", reason: "billing provider not configured" };
  }

  async syncEntitlement(input: { companyId: string; tier: Tier }): Promise<void> {
    this.logger.info("syncEntitlement", input);
  }
}

export interface CreateBillingProviderOptions {
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePriceMap?: string; // JSON string from env
  successUrl?: string;
  cancelUrl?: string;
  portalReturnUrl?: string;
  logger?: BillingLogger;
}

export function createBillingProvider(opts: CreateBillingProviderOptions = {}): BillingProvider {
  const key = opts.stripeSecretKey ?? process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return new StubBillingProvider(opts.logger);
  }
  let priceMap: StripePriceMap = {};
  const raw = opts.stripePriceMap ?? process.env.STRIPE_PRICE_MAP;
  if (raw) {
    try { priceMap = JSON.parse(raw); } catch { priceMap = {}; }
  }
  return new StripeBillingProvider(
    {
      secretKey: key,
      webhookSecret: opts.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET,
      priceMap,
      successUrl: opts.successUrl ?? process.env.STRIPE_CHECKOUT_SUCCESS_URL ?? "http://localhost:3100/billing?checkout=success",
      cancelUrl: opts.cancelUrl ?? process.env.STRIPE_CHECKOUT_CANCEL_URL ?? "http://localhost:3100/billing?checkout=cancel",
      portalReturnUrl: opts.portalReturnUrl ?? process.env.STRIPE_PORTAL_RETURN_URL ?? "http://localhost:3100/billing",
    },
    opts.logger,
  );
}
