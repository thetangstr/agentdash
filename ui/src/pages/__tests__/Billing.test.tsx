// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import {
  entitlementsForTier,
  type Entitlements,
  type Tier,
} from "@agentdash/shared";

const entitlementsState: { tier: Tier; entitlements: Entitlements } = {
  tier: "free",
  entitlements: entitlementsForTier("free"),
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

import { Billing } from "../Billing";

describe("Billing", () => {
  it("renders free tier with upgrade CTA pointing at pro", () => {
    entitlementsState.tier = "free";
    entitlementsState.entitlements = entitlementsForTier("free");
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
    entitlementsState.tier = "pro";
    entitlementsState.entitlements = entitlementsForTier("pro");
    const html = renderToStaticMarkup(<Billing />);
    expect(html).toContain(`data-tier="pro"`);
    expect(html).toContain("Upgrade to Enterprise");
  });

  it("does not render an upgrade CTA on enterprise", () => {
    entitlementsState.tier = "enterprise";
    entitlementsState.entitlements = entitlementsForTier("enterprise");
    const html = renderToStaticMarkup(<Billing />);
    expect(html).toContain(`data-tier="enterprise"`);
    expect(html).not.toContain("Upgrade to");
  });

  it("surfaces the current limits from entitlements", () => {
    entitlementsState.tier = "pro";
    entitlementsState.entitlements = entitlementsForTier("pro");
    const html = renderToStaticMarkup(<Billing />);
    const pro = entitlementsForTier("pro");
    expect(html).toContain(pro.limits.agents.toLocaleString());
    expect(html).toContain(pro.limits.monthlyActions.toLocaleString());
    expect(html).toContain(pro.limits.pipelines.toLocaleString());
  });
});
