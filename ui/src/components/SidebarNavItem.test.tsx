// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarNavItem } from "./SidebarNavItem";

vi.mock("@/lib/router", () => ({
  NavLink: ({
    to,
    children,
    className,
    ...props
  }: {
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

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const StubIcon = (() => <svg data-testid="stub-icon" />) as unknown as LucideIcon;

function renderNavItem(
  badge: number | undefined,
  options?: { dark?: boolean; badgeTone?: "default" | "danger" },
) {
  const container = document.createElement("div");
  if (options?.dark) {
    container.className = "dark";
  }
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SidebarNavItem
        to="/inbox"
        label="Inbox"
        icon={StubIcon}
        badge={badge}
        badgeTone={options?.badgeTone}
      />,
    );
  });
  return { container, root };
}

describe("SidebarNavItem count badge", () => {
  let mounted: { container: HTMLDivElement; root: ReturnType<typeof createRoot> } | null = null;

  beforeEach(() => {
    mounted = null;
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = null;
    }
    document.body.innerHTML = "";
  });

  function mount(badge: number | undefined, options?: { dark?: boolean; badgeTone?: "default" | "danger" }) {
    mounted = renderNavItem(badge, options);
    return mounted.container;
  }

  it("keeps the dark-mode count bubble legible: ink text on the near-white primary fill", () => {
    // Dark-mode regression (AGE-31): the bubble previously paired
    // `bg-primary` (near-white in dark) with `text-primary-foreground`
    // (hardcoded #FFFFFF), leaving the count effectively invisible.
    // The badge must use the mode-aware inverse text token instead.
    const container = mount(7, { dark: true });

    const badge = container.querySelector('[data-testid="sidebar-nav-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("7");
    expect(badge?.className).toContain("bg-primary");
    expect(badge?.className).toContain("text-text-inverse");
    expect(badge?.className).not.toContain("text-primary-foreground");
  });

  it("uses the same legible pairing in light mode so the appearance is unchanged", () => {
    const container = mount(7);

    const badge = container.querySelector('[data-testid="sidebar-nav-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("7");
    expect(badge?.className).toContain("bg-primary");
    expect(badge?.className).toContain("text-text-inverse");
    expect(badge?.className).not.toContain("text-primary-foreground");
  });

  it("renders no bubble when the count is zero", () => {
    const container = mount(0, { dark: true });

    expect(container.querySelector('[data-testid="sidebar-nav-badge"]')).toBeNull();
    expect(container.textContent).not.toContain("0");
  });

  it("caps large counts at 99+ like the mobile bottom nav", () => {
    const container = mount(147, { dark: true });

    const badge = container.querySelector('[data-testid="sidebar-nav-badge"]');
    expect(badge?.textContent).toBe("99+");
  });

  it("renders exactly 99 without capping", () => {
    const container = mount(99, { dark: true });

    const badge = container.querySelector('[data-testid="sidebar-nav-badge"]');
    expect(badge?.textContent).toBe("99");
  });

  it("keeps the danger tone styling for failed-run state", () => {
    const container = mount(3, { dark: true, badgeTone: "danger" });

    const badge = container.querySelector('[data-testid="sidebar-nav-badge"]');
    expect(badge?.className).toContain("bg-red-600/90");
    expect(badge?.className).toContain("text-red-50");
    expect(badge?.className).not.toContain("text-text-inverse");
  });
});
