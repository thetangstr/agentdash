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
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(async () => ({})),
  updateExperimental: vi.fn(async () => ({})),
  previewIssueGraphLivenessAutoRecovery: vi.fn(),
  runIssueGraphLivenessAutoRecovery: vi.fn(async () => ({})),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../hooks/useCapability", () => ({
  useCapabilities: () => ({ data: { isInstanceAdmin: mockCapabilitiesState.isInstanceAdmin } }),
}));

vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));

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

describe("InstanceExperimentalSettings saves explicitly", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.clearAllMocks();
    mockCapabilitiesState.isInstanceAdmin = true;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    mockInstanceSettingsApi.updateExperimental.mockResolvedValue({});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
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
    await flush();
  }

  const byTestId = <T extends Element = HTMLElement>(id: string) => document.body.querySelector<T>(`[data-testid="${id}"]`);
  const byLabel = <T extends Element = HTMLButtonElement>(label: string) => document.body.querySelector<T>(`[aria-label="${label}"]`)!;
  const buttonByText = (text: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!;

  async function click(el: Element) {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  async function type(el: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("flipping a switch sends nothing; Save sends only that field", async () => {
    await renderPage();
    expect(byTestId<HTMLButtonElement>("instance-experimental-environments-save")!.disabled).toBe(true);
    await click(byLabel("Toggle environments experimental setting"));
    await click(byLabel("Toggle guarded dev-server auto-restart"));
    expect(mockInstanceSettingsApi.updateExperimental).not.toHaveBeenCalled();
    expect(byTestId("instance-experimental-environments-state")!.textContent).toBe("Unsaved changes");
    await click(byTestId("instance-experimental-environments-save")!);
    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledTimes(1);
    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({ enableEnvironments: true });
    // The dev-server section still holds its own unsaved draft.
    expect(byTestId("instance-experimental-dev-server-state")!.textContent).toBe("Unsaved changes");
  });

  it("Discard resets a section and a failed save keeps the draft", async () => {
    mockInstanceSettingsApi.updateExperimental.mockRejectedValueOnce(new Error("Instance admin required"));
    await renderPage();
    const toggle = byLabel("Toggle isolated workspaces experimental setting");
    await click(toggle);
    await click(byTestId("instance-experimental-workspaces-save")!);
    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({ enableIsolatedWorkspaces: true });
    expect(byTestId("instance-experimental-workspaces-error")!.textContent).toBe("Instance admin required");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await click(byTestId("instance-experimental-workspaces-discard")!);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(byTestId("instance-experimental-workspaces-error")).toBeNull();
  });

  it("turning auto-recovery on previews first; the dialog's button is what saves it", async () => {
    mockInstanceSettingsApi.previewIssueGraphLivenessAutoRecovery.mockResolvedValue({
      lookbackHours: 24,
      recoverableFindings: 0,
      skippedOutsideLookback: 0,
      items: [],
    });
    await renderPage();
    await click(byLabel("Toggle issue graph liveness auto-recovery"));
    expect(mockInstanceSettingsApi.previewIssueGraphLivenessAutoRecovery).not.toHaveBeenCalled();
    await click(byTestId("instance-experimental-recovery-save")!);
    expect(mockInstanceSettingsApi.previewIssueGraphLivenessAutoRecovery).toHaveBeenCalledWith({ lookbackHours: 24 });
    expect(mockInstanceSettingsApi.updateExperimental).not.toHaveBeenCalled();
    await click(buttonByText("Enable only"));
    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledTimes(1);
    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({ enableIssueGraphLivenessAutoRecovery: true });
  });

  it("Run now uses the saved lookback hours, not unsaved ones", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
    await renderPage();
    await type(byLabel<HTMLInputElement>("Lookback hours"), "48");
    await click(buttonByText("Run now"));
    expect(mockInstanceSettingsApi.runIssueGraphLivenessAutoRecovery).toHaveBeenCalledWith({ lookbackHours: 24 });
  });

  it("turning auto-recovery on and off again, then Preview and Enable only, leaves no stale draft", async () => {
    mockInstanceSettingsApi.previewIssueGraphLivenessAutoRecovery.mockResolvedValue({
      lookbackHours: 24,
      recoverableFindings: 0,
      skippedOutsideLookback: 0,
      items: [],
    });
    const enabled = { enableIssueGraphLivenessAutoRecovery: true, issueGraphLivenessAutoRecoveryLookbackHours: 24 };
    mockInstanceSettingsApi.updateExperimental.mockImplementation(async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue(enabled);
      return enabled;
    });
    await renderPage();
    const toggle = byLabel("Toggle issue graph liveness auto-recovery");
    await click(toggle);
    await click(toggle);
    await click(buttonByText("Preview"));
    await click(buttonByText("Enable only"));
    await flush();
    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({ enableIssueGraphLivenessAutoRecovery: true });
    expect(byLabel("Toggle issue graph liveness auto-recovery").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("instance-experimental-recovery-state")!.textContent).not.toBe("Unsaved changes");
    expect(byTestId<HTMLButtonElement>("instance-experimental-recovery-save")!.disabled).toBe(true);
  });

  it("turning auto-recovery off and changing the hours save together without a preview", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
    await renderPage();
    const hours = byLabel<HTMLInputElement>("Lookback hours");
    await type(hours, "0");
    expect(byTestId<HTMLButtonElement>("instance-experimental-recovery-save")!.disabled).toBe(true);
    await type(hours, "48");
    await click(byLabel("Toggle issue graph liveness auto-recovery"));
    expect(mockInstanceSettingsApi.updateExperimental).not.toHaveBeenCalled();
    await click(byTestId("instance-experimental-recovery-save")!);
    expect(mockInstanceSettingsApi.previewIssueGraphLivenessAutoRecovery).not.toHaveBeenCalled();
    expect(mockInstanceSettingsApi.updateExperimental).toHaveBeenCalledWith({
      enableIssueGraphLivenessAutoRecovery: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
    });
  });
});
