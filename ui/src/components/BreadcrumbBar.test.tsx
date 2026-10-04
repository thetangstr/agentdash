// @vitest-environment jsdom

import { act, useEffect } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider, useBreadcrumbs, type Breadcrumb } from "../context/BreadcrumbContext";
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

function SetCrumbs({ crumbs }: { crumbs: Breadcrumb[] }) {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs(crumbs), [crumbs, setBreadcrumbs]);
  return null;
}

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

  function renderBar(crumbs: Breadcrumb[] = []) {
    act(() => {
      root.render(
        <BreadcrumbProvider>
          <SetCrumbs crumbs={crumbs} />
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

  it("replaces the parent crumb with a labelled back chevron on phones and keeps the page name in full", () => {
    renderBar([
      { label: "Workforce Management Console", href: "/workforce" },
      { label: "Agent Settings" },
    ]);

    const back = container.querySelector('a[aria-label="Back to Workforce Management Console"]');
    expect(back).not.toBeNull();
    expect(back!.getAttribute("href")).toBe("/workforce");

    // Phone-only (sm:hidden removes it from the desktop accessibility tree),
    // icon-only, and at the 44px tap floor — no "W"/"Worl" fragment can render.
    expect(back!.classList.contains("sm:hidden")).toBe(true);
    expect(back!.textContent?.trim()).toBe("");
    expect(back!.querySelector("svg")).not.toBeNull();

    // The current page name renders complete, not a fragment.
    expect(container.textContent).toContain("Agent Settings");
  });

  it("keeps the parent crumb's text label for desktop widths", () => {
    renderBar([
      { label: "Workforce", href: "/workforce" },
      { label: "Agents" },
    ]);

    // Desktop keeps a text crumb literally named "Workforce": the chevron's
    // "Back to Workforce" name must not leak onto it (a shared aria-label
    // collided with pages' own "Back to …" links — first-run e2e).
    const textCrumb = Array.from(container.querySelectorAll('a[href="/workforce"]'))
      .find((a) => a.textContent === "Workforce");
    expect(textCrumb).not.toBeUndefined();
    expect(textCrumb!.getAttribute("aria-label")).toBeNull();
    expect(textCrumb!.classList.contains("max-sm:hidden")).toBe(true);
    expect(textCrumb!.classList.contains("truncate")).toBe(true);
  });
});
