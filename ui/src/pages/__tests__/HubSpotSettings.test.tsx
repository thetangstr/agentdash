// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HubspotConfig,
  HubspotSaveConfig,
  HubspotSyncStatus,
  HubspotSyncSummary,
  HubspotTestResult,
} from "../../api/crm";

const hubspotConfigMock = vi.fn<(companyId: string) => Promise<HubspotConfig>>();
const saveHubspotConfigMock = vi.fn<
  (companyId: string, body: HubspotSaveConfig) => Promise<{ success: boolean }>
>();
const disconnectHubspotMock = vi.fn<(companyId: string) => Promise<{ success: boolean }>>();
const testHubspotConnectionMock = vi.fn<(companyId: string) => Promise<HubspotTestResult>>();
const hubspotSyncStatusMock = vi.fn<(companyId: string) => Promise<HubspotSyncStatus>>();
const syncHubspotMock = vi.fn<(companyId: string) => Promise<HubspotSyncSummary>>();

const setBreadcrumbsMock = vi.fn();
const pushToastMock = vi.fn();

vi.mock("../../api/crm", () => ({
  crmApi: {
    hubspotConfig: (companyId: string) => hubspotConfigMock(companyId),
    saveHubspotConfig: (companyId: string, body: HubspotSaveConfig) =>
      saveHubspotConfigMock(companyId, body),
    disconnectHubspot: (companyId: string) => disconnectHubspotMock(companyId),
    testHubspotConnection: (companyId: string) => testHubspotConnectionMock(companyId),
    hubspotSyncStatus: (companyId: string) => hubspotSyncStatusMock(companyId),
    syncHubspot: (companyId: string) => syncHubspotMock(companyId),
  },
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("../../hooks/useEntitlements", () => ({
  useEntitlements: () => ({
    entitlements: {
      tier: "pro",
      limits: { agents: 25, monthlyActions: 50_000, pipelines: 10 },
      features: {
        hubspotSync: true,
        autoResearch: true,
        assessMode: true,
        prioritySupport: false,
      },
    },
    tier: "pro",
    isLoading: false,
    hasFeature: (feature: string) => feature !== "prioritySupport",
    isAtLeast: () => true,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function renderPage(container: HTMLDivElement, Component: () => ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Component />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("HubSpotSettings page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    hubspotConfigMock.mockReset();
    saveHubspotConfigMock.mockReset();
    disconnectHubspotMock.mockReset();
    testHubspotConnectionMock.mockReset();
    hubspotSyncStatusMock.mockReset();
    syncHubspotMock.mockReset();
    setBreadcrumbsMock.mockReset();
    pushToastMock.mockReset();

    // Sync status defaults: never called except when connected; safe default
    hubspotSyncStatusMock.mockResolvedValue({
      lastSyncAt: null,
      lastSyncResult: null,
      lastSyncError: null,
      syncInProgress: false,
    });
    saveHubspotConfigMock.mockResolvedValue({ success: true });
    disconnectHubspotMock.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders disconnected state with token input when no config exists", async () => {
    hubspotConfigMock.mockResolvedValue({ configured: false });

    const { HubSpotSettings } = await import("../HubSpotSettings");
    const root = renderPage(container, HubSpotSettings);
    await act(async () => {
      await flush();
    });

    expect(hubspotConfigMock).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("HubSpot Integration");
    const tokenInput = container.querySelector<HTMLInputElement>(
      'input[data-testid="hubspot-access-token"]',
    );
    expect(tokenInput).toBeTruthy();
    const portalInput = container.querySelector<HTMLInputElement>(
      'input[data-testid="hubspot-portal-id"]',
    );
    expect(portalInput).toBeTruthy();

    act(() => {
      root.unmount();
    });
  });

  it("clicking Save calls saveHubspotConfig with entered values", async () => {
    hubspotConfigMock.mockResolvedValue({ configured: false });

    const { HubSpotSettings } = await import("../HubSpotSettings");
    const root = renderPage(container, HubSpotSettings);
    await act(async () => {
      await flush();
    });

    const tokenInput = container.querySelector<HTMLInputElement>(
      'input[data-testid="hubspot-access-token"]',
    )!;
    const portalInput = container.querySelector<HTMLInputElement>(
      'input[data-testid="hubspot-portal-id"]',
    )!;

    await act(async () => {
      const inputSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      inputSetter.call(tokenInput, "pat-na1-abc123");
      tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
      inputSetter.call(portalInput, "43210987");
      portalInput.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });

    const saveBtn = container.querySelector<HTMLButtonElement>(
      'button[data-testid="hubspot-save"]',
    );
    expect(saveBtn).toBeTruthy();

    await act(async () => {
      saveBtn!.click();
      await flush();
    });

    expect(saveHubspotConfigMock).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        accessToken: "pat-na1-abc123",
        portalId: "43210987",
      }),
    );

    act(() => {
      root.unmount();
    });
  });

  it("renders connected state with Disconnect and Sync buttons when configured", async () => {
    hubspotConfigMock.mockResolvedValue({
      configured: true,
      portalId: "43210987",
      syncEnabled: true,
      accessToken: "****c123",
      hasClientSecret: false,
      syncDirection: "bidirectional",
      fieldMapping: {},
    });
    hubspotSyncStatusMock.mockResolvedValue({
      lastSyncAt: "2026-04-10T12:00:00.000Z",
      lastSyncResult: {
        contacts: { synced: 5, created: 5, updated: 0, errors: 0 },
        companies: { synced: 3, created: 3, updated: 0, errors: 0 },
        deals: { synced: 2, created: 2, updated: 0, errors: 0 },
        activities: { synced: 1, created: 1, updated: 0, errors: 0 },
      },
      lastSyncError: null,
      syncInProgress: false,
    });

    const { HubSpotSettings } = await import("../HubSpotSettings");
    const root = renderPage(container, HubSpotSettings);
    await act(async () => {
      await flush();
    });

    expect(container.textContent).toContain("43210987");
    expect(
      container.querySelector('button[data-testid="hubspot-disconnect"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('button[data-testid="hubspot-sync-now"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('button[data-testid="hubspot-test-connection"]'),
    ).toBeTruthy();

    act(() => {
      root.unmount();
    });
  });
});
