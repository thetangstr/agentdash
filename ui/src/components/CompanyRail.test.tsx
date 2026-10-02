// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CompanyRail } from "./CompanyRail";

const mockState = vi.hoisted(() => ({
  companies: [
    { id: "company-1", issuePrefix: "PAP", name: "Paperclip", status: "active" },
  ] as Array<Record<string, unknown>>,
  selectedCompany: {
    id: "company-1",
    issuePrefix: "PAP",
    name: "Paperclip",
  } as Record<string, unknown>,
  health: { status: "ok" } as Record<string, unknown>,
}));

vi.mock("../api/health", () => ({
  healthApi: { get: vi.fn(async () => mockState.health) },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: mockState.companies,
    selectedCompanyId: "company-1",
    selectedCompany: mockState.selectedCompany,
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openOnboarding: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/dashboard" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("../hooks/useCompanyOrder", () => ({
  useCompanyOrder: ({ companies }: { companies: unknown[] }) => ({
    orderedCompanies: companies,
    persistOrder: vi.fn(),
  }),
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue(null) },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/sidebarBadges", () => ({
  sidebarBadgesApi: { get: vi.fn().mockResolvedValue({ inbox: 0 }) },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function resetState() {
  mockState.health = { status: "ok" };
  mockState.companies = [
    { id: "company-1", issuePrefix: "PAP", name: "Paperclip", status: "active" },
  ];
  mockState.selectedCompany = {
    id: "company-1",
    issuePrefix: "PAP",
    name: "Paperclip",
  };
}

async function renderRail() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <CompanyRail />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return { container, root };
}

describe("CompanyRail", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    resetState();
  });

  // AgentDash: UX-6 (#787) + one UX — the rail is hidden for a single-company
  // person, whatever the company's profile.
  it("renders nothing for a single-company user", async () => {
    const { container, root } = await renderRail();
    expect(container.querySelector("a, button")).toBeNull();
    expect(container.textContent).toBe("");
    await act(async () => root.unmount());
  });

  it("applies the same one-company rule to an MK company", async () => {
    mockState.selectedCompany = {
      id: "company-1",
      issuePrefix: "PAP",
      name: "Paperclip",
      productProfile: "agentdash_mk",
    };
    const { container, root } = await renderRail();
    expect(container.querySelector("a, button")).toBeNull();
    await act(async () => root.unmount());
  });

  it("renders when the person belongs to multiple companies", async () => {
    mockState.companies = [
      { id: "company-1", issuePrefix: "PAP", name: "Paperclip", status: "active" },
      { id: "company-2", issuePrefix: "TST", name: "Second", status: "active" },
    ];
    const { container, root } = await renderRail();
    expect(container.querySelector('button[aria-label="Add company"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  // AgentDash (scan 2, E1): a hosted box holds one workspace, so it offers no
  // way to start a second one that the server would refuse at the end.
  it("offers no Add company on a hosted box", async () => {
    mockState.companies = [
      { id: "company-1", issuePrefix: "PAP", name: "Paperclip", status: "active" },
      { id: "company-2", issuePrefix: "TST", name: "Second", status: "active" },
    ];
    mockState.health = { status: "ok", hostedBox: true };
    const { container, root } = await renderRail();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('a, button')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Add company"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
