// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// Radix Dialog uses portals that don't work in plain SSR — stub the
// primitives with inert wrappers so we can assert on the body content.
vi.mock("./ui/dialog", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Conditional = ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div data-testid="dialog">{children}</div> : null);
  return {
    Dialog: Conditional,
    DialogContent: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    DialogFooter: Passthrough,
  };
});

vi.mock("./ui/button", () => ({
  Button: ({
    children,
    asChild: _asChild,
    ...rest
  }: {
    children: ReactNode;
    asChild?: boolean;
    [key: string]: unknown;
  }) => <button {...rest}>{children}</button>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-test" }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../api/billing", () => ({
  billingApi: {
    createCheckoutSession: vi.fn(),
  },
}));

import { UpgradeDialog } from "./UpgradeDialog";

describe("UpgradeDialog", () => {
  it("renders nothing when closed", () => {
    const html = renderToStaticMarkup(
      <UpgradeDialog
        open={false}
        onOpenChange={() => {}}
        currentTier="free"
        requiredTier="pro"
      />,
    );
    expect(html).toBe("");
  });

  it("surfaces pro-only features when upgrading from free", () => {
    const html = renderToStaticMarkup(
      <UpgradeDialog
        open={true}
        onOpenChange={() => {}}
        currentTier="free"
        requiredTier="pro"
        featureName="HubSpot sync"
      />,
    );
    expect(html).toContain("Upgrade to Pro");
    expect(html).toContain("HubSpot sync requires the Pro plan");
    expect(html).toContain("HubSpot bi-directional sync");
    expect(html).toContain("AutoResearch agents");
    expect(html).not.toContain("Priority support");
  });

  it("surfaces enterprise-only features when upgrading from pro", () => {
    const html = renderToStaticMarkup(
      <UpgradeDialog
        open={true}
        onOpenChange={() => {}}
        currentTier="pro"
        requiredTier="enterprise"
      />,
    );
    expect(html).toContain("Upgrade to Enterprise");
    expect(html).toContain("Priority support");
  });

  it("shows self-serve checkout CTA for pro tier", () => {
    const html = renderToStaticMarkup(
      <UpgradeDialog
        open={true}
        onOpenChange={() => {}}
        currentTier="free"
        requiredTier="pro"
      />,
    );
    expect(html).toContain("Upgrade to Pro");
    expect(html).not.toContain("Contact sales");
  });

  it("shows Contact sales CTA for enterprise tier", () => {
    const html = renderToStaticMarkup(
      <UpgradeDialog
        open={true}
        onOpenChange={() => {}}
        currentTier="pro"
        requiredTier="enterprise"
      />,
    );
    expect(html).toContain("Contact sales");
    expect(html).toContain("mailto:sales@agentdash.com");
  });
});
