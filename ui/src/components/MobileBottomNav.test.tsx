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
    // The Inbox badge pairing these tests exercise only renders on MK now —
    // the default profile's five-item nav has no Inbox item (UX-6).
    productProfile: "agentdash_mk",
  } as Record<string, unknown>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: mockCompany.current,
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({
    openNewIssue: vi.fn(),
  }),
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 7, failedRuns: 0 }),
}));

vi.mock("../hooks/useDecisionsBadge", () => ({
  useDecisionsBadge: () => 0,
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

describe("MobileBottomNav Inbox badge", () => {
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

  it("keeps the dark-mode Inbox badge legible with the mode-aware inverse text token", () => {
    // Same dark-mode pairing bug as the desktop sidebar bubble (AGE-31):
    // bg-primary (near-white in dark) must never pair with hardcoded white text.
    mounted = renderNav(true);

    const inboxLink = [...mounted.container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent?.includes("Inbox"),
    );
    expect(inboxLink).toBeDefined();
    const badge = inboxLink?.querySelector("span.rounded-full");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("7");
    expect(badge?.className).toContain("bg-primary");
    expect(badge?.className).toContain("text-text-inverse");
    expect(badge?.className).not.toContain("text-primary-foreground");
  });

  it("keeps light mode on the same legible pairing", () => {
    mounted = renderNav(false);

    const inboxLink = [...mounted.container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent?.includes("Inbox"),
    );
    const badge = inboxLink?.querySelector("span.rounded-full");
    expect(badge?.className).toContain("text-text-inverse");
    expect(badge?.className).not.toContain("text-primary-foreground");
  });

  // AgentDash: UX-6 (#787) — the default profile gets the five-item nav.
  it("renders Home, Work, Ask, Decisions, Team on the default profile", () => {
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    try {
      mounted = renderNav(false);

      const links = [...mounted.container.querySelectorAll("a")];
      const byLabel = (text: string) =>
        links.find((anchor) => anchor.textContent?.includes(text));
      expect(byLabel("Home")?.getAttribute("href")).toBe("/dashboard");
      expect(byLabel("Work")?.getAttribute("href")).toBe("/issues");
      expect(byLabel("Ask")?.getAttribute("href")).toBe("/cos");
      expect(byLabel("Decisions")?.getAttribute("href")).toBe("/decisions");
      expect(byLabel("Team")?.getAttribute("href")).toBe("/agents");
      // The Decisions badge reads useDecisionsBadge (mocked to 0), not the
      // inbox badge (7) — no stray "7" on the item.
      expect(byLabel("Decisions")?.textContent).toBe("Decisions");
      expect(byLabel("Inbox")).toBeUndefined();
      expect(byLabel("Create")).toBeUndefined();
    } finally {
      mockCompany.current = {
        id: "company-1",
        issuePrefix: "PAP",
        name: "Paperclip",
        productProfile: "agentdash_mk",
      };
    }
  });
});
