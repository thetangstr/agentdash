// @vitest-environment jsdom
//
// Agent Performance Management gate 5 (P5.2): the page glue for "start from
// a brief". Saving a brief opens its page and tells it the brief was just
// saved; the brief page and the draft page read their ids from the route;
// a draft opened from a brief carries the brief's id; the adapter choices
// leave out disabled adapters.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: {} as Record<string, string>,
  state: null as unknown,
  search: new URLSearchParams(),
}));
const captured = vi.hoisted(() => ({ props: {} as Record<string, Record<string, unknown>> }));

vi.mock("@/lib/router", () => ({
  useNavigate: () => router.navigate,
  useParams: () => router.params,
  useLocation: () => ({ state: router.state }),
  useSearchParams: () => [router.search],
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../adapters", () => ({
  listUIAdapters: () => [
    { type: "claude_local", label: "Claude Code" },
    { type: "codex_local", label: "Codex" },
  ],
}));
vi.mock("../adapters/use-disabled-adapters", () => ({ useDisabledAdaptersSync: () => new Set(["codex_local"]) }));
vi.mock("../components/agent-performance/StartFromBrief", () => ({
  StartFromBrief: (props: Record<string, unknown>) => {
    captured.props.start = props;
    return <div data-testid="start" />;
  },
}));
vi.mock("../components/agent-performance/AgentBriefView", () => ({
  AgentBriefView: (props: Record<string, unknown>) => {
    captured.props.brief = props;
    return <div data-testid="brief" />;
  },
}));
vi.mock("../components/agent-performance/UnboundDraftView", () => ({
  UnboundDraftView: (props: Record<string, unknown>) => {
    captured.props.draft = props;
    return <div data-testid="draft" />;
  },
}));

const { AgentBriefPage, AgentDraftProfilePage, NewAgentFromBrief } = await import("./AgentBriefPages");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function render(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.props = {};
  router.params = {};
  router.state = null;
  router.search = new URLSearchParams();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
});

describe("start-from-a-brief pages", () => {
  it("opens the saved brief's page and says it was just saved", async () => {
    await render(<NewAgentFromBrief />);
    expect(captured.props.start!.companyId).toBe("company-1");
    (captured.props.start!.onSaved as (r: { issueId: string }) => void)({ issueId: "issue-1" });
    expect(router.navigate).toHaveBeenCalledWith("/agents/briefs/issue-1", { state: { briefSaved: true } });
  });

  it("the brief page reads the issue from the route and the just-saved flag from navigation state", async () => {
    router.params = { issueId: "issue-1" };
    router.state = { briefSaved: true };
    await render(<AgentBriefPage />);
    expect(captured.props.brief).toMatchObject({ companyId: "company-1", issueId: "issue-1", justSaved: true });
  });

  it("a brief page opened directly isn't announced as just saved", async () => {
    router.params = { issueId: "issue-1" };
    await render(<AgentBriefPage />);
    expect(captured.props.brief!.justSaved).toBe(false);
  });

  it("the draft page carries the brief it came from and offers only enabled adapters", async () => {
    router.params = { profileId: "profile-1" };
    router.search = new URLSearchParams("brief=issue-1");
    await render(<AgentDraftProfilePage />);
    expect(captured.props.draft).toMatchObject({ companyId: "company-1", profileId: "profile-1", briefIssueId: "issue-1" });
    expect(captured.props.draft!.adapterOptions).toEqual([{ value: "claude_local", label: "Claude Code" }]);
  });
});
