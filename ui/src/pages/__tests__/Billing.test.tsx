// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import {
  entitlementsForTier,
  type Entitlements,
  type Tier,
} from "@agentdash/shared";
import type { SubscriptionStatus } from "../../hooks/useEntitlements";

interface EntitlementsState {
  tier: Tier;
  entitlements: Entitlements;
  stripeCustomerId: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  currentPeriodEnd: string | null;
}

const entitlementsState: EntitlementsState = {
  tier: "free",
  entitlements: entitlementsForTier("free"),
  stripeCustomerId: null,
  subscriptionStatus: null,
  currentPeriodEnd: null,
};

vi.mock("../../hooks/useEntitlements", () => ({
  useEntitlements: () => ({
    ...entitlementsState,
    isLoading: false,
    hasFeature: (feature: keyof Entitlements["features"]) =>
      entitlementsState.entitlements.features[feature],
    isAtLeast: () => true,
  }),
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-123" }),
}));

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../../api/billing", () => ({
  billingApi: {
    createPortalSession: vi.fn(),
    createCheckoutSession: vi.fn(),
  },
}));

vi.mock("../../components/ui/button", () => ({
  Button: ({
    children,
    ...rest
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => <button {...rest}>{children}</button>,
}));

vi.mock("../../components/UpgradeDialog", () => ({
  UpgradeDialog: ({
    open,
    requiredTier,
  }: {
    open: boolean;
    requiredTier: Tier;
  }) => (open ? <div data-testid="upgrade-dialog">to {requiredTier}</div> : null),
}));

function resetState() {
  entitlementsState.tier = "free";
  entitlementsState.entitlements = entitlementsForTier("free");
  entitlementsState.stripeCustomerId = null;
  entitlementsState.subscriptionStatus = null;
  entitlementsState.currentPeriodEnd = null;
}

import { Billing } from "../Billing";

describe("Billing", () => {
  it("renders free tier with upgrade CTA pointing at pro", () => {
    resetState();
    const html = renderToStaticMarkup(<Billing />);
    expect(html).toContain(`data-testid="billing-page"`);
    expect(html).toContain(`data-testid="tier-badge"`);
    expect(html).toContain(`data-tier="free"`);
    expect(html).toContain("Upgrade to Pro");
    expect(html).toContain(`data-testid="matrix-hubspotSync-free"`);
    expect(html).toContain(`data-testid="matrix-hubspotSync-pro"`);
    expect(html).toContain(`data-testid="matrix-hubspotSync-enterprise"`);
  });

  it("renders pro tier with upgrade CTA pointing at enterprise", () => {
    resetState();
    entitlementsState.tier = "pro";
    entitlementsState.entitlements = entitlementsForTier("pro");
    const html = renderToStaticMarkup(<Billing />);
    expect(html).toContain(`data-tier="pro"`);
    expect(html).toContain("Upgrade to Enterprise");
  });

  it("does not render an upgrade CTA on enterprise", () => {
    resetState();
    entitlementsState.tier = "enterprise";
    entitlementsState.entitlements = entitlementsForTier("enterprise");
    const html = renderToStaticMarkup(<Billing />);
    expect(html).toContain(`data-tier="enterprise"`);
    expect(html).not.toContain("Upgrade to");
  });

  it("surfaces the current limits from entitlements", () => {
    resetState();
    entitlementsState.tier = "pro";
    entitlementsState.entitlements = entitlementsForTier("pro");
    const html = renderToStaticMarkup(<Billing />);
    const pro = entitlementsForTier("pro");
    expect(html).toContain(pro.limits.agents.toLocaleString());
    expect(html).toContain(pro.limits.monthlyActions.toLocaleString());
    expect(html).toContain(pro.limits.pipelines.toLocaleString());
  });

  it("shows renewal date when subscriptionStatus is active", () => {
    resetState();
    entitlementsState.tier = "pro";
    entitlementsState.entitlements = entitlementsForTier("pro");
    entitlementsState.subscriptionStatus = "active";
    // Use noon UTC so the formatted date lands on Jan 5 across all common timezones
    entitlementsState.currentPeriodEnd = "2026-01-05T12:00:00.000Z";
    const html = renderToStaticMarkup(<Billing />);
    expect(html).toContain(`data-testid="billing-renewal-date"`);
    expect(html).toContain("Renews on");
    expect(html).toContain("Jan 5, 2026");
  });

  it("shows past due warning when subscriptionStatus is past_due", () => {
    resetState();
    entitlementsState.tier = "pro";
    entitlementsState.entitlements = entitlementsForTier("pro");
    entitlementsState.subscriptionStatus = "past_due";
    const html = renderToStaticMarkup(<Billing />);
    expect(html).toContain(`data-testid="billing-past-due-banner"`);
    expect(html).toContain("Payment past due");
  });

  it("shows canceled notice when subscriptionStatus is canceled", () => {
    resetState();
    entitlementsState.tier = "free";
    entitlementsState.entitlements = entitlementsForTier("free");
    entitlementsState.subscriptionStatus = "canceled";
    entitlementsState.currentPeriodEnd = "2026-02-01T12:00:00.000Z";
    const html = renderToStaticMarkup(<Billing />);
    expect(html).toContain(`data-testid="billing-canceled-banner"`);
    expect(html).toContain("Subscription canceled");
    expect(html).toContain("Feb 1, 2026");
  });

  it("shows Manage Subscription button when stripeCustomerId is set", () => {
    resetState();
    entitlementsState.tier = "pro";
    entitlementsState.entitlements = entitlementsForTier("pro");
    entitlementsState.stripeCustomerId = "cus_abc123";
    const html = renderToStaticMarkup(<Billing />);
    expect(html).toContain(`data-testid="billing-manage-subscription"`);
    expect(html).toContain("Manage Subscription");
  });

  it("does not show Manage Subscription button when stripeCustomerId is null", () => {
    resetState();
    entitlementsState.stripeCustomerId = null;
    const html = renderToStaticMarkup(<Billing />);
    expect(html).not.toContain(`data-testid="billing-manage-subscription"`);
  });
});
