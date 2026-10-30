// @vitest-environment jsdom
//
// Agent Performance Management, Profile tab.
// Gate 1: with nothing applied the tab shows revision 0 the server derived
// from today's records, read-only, every field labelled "Proposed — from
// <source>" or "Missing", in the order work it owns, how it works, what it
// knows, style, then runtime (collapsed).
// Gate 2: the active revision with provenance, the draft editor (save with
// If-Match, 409 comparison, validation), request approval, withdraw, export,
// revision history with diffs, and the application receipt with Resume.
// Saving a draft never proposes, applies or resumes anything.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PROFILE_DRAFT_CONFLICT,
  DEFAULT_AGENT_GOVERNANCE_POLICY,
  agentOperatingProfileV1Schema,
  profileBodyHash,
  type AgentOperatingProfileV1,
  type AgentProfileApplicationDto,
  type AgentProfileDerived,
  type AgentProfileRevisionDto,
  type AgentProfileView,
} from "@paperclipai/shared";
import { ApiError } from "../../api/client";

const mockPerf = vi.hoisted(() => ({ profile: vi.fn(), access: vi.fn(), projection: vi.fn() }));
const mockProfiles = vi.hoisted(() => ({
  revisions: vi.fn(),
  revision: vi.fn(),
  diff: vi.fn(),
  exportMarkdownUrl: vi.fn((c: string, a: string, r: string) => `/api/companies/${c}/agents/${a}/profile/revisions/${r}/export.md`),
  createDraft: vi.fn(),
  saveDraft: vi.fn(),
  propose: vi.fn(),
  withdraw: vi.fn(),
  applications: vi.fn(),
  resumeApplication: vi.fn(),
}));
// Gate 4: revision history marks the performance manager's proposals from each revision's
// `proposedByCapacity`; it must not read approvals (GET /approvals/:id) to do so.
const defaultApprovalGet = vi.hoisted(() => async (path: string) => ({ id: path.replace("/approvals/", ""), type: "agent_profile_change", payload: {} }));
const mockClient = vi.hoisted(() => ({ get: vi.fn(defaultApprovalGet), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));

vi.mock("../../api/agent-performance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-performance")>();
  return { ...actual, agentPerformanceApi: mockPerf };
});
vi.mock("../../api/agent-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-profiles")>();
  return { ...actual, agentProfilesApi: mockProfiles };
});
vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: mockClient };
});
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { AgentProfileTab, PROFILE_BANNER_TEXT, APPLICATION_IN_PROGRESS_TEXT } = await import("./AgentProfileTab");
const { RESTRICTED_VIEW_TEXT } = await import("./shared");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function derived(overrides: Partial<AgentProfileDerived> = {}): AgentProfileDerived {
  return {
    kind: "agent_profile_derived",
    version: "agent-profile-derived/0",
    derived: true,
    companyId: "company-1",
    agentId: "agent-1",
    generatedAt: "2026-10-29T12:00:00.000Z",
    identity: {
      name: { value: "Ivy", provenance: "proposed", source: "agent.name" },
      title: { value: "Revenue analyst", provenance: "proposed", source: "agent.title" },
      role: { value: "general", provenance: "proposed", source: "agent.role" },
      summary: { value: null, provenance: "missing", source: null },
    },
    objective: { value: "Keep the pipeline report current", provenance: "proposed", source: "workforce_enrollment" },
    responsibilities: [
      {
        key: "weekly-pipeline-report",
        title: "Weekly pipeline report",
        source: "plan_card:abcd1234-5678",
        obligation: { kind: "routine", routineId: "routine-1", routineTriggerIds: ["trigger-1"] },
      },
      {
        key: "answer-sales-questions",
        title: "Answer sales questions",
        source: "plan_card:abcd1234-5678",
        obligation: { kind: "unknown" },
      },
    ],
    kpis: { value: ["Report shipped by Monday 9am"], provenance: "proposed", source: "plan_card:abcd1234-5678" },
    rhythm: {
      heartbeat: { enabled: true, intervalSec: 3600, wakeOnDemand: true },
      routines: [
        {
          routineId: "routine-1",
          title: "Monday pipeline report",
          status: "active",
          triggers: [
            { id: "trigger-1", kind: "schedule", cronExpression: "0 9 * * 1", timezone: "America/Los_Angeles", enabled: true },
          ],
        },
      ],
      reportsTo: { agentId: "agent-ceo", agentName: "Chief of Staff" },
      accountableUserId: "user-yang",
    },
    skills: { value: [], provenance: "missing", source: null },
    runtime: { adapterType: "claude_local", model: "claude-opus-5-5", environmentId: null },
    gaps: [
      { code: "NO_STRUCTURED_OBLIGATIONS", message: "One responsibility has no routine or assignment behind it." },
      { code: "NO_CRITERIA", message: "Nobody has said how the work will be judged." },
      { code: "NO_ACCESS_REQUEST", message: "Nobody has requested access for this agent." },
      { code: "NO_STYLE", message: "No communication style is recorded." },
    ],
    ...overrides,
  };
}

function body(overrides: Partial<AgentOperatingProfileV1> = {}): AgentOperatingProfileV1 {
  return agentOperatingProfileV1Schema.parse({
    profileVersion: 1,
    identity: {
      name: "Ivy",
      title: "Revenue analyst",
      summary: "Keeps the pipeline report current",
      audience: "",
      style: { tone: "", uncertaintyRule: "" },
    },
    responsibilities: [
      {
        key: "weekly-pipeline-report",
        title: "Weekly pipeline report",
        outcome: "",
        stakeholders: [],
        obligation: { kind: "assigned" },
        deliverable: { what: "", destination: "" },
        escalation: { toUserId: "user-yang", when: "" },
        performance: { criteria: [], coverage: [], outcomeLinks: [], expectedHumanSteps: [], judges: { automated: [] } },
      },
    ],
    knowledge: [],
    skills: ["crm-report"],
    access: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, policyVersion: 2 },
    rhythm: { timezone: "UTC", reportTo: { userId: "user-yang" } },
    runtime: { adapterType: "claude_local", heartbeat: { intervalSec: 3600 } },
    ...overrides,
  });
}

const PROVENANCE = {
  "/identity/name": { state: "proposed" as const, sourceRef: "agent.name" },
  "/identity/title": { state: "owner_confirmed" as const, at: "2026-10-29T11:00:00.000Z" },
  "/identity/audience": { state: "missing" as const },
};

function revision(overrides: Partial<AgentProfileRevisionDto> = {}): AgentProfileRevisionDto {
  const b = overrides.body ?? body();
  return {
    id: "rev-2",
    companyId: "company-1",
    profileId: "profile-1",
    agentId: "agent-1",
    revisionNumber: 2,
    basedOnRevisionId: null,
    state: "draft",
    body: b,
    bodyHash: profileBodyHash(b),
    provenance: PROVENANCE,
    sourceRefs: [],
    bases: null,
    createdByAgentId: null,
    createdByUserId: "user-yang",
    createdByRunId: null,
    approvalId: null,
    createdAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T10:30:00.000Z",
    ...overrides,
  };
}

function summary(rev: AgentProfileRevisionDto) {
  const { body: _b, provenance: _p, sourceRefs: _s, ...rest } = rev;
  return rest;
}

/** A viewer the server lets do everything; tests narrow it. */
const ALL_ALLOWED: AgentProfileView["viewer"] = {
  canEditDraft: true,
  canPropose: true,
  canWithdraw: true,
  canResumeApplication: true,
  canDecideActiveProposal: null,
};

const NOTHING_ALLOWED: AgentProfileView["viewer"] = {
  canEditDraft: false,
  canPropose: false,
  canWithdraw: false,
  canResumeApplication: false,
  canDecideActiveProposal: false,
};

function view(overrides: Partial<AgentProfileView> = {}): AgentProfileView {
  return {
    kind: "agent_profile_view",
    version: "agent-profile/1",
    companyId: "company-1",
    agentId: "agent-1",
    profileId: null,
    active: null,
    latestDraft: null,
    pendingProposal: null,
    derived: derived(),
    latestApplication: null,
    applicationInProgress: false,
    viewer: ALL_ALLOWED,
    ...overrides,
  };
}

function application(overrides: Partial<AgentProfileApplicationDto> = {}): AgentProfileApplicationDto {
  return {
    id: "app-1",
    companyId: "company-1",
    agentId: "agent-1",
    revisionId: "rev-1",
    approvalId: "approval-1",
    status: "failed",
    steps: [
      { step: "governance_request", status: "done", targetId: "gov-1", beforeHash: null, afterHash: null, error: null, completedAt: "2026-10-29T12:01:00.000Z" },
      { step: "config", status: "failed", targetId: null, beforeHash: null, afterHash: null, error: "The configuration write was refused.", completedAt: null },
      { step: "environment", status: "pending", targetId: null, beforeHash: null, afterHash: null, error: null, completedAt: null },
      { step: "routine_bindings", status: "pending", targetId: null, beforeHash: null, afterHash: null, error: null, completedAt: null },
      { step: "skills", status: "pending", targetId: null, beforeHash: null, afterHash: null, error: null, completedAt: null },
      { step: "contract", status: "pending", targetId: null, beforeHash: null, afterHash: null, error: null, completedAt: null },
    ],
    approverUserId: "user-admin",
    approverAuthority: null,
    failure: { kind: "step", step: "config", detail: "The configuration write was refused." },
    createdAt: "2026-10-29T12:00:00.000Z",
    updatedAt: "2026-10-29T12:01:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <AgentProfileTab
          companyId="company-1"
          agentId="agent-1"
          accountable={{ userId: "user-yang", name: "Yang", email: "yang@example.com", via: "assignment" }}
        />
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
  return container;
}

function button(node: HTMLElement, text: string | RegExp): HTMLButtonElement {
  const found = Array.from(node.querySelectorAll("button")).find((el) =>
    typeof text === "string" ? el.textContent?.trim() === text : text.test(el.textContent ?? ""),
  );
  if (!found) throw new Error(`No button ${String(text)}`);
  return found as HTMLButtonElement;
}

/** The input whose <label> reads `label`, inside `scope`. */
function field(scope: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const el = Array.from(scope.querySelectorAll("label")).find((l) => l.textContent?.trim() === label);
  if (!el) throw new Error(`No label ${label}`);
  const input = scope.ownerDocument.getElementById(el.htmlFor);
  if (!input) throw new Error(`No input for ${label}`);
  return input as HTMLInputElement;
}

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
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

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

function noApplicationCalls() {
  expect(mockProfiles.propose).not.toHaveBeenCalled();
  expect(mockProfiles.resumeApplication).not.toHaveBeenCalled();
  expect(mockProfiles.withdraw).not.toHaveBeenCalled();
  expect(mockClient.post).not.toHaveBeenCalled();
  expect(mockClient.put).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Gate 1: derived revision 0
// ---------------------------------------------------------------------------

describe("AgentProfileTab — revision 0 (nothing applied)", () => {
  it("shows a loading state while the profile is read", async () => {
    mockPerf.profile.mockReturnValue(new Promise(() => {}));
    const node = await render();
    expect(node.querySelector("[role='status']")?.textContent).toContain("Loading profile");
  });

  it("renders the status, then the derived sections in order, with the starting-point banner and the gaps", async () => {
    mockPerf.profile.mockResolvedValue(view());
    const node = await render();

    expect(mockPerf.profile).toHaveBeenCalledWith("company-1", "agent-1");
    expect(node.querySelector("[role='note']")?.textContent).toContain(PROFILE_BANNER_TEXT);
    const headings = Array.from(node.querySelectorAll("h3")).map((h) => h.textContent?.trim());
    expect(headings).toEqual(["Profile status", "Work it owns", "How it works", "What it knows", "Style", "Runtime (advanced)", "Gaps"]);
    expect(node.textContent).toContain("None applied yet. Below is revision 0");
    expect(node.textContent).toContain("Weekly pipeline report");
    expect(node.textContent).toContain("Bound to a routine (1 trigger)");
    expect(node.textContent).toContain("No obligation recorded");
    expect(node.textContent).toContain("Every 1 hour");
    expect(node.textContent).toContain("Chief of Staff");
    expect(node.textContent).toContain("Yang");
    expect(node.textContent).toContain("0 9 * * 1");
    for (const code of ["NO_STRUCTURED_OBLIGATIONS", "NO_CRITERIA", "NO_ACCESS_REQUEST", "NO_STYLE"]) {
      expect(node.textContent).toContain(code);
    }
    // No profile row yet: no history to read.
    expect(mockProfiles.revisions).not.toHaveBeenCalled();
  });

  it("labels every derived field with its provenance as text", async () => {
    mockPerf.profile.mockResolvedValue(view());
    const node = await render();
    const labels = Array.from(node.querySelectorAll("[data-testid='agent-pm-provenance']")).map((el) => el.textContent);
    expect(labels).toContain("Proposed — from the confirmed plan card abcd1234");
    expect(labels).toContain("Proposed — from the workforce enrollment");
    expect(labels).toContain("Proposed — from the agent record (title)");
    expect(labels.filter((label) => label === "Missing").length).toBeGreaterThanOrEqual(3);
    expect(node.textContent).toContain("Not recorded");
  });

  it("keeps runtime collapsed until the person opens it with a button", async () => {
    mockPerf.profile.mockResolvedValue(view());
    const node = await render();
    const trigger = node.querySelector<HTMLButtonElement>("[data-testid='agent-profile-runtime'] button");
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");
    expect(node.textContent).not.toContain("claude_local");
    await act(async () => {
      trigger!.click();
    });
    expect(trigger!.getAttribute("aria-expanded")).toBe("true");
    expect(node.textContent).toContain("claude_local");
    expect(node.textContent).toContain("claude-opus-5-5");
  });

  it("says so when no responsibilities or routines are recorded", async () => {
    const d = derived();
    mockPerf.profile.mockResolvedValue(
      view({
        derived: derived({
          responsibilities: [],
          rhythm: { ...d.rhythm, routines: [], reportsTo: { agentId: null, agentName: null }, accountableUserId: null },
          gaps: [{ code: "AMBIGUOUS_PLAN_MAPPING", message: "Two plan entries could be this agent; none was used." }],
        }),
      }),
    );
    const node = await render();
    expect(node.textContent).toContain("No responsibilities are recorded for this agent.");
    expect(node.textContent).toContain("No routines are assigned to this agent.");
    expect(node.textContent).toContain("Two plan entries could be this agent; none was used.");
  });

  it("shows the server's message when the read fails", async () => {
    mockPerf.profile.mockRejectedValue(new ApiError("Agent not found", 404, { error: "Agent not found" }));
    const node = await render();
    const alert = node.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Couldn't load this agent's profile.");
    expect(alert?.textContent).toContain("Agent not found");
  });

  it("treats a 403 as an error with the server's message (members may read profiles)", async () => {
    mockPerf.profile.mockRejectedValue(new ApiError("Board access required", 403, { error: "Board access required" }));
    const node = await render();
    expect(node.querySelector("[role='alert']")?.textContent).toContain("Board access required");
    expect(node.textContent).not.toContain(RESTRICTED_VIEW_TEXT);
  });

  it("starts a draft with no body (the server seeds it) and opens the editor without proposing", async () => {
    const draft = revision({ id: "rev-1", revisionNumber: 1 });
    // The view is re-read after the create, so its flags answer for the new draft.
    mockPerf.profile.mockResolvedValueOnce(view()).mockResolvedValue(view({ profileId: "profile-1", latestDraft: draft }));
    mockProfiles.createDraft.mockResolvedValue(draft);
    mockProfiles.revisions.mockResolvedValue([summary(draft)]);
    const node = await render();
    await click(button(node, "Draft changes"));
    expect(mockProfiles.createDraft).toHaveBeenCalledWith("company-1", "agent-1");
    expect(node.querySelector("[data-testid='agent-profile-editor']")).not.toBeNull();
    expect(node.querySelector("[data-testid='agent-profile-tab-status']")?.textContent).toContain("started from revision 0");
    noApplicationCalls();
  });
});

// ---------------------------------------------------------------------------
// Gate 2: the viewer flags decide which controls show
// ---------------------------------------------------------------------------

describe("AgentProfileTab — controls follow the server's viewer flags", () => {
  it("offers no Draft changes to a viewer who may not draft, and says so", async () => {
    mockPerf.profile.mockResolvedValue(view({ viewer: { ...NOTHING_ALLOWED, canDecideActiveProposal: null } }));
    const node = await render();
    expect(() => button(node, "Draft changes")).toThrow();
    expect(node.querySelector("[data-testid='agent-profile-read-only']")?.textContent).toContain("Drafting changes is for");
  });

  it("shows an open draft read-only, with no save or approval controls, to a viewer who may not edit it", async () => {
    const draft = revision();
    mockPerf.profile.mockResolvedValue(view({ profileId: "profile-1", latestDraft: draft, viewer: NOTHING_ALLOWED }));
    mockProfiles.revisions.mockResolvedValue([summary(draft)]);
    const node = await render();
    expect(node.querySelector("[data-testid='agent-profile-editor']")).toBeNull();
    const readOnly = node.querySelector<HTMLElement>("[data-testid='agent-profile-draft-readonly']")!;
    expect(readOnly.textContent).toContain("Draft revision 2");
    expect(readOnly.querySelector("[data-testid='agent-profile-draft-readonly-body']")).not.toBeNull();
    expect(node.querySelector("[data-testid='agent-profile-save']")).toBeNull();
    expect(node.querySelector("[data-testid='agent-profile-request-approval']")).toBeNull();
  });

  it("hides Request approval when the viewer may edit but not propose", async () => {
    const draft = revision();
    mockPerf.profile.mockResolvedValue(view({ profileId: "profile-1", latestDraft: draft, viewer: { ...ALL_ALLOWED, canPropose: false } }));
    mockProfiles.revisions.mockResolvedValue([summary(draft)]);
    const node = await render();
    expect(node.querySelector("[data-testid='agent-profile-save']")).not.toBeNull();
    expect(node.querySelector("[data-testid='agent-profile-request-approval']")).toBeNull();
  });

  it("offers Withdraw only with canWithdraw, and says whether the viewer can decide the pending change", async () => {
    const pending = revision({ id: "rev-2", revisionNumber: 2, state: "proposed", approvalId: "approval-9" });
    mockPerf.profile.mockResolvedValue(
      view({ profileId: "profile-1", pendingProposal: summary(pending), viewer: { ...NOTHING_ALLOWED, canDecideActiveProposal: false } }),
    );
    mockProfiles.revisions.mockResolvedValue([summary(pending)]);
    let node = await render();
    expect(() => button(node, "Withdraw revision 2")).toThrow();
    expect(node.querySelector("[data-testid='agent-profile-can-decide']")?.textContent).toContain("You can't decide this change");
    act(() => root!.unmount());
    container!.remove();
    root = null;
    container = null;

    mockPerf.profile.mockResolvedValue(
      view({ profileId: "profile-1", pendingProposal: summary(pending), viewer: { ...ALL_ALLOWED, canDecideActiveProposal: true } }),
    );
    node = await render();
    expect(button(node, "Withdraw revision 2")).toBeTruthy();
    expect(node.querySelector("[data-testid='agent-profile-can-decide']")?.textContent).toBe("You can decide it.");
  });

  it("offers Resume only with canResumeApplication, and names who can", async () => {
    mockPerf.profile.mockResolvedValue(
      view({ profileId: "profile-1", latestApplication: application(), viewer: { ...ALL_ALLOWED, canResumeApplication: false } }),
    );
    mockProfiles.revisions.mockResolvedValue([]);
    const node = await render();
    expect(node.querySelector("[data-testid='agent-profile-resume']")).toBeNull();
    expect(node.querySelector("[data-testid='agent-profile-resume-not-yours']")?.textContent).toContain(
      "the person who approved it or a company admin",
    );
    expect(mockProfiles.resumeApplication).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gate 2: active revision, history, export
// ---------------------------------------------------------------------------

describe("AgentProfileTab — active revision", () => {
  it("shows the active revision with provenance labels, export and history", async () => {
    const active = revision({ id: "rev-1", revisionNumber: 1, state: "applied" });
    const older = revision({ id: "rev-0", revisionNumber: 3, state: "rejected" });
    mockPerf.profile.mockResolvedValue(view({ profileId: "profile-1", active, derived: null }));
    mockProfiles.revisions.mockResolvedValue([summary(active), summary(older)]);
    mockProfiles.diff.mockResolvedValue({
      against: "active",
      diff: [{ op: "replace", pointer: "/identity/title", before: "Revenue analyst", after: "Head of revenue" }],
    });
    const node = await render();

    expect(node.textContent).toContain("Revision 1 · Active");
    const labels = Array.from(node.querySelectorAll("[data-testid='agent-profile-active-body'] [data-testid='agent-pm-provenance']")).map((el) => el.textContent);
    expect(labels).toContain("Proposed — from the agent record (name)");
    expect(labels).toContain("Confirmed by a person");
    expect(labels).toContain("Missing");
    expect(labels).toContain("Source not recorded");
    const exportLink = Array.from(node.querySelectorAll("a")).find((a) => a.textContent === "Export Markdown (active)");
    expect(exportLink?.getAttribute("href")).toBe("/api/companies/company-1/agents/agent-1/profile/revisions/rev-1/export.md");

    const rows = node.querySelectorAll("[data-testid='agent-profile-history-row']");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Revision 3 · Rejected");
    await click(button(rows[0] as HTMLElement, "Compare with active"));
    expect(mockProfiles.diff).toHaveBeenCalledWith("company-1", "agent-1", "rev-0", "active");
    const diff = node.querySelector("[data-testid='agent-profile-history-diff-3']")?.textContent ?? "";
    expect(diff).toContain("Changed: Identity › Title");
    expect(diff).toContain("“Revenue analyst”");
    expect(diff).toContain("“Head of revenue”");
  });

  // Gate 4 (P4.2/P4.3): a revision the performance manager proposed is marked, from the
  // revision's own `proposedByCapacity` (the server reads the approval payload), with no approval GETs.
  it("marks revisions the performance manager proposed, and no others, without fetching approvals", async () => {
    const active = revision({ id: "rev-1", revisionNumber: 1, state: "applied", approvalId: "approval-user", proposedByCapacity: null });
    const byManager = revision({ id: "rev-2", revisionNumber: 2, state: "rejected", approvalId: "approval-manager", proposedByCapacity: "performance_manager" });
    const byAgent = revision({ id: "rev-3", revisionNumber: 3, state: "withdrawn", approvalId: "approval-agent", proposedByCapacity: null });
    mockPerf.profile.mockResolvedValue(view({ profileId: "profile-1", active, derived: null }));
    mockProfiles.revisions.mockResolvedValue([summary(active), summary(byManager), summary(byAgent)]);
    const node = await render();
    await flush();
    expect(mockClient.get.mock.calls.filter(([path]) => String(path).startsWith("/approvals/"))).toEqual([]);
    const rows = Array.from(node.querySelectorAll<HTMLElement>("[data-testid='agent-profile-history-row']"));
    const marked = rows.map((row) => row.querySelector("[data-testid='agent-profile-history-manager-filed']")?.textContent ?? null);
    // Newest first: revisions 3, 2, 1.
    expect(rows.map((row) => row.textContent?.match(/Revision \d+/)?.[0])).toEqual(["Revision 3", "Revision 2", "Revision 1"]);
    expect(marked).toEqual([null, "Proposed by the performance manager", null]);
  });

  it("offers Withdraw for a pending proposal and links its approval", async () => {
    const active = revision({ id: "rev-1", revisionNumber: 1, state: "applied" });
    const pending = revision({ id: "rev-2", revisionNumber: 2, state: "proposed", approvalId: "approval-9" });
    mockPerf.profile.mockResolvedValue(view({ profileId: "profile-1", active, derived: null, pendingProposal: summary(pending) }));
    mockProfiles.revisions.mockResolvedValue([summary(active), summary(pending)]);
    mockProfiles.withdraw.mockResolvedValue({ ...pending, state: "withdrawn" });
    const node = await render();
    const link = Array.from(node.querySelectorAll("a")).find((a) => a.textContent === "Open the approval");
    expect(link?.getAttribute("href")).toBe("/approvals/approval-9");
    await click(button(node, "Withdraw revision 2"));
    expect(mockProfiles.withdraw).toHaveBeenCalledWith("company-1", "agent-1", "rev-2");
    expect(node.querySelector("[data-testid='agent-profile-tab-status']")?.textContent).toContain(
      "Revision 2 withdrawn. Nothing changed for the agent.",
    );
  });
});

// ---------------------------------------------------------------------------
// Gate 2: the draft editor
// ---------------------------------------------------------------------------

async function renderWithDraft(draft = revision()) {
  mockPerf.profile.mockResolvedValue(view({ profileId: "profile-1", latestDraft: draft }));
  mockProfiles.revisions.mockResolvedValue([summary(draft)]);
  const node = await render();
  const editor = node.querySelector<HTMLElement>("[data-testid='agent-profile-editor']")!;
  expect(editor).not.toBeNull();
  return { node, editor, draft };
}

describe("AgentProfileTab — draft editor", () => {
  it("shows the sections in the LLD order with provenance on every field", async () => {
    const { editor } = await renderWithDraft();
    const headings = Array.from(editor.querySelectorAll("h3")).map((h) => h.textContent?.trim());
    expect(headings).toEqual(["Draft revision 2", "Work it owns", "How it works", "What it knows", "Style"]);
    expect(editor.querySelector("[data-testid='agent-profile-edit-runtime'] summary")?.textContent).toContain("Runtime (advanced)");
    const fields = Array.from(editor.querySelectorAll("[data-testid='agent-profile-field']"));
    expect(fields.length).toBeGreaterThan(20);
    for (const f of fields) {
      expect(f.querySelector("[data-testid='agent-pm-provenance']")?.textContent?.length).toBeGreaterThan(0);
    }
    // Admin-decided runtime fields are marked as such.
    expect(editor.querySelector("[data-testid='agent-profile-edit-runtime']")?.textContent).toContain("(a company admin decides)");
    expect(field(editor, "Name").getAttribute("aria-describedby")).toContain("provenance");
  });

  it("saves with If-Match, says 'Draft saved', keeps focus, and makes no approval or application call", async () => {
    const { node, editor, draft } = await renderWithDraft();
    const saved = revision({ body: body({ identity: { ...body().identity, title: "Head of revenue" } }), updatedAt: "2026-10-29T13:00:00.000Z" });
    mockProfiles.saveDraft.mockResolvedValue(saved);

    await type(field(editor, "Title"), "Head of revenue");
    expect(editor.textContent).toContain("You have unsaved changes.");
    const save = editor.querySelector<HTMLButtonElement>("[data-testid='agent-profile-save']")!;
    save.focus();
    await click(save);

    expect(mockProfiles.saveDraft).toHaveBeenCalledTimes(1);
    const [companyId, agentId, revisionId, ifMatch, input] = mockProfiles.saveDraft.mock.calls[0];
    expect([companyId, agentId, revisionId, ifMatch]).toEqual(["company-1", "agent-1", "rev-2", draft.bodyHash]);
    expect(input.body.identity.title).toBe("Head of revenue");
    // The edited field is now confirmed by the person; untouched fields keep their source.
    expect(input.provenance["/identity/title"].state).toBe("owner_confirmed");
    expect(input.provenance["/identity/name"]).toEqual({ state: "proposed", sourceRef: "agent.name" });

    const status = editor.querySelector("[data-testid='agent-profile-draft-status']");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toBe("Draft saved");
    expect(document.activeElement).toBe(save);
    expect(node.textContent).not.toMatch(/Agent ready|Agent started/);
    expect(editor.textContent).toContain("No unsaved changes.");
    noApplicationCalls();
    expect(mockProfiles.createDraft).not.toHaveBeenCalled();
  });

  it("refuses to send an invalid draft and says which field is wrong", async () => {
    const { editor } = await renderWithDraft();
    await type(field(editor, "Name"), "");
    await click(editor.querySelector<HTMLButtonElement>("[data-testid='agent-profile-save']")!);
    expect(mockProfiles.saveDraft).not.toHaveBeenCalled();
    const alert = editor.querySelector("[data-testid='agent-profile-editor-error']");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("nothing was saved");
    expect(alert?.textContent).toContain("Identity › Name");
  });

  it("blocks saving while a structured field holds invalid JSON", async () => {
    const { editor } = await renderWithDraft();
    await type(field(editor, "What it may do (requested access, structured)"), "{ not json");
    expect(editor.textContent).toContain("This is not valid JSON yet");
    await click(editor.querySelector<HTMLButtonElement>("[data-testid='agent-profile-save']")!);
    expect(mockProfiles.saveDraft).not.toHaveBeenCalled();
    expect(editor.querySelector("[data-testid='agent-profile-editor-error']")?.textContent).toContain("structured fields");
  });

  it("on a 409 shows the saved draft beside yours and overwrites nothing until the person chooses", async () => {
    const { editor } = await renderWithDraft();
    const theirs = revision({
      body: body({ identity: { ...body().identity, summary: "Their summary" } }),
      updatedAt: "2026-10-29T12:45:00.000Z",
    });
    mockProfiles.saveDraft.mockRejectedValueOnce(
      new ApiError("This draft changed since you loaded it", 409, {
        error: "This draft changed since you loaded it",
        code: AGENT_PROFILE_DRAFT_CONFLICT,
        current: theirs,
      }),
    );
    await type(field(editor, "Title"), "Mine");
    await click(editor.querySelector<HTMLButtonElement>("[data-testid='agent-profile-save']")!);

    const panel = editor.querySelector("[data-testid='agent-profile-conflict']");
    expect(panel?.getAttribute("role")).toBe("alert");
    expect(panel?.textContent).toContain("This draft changed since you opened it.");
    expect(panel?.textContent).toContain("Nothing was overwritten.");
    const diff = panel?.querySelector("[data-testid='agent-profile-conflict-diff']")?.textContent ?? "";
    expect(diff).toContain("Identity › Title");
    expect(diff).toContain("Saved draft");
    expect(diff).toContain("Yours");
    expect(diff).toContain("“Mine”");
    expect(diff).toContain("“Their summary”");
    expect(editor.querySelector("[data-testid='agent-profile-draft-status']")?.textContent).toBe("");
    // Approval can't be requested while the conflict is open.
    expect(editor.querySelector("[data-testid='agent-profile-request-approval']")?.getAttribute("aria-disabled")).toBe("true");

    // Keep mine: the retry carries the CURRENT hash, explicitly.
    mockProfiles.saveDraft.mockResolvedValueOnce(revision({ body: body({ identity: { ...body().identity, title: "Mine" } }) }));
    await click(button(panel as HTMLElement, "Save my version over it"));
    expect(mockProfiles.saveDraft).toHaveBeenLastCalledWith("company-1", "agent-1", "rev-2", theirs.bodyHash, expect.anything());
    expect(editor.querySelector("[data-testid='agent-profile-conflict']")).toBeNull();
    expect(editor.querySelector("[data-testid='agent-profile-draft-status']")?.textContent).toBe("Draft saved");
    noApplicationCalls();
  });

  it("on a 409 can load the saved draft instead, discarding the unsaved edit", async () => {
    const { editor } = await renderWithDraft();
    const theirs = revision({ body: body({ identity: { ...body().identity, summary: "Their summary" } }) });
    mockProfiles.saveDraft.mockRejectedValueOnce(
      new ApiError("changed", 409, { error: "changed", code: AGENT_PROFILE_DRAFT_CONFLICT, current: theirs }),
    );
    await type(field(editor, "Title"), "Mine");
    await click(editor.querySelector<HTMLButtonElement>("[data-testid='agent-profile-save']")!);
    await click(button(editor, "Use the saved draft"));
    expect((field(editor, "Summary") as HTMLTextAreaElement).value).toBe("Their summary");
    expect((field(editor, "Title") as HTMLInputElement).value).toBe("Revenue analyst");
    expect(editor.querySelector("[data-testid='agent-profile-draft-status']")?.textContent).toContain("Loaded the saved draft");
    expect(mockProfiles.saveDraft).toHaveBeenCalledTimes(1);
  });

  it("shows a server refusal on save without losing the edit", async () => {
    const { editor } = await renderWithDraft();
    mockProfiles.saveDraft.mockRejectedValueOnce(
      new ApiError("Only the agent's steward, its accountable person or an administrator can draft its profile", 403, {
        error: "Only the agent's steward, its accountable person or an administrator can draft its profile",
      }),
    );
    await type(field(editor, "Title"), "Mine");
    await click(editor.querySelector<HTMLButtonElement>("[data-testid='agent-profile-save']")!);
    const alert = editor.querySelector("[data-testid='agent-profile-editor-error']")?.textContent ?? "";
    expect(alert).toContain("The server refused to save the draft: Only the agent's steward");
    expect(alert).toContain("Your changes are still here");
    expect((field(editor, "Title") as HTMLInputElement).value).toBe("Mine");
  });

  it("adds and removes responsibilities, keeping labels on the right rows", async () => {
    const { editor } = await renderWithDraft();
    await click(button(editor, "Add responsibility"));
    expect(editor.querySelectorAll("[data-testid='agent-profile-edit-responsibility']")).toHaveLength(2);
    await click(button(editor, "Remove responsibility “Weekly pipeline report”"));
    const rows = editor.querySelectorAll("[data-testid='agent-profile-edit-responsibility']");
    expect(rows).toHaveLength(1);
    expect((field(rows[0] as HTMLElement, "Key") as HTMLInputElement).value).toBe("responsibility-2");
    expect(rows[0].querySelector("[data-testid='agent-pm-provenance']")?.textContent).toBe("Confirmed by a person");
  });

  it("asks for approval only for a saved draft, then reports it without applying", async () => {
    const { node, editor } = await renderWithDraft();
    const request = editor.querySelector<HTMLButtonElement>("[data-testid='agent-profile-request-approval']")!;
    expect(request.getAttribute("aria-disabled")).toBe("false");

    await type(field(editor, "Title"), "Changed");
    expect(request.getAttribute("aria-disabled")).toBe("true");
    expect(editor.textContent).toContain("Save the draft first");
    await click(request);
    expect(editor.querySelector("[data-testid='agent-profile-propose-form']")).toBeNull();

    mockProfiles.saveDraft.mockResolvedValue(revision({ body: body({ identity: { ...body().identity, title: "Changed" } }) }));
    await click(editor.querySelector<HTMLButtonElement>("[data-testid='agent-profile-save']")!);
    await click(request);
    const form = editor.querySelector<HTMLElement>("[data-testid='agent-profile-propose-form']")!;
    await type(field(form, "Why this change (optional)"), "The title was wrong");
    mockProfiles.propose.mockResolvedValue({
      revision: revision({ state: "proposed", approvalId: "approval-5" }),
      approvalId: "approval-5",
      payload: {},
    });
    await click(button(form, "Send for approval"));
    expect(mockProfiles.propose).toHaveBeenCalledWith("company-1", "agent-1", "rev-2", { reason: "The title was wrong" });
    expect(node.querySelector("[data-testid='agent-profile-tab-status']")?.textContent).toContain(
      "Revision 2 sent for approval. Nothing changes for the agent until it is approved and applied.",
    );
    expect(mockProfiles.resumeApplication).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gate 2: application receipt
// ---------------------------------------------------------------------------

describe("AgentProfileTab — application status", () => {
  async function renderApplication(app: AgentProfileApplicationDto, applicationInProgress = false) {
    mockPerf.profile.mockResolvedValue(view({ profileId: "profile-1", latestApplication: app, applicationInProgress }));
    mockProfiles.revisions.mockResolvedValue([]);
    return render();
  }

  it("lists every step with its result and offers Resume for a step failure", async () => {
    const node = await renderApplication(application());
    const block = node.querySelector<HTMLElement>("[data-testid='agent-profile-application']")!;
    expect(block.textContent).toContain("Application: Stopped before finishing");
    expect(block.textContent).toContain("The configuration write was refused.");
    const steps = Array.from(block.querySelectorAll("[data-testid='agent-profile-application-step']")).map((li) => li.textContent);
    expect(steps).toHaveLength(6);
    expect(steps[0]).toContain("Step 1. Requested access: Done");
    expect(steps[1]).toContain("Step 2. Configuration: Failed");
    expect(steps[3]).toContain("Routine bindings (checked, never changed): Not done yet");
    mockProfiles.resumeApplication.mockResolvedValue({ application: application({ status: "applied", failure: null }), activated: true });
    await click(block.querySelector<HTMLButtonElement>("[data-testid='agent-profile-resume']")!);
    expect(mockProfiles.resumeApplication).toHaveBeenCalledWith("company-1", "agent-1", "app-1");
    expect(node.querySelector("[data-testid='agent-profile-tab-status']")?.textContent).toBe("The approved revision is now active.");
  });

  it("shows the server's 403 when the viewer may not resume", async () => {
    const node = await renderApplication(application());
    mockProfiles.resumeApplication.mockRejectedValue(
      new ApiError("Only the approver or an administrator can resume a profile application", 403, {
        error: "Only the approver or an administrator can resume a profile application",
      }),
    );
    await click(node.querySelector<HTMLButtonElement>("[data-testid='agent-profile-resume']")!);
    const alert = node.querySelector("[data-testid='agent-profile-resume-error']");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe(
      "The server refused to resume this application: Only the approver or an administrator can resume a profile application",
    );
  });

  it("offers no Resume once an application ended on a stale base", async () => {
    const node = await renderApplication(
      application({
        status: "refused_stale",
        failure: { kind: "stale", step: null, detail: "The agent's profile, access policy or configuration changed after this revision was proposed." },
      }),
    );
    expect(node.textContent).toContain("Stopped: the agent changed after this was proposed");
    expect(node.textContent).toContain("This application has ended. Start a new draft");
    expect(node.querySelector("[data-testid='agent-profile-resume']")).toBeNull();
  });

  it("while applying, says new runs wait and offers no Resume", async () => {
    const node = await renderApplication(application({ status: "in_progress", failure: null }), true);
    expect(node.querySelector("[data-testid='agent-profile-applying']")?.textContent).toBe(APPLICATION_IN_PROGRESS_TEXT);
    expect(node.textContent).toContain("Application: Applying");
    expect(node.querySelector("[data-testid='agent-profile-resume']")).toBeNull();
  });

  it("treats an in-progress receipt the server no longer holds as interrupted and resumable", async () => {
    const node = await renderApplication(application({ status: "in_progress", failure: null }), false);
    expect(node.textContent).toContain("Interrupted: it stopped before finishing");
    expect(node.querySelector("[data-testid='agent-profile-resume']")).not.toBeNull();
  });

  it("offers no Resume for an applied receipt", async () => {
    const node = await renderApplication(application({ status: "applied", failure: null }));
    expect(node.textContent).toContain("Application: Applied");
    expect(node.querySelector("[data-testid='agent-profile-resume']")).toBeNull();
  });
});
