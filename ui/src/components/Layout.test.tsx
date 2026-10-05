// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "./Layout";

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
let currentPathname = "/PAP/dashboard";

vi.mock("@/lib/router", () => ({
  Outlet: () => <div>Outlet content</div>,
  useLocation: () => ({ pathname: currentPathname, search: "", hash: "", state: null }),
  useNavigate: () => mockNavigate,
  useNavigationType: () => "PUSH",
  useParams: () => ({ companyPrefix: "PAP" }),
}));

vi.mock("./CompanyRail", () => ({
  CompanyRail: () => <div>Company rail</div>,
}));

vi.mock("./Sidebar", () => ({
  Sidebar: () => <div>Main company nav</div>,
}));

vi.mock("./SettingsSidebar", () => ({
  SettingsSidebar: () => <div>Settings sidebar</div>,
}));

vi.mock("./BreadcrumbBar", () => ({
  BreadcrumbBar: () => <div>Breadcrumbs</div>,
}));

vi.mock("./PropertiesPanel", () => ({
  PropertiesPanel: () => null,
}));

vi.mock("./CommandPalette", () => ({
  CommandPalette: () => null,
}));

vi.mock("./NewIssueDialog", () => ({
  NewIssueDialog: () => null,
}));

vi.mock("./NewProjectDialog", () => ({
  NewProjectDialog: () => null,
}));

vi.mock("./NewGoalDialog", () => ({
  NewGoalDialog: () => null,
}));

vi.mock("./NewAgentDialog", () => ({
  NewAgentDialog: () => null,
}));

// Closes #286 unhandled-errors: TrialBanner + UpgradePromptModal call
// billingApi.status / register cap-exceeded listeners at mount. In jsdom
// `fetch` with a relative path throws "Failed to parse URL", surfacing as
// an unhandled error after the test finishes. Mock both out — Layout
// tests only care about Layout structure, not these notification surfaces.
vi.mock("./TrialBanner", () => ({
  TrialBanner: () => null,
}));

vi.mock("./UpgradePromptModal", () => ({
  UpgradePromptModal: () => null,
}));

vi.mock("./KeyboardShortcutsCheatsheet", () => ({
  KeyboardShortcutsCheatsheet: () => null,
}));

vi.mock("./ToastViewport", () => ({
  ToastViewport: () => null,
}));

vi.mock("./MobileBottomNav", () => ({
  MobileBottomNav: () => null,
}));

vi.mock("./WorktreeBanner", () => ({
  WorktreeBanner: () => null,
}));

vi.mock("./DevRestartBanner", () => ({
  DevRestartBanner: () => null,
}));

vi.mock("./SidebarAccountMenu", () => ({
  SidebarAccountMenu: () => <div>Account menu</div>,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
    openOnboarding: vi.fn(),
  }),
  useDialogActions: () => ({
    openNewIssue: vi.fn(),
    openOnboarding: vi.fn(),
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    togglePanelVisible: vi.fn(),
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", issuePrefix: "PAP", name: "Paperclip" }],
    loading: false,
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
    selectedCompanyId: "company-1",
    selectionSource: "manual",
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

const sidebarState = vi.hoisted(() => ({ isMobile: false }));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    sidebarOpen: !sidebarState.isMobile,
    setSidebarOpen: mockSetSidebarOpen,
    toggleSidebar: vi.fn(),
    isMobile: sidebarState.isMobile,
  }),
}));

vi.mock("./ConnectionStatus", () => ({
  ConnectionStatus: () => <div data-testid="connection-status-stub">Connected</div>,
}));

vi.mock("./ReportIssueButton", () => ({
  ReportIssueButton: () => <button type="button">Report</button>,
}));

vi.mock("../hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: () => undefined,
}));

vi.mock("../hooks/useCompanyPageMemory", () => ({
  useCompanyPageMemory: () => undefined,
}));

vi.mock("../api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../lib/company-selection", () => ({
  shouldSyncCompanySelectionFromRoute: () => false,
}));

vi.mock("../lib/instance-settings", () => ({
  DEFAULT_INSTANCE_SETTINGS_PATH: "/instance/settings/general",
  normalizeRememberedInstanceSettingsPath: (value: string | null | undefined) =>
    value ?? "/instance/settings/general",
}));

vi.mock("../lib/main-content-focus", () => ({
  scheduleMainContentFocus: () => () => undefined,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Layout", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentPathname = "/PAP/dashboard";
    sidebarState.isMobile = false;
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      version: "1.2.3",
    });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      keyboardShortcuts: false,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("does not render the deployment explainer in the shared layout", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(mockHealthApi.get).toHaveBeenCalled();
    expect(container.textContent).toContain("Breadcrumbs");
    expect(container.textContent).toContain("Outlet content");
    expect(container.textContent).not.toContain("Authenticated private");
    expect(container.textContent).not.toContain(
      "Sign-in is required and this instance is intended for private-network access.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  // AgentDash: sidebar IA — one Settings navigation for company settings,
  // instance settings and the configuration pages that keep their own URLs.
  it.each([
    "/PAP/company/settings/access",
    "/instance/settings/general",
    "/PAP/skills",
    "/PAP/billing",
    "/PAP/evaluation",
    "/PAP/company/import",
    "/PAP/company/export",
    "/instance/settings/adapters",
  ])("renders the one settings sidebar on %s", async (pathname) => {
    currentPathname = pathname;
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Settings sidebar");
    expect(container.textContent).not.toContain("Main company nav");

    await act(async () => {
      root.unmount();
    });
  });

  it.each(["/PAP/dashboard", "/PAP/goals", "/PAP/org", "/PAP/guides"])(
    "keeps the main sidebar on %s",
    async (pathname) => {
      currentPathname = pathname;
      const root = createRoot(container);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Layout />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();

      expect(container.textContent).toContain("Main company nav");
      expect(container.textContent).not.toContain("Settings sidebar");

      await act(async () => {
        root.unmount();
      });
    },
  );

  // AgentDash: mobile redesign, lane C.
  async function renderLayout() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  it("on phones the status dot and report button sit in the sticky header, not over content", async () => {
    sidebarState.isMobile = true;
    const root = await renderLayout();

    const cluster = container.querySelector("[data-testid='mobile-status-cluster']");
    expect(cluster).not.toBeNull();
    expect(cluster!.textContent).toContain("Connected");
    expect(cluster!.textContent).toContain("Report");
    expect(cluster!.parentElement!.className).toContain("sticky");
    expect(container.querySelector(".fixed.bottom-4.right-4")).toBeNull();

    await act(async () => root.unmount());
  });

  it("on desktop the status cluster stays fixed bottom-right", async () => {
    const root = await renderLayout();
    expect(container.querySelector("[data-testid='mobile-status-cluster']")).toBeNull();
    const fixed = container.querySelector(".fixed.bottom-4.right-4");
    expect(fixed?.textContent).toContain("Connected");
    await act(async () => root.unmount());
  });

  // AgentDash (c4 trust): the floating cluster sits above the scroll area —
  // the last feed row used to hide underneath it on desktop. The clearance
  // must be scoped to md+ too: a bare pb-20 loses to md:p-6 in the generated
  // stylesheet (computed padding stays 24px; e2e asserts the computed value).
  it("reserves clearance under the floating status cluster on desktop", async () => {
    const root = await renderLayout();
    const main = container.querySelector("#main-content");
    expect(main?.className).toContain("md:pb-20");
    await act(async () => root.unmount());
  });

  it("publishes --mobile-bottom-nav-offset: nav height while shown, 0px when hidden on scroll", async () => {
    sidebarState.isMobile = true;
    const html = document.documentElement;
    const root = await renderLayout();

    expect(html.style.getPropertyValue("--mobile-bottom-nav-offset")).toBe(
      "calc(4rem + env(safe-area-inset-bottom, 0px))",
    );
    expect(html.dataset.mobileBottomNav).toBe("visible");

    // Scroll down past the threshold: the nav hides and the offset drops to 0.
    await act(async () => {
      Object.defineProperty(window, "scrollY", { configurable: true, value: 400 });
      window.dispatchEvent(new Event("scroll"));
    });
    expect(html.style.getPropertyValue("--mobile-bottom-nav-offset")).toBe("0px");
    expect(html.dataset.mobileBottomNav).toBe("hidden");

    // Scroll back up: the nav returns.
    await act(async () => {
      Object.defineProperty(window, "scrollY", { configurable: true, value: 100 });
      window.dispatchEvent(new Event("scroll"));
    });
    expect(html.dataset.mobileBottomNav).toBe("visible");

    await act(async () => root.unmount());
    expect(html.style.getPropertyValue("--mobile-bottom-nav-offset")).toBe("");
    expect(html.dataset.mobileBottomNav).toBeUndefined();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("publishes a 0px offset on desktop, where there is no bottom nav", async () => {
    const root = await renderLayout();
    expect(document.documentElement.style.getPropertyValue("--mobile-bottom-nav-offset")).toBe("0px");
    expect(document.documentElement.dataset.mobileBottomNav).toBe("none");
    await act(async () => root.unmount());
  });
});
