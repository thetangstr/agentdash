// @vitest-environment jsdom
// AgentDash (c4-hire-ux): the approval page speaks to an owner — the requester
// is named ("Dana Whitfield (via Chief of Staff)"), a hire reads as a hire
// ("Hire Bea as Bookkeeper"), and ids/adapters live under Technical details.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalsApi = vi.hoisted(() => ({
  get: vi.fn(),
  listComments: vi.fn(),
  listIssues: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  addComment: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ listUserDirectory: vi.fn() }));
const mockCompany = vi.hoisted(() => ({ id: "company-1", spentMonthlyCents: null as number | null }));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());

vi.mock("../api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: mockCompany, setSelectedCompanyId: mockSetSelectedCompanyId }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({ approvalId: "appr-1" }),
  useSearchParams: () => [new URLSearchParams()],
}));
// MarkdownBody pulls in a markdown renderer jsdom cannot style.
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

const { ApprovalDetail } = await import("./ApprovalDetail");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function cosPlanHireApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "appr-1",
    companyId: "company-1",
    type: "hire_agent",
    requestedByAgentId: null,
    requestedByUserId: "u-dana",
    status: "pending",
    revision: 1,
    payload: {
      name: "Bea",
      title: "Bookkeeper",
      role: "finance",
      agentId: "agent-9",
      adapterType: "hermes_local",
      source: "cos_plan",
    },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    decisionChannel: null,
    decisionIdempotencyKey: null,
    decisionActorRole: null,
    overrideReason: null,
    expiresAt: null,
    supersededAt: null,
    createdAt: new Date("2026-10-03T10:00:00Z"),
    updatedAt: new Date("2026-10-03T10:00:00Z"),
    ...overrides,
  };
}

describe("ApprovalDetail", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  it("directs restricted budget readers to an administrator without a costs link", async () => {
    mockApprovalsApi.get.mockResolvedValue(cosPlanHireApproval({ type: "budget_override_required", payload: { scopeName: "Synthetic workspace", budgetAmount: 876543, observedAmount: 987654, guidance: "Ask an administrator" } }));
    await renderPage("Budget Override");
    expect(container.textContent).toContain("Ask a workspace administrator to resolve this budget stop");
    expect(container.querySelector('a[href="/costs"]')).toBeNull();
    expect(container.textContent).toContain("Synthetic workspace");
    expect(container.textContent).not.toMatch(/8,765|9,876|876543|987654/);
    const details = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Technical details"))!;
    act(() => details.click());
    expect(container.textContent).not.toMatch(/8,765|9,876|876543|987654/);
  });

  it("keeps budget amounts and the Costs link for an authorized reader", async () => {
    mockCompany.spentMonthlyCents = 0;
    mockApprovalsApi.get.mockResolvedValue(cosPlanHireApproval({ type: "budget_override_required", payload: { scopeName: "Synthetic workspace", budgetAmount: 876543, observedAmount: 987654 } }));
    await renderPage("Budget Override");
    expect(container.textContent).toContain("8,765.43");
    expect(container.textContent).toContain("9,876.54");
    expect(container.querySelector('a[href="/costs"]')).not.toBeNull();
  });

  beforeEach(() => {
    mockCompany.spentMonthlyCents = null;
    mockApprovalsApi.get.mockResolvedValue(cosPlanHireApproval());
    mockApprovalsApi.listComments.mockResolvedValue([]);
    mockApprovalsApi.listIssues.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAccessApi.listUserDirectory.mockResolvedValue({
      users: [
        { principalId: "u-dana", status: "active", user: { id: "u-dana", name: "Dana Whitfield", email: "dana@x.test", image: null } },
      ],
    });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage(expected = "Bookkeeper") {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalDetail />
        </QueryClientProvider>,
      );
    });
    // The page resolves several queries before the card renders.
    await vi.waitFor(() => {
      expect(container.textContent ?? "").toContain(expected);
    });
  }

  it("names the person behind a cos_plan hire and reads 'Hire Bea as Bookkeeper'", async () => {
    await renderPage();
    const text = container.textContent ?? "";
    expect(text).toContain("Hire Bea as Bookkeeper");
    expect(text).toContain("Dana Whitfield (via Chief of Staff)");
    expect(text).toContain("Waiting for a decision");
    // Owner-facing fields stay human: the title, not the role slug.
    expect(text).toContain("Bookkeeper");
    // Ids and the adapter are collapsed under Technical details, not the header.
    const details = container.querySelector('[data-testid="plan-proposal"], pre');
    expect(text).not.toContain('"adapterType"');
    expect(details).toBeNull();
  });

  it("keeps ids and the adapter payload under Technical details", async () => {
    await renderPage();
    const toggle = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Technical details"),
    );
    expect(toggle).toBeDefined();
    await act(async () => toggle!.click());
    const text = container.textContent ?? "";
    expect(text).toContain("appr-1");
    expect(text).toContain('"adapterType": "hermes_local"');
  });

  it("gives the comment textarea an accessible name and uses plain button words", async () => {
    await renderPage();
    expect(container.querySelector('textarea[aria-label="Add a comment"]')).not.toBeNull();
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons).toContain("Ask for changes");
    expect(buttons).not.toContain("Request revision");
  });
});
