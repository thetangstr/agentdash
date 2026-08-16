// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Does the PAGE actually pass the capability down?
 *
 * `InlineEditor.readonly.test.tsx` proves the primitive refuses to open. This
 * proves GoalDetail asks for it — a distinction that matters, because the
 * previous commit shipped a `readOnly` prop that was accepted, wired, reported
 * as working, and did nothing. The wiring and the primitive can each be correct
 * while the pair is not.
 *
 * `InlineEditor` is mocked to RECORD its props rather than render, which keeps
 * this test about the wiring and avoids the `@codesandbox/sandpack-react`
 * import that kills jsdom.
 */

const inlineEditorProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: (props: Record<string, unknown>) => {
    inlineEditorProps.push(props);
    return <span>{String(props.value ?? "")}</span>;
  },
}));

const mockCapabilitiesApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/capabilities", () => ({ capabilitiesApi: mockCapabilitiesApi }));

const goal = {
  id: "goal-1",
  companyId: "company-1",
  title: "Weekly board pack",
  description: "Assembled without a fire drill",
  status: "active",
  level: "company",
  parentId: null,
  goalIds: [],
  goals: [],
  goalId: null,
};

const mockGoalsApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  tree: vi.fn(),
}));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/assets", () => ({ assetsApi: { uploadImage: vi.fn() } }));
vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ goalId: "goal-1" }),
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }),
}));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewGoal: vi.fn() }) }));
vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({ openPanel: vi.fn(), closePanel: vi.fn(), panelVisible: false, setPanelVisible: vi.fn() }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../components/GoalProperties", () => ({ GoalProperties: () => <div /> }));
vi.mock("../components/GoalTree", () => ({ GoalTree: () => <div /> }));
vi.mock("../components/GoalMetricTile", () => ({ GoalMetricTile: () => <div /> }));
vi.mock("../components/StatusBadge", () => ({ StatusBadge: () => <span /> }));
vi.mock("../components/EntityRow", () => ({ EntityRow: () => null }));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div>loading</div> }));

const { GoalDetail } = await import("./GoalDetail");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  inlineEditorProps.length = 0;
  vi.clearAllMocks();
  mockGoalsApi.get.mockResolvedValue(goal);
  mockGoalsApi.list.mockResolvedValue([]);
  mockGoalsApi.tree.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <GoalDetail />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 20; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

function capabilities(directionSet: boolean) {
  mockCapabilitiesApi.get.mockResolvedValue({
    companyId: "company-1",
    actorType: "board",
    membershipRole: directionSet ? "owner" : "member",
    isInstanceAdmin: false,
    capabilities: { "direction:set": directionSet },
  });
}

describe("GoalDetail permissions", () => {
  it("renders the title and description read-only for a member", async () => {
    capabilities(false);
    await render();

    expect(inlineEditorProps.length, "the editors should still render").toBeGreaterThan(0);
    for (const props of inlineEditorProps) {
      expect(props.readOnly, "every direction editor must be read-only for a member").toBe(true);
    }
  });

  it("leaves them editable for an owner", async () => {
    capabilities(true);
    await render();

    expect(inlineEditorProps.length).toBeGreaterThan(0);
    for (const props of inlineEditorProps) {
      expect(props.readOnly, "an owner must still be able to edit").toBe(false);
    }
  });

  it("hides the delete control from a member", async () => {
    capabilities(false);
    await render();
    expect(container.querySelector('[data-testid="delete-goal-button"]')).toBeNull();
  });

  it("offers delete to an owner", async () => {
    // The control case. Without it, a page that simply never renders the button
    // would satisfy the assertion above.
    capabilities(true);
    await render();
    expect(container.querySelector('[data-testid="delete-goal-button"]')).not.toBeNull();
  });

  it("does not offer editing while the answer is still unknown", async () => {
    // Never flash an editor at someone who will be refused.
    mockCapabilitiesApi.get.mockReturnValue(new Promise(() => {}));
    await render();
    for (const props of inlineEditorProps) {
      expect(props.readOnly, "must not be editable before capabilities resolve").toBe(true);
    }
    expect(container.querySelector('[data-testid="delete-goal-button"]')).toBeNull();
  });
});
