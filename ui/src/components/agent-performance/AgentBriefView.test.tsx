// @vitest-environment jsdom
//
// Agent Performance Management gate 5 (P5.2): the brief page. The brief is
// a revisioned issue document; editing it writes a new revision against the
// one loaded, and a stale edit overwrites nothing. "Send to the planner"
// assigns the performance manager; with none the server answers 409 and the
// page links to the Performance manager setting. The planner's scenario
// manifest shows each scenario's recommendation in plain words, the reason,
// the unknowns and a link to the agent or draft profile; with no manifest yet
// it says "The planner hasn't written a plan yet".

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_BRIEF_ALREADY_SUBMITTED,
  AGENT_BRIEF_NO_PERFORMANCE_MANAGER,
  type AgentScenario,
  type IssueDocument,
} from "@paperclipai/shared";
import { ApiError } from "../../api/client";

const mockBriefs = vi.hoisted(() => ({
  create: vi.fn(),
  submit: vi.fn(),
  list: vi.fn(),
  issue: vi.fn(),
  brief: vi.fn(),
  briefRevisions: vi.fn(),
  saveBrief: vi.fn(),
  manifest: vi.fn(),
  performanceManager: vi.fn(),
}));
const mockAgents = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../../api/agent-briefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-briefs")>();
  return { ...actual, agentBriefsApi: mockBriefs };
});
vi.mock("../../api/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agents")>();
  return { ...actual, agentsApi: mockAgents };
});
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { AgentBriefView, NO_PERFORMANCE_MANAGER_TEXT } = await import("./AgentBriefView");
const { BRIEF_SAVED_TEXT, MANIFEST_EMPTY_TEXT, RECOMMENDATION_TEXT } = await import("./brief-shared");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const REV_1 = "33333333-3333-4333-8333-333333333331";
const REV_2 = "33333333-3333-4333-8333-333333333332";

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "ACME-12",
    title: "Collections at Acme",
    status: "backlog",
    assigneeAgentId: null,
    assigneeUserId: null,
    originKind: "agent_work_brief",
    updatedAt: "2026-10-29T10:00:00.000Z",
    ...overrides,
  };
}

function doc(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "doc-1",
    companyId: "company-1",
    issueId: "issue-1",
    key: "agent-work-brief",
    title: "Agent-work brief",
    format: "markdown",
    latestRevisionId: REV_1,
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "user-yang",
    updatedByAgentId: null,
    updatedByUserId: "user-yang",
    createdAt: new Date("2026-10-29T10:00:00.000Z"),
    updatedAt: new Date("2026-10-29T10:00:00.000Z"),
    body: "# Collections at Acme\n\nChase overdue invoices.",
    ...overrides,
  };
}

function scenario(overrides: Partial<AgentScenario> = {}): AgentScenario {
  return {
    key: "s01",
    title: "Chase overdue invoices",
    stakeholders: "Finance lead",
    currentProcess: "Dana, by hand, every Monday",
    removedOrNewWork: "",
    triggerCadence: "Weekly, Monday 9am PT",
    inputsSources: "",
    deliverable: "",
    acceptanceNotes: "",
    authorityNeeds: "",
    escalation: "",
    baselineMeasure: "",
    unknowns: ["Who approves write-offs"],
    recommendation: "reuse",
    targetAgentId: AGENT_ID,
    reason: "Ivy already owns the receivables report",
    ...overrides,
  };
}

function manifestDoc(scenarios: AgentScenario[], briefRevisionId: string | null = REV_1): IssueDocument {
  return doc({
    id: "doc-2",
    key: "scenario-manifest",
    title: "Scenario manifest",
    latestRevisionId: "44444444-4444-4444-8444-444444444441",
    latestRevisionNumber: 1,
    body: JSON.stringify({ manifestVersion: 1, briefRevisionId, scenarios }),
  });
}

const REVISIONS = [
  { id: REV_1, companyId: "company-1", documentId: "doc-1", issueId: "issue-1", key: "agent-work-brief", revisionNumber: 1, title: null, format: "markdown", body: "", changeSummary: "Brief pasted", createdByAgentId: null, createdByUserId: "user-yang", createdAt: "2026-10-29T10:00:00.000Z" },
];

const notFound = () => new ApiError("Document not found", 404, { error: "Document not found" });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(justSaved = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <AgentBriefView companyId="company-1" issueId="issue-1" justSaved={justSaved} />
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

function byTestId<T extends HTMLElement = HTMLElement>(scope: ParentNode, id: string): T {
  const found = scope.querySelector<T>(`[data-testid='${id}']`);
  if (!found) throw new Error(`No [data-testid=${id}]`);
  return found;
}

async function type(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBriefs.issue.mockResolvedValue(issue());
  mockBriefs.brief.mockResolvedValue(doc());
  mockBriefs.briefRevisions.mockResolvedValue(REVISIONS);
  mockBriefs.manifest.mockRejectedValue(notFound());
  mockBriefs.performanceManager.mockResolvedValue({
    kind: "performance_manager",
    companyId: "company-1",
    designatedAgentId: null,
    designated: null,
    effective: { agentId: "agent-cos", name: "Clara", role: "chief_of_staff", status: "active" },
    source: "chief_of_staff",
    viewer: { canChange: false },
  });
  mockAgents.list.mockResolvedValue([
    { id: AGENT_ID, name: "Ivy", urlKey: "ivy", companyId: "company-1", role: "general", status: "active" },
    { id: "agent-cos", name: "Clara", urlKey: "clara", companyId: "company-1", role: "chief_of_staff", status: "active" },
  ]);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

// ---------------------------------------------------------------------------
// Saved, then sent
// ---------------------------------------------------------------------------

describe("AgentBriefView — sending to the planner", () => {
  it("right after saving: announces it was saved and that nobody was woken", async () => {
    const node = await render(true);
    const status = byTestId(node, "brief-view-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe(`${BRIEF_SAVED_TEXT} Saving doesn't wake anyone.`);
    expect(byTestId(node, "brief-state").textContent).toContain("Saved, not sent to the planner.");
    expect(document.activeElement?.tagName).toBe("H1");
    expect(mockBriefs.submit).not.toHaveBeenCalled();
  });

  it("names the planner, and sending assigns it once", async () => {
    const node = await render();
    const send = byTestId(node, "brief-send");
    expect(byTestId(send, "brief-send-planner").textContent).toBe("It goes to Clara, the performance manager.");
    expect(send.textContent).toContain("Nothing is hired until a person approves a hire.");

    mockBriefs.submit.mockResolvedValue({ ...issue(), kind: "agent_brief", issueId: "issue-1", status: "todo", assigneeAgentId: "agent-cos" });
    mockBriefs.issue.mockResolvedValue(issue({ status: "todo", assigneeAgentId: "agent-cos" }));
    await click(byTestId(send, "brief-submit"));
    expect(mockBriefs.submit).toHaveBeenCalledTimes(1);
    expect(mockBriefs.submit).toHaveBeenCalledWith("company-1", "issue-1");
    expect(byTestId(node, "brief-view-status").textContent).toBe("Sent to the planner, Clara. Its plan will appear below.");
    expect(node.querySelector("[data-testid='brief-send']")).toBeNull();
    expect(byTestId(node, "brief-state").textContent).toContain("With the planner, Clara.");
  });

  it("with no performance manager (409): says so, links the setting, and keeps the brief", async () => {
    mockBriefs.submit.mockRejectedValue(
      new ApiError("No performance manager", 409, { error: "No performance manager", details: { code: AGENT_BRIEF_NO_PERFORMANCE_MANAGER } }),
    );
    const node = await render();
    await click(byTestId(node, "brief-submit"));
    const alert = byTestId(node, "brief-submit-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(NO_PERFORMANCE_MANAGER_TEXT);
    expect(alert.textContent).toContain("Your brief is saved; nothing was sent.");
    expect(byTestId(alert, "brief-settings-link").getAttribute("href")).toBe("/company/settings");
    expect(byTestId(node, "markdown-body").textContent).toContain("Chase overdue invoices.");
    expect(byTestId(node, "brief-send")).toBeTruthy();
  });

  it("says ahead of time when the company has no performance manager", async () => {
    mockBriefs.performanceManager.mockResolvedValue({
      kind: "performance_manager",
      companyId: "company-1",
      designatedAgentId: null,
      designated: null,
      effective: null,
      source: "none",
      viewer: { canChange: false },
    });
    const node = await render();
    const note = byTestId(node, "brief-send-no-planner");
    expect(note.textContent).toContain(NO_PERFORMANCE_MANAGER_TEXT);
    expect(note.querySelector("a")?.getAttribute("href")).toBe("/company/settings");
  });

  it("an already-sent brief (409) says so and reloads", async () => {
    mockBriefs.submit.mockRejectedValue(
      new ApiError("This brief was already submitted", 409, { error: "already", details: { code: AGENT_BRIEF_ALREADY_SUBMITTED } }),
    );
    const node = await render();
    const before = mockBriefs.issue.mock.calls.length;
    await click(byTestId(node, "brief-submit"));
    expect(byTestId(node, "brief-submit-error").textContent).toBe("This brief was already sent to the planner.");
    expect(mockBriefs.issue.mock.calls.length).toBeGreaterThan(before);
  });

  it("a sent brief shows who has it and no send button", async () => {
    mockBriefs.issue.mockResolvedValue(issue({ status: "in_progress", assigneeAgentId: "agent-cos" }));
    const node = await render();
    expect(node.querySelector("[data-testid='brief-send']")).toBeNull();
    expect(byTestId(node, "brief-state").textContent).toContain("With the planner, Clara.");
    expect(mockBriefs.performanceManager).not.toHaveBeenCalled();
  });

  it("an issue that isn't a brief says so", async () => {
    mockBriefs.issue.mockResolvedValue(issue({ originKind: "manual" }));
    const node = await render();
    expect(byTestId(node, "brief-view-not-brief").textContent).toContain("wasn't created from a brief");
  });
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe("AgentBriefView — the scenario manifest", () => {
  it("empty: the planner hasn't written a plan yet", async () => {
    const node = await render();
    expect(byTestId(node, "manifest-empty").textContent).toContain(`${MANIFEST_EMPTY_TEXT}.`);
  });

  it("shows each scenario's recommendation in plain words, the reason, the unknowns and the link", async () => {
    mockBriefs.manifest.mockResolvedValue(
      manifestDoc([
        scenario(),
        scenario({ key: "s02", title: "Monthly dunning letters", recommendation: "new_role", targetAgentId: undefined, unboundProfileId: PROFILE_ID, reason: "No agent owns letters", unknowns: [] }),
        scenario({ key: "s03", title: "Credit holds", recommendation: "new_role", targetAgentId: undefined, reason: "Needs its own role" }),
        scenario({ key: "s04", title: "Write-offs", recommendation: "human_owned", targetAgentId: undefined, reason: "A finance decision" }),
        scenario({ key: "s05", title: "Reminder emails", recommendation: "deterministic_workflow", targetAgentId: undefined, reason: "Same email every time" }),
        scenario({ key: "s06", title: "Receivables report", recommendation: "bounded_change", reason: "Add the aging view" }),
      ]),
    );
    const node = await render();
    const items = Array.from(node.querySelectorAll<HTMLElement>("[data-testid='manifest-scenario']"));
    expect(items).toHaveLength(6);
    const [reuse, newRole, newRoleNoDraft, human, workflow, bounded] = items;

    expect(reuse!.querySelector("h3")?.textContent).toBe("Chase overdue invoices");
    expect(byTestId(reuse!, "manifest-recommendation").textContent).toBe(RECOMMENDATION_TEXT.reuse);
    expect(reuse!.textContent).toContain("Ivy already owns the receivables report");
    expect(byTestId(reuse!, "manifest-unknowns").textContent).toContain("Who approves write-offs");
    const agentLink = byTestId(reuse!, "manifest-target-agent");
    expect(agentLink.getAttribute("href")).toBe("/agents/ivy");
    expect(agentLink.textContent).toBe("Ivy");

    expect(byTestId(newRole!, "manifest-recommendation").textContent).toBe(RECOMMENDATION_TEXT.new_role);
    expect(byTestId(newRole!, "manifest-unbound-draft").getAttribute("href")).toBe(`/agents/drafts/${PROFILE_ID}?brief=issue-1`);
    expect(byTestId(newRole!, "manifest-unknowns").textContent).toContain("listed nothing unknown");
    expect(newRoleNoDraft!.textContent).toContain("The planner hasn't written the draft profile yet.");
    expect(byTestId(human!, "manifest-recommendation").textContent).toBe("Keep it with a person");
    expect(human!.textContent).toContain("A person; no agent takes it.");
    expect(byTestId(workflow!, "manifest-recommendation").textContent).toBe("A fixed workflow, not an agent");
    expect(byTestId(bounded!, "manifest-recommendation").textContent).toBe(RECOMMENDATION_TEXT.bounded_change);

    // Raw enum values never show; the details read from the brief are behind a disclosure.
    for (const raw of ["bounded_change", "new_role", "human_owned", "deterministic_workflow"]) {
      expect(byTestId(node, "manifest").textContent).not.toContain(raw);
    }
    expect(reuse!.querySelector("details")?.textContent).toContain("Dana, by hand, every Monday");
    expect(byTestId(node, "manifest").textContent).toContain("none of them hires, changes or starts an agent");
  });

  it("says when the brief changed after the plan was written", async () => {
    mockBriefs.brief.mockResolvedValue(doc({ latestRevisionId: REV_2, latestRevisionNumber: 2 }));
    mockBriefs.manifest.mockResolvedValue(manifestDoc([scenario()], REV_1));
    const node = await render();
    expect(byTestId(node, "manifest-stale").textContent).toContain("The brief changed after this plan was written (the plan read revision 1)");
  });

  it("an unreadable manifest says so instead of guessing", async () => {
    mockBriefs.manifest.mockResolvedValue(doc({ key: "scenario-manifest", body: "not json" }));
    const node = await render();
    expect(byTestId(node, "manifest-invalid").textContent).toContain("can't be read as a scenario plan");
  });
});

// ---------------------------------------------------------------------------
// Editing the brief (the issue-document revision API)
// ---------------------------------------------------------------------------

describe("AgentBriefView — editing the brief", () => {
  it("saves a new revision against the one loaded, and wakes no one", async () => {
    const node = await render();
    await click(byTestId(node, "brief-edit"));
    const text = byTestId<HTMLTextAreaElement>(node, "brief-edit-text");
    expect(text.value).toBe(doc().body);
    mockBriefs.saveBrief.mockResolvedValue(doc({ latestRevisionId: REV_2, latestRevisionNumber: 2, body: "# Collections\n\nUpdated." }));
    await type(text, "# Collections\n\nUpdated.");
    await click(byTestId(node, "brief-edit-save"));
    expect(mockBriefs.saveBrief).toHaveBeenCalledWith("issue-1", {
      body: "# Collections\n\nUpdated.",
      baseRevisionId: REV_1,
      title: "Agent-work brief",
      changeSummary: "Brief edited",
    });
    expect(byTestId(node, "brief-document-status").textContent).toBe("Brief revision 2 saved. Saving doesn't wake anyone.");
    expect(mockBriefs.submit).not.toHaveBeenCalled();
  });

  it("a stale edit (409) overwrites nothing, keeps the text, and saves over only when asked", async () => {
    const node = await render();
    await click(byTestId(node, "brief-edit"));
    await type(byTestId(node, "brief-edit-text"), "My version");
    mockBriefs.saveBrief.mockRejectedValueOnce(
      new ApiError("Document was updated by someone else", 409, { error: "Document was updated by someone else", details: { currentRevisionId: REV_2 } }),
    );
    mockBriefs.brief.mockResolvedValue(doc({ latestRevisionId: REV_2, latestRevisionNumber: 2, body: "Their version" }));
    await click(byTestId(node, "brief-edit-save"));
    const conflict = byTestId(node, "brief-conflict");
    expect(conflict.getAttribute("role")).toBe("alert");
    expect(conflict.textContent).toContain("It is now revision 2");
    expect(conflict.textContent).toContain("Nothing was overwritten");
    expect(conflict.textContent).toContain("Their version");
    expect(byTestId<HTMLTextAreaElement>(node, "brief-edit-text").value).toBe("My version");

    mockBriefs.saveBrief.mockResolvedValueOnce(doc({ latestRevisionId: "33333333-3333-4333-8333-333333333333", latestRevisionNumber: 3, body: "My version" }));
    await click(byTestId(conflict, "brief-conflict-keep-mine"));
    expect(mockBriefs.saveBrief).toHaveBeenLastCalledWith("issue-1", expect.objectContaining({ body: "My version", baseRevisionId: REV_2 }));
    expect(byTestId(node, "brief-document-status").textContent).toContain("Brief revision 3 saved.");
  });

  it("lists the brief's revisions", async () => {
    const node = await render();
    expect(byTestId(node, "brief-revisions").textContent).toContain("Revision 1");
    expect(byTestId(node, "brief-revisions").textContent).toContain("Brief pasted");
  });
});
