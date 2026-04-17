// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getMock = vi.fn();
vi.mock("../api/entitlements", () => ({
  entitlementsApi: {
    get: (companyId: string) => getMock(companyId),
  },
}));

const useCompanyMock = vi.fn();
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => useCompanyMock(),
}));

import { useEntitlements } from "./useEntitlements";
import { queryKeys } from "../lib/queryKeys";

function Probe() {
  const { tier, hasFeature, isAtLeast } = useEntitlements();
  return (
    <div>
      <span data-testid="tier">{tier}</span>
      <span data-testid="hubspot">{String(hasFeature("hubspotSync"))}</span>
      <span data-testid="priority">{String(hasFeature("prioritySupport"))}</span>
      <span data-testid="at-least-pro">{String(isAtLeast("pro"))}</span>
      <span data-testid="at-least-enterprise">
        {String(isAtLeast("enterprise"))}
      </span>
    </div>
  );
}

function renderWith(qc: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
}

describe("useEntitlements", () => {
  beforeEach(() => {
    getMock.mockReset();
    useCompanyMock.mockReset();
  });

  it("returns free-tier fallback while no company is selected", () => {
    useCompanyMock.mockReturnValue({ selectedCompanyId: null });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const html = renderWith(qc);
    expect(html).toContain(`data-testid="tier">free<`);
    expect(html).toContain(`data-testid="hubspot">false<`);
    expect(html).toContain(`data-testid="at-least-pro">false<`);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("reads preloaded pro-tier entitlements from the query cache", () => {
    useCompanyMock.mockReturnValue({ selectedCompanyId: "company-1" });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    qc.setQueryData(queryKeys.entitlements.detail("company-1"), {
      tier: "pro",
      limits: { agents: 25, monthlyActions: 50_000, pipelines: 10 },
      features: {
        hubspotSync: true,
        autoResearch: true,
        assessMode: true,
        prioritySupport: false,
      },
    });
    const html = renderWith(qc);
    expect(html).toContain(`data-testid="tier">pro<`);
    expect(html).toContain(`data-testid="hubspot">true<`);
    expect(html).toContain(`data-testid="priority">false<`);
    expect(html).toContain(`data-testid="at-least-pro">true<`);
    expect(html).toContain(`data-testid="at-least-enterprise">false<`);
  });

  it("exposes enterprise as >= pro", () => {
    useCompanyMock.mockReturnValue({ selectedCompanyId: "company-1" });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    qc.setQueryData(queryKeys.entitlements.detail("company-1"), {
      tier: "enterprise",
      limits: { agents: 1000, monthlyActions: 5_000_000, pipelines: 1000 },
      features: {
        hubspotSync: true,
        autoResearch: true,
        assessMode: true,
        prioritySupport: true,
      },
    });
    const html = renderWith(qc);
    expect(html).toContain(`data-testid="tier">enterprise<`);
    expect(html).toContain(`data-testid="at-least-pro">true<`);
    expect(html).toContain(`data-testid="at-least-enterprise">true<`);
  });
});
