// @vitest-environment jsdom
// AgentDash (chat auto-follow): the dashboard run cards render the real
// RunChatSurface in its own scroll pane. A live run's card opens on the
// latest output, follows it while the viewer is at the bottom, lets go on a
// scroll up and offers "Jump to latest". (LiveRunWidget uses the same
// RunChatSurface scrollPaneClassName path.)

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";

const mockHeartbeatsApi = vi.hoisted(() => ({ liveRunsForCompany: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn() }));
const transcriptState = vi.hoisted(() => ({ lines: 3 }));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  };
});
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("./Identity", () => ({ Identity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock("./MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useAui: () => ({ thread: () => ({ append: vi.fn() }) }),
}));
vi.mock("./MarkdownEditor", () => ({ MarkdownEditor: () => null }));
vi.mock("./InlineEntitySelector", () => ({ InlineEntitySelector: () => null }));
vi.mock("./OutputFeedbackButtons", () => ({ OutputFeedbackButtons: () => null }));
vi.mock("./AgentIconPicker", () => ({ AgentIcon: () => null }));
vi.mock("./StatusBadge", () => ({ StatusBadge: ({ status }: { status: string }) => <span>{status}</span> }));
vi.mock("./IssueLinkQuicklook", () => ({
  IssueLinkQuicklook: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../hooks/usePaperclipIssueRuntime", () => ({ usePaperclipIssueRuntime: () => ({}) }));
vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map([
      [
        "run-live",
        Array.from({ length: transcriptState.lines }, (_, index) => ({
          kind: "assistant" as const,
          ts: new Date(Date.UTC(2026, 3, 24, 12, 0, index + 1)).toISOString(),
          text: `Working line ${index}`,
        })),
      ],
    ]),
    hasOutputForRun: () => true,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const LINE_PX = 200;
const PANE_PX = 300;
const scrollTops = new WeakMap<Element, number>();
const isPane = (el: HTMLElement) => el.dataset.testid === "run-chat-scroll-pane";

function installPaneLayout() {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const savedScrollTo = proto.scrollTo;
  const max = (_el: HTMLElement) => Math.max(0, transcriptState.lines * LINE_PX - PANE_PX);
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isPane(this) ? transcriptState.lines * LINE_PX : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isPane(this) ? PANE_PX : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrollTops.set(this, Math.min(Math.max(0, value), isPane(this) ? max(this) : 0));
    },
  });
  proto.scrollTo = function scrollTo(this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? 0;
    this.dispatchEvent(new Event("scroll"));
  };
  return () => {
    for (const key of ["scrollHeight", "clientHeight", "scrollTop"]) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
    proto.scrollTo = savedScrollTo;
  };
}

describe("ActiveAgentsPanel run card auto-follow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let restoreLayout: () => void;
  let queryClient: QueryClient;

  beforeEach(() => {
    restoreLayout = installPaneLayout();
    window.scrollTo = vi.fn();
    transcriptState.lines = 3;
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      {
        id: "run-live",
        status: "running",
        invocationSource: "assignment",
        triggerDetail: null,
        startedAt: "2026-04-24T12:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-04-24T12:00:00.000Z",
        agentId: "agent-1",
        agentName: "Agent 1",
        adapterType: "codex_local",
        issueId: null,
      },
    ]);
    mockIssuesApi.list.mockResolvedValue([]);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreLayout();
    vi.clearAllMocks();
  });

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ActiveAgentsPanel companyId="company-1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  const pane = () => container.querySelector<HTMLElement>('[data-testid="run-chat-scroll-pane"]')!;
  const jump = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="issue-chat-embedded-jump-to-latest"]');

  it("opens on the latest output, follows it, and offers Jump to latest after a scroll up", async () => {
    await render();
    expect(pane()).not.toBeNull();
    expect(pane().scrollTop).toBe(300);
    expect(jump()).toBeNull();

    transcriptState.lines = 5;
    await render();
    expect(pane().scrollTop).toBe(700);

    act(() => {
      pane().scrollTop = 100;
      pane().dispatchEvent(new Event("scroll"));
    });
    transcriptState.lines = 7;
    await render();
    expect(pane().scrollTop).toBe(100);
    expect(jump()?.textContent).toContain("Jump to latest");

    act(() => jump()!.click());
    expect(pane().scrollTop).toBe(1100);
    expect(jump()).toBeNull();
  });
});
