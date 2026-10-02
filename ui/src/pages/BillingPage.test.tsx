// @vitest-environment jsdom
// AgentDash (GH #790): the Billing page speaks in words, not tier identifiers.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStatus = vi.hoisted(() => vi.fn());
vi.mock("../api/billing", () => ({
  billingApi: { status: mockStatus, startCheckout: vi.fn(), openPortal: vi.fn() },
}));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/billing", search: "" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import BillingPage from "./BillingPage";

/** Let the status query settle (it resolves after the first render). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function withQueryClient(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function renderPage(status: { tier: string; seatsPaid: number; periodEnd: string | null; configured?: boolean }) {
  mockStatus.mockResolvedValue(status);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(withQueryClient(<BillingPage companyId="c1" />));
  });
  await settle();
  return { container, root };
}

describe("BillingPage", () => {
  const rendered: Array<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

  beforeEach(() => {
    mockStatus.mockReset();
  });

  afterEach(() => {
    for (const r of rendered.splice(0)) {
      act(() => r.root.unmount());
      r.container.remove();
    }
  });

  it("shows Free without a raw tier identifier", async () => {
    rendered.push(await renderPage({ tier: "free", seatsPaid: 0, periodEnd: null }));
    const text = rendered[0].container.textContent!;
    expect(text).toContain("Plan: Free");
    expect(text).not.toContain("free\"");
    expect(text).not.toContain("Plan: free");
  });

  it("shows the Pro trial with a countdown", async () => {
    const end = new Date(Date.now() + 9 * 86_400_000).toISOString();
    rendered.push(await renderPage({ tier: "pro_trial", seatsPaid: 1, periodEnd: end }));
    const text = rendered[0].container.textContent!;
    expect(text).toMatch(/Pro trial — 9 days left/);
    expect(text).not.toContain("pro_trial");
    expect(text).toContain("One seat paid");
  });

  it("shows Pro and seat count in words", async () => {
    rendered.push(await renderPage({ tier: "pro_active", seatsPaid: 3, periodEnd: null }));
    const text = rendered[0].container.textContent!;
    expect(text).toContain("Plan: Pro");
    expect(text).toContain("Three seats paid");
    expect(text).not.toContain("pro_active");
  });

  it("shows the past-due phrase, not the raw tier", async () => {
    rendered.push(await renderPage({ tier: "pro_past_due", seatsPaid: 2, periodEnd: null }));
    const text = rendered[0].container.textContent!;
    expect(text).toContain("Pro — payment past due");
    expect(text).toContain("Two seats paid");
    expect(text).not.toContain("pro_past_due");
  });

  it("hides checkout and trial when the server reports billing unconfigured", async () => {
    rendered.push(await renderPage({ tier: "free", seatsPaid: 0, periodEnd: null, configured: false }));
    const text = rendered[0].container.textContent!;
    expect(text).toContain("Billing isn't configured on this instance.");
    expect(text).not.toContain("Pro trial, no card");
    expect(rendered[0].container.querySelector("button")).toBeNull();
  });

  it("still shows the trial action when the server reports billing configured", async () => {
    rendered.push(await renderPage({ tier: "free", seatsPaid: 0, periodEnd: null, configured: true }));
    expect(rendered[0].container.textContent!).toContain("Pro trial, no card");
  });

  it("shows an error instead of Loading forever when status fails", async () => {
    mockStatus.mockRejectedValue(new ApiError("Not a member of this company", 403, null));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered.push({ container, root });
    await act(async () => {
      root.render(withQueryClient(<BillingPage companyId="c1" />));
    });
    await settle();
    const text = container.textContent!;
    expect(text).not.toContain("Loading…");
    expect(text).toContain("Not a member of this company");
  });

  // AgentDash (scan 3 lane L): a 429 is answered once, in words, and is not retried.
  it("asks once on a 429 and says so in plain words", async () => {
    mockStatus.mockRejectedValue(new ApiError("Rate limited", 429, { error: "Rate limited" }, 900_000));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered.push({ container, root });
    await act(async () => {
      root.render(withQueryClient(<BillingPage companyId="c1" />));
    });
    await settle();
    expect(mockStatus).toHaveBeenCalledTimes(1);
    const text = container.textContent!;
    expect(text).toContain("Too many plan checks");
    expect(text).not.toContain("Rate limited");
  });
});
