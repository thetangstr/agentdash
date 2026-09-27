// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockDashboardApi = vi.hoisted(() => ({
  waitingOnYou: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
  }),
  useDialogActions: () => ({
    openNewIssue: vi.fn(),
  }),
}));

const mockCompany = vi.hoisted(() => ({
  current: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" } as Record<string, unknown>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: mockCompany.current,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/dashboard", () => ({
  dashboardApi: mockDashboardApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

vi.mock("./SidebarCompanyMenu", () => ({
  SidebarCompanyMenu: () => <div>Company menu</div>,
}));

vi.mock("./SidebarProjects", () => ({
  SidebarProjects: () => null,
}));

vi.mock("./SidebarAgents", () => ({
  SidebarAgents: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Sidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockDashboardApi.waitingOnYou.mockResolvedValue({
      decisions: [{ approvalId: "appr-1" }],
      total: 1,
      shown: 1,
      tasksAssignedToYou: [
        { issueId: "i-1", originKind: "manual" },
        { issueId: "i-2", originKind: "routine_execution" },
      ],
      tasksAssignedToYouTotal: 2,
    });
    mockAccessApi.listMembers.mockResolvedValue({ access: { canManageAgents: true } });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("does not flash the Workspaces link while experimental settings are loading", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).not.toContain("Workspaces");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the Workspaces link when isolated workspaces are enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Workspaces");
    expect(link?.getAttribute("href")).toBe("/workspaces");

    await act(async () => {
      root.unmount();
    });
  });

  // AgentDash: UX-2 (#783) — Shipped is a default-profile link; MK keeps its sidebar.
  async function renderSidebar() {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  it("shows the Shipped link on the default profile", async () => {
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    const root = await renderSidebar();
    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Shipped");
    expect(link?.getAttribute("href")).toBe("/shipped");
    // AgentDash: UX-3 (#784) — the dashboard is called Home on the default profile.
    const home = [...container.querySelectorAll("a")].find((anchor) => anchor.getAttribute("href") === "/dashboard");
    expect(home?.textContent).toContain("Home");
    await act(async () => root.unmount());
  });

  it("does not add the Shipped link on the agentdash_mk profile", async () => {
    mockCompany.current = {
      id: "company-1",
      issuePrefix: "PAP",
      name: "Paperclip",
      productProfile: "agentdash_mk",
    };
    const root = await renderSidebar();
    expect([...container.querySelectorAll("a")].some((a) => a.textContent === "Shipped")).toBe(false);
    const dashboard = [...container.querySelectorAll("a")].find((anchor) => anchor.getAttribute("href") === "/dashboard");
    expect(dashboard?.textContent).toContain("Dashboard");
    await act(async () => root.unmount());
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
  });

  // AgentDash: UX-7 (GH #788) — the default profile's Inbox item becomes
  // Decisions; its badge is the page's main-list length (approvals plus
  // manual-origin assigned issues — machine-generated rows don't count).
  it("shows Decisions with the waiting-list length as its badge on the default profile", async () => {
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    const root = await renderSidebar();
    const decisions = [...container.querySelectorAll("a")].find((anchor) => anchor.getAttribute("href") === "/decisions");
    expect(decisions?.textContent).toContain("Decisions");
    // 1 approval + 1 manual task; the routine_execution row is muted.
    expect(decisions?.textContent).toContain("2");
    expect([...container.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/inbox")).toBe(false);
    expect(mockDashboardApi.waitingOnYou).toHaveBeenCalledWith("company-1");
    await act(async () => root.unmount());
  });

  it("keeps the Inbox item and skips the Decisions query on the agentdash_mk profile", async () => {
    mockCompany.current = {
      id: "company-1",
      issuePrefix: "PAP",
      name: "Paperclip",
      productProfile: "agentdash_mk",
    };
    const root = await renderSidebar();
    const inbox = [...container.querySelectorAll("a")].find((anchor) => anchor.getAttribute("href") === "/inbox");
    expect(inbox?.textContent).toContain("Inbox");
    expect([...container.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/decisions")).toBe(false);
    expect(mockDashboardApi.waitingOnYou).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
  });
});
