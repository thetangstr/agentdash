// @vitest-environment jsdom
// AgentDash (c3-a11y review): the dev-server section names a real local
// command, so it renders only for instance admins — everyone else never sees
// the blurb (or the command).

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceExperimentalSettings } from "./InstanceExperimentalSettings";

const mockCapabilitiesState = vi.hoisted(() => ({ isInstanceAdmin: false }));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../hooks/useCapability", () => ({
  useCapabilities: () => ({ data: { isInstanceAdmin: mockCapabilitiesState.isInstanceAdmin } }),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getExperimental: vi.fn(async () => ({})),
    updateExperimental: vi.fn(async () => ({})),
    previewIssueGraphLivenessAutoRecovery: vi.fn(),
    runIssueGraphLivenessAutoRecovery: vi.fn(async () => ({})),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("InstanceExperimentalSettings dev-server section", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
  });

  async function renderPage() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <InstanceExperimentalSettings />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("shows the dev-command section only to an instance admin", async () => {
    mockCapabilitiesState.isInstanceAdmin = true;
    await renderPage();
    expect(container.textContent).toContain("Auto-Restart Dev Server When Idle");
    expect(container.textContent).toContain("pnpm dev:once");
  });

  it("hides the dev-command blurb entirely for everyone else", async () => {
    mockCapabilitiesState.isInstanceAdmin = false;
    await renderPage();
    expect(container.textContent).not.toContain("Auto-Restart Dev Server");
    expect(container.textContent).not.toContain("pnpm dev:once");
    expect(container.textContent).not.toContain("dev:once");
  });
});
