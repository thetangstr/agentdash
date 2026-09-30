// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";

vi.mock("@/lib/router", () => ({
  NavLink: ({
    to,
    children,
    className,
    ...props
  }: {
    to: string;
    children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {typeof children === "function" ? children({ isActive: false }) : children}
    </a>
  ),
  useLocation: () => ({ pathname: "/issues" }),
}));

const mockCompany = vi.hoisted(() => ({
  current: {
    id: "company-1",
    issuePrefix: "PAP",
    name: "Paperclip",
  } as Record<string, unknown>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: mockCompany.current,
  }),
}));

const mockBadge = vi.hoisted(() => ({ value: 7 }));

vi.mock("../hooks/useDecisionsBadge", () => ({
  useDecisionsBadge: () => mockBadge.value,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderNav(dark: boolean) {
  const container = document.createElement("div");
  if (dark) {
    container.className = "dark";
  }
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MobileBottomNav visible />);
  });
  return { container, root };
}

describe("MobileBottomNav", () => {
  let mounted: { container: HTMLDivElement; root: ReturnType<typeof createRoot> } | null = null;

  beforeEach(() => {
    mounted = null;
    mockBadge.value = 7;
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
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

  const decisionsLink = () =>
    [...mounted!.container.querySelectorAll("a")].find((anchor) =>
      anchor.textContent?.includes("Decisions"),
    );

  it("keeps the dark-mode Decisions badge legible with the mode-aware inverse text token", () => {
    // Same dark-mode pairing bug as the desktop sidebar bubble (AGE-31):
    // bg-primary (near-white in dark) must never pair with hardcoded white text.
    mounted = renderNav(true);

    const badge = decisionsLink()?.querySelector("span.rounded-full");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("7");
    expect(badge?.className).toContain("bg-primary");
    expect(badge?.className).toContain("text-text-inverse");
    expect(badge?.className).not.toContain("text-primary-foreground");
  });

  it("keeps light mode on the same legible pairing", () => {
    mounted = renderNav(false);

    const badge = decisionsLink()?.querySelector("span.rounded-full");
    expect(badge?.className).toContain("text-text-inverse");
    expect(badge?.className).not.toContain("text-primary-foreground");
  });

  it("renders no badge when nothing is waiting", () => {
    mockBadge.value = 0;
    mounted = renderNav(false);
    expect(decisionsLink()?.textContent).toBe("Decisions");
  });

  // AgentDash: UX-6 (#787) + one UX — the five-item nav for every company.
  it.each([
    ["a default-profile company", {}],
    ["an MK company (same nav as everyone)", { productProfile: "agentdash_mk" }],
  ])("renders Home, Work, Ask, Decisions, Team for %s", (_label, extra) => {
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip", ...extra };
    mounted = renderNav(false);

    const links = [...mounted.container.querySelectorAll("a")];
    const byLabel = (text: string) => links.find((anchor) => anchor.textContent?.includes(text));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/dashboard",
      "/issues",
      "/cos",
      "/decisions",
      "/agents",
    ]);
    expect(byLabel("Home")?.getAttribute("href")).toBe("/dashboard");
    expect(byLabel("Team")?.getAttribute("href")).toBe("/agents");
    expect(byLabel("Inbox")).toBeUndefined();
    expect(mounted.container.textContent).not.toContain("Create");
  });
});
