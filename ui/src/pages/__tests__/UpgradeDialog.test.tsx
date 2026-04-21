// @vitest-environment node
// AgentDash: UpgradeDialog unit tests
// Renders to static markup (no JSDOM) to avoid Radix UI portal issues.
// Tests: dialog content, feature list, CTA behavior for pro vs enterprise.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Tier } from "@agentdash/shared";

// ---------------------------------------------------------------------------
// Module mocks — use vi.hoisted so factories can reference these before hoisting
// ---------------------------------------------------------------------------

const { mockCreateCheckoutSession, mockPushToast } = vi.hoisted(() => ({
  mockCreateCheckoutSession: vi.fn(),
  mockPushToast: vi.fn(),
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-test-123" }),
}));

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../../api/billing", () => ({
  billingApi: {
    createCheckoutSession: mockCreateCheckoutSession,
    createPortalSession: vi.fn(),
  },
}));

// Stub out Radix UI Dialog so it renders in SSR without portals
vi.mock("../../components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="dialog-root">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  DialogTitle: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <h2 {...rest}>{children}</h2>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p data-testid="dialog-desc">{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
}));

vi.mock("../../components/ui/button", () => ({
  Button: ({
    children,
    asChild,
    ...rest
  }: {
    children: ReactNode;
    asChild?: boolean;
    [key: string]: unknown;
  }) => {
    if (asChild) return <>{children}</>;
    return <button {...rest}>{children}</button>;
  },
}));

import { UpgradeDialog } from "../../components/UpgradeDialog";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDialog(props: {
  open?: boolean;
  currentTier?: Tier;
  requiredTier?: Tier;
  featureName?: string;
}) {
  const {
    open = true,
    currentTier = "free",
    requiredTier = "pro",
    featureName,
  } = props;
  return renderToStaticMarkup(
    <UpgradeDialog
      open={open}
      onOpenChange={vi.fn()}
      currentTier={currentTier}
      requiredTier={requiredTier}
      featureName={featureName}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UpgradeDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when open=false", () => {
    const html = renderDialog({ open: false });
    expect(html).toBe("");
  });

  it("shows the correct tier name in the dialog title for pro", () => {
    const html = renderDialog({ currentTier: "free", requiredTier: "pro" });
    expect(html).toContain("Upgrade to Pro");
  });

  it("shows the correct tier name in the dialog title for enterprise", () => {
    const html = renderDialog({ currentTier: "pro", requiredTier: "enterprise" });
    expect(html).toContain("Upgrade to Enterprise");
  });

  it("shows featureName in the description when provided", () => {
    const html = renderDialog({
      currentTier: "free",
      requiredTier: "pro",
      featureName: "HubSpot Sync",
    });
    expect(html).toContain("HubSpot Sync requires the Pro plan");
  });

  it("shows generic description when featureName is not provided", () => {
    const html = renderDialog({ currentTier: "free", requiredTier: "pro" });
    expect(html).toContain("This capability is part of the Pro plan");
  });

  it("shows current tier in the description", () => {
    const html = renderDialog({ currentTier: "free", requiredTier: "pro" });
    expect(html).toContain("Your workspace is on Free");
  });

  it("lists features gained on upgrade from free to pro", () => {
    const html = renderDialog({ currentTier: "free", requiredTier: "pro" });
    // Pro adds hubspotSync, autoResearch, assessMode over free
    expect(html).toContain("HubSpot bi-directional sync");
    expect(html).toContain("AutoResearch agents");
    expect(html).toContain("Assess mode");
  });

  it("shows limits text for the target tier", () => {
    const html = renderDialog({ currentTier: "free", requiredTier: "pro" });
    // Pro has 25 agents limit
    expect(html).toContain("25");
    expect(html).toContain("agents");
  });

  it("renders upgrade CTA button for pro tier", () => {
    const html = renderDialog({ currentTier: "free", requiredTier: "pro" });
    expect(html).toContain(`data-testid="upgrade-cta"`);
    expect(html).toContain("Upgrade to Pro");
  });

  it("renders Contact sales mailto link for enterprise tier", () => {
    const html = renderDialog({ currentTier: "pro", requiredTier: "enterprise" });
    expect(html).toContain("mailto:sales@agentdash.com");
    expect(html).toContain("Contact sales");
  });

  it("renders dismiss button", () => {
    const html = renderDialog({ currentTier: "free", requiredTier: "pro" });
    expect(html).toContain(`data-testid="upgrade-dismiss"`);
    expect(html).toContain("Not now");
  });

  it("shows 'higher limits and capacity' when no features are gained", () => {
    // enterprise to enterprise would have no gained features — use a scenario where
    // the feature diff is empty. We simulate by setting same tier.
    // This tests the fallback list item.
    const html = renderDialog({ currentTier: "enterprise", requiredTier: "enterprise" });
    // The gainedFeatures list would be empty — fallback renders
    expect(html).toContain("Higher limits and capacity");
  });

  it("includes the upgrade-features testid list", () => {
    const html = renderDialog({ currentTier: "free", requiredTier: "pro" });
    expect(html).toContain(`data-testid="upgrade-features"`);
  });
});
