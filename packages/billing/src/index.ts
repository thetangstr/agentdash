import type { Tier } from "@agentdash/shared";

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
