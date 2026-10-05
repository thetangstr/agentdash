// @vitest-environment jsdom
//
// AgentDash (c4 trust, review #1026): page-level coverage for the background
// preflight — opening an agent whose saved check evidence is missing must
// re-check with { background: true } so the server writes no activity row.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";

// AgentDetail's import graph reaches `@mdxeditor/editor` via AgentConfigForm →
// MarkdownEditor, and its Sandpack dependency throws inside jsdom's CSS parser.
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

// Every api module funnels through `api` in ../api/client — mocking the
// transport once covers all of them. GET returns the agent for its detail
// path and empty collections elsewhere; POST is recorded so the preflight
// body can be asserted.
const postCalls: { path: string; body: unknown }[] = [];

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      get: vi.fn(async (path: string) => {
        if (path.startsWith(`/agents/${AGENT_ID}`)) return AGENT;
        if (path.includes("budget")) return { policies: [], incidents: [] };
        return [];
      }),
      post: vi.fn(async (path: string, body: unknown) => {
        postCalls.push({ path, body });
        return {};
      }),
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
    useParams: () => ({ companyPrefix: "acm", agentId: AGENT_ID }),
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

// No harnessReadiness and no saved evidence → the panel state is "missing",
// which is what arms the one-shot background re-check.
const AGENT = {
  id: AGENT_ID,
  companyId: "company-1",
  name: "Scout",
  status: "active",
  adapterType: "codex_local",
  metadata: null,
  harnessReadiness: null,
};

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  postCalls.length = 0;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("AgentDetail background harness preflight", () => {
  it("re-checks a missing-evidence agent with background: true", async () => {
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

    const preflight = postCalls.filter(({ path }) => path.includes("/harness-preflight"));
    expect(preflight).toHaveLength(1);
    expect(preflight[0].body).toEqual({ background: true });
  });
});
