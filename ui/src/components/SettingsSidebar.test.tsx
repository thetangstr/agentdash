// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSidebar } from "./SettingsSidebar";

const mockSidebarBadgesApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockPluginsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockCapabilitiesApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, onClick }: { children: ReactNode; to: string; onClick?: () => void }) => (
    <a href={to} data-testid="back-link" onClick={onClick}>
      {children}
    </a>
  ),
  NavLink: ({ children, to, className }: {
    children: ReactNode;
    to: string;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className}>
      {children}
    </a>
  ),
}));

const mockCompany = vi.hoisted(() => ({
  current: { id: "company-1", name: "Paperclip" } as Record<string, unknown>,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: mockCompany.current }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("@/api/sidebarBadges", () => ({ sidebarBadgesApi: mockSidebarBadgesApi }));
vi.mock("@/api/plugins", () => ({ pluginsApi: mockPluginsApi }));
vi.mock("../api/capabilities", () => ({ capabilitiesApi: mockCapabilitiesApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SettingsSidebar", () => {
  let container: HTMLDivElement;

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  function group(id: string) {
    return container.querySelector(`[data-testid="settings-nav-${id}"]`);
  }

  function groupLinks(id: string) {
    return [...(group(id)?.querySelectorAll("a") ?? [])].map((a) => ({
      label: a.textContent,
      href: a.getAttribute("href"),
    }));
  }

  function setInstanceAdmin(isInstanceAdmin: boolean) {
    mockCapabilitiesApi.get.mockResolvedValue({ capabilities: {}, membershipRole: "owner", isInstanceAdmin });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompany.current = { id: "company-1", name: "Paperclip" };
    mockSidebarBadgesApi.get.mockResolvedValue({ inbox: 0, approvals: 0, failedRuns: 0, joinRequests: 2 });
    mockPluginsApi.list.mockResolvedValue([]);
    setInstanceAdmin(false);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the back link and one Settings title", async () => {
    const root = await render();
    expect(container.querySelector('[data-testid="back-link"]')?.textContent).toContain("Paperclip");
    expect(container.textContent).toContain("Settings");
    expect(container.textContent).not.toContain("Company Settings");
    expect(container.textContent).not.toContain("Instance Settings");
    await act(async () => root.unmount());
  });

  it("groups the pages into Workspace, Agents, Data, Quality and Account for a member", async () => {
    const root = await render();
    const headings = [...container.querySelectorAll("[data-testid^='settings-nav-']")].map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(headings).toEqual([
      "settings-nav-workspace",
      "settings-nav-agents",
      "settings-nav-data",
      "settings-nav-quality",
      "settings-nav-account",
    ]);

    expect(groupLinks("workspace").map((l) => l.label?.replace(/\d+$/, ""))).toEqual([
      "General",
      "Members & access",
      "Invites",
      "Billing",
      "Model key",
      "Connections",
    ]);
    expect(groupLinks("workspace").map((l) => l.href)).toEqual([
      "/company/settings",
      "/company/settings/access",
      "/company/settings/invites",
      "/billing",
      "/company/settings/model-key",
      "/company/settings/connections",
    ]);
    // Members & access carries the pending join-request count.
    expect(groupLinks("workspace")[1]?.label).toBe("Members & access2");

    // Heartbeats is instance-admin only (its API is), so a member sees four.
    expect(groupLinks("agents")).toEqual([
      { label: "Workforce roles", href: "/workforce" },
      { label: "Skills", href: "/skills" },
      { label: "Environments", href: "/company/settings/environments" },
      { label: "Adapters", href: "/instance/settings/adapters" },
    ]);
    expect(groupLinks("data")).toEqual([
      { label: "Import", href: "/company/import" },
      { label: "Export", href: "/company/export" },
    ]);
    expect(groupLinks("quality")).toEqual([
      { label: "Evaluation", href: "/evaluation" },
      { label: "Health", href: "/company/settings/health" },
    ]);
    expect(groupLinks("account")).toEqual([
      { label: "Profile", href: "/instance/settings/profile" },
      { label: "About", href: "/instance/settings/about" },
      { label: "Changelog", href: "/instance/settings/changelog" },
    ]);
    await act(async () => root.unmount());
  });

  it("hides the Instance section and never asks for plugins when the user is not an instance admin", async () => {
    const root = await render();
    expect(group("instance")).toBeNull();
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const href of [
      "/instance/settings/general",
      "/instance/settings/access",
      "/instance/settings/plugins",
      "/instance/settings/experimental",
      "/instance/settings/heartbeats",
    ]) {
      expect(hrefs).not.toContain(href);
    }
    expect(mockPluginsApi.list).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("adds Heartbeats and the Instance section for an instance admin", async () => {
    setInstanceAdmin(true);
    mockPluginsApi.list.mockResolvedValue([
      { id: "p-1", packageName: "@acme/plugin", manifestJson: { displayName: "Acme" } },
    ]);
    const root = await render();
    expect(groupLinks("agents").map((l) => l.label)).toEqual(["Workforce roles", "Skills", "Environments", "Adapters", "Schedules"]);
    expect(groupLinks("instance")).toEqual([
      { label: "General", href: "/instance/settings/general" },
      { label: "Access", href: "/instance/settings/access" },
      { label: "Plugins", href: "/instance/settings/plugins" },
      { label: "Experimental", href: "/instance/settings/experimental" },
      { label: "Acme", href: "/instance/settings/plugins/p-1" },
    ]);
    await act(async () => root.unmount());
  });

  // One UX: an MK company gets the same settings navigation.
  it("renders the same navigation for an MK company", async () => {
    mockCompany.current = { id: "company-1", name: "Paperclip MK", productProfile: "agentdash_mk" };
    const root = await render();
    const labels = groupLinks("workspace").map((l) => l.label?.replace(/\d+$/, ""));
    expect(labels).toContain("Connections");
    expect(labels).toContain("Model key");
    await act(async () => root.unmount());
  });
});
