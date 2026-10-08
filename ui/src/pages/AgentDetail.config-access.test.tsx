// @vitest-environment jsdom
//
// AgentDash (GH #886): an agent's instructions, skills and configuration
// history answer 403 to a viewer who is neither its steward nor a company
// owner/admin. The settings views must explain that in plain words instead of
// crashing or handing over an empty editor that would 403 on save.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";
let currentTab = "instructions";

// AgentDetail's import graph reaches `@mdxeditor/editor` via AgentConfigForm →
// MarkdownEditor, and its Sandpack dependency throws inside jsdom's CSS parser.
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

// Every api module funnels through `api` in ../api/client — mocking the
// transport once covers all of them. The agent detail loads; the per-agent
// configuration reads answer 403 as the server does for an unrelated member.
const FORBIDDEN_READS = ["/instructions-bundle", "/skills", "/config-revisions"];

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      get: vi.fn(async (path: string) => {
        if (FORBIDDEN_READS.some((suffix) => path.includes(`/agents/${AGENT_ID}${suffix}`))) {
          throw new actual.ApiError(
            "Only this agent's steward or a company administrator can read its configuration",
            403,
            { error: "forbidden" },
          );
        }
        if (path.startsWith(`/agents/${AGENT_ID}`)) return AGENT;
        if (path.includes("budget")) throw new actual.ApiError("Spend is restricted", 403, { error: "forbidden" });
        return [];
      }),
      post: vi.fn(async () => ({})),
      postForm: vi.fn(async () => ({})),
      put: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
  };
});

vi.mock("@/lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/router")>();
  return {
    ...actual,
    Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
    CompanyLink: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
    useNavigate: () => () => undefined,
    useParams: () => ({ companyPrefix: "acm", agentId: AGENT_ID, tab: currentTab }),
    Navigate: () => null,
    useBeforeUnload: () => undefined,
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", issuePrefix: "ACM", name: "Acme" }],
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
    loading: false,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({ closePanel: vi.fn(), togglePanelVisible: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  ToastProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useToastActions: () => ({ pushToast: vi.fn(), dismissToast: vi.fn() }),
  useToasts: () => ({ toasts: [] }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { AgentDetail } = await import("./AgentDetail");

const AGENT = {
  id: AGENT_ID,
  companyId: "company-1",
  name: "Scout",
  status: "active",
  adapterType: "codex_local",
  adapterConfig: {},
  runtimeConfig: {},
  metadata: null,
  harnessReadiness: null,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
};

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderTab(tab: string) {
  currentTab = tab;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <AgentDetail />
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("AgentDetail settings views for a viewer without configuration access", () => {
  it("renders an unavailable budget instead of a zero-filled editor after overview 403", async () => {
    const page = await renderTab("budget");
    expect(page.textContent).toContain("Budget details are unavailable");
    expect(page.textContent).toContain("Ask a workspace administrator");
    expect(page.querySelector('input[type="number"]')).toBeNull();
    expect(page.textContent).not.toContain("$0.00");
  });
  it("explains the hidden instructions instead of showing an empty editor", async () => {
    const page = await renderTab("instructions");
    const notice = page.querySelector('[data-testid="agent-config-access-notice"]');
    expect(notice?.textContent).toContain("Only this agent's steward or a company owner or admin can see its instructions");
    expect(page.querySelector("textarea")).toBeNull();
  });

  it("explains the hidden skills", async () => {
    const page = await renderTab("skills");
    const notice = page.querySelector('[data-testid="agent-config-access-notice"]');
    expect(notice?.textContent).toContain("can see its skills");
  });
});
