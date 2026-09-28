// @vitest-environment jsdom
// AgentDash: UX-7 (GH #788) review — the profile switch must wait for the
// profile before it redirects. Cold deep links were lost when the null
// selectedCompany during the companies fetch was read as "default".

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCompany = vi.hoisted(() => ({
  current: {
    companies: [] as Array<{ id: string; productProfile?: string }>,
    selectedCompany: null as { id: string; productProfile?: string } | null,
    loading: true,
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompany.current,
}));
vi.mock("@/lib/router", () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
}));

const { InboxRootRedirect, ProfileRouteSwitch } = await import("./ProfileRouteSwitch");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

const DEFAULT_CO = { id: "c-1", productProfile: "default" };
const MK_CO = { id: "c-2", productProfile: "agentdash_mk" };

describe("ProfileRouteSwitch", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(node: ReactNode) {
    await act(async () => root.render(<>{node}</>));
    await flush();
  }

  it("renders a skeleton while the companies query is in flight — no redirect", async () => {
    mockCompany.current = { companies: [], selectedCompany: null, loading: true };
    await render(
      <ProfileRouteSwitch
        mk={<div data-testid="mk">MK</div>}
        fallback={<div data-testid="navigate" data-to="/decisions" />}
      />,
    );
    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
    expect(container.querySelector('[data-testid="mk"]')).toBeNull();
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it("renders a skeleton after the fetch while the selection effect is still picking", async () => {
    // The post-load render gap: loading is false but selectedCompany is
    // still null — the state a cold /X/inbox/unread hits before the fix.
    mockCompany.current = { companies: [MK_CO], selectedCompany: null, loading: false };
    await render(
      <ProfileRouteSwitch
        mk={<div data-testid="mk">MK</div>}
        fallback={<div data-testid="fallback">FB</div>}
      />,
    );
    expect(container.querySelector('[data-testid="fallback"]')).toBeNull();
    expect(container.querySelector('[data-testid="mk"]')).toBeNull();
  });

  it("renders fallback on the default profile once resolved", async () => {
    mockCompany.current = { companies: [DEFAULT_CO], selectedCompany: DEFAULT_CO, loading: false };
    await render(
      <ProfileRouteSwitch
        mk={<div data-testid="mk">MK</div>}
        fallback={<div data-testid="fallback">FB</div>}
      />,
    );
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mk"]')).toBeNull();
  });

  it("renders the mk branch on agentdash_mk — the deep link survives", async () => {
    mockCompany.current = { companies: [MK_CO], selectedCompany: MK_CO, loading: false };
    await render(
      <ProfileRouteSwitch
        mk={<div data-testid="mk">MK</div>}
        fallback={<div data-testid="fallback">FB</div>}
      />,
    );
    expect(container.querySelector('[data-testid="mk"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="fallback"]')).toBeNull();
  });

  it("InboxRootRedirect waits, then sends default to /decisions and MK to the last inbox tab", async () => {
    mockCompany.current = { companies: [], selectedCompany: null, loading: true };
    await render(<InboxRootRedirect />);
    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    mockCompany.current = { companies: [DEFAULT_CO], selectedCompany: DEFAULT_CO, loading: false };
    await render(<InboxRootRedirect />);
    expect(container.querySelector('[data-testid="navigate"]')?.getAttribute("data-to")).toBe("/decisions");

    await act(async () => root.unmount());
    root = createRoot(container);
    mockCompany.current = { companies: [MK_CO], selectedCompany: MK_CO, loading: false };
    await render(<InboxRootRedirect />);
    expect(container.querySelector('[data-testid="navigate"]')?.getAttribute("data-to")).toBe("/inbox/mine");
  });
});
