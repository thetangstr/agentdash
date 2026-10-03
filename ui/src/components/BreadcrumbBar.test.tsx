// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider } from "../context/BreadcrumbContext";
import { BreadcrumbBar } from "./BreadcrumbBar";

const mockState = vi.hoisted(() => ({
  isMobile: true,
  toggleSidebar: vi.fn(),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: mockState.isMobile,
    toggleSidebar: mockState.toggleSidebar,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { name: "Acme Travel", issuePrefix: "ACM" },
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: () => null,
  usePluginLaunchers: () => ({ launchers: [] }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("BreadcrumbBar", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockState.isMobile = true;
    mockState.toggleSidebar.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderBar() {
    act(() => {
      root.render(
        <BreadcrumbProvider>
          <BreadcrumbBar />
        </BreadcrumbProvider>,
      );
    });
  }

  it("keeps the sidebar button and workspace name on phones when a page registers no breadcrumbs", async () => {
    renderBar();

    const menuButton = container.querySelector('button[aria-label="Open sidebar"]');
    expect(menuButton).not.toBeNull();
    expect(container.textContent).toContain("Acme Travel");

    await act(async () => {
      menuButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockState.toggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("stays quiet on desktop when a page registers no breadcrumbs", () => {
    mockState.isMobile = false;
    renderBar();

    expect(container.querySelector('button[aria-label="Open sidebar"]')).toBeNull();
    expect(container.textContent).not.toContain("Acme Travel");
  });
});
