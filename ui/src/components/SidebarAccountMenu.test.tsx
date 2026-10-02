// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarAccountMenu } from "./SidebarAccountMenu";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
}));
const mockToggleTheme = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

const mockCapabilitiesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/api/capabilities", () => ({
  capabilitiesApi: mockCapabilitiesApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockSetSidebarOpen,
  }),
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    theme: "dark",
    toggleTheme: mockToggleTheme,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SidebarAccountMenu", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: "https://example.com/jane.png",
      },
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the signed-in user and opens the account card menu", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAccountMenu
            deploymentMode="authenticated"
            instanceSettingsTarget="/instance/settings/general"
            version="1.2.3"
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Jane Example");
    expect(container.textContent).not.toContain("jane@example.com");

    const trigger = container.querySelector('button[aria-label="Open account menu"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Edit profile");
    expect(document.body.textContent).toContain("Documentation");
    expect(document.body.textContent).toContain("AgentDash v1.2.3");
    expect(document.body.textContent).toContain("jane@example.com");

    await act(async () => {
      root.unmount();
    });
  });

  // AgentDash (Lane F2): instance settings are an instance-admin page.
  async function openMenuWithAdmin(isInstanceAdmin: boolean) {
    mockCapabilitiesApi.get.mockResolvedValue({
      companyId: "company-1",
      actorType: "user",
      membershipRole: "owner",
      isInstanceAdmin,
      capabilities: {},
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAccountMenu
            companyId="company-1"
            deploymentMode="authenticated"
            instanceSettingsTarget="/instance/settings/general"
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    const trigger = container.querySelector('button[aria-label="Open account menu"]');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    return root;
  }

  it("hides Instance settings from a company founder who is not an instance admin", async () => {
    const root = await openMenuWithAdmin(false);
    expect(document.body.textContent).toContain("Edit profile");
    expect(document.body.textContent).not.toContain("Instance settings");
    expect(document.querySelector('a[href="/instance/settings/general"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("keeps Instance settings for an instance admin", async () => {
    const root = await openMenuWithAdmin(true);
    expect(document.body.textContent).toContain("Instance settings");
    expect(document.querySelector('a[href="/instance/settings/general"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
