// @vitest-environment jsdom
//
// Agent Performance Management gate 5 (P5.2): a draft profile for a role
// nobody holds yet. The editor is DESIGN.md's four steps (Work to own →
// Operating profile → Boundaries and checks → Review plan), keyboard
// operable, and moving between steps never loses an edit. Save draft writes
// the draft and nothing else ("Draft saved"); a stale save shows both
// versions and overwrites nothing. Request hire files the hire for the saved
// draft and says it needs approval and that nothing starts until then. The
// page also covers a pending hire, a bound profile, read-only, closed, 403.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PROFILE_DRAFT_CONFLICT,
  AGENT_PROFILE_HIRE_INVALID,
  DEFAULT_AGENT_GOVERNANCE_POLICY,
  agentOperatingProfileV1Schema,
  profileBodyHash,
  type AgentOperatingProfileV1,
  type AgentProfileRevisionDto,
  type UnboundAgentProfileView,
} from "@paperclipai/shared";
import { ApiError } from "../../api/client";

const mockUnbound = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  revision: vi.fn(),
  diff: vi.fn(),
  create: vi.fn(),
  createDraft: vi.fn(),
  saveDraft: vi.fn(),
  propose: vi.fn(),
  withdraw: vi.fn(),
  exportMarkdownUrl: vi.fn((c: string, p: string, r: string) => `/api/companies/${c}/agent-profiles/${p}/revisions/${r}/export.md`),
}));

vi.mock("../../api/agent-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-profiles")>();
  return { ...actual, unboundAgentProfilesApi: mockUnbound };
});
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { UnboundDraftView, UNBOUND_RESTRICTED_TEXT } = await import("./UnboundDraftView");
const { UNBOUND_DRAFT_INTRO_TEXT } = await import("./UnboundDraftEditor");
const { HIRE_NEEDS_APPROVAL_TEXT } = await import("./brief-shared");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function body(overrides: Partial<AgentOperatingProfileV1> = {}): AgentOperatingProfileV1 {
  return agentOperatingProfileV1Schema.parse({
    profileVersion: 1,
    identity: {
      name: "Rowan",
      title: "Collections assistant",
      summary: "Chases overdue invoices",
      audience: "",
      style: { tone: "", uncertaintyRule: "" },
    },
    responsibilities: [
      {
        key: "overdue-invoices",
        title: "Overdue invoices",
        outcome: "",
        stakeholders: [],
        obligation: { kind: "assigned" },
        deliverable: { what: "", destination: "" },
        escalation: { when: "" },
        performance: { criteria: [], coverage: [], outcomeLinks: [], expectedHumanSteps: [], judges: { automated: [] } },
      },
    ],
    knowledge: [],
    skills: [],
    access: { ...DEFAULT_AGENT_GOVERNANCE_POLICY, policyVersion: 2 },
    rhythm: { timezone: "UTC", reportTo: { userId: "user-yang" } },
    runtime: { adapterType: "claude_local" },
    ...overrides,
  });
}

function revision(overrides: Partial<AgentProfileRevisionDto> = {}): AgentProfileRevisionDto {
  const b = overrides.body ?? body();
  return {
    id: "rev-1",
    companyId: "company-1",
    profileId: "profile-1",
    agentId: null,
    revisionNumber: 1,
    basedOnRevisionId: null,
    state: "draft",
    body: b,
    bodyHash: profileBodyHash(b),
    provenance: { "/identity/name": { state: "from_brief", sourceRef: "brief:doc-1" } },
    sourceRefs: [],
    bases: null,
    createdByAgentId: "agent-cos",
    createdByUserId: null,
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

function view(overrides: Partial<UnboundAgentProfileView> = {}): UnboundAgentProfileView {
  const draft = overrides.latestDraft === undefined ? revision() : overrides.latestDraft;
  return {
    kind: "unbound_agent_profile_view",
    version: "agent-profile/1",
    companyId: "company-1",
    profileId: "profile-1",
    agentId: null,
    revisions: draft ? [summary(draft)] : [],
    latestDraft: draft,
    pendingProposal: null,
    hireApprovalId: null,
    viewer: { canEditDraft: true, canPropose: true, canWithdraw: false },
    ...overrides,
  };
}

const ADAPTERS = [
  { value: "claude_local", label: "Claude Code" },
  { value: "codex_local", label: "Codex" },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(briefIssueId: string | null = "issue-1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <UnboundDraftView companyId="company-1" profileId="profile-1" adapterOptions={ADAPTERS} briefIssueId={briefIssueId} />
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

function button(scope: HTMLElement, text: string | RegExp): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll("button")).find((el) =>
    typeof text === "string" ? el.textContent?.trim() === text : text.test(el.textContent ?? ""),
  );
  if (!found) throw new Error(`No button ${String(text)}`);
  return found as HTMLButtonElement;
}

function field(scope: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const el = Array.from(scope.querySelectorAll("label")).find((l) => l.textContent?.trim() === label);
  if (!el) throw new Error(`No label ${label}`);
  const input = scope.ownerDocument.getElementById(el.htmlFor);
  if (!input) throw new Error(`No input for ${label}`);
  return input as HTMLInputElement;
}

async function type(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function key(el: HTMLElement, keyName: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true }));
  });
}

function panel(node: HTMLElement, step: "work" | "profile" | "boundaries" | "review") {
  return byTestId(node, `unbound-step-panel-${step}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUnbound.get.mockResolvedValue(view());
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

// ---------------------------------------------------------------------------
// The four steps
// ---------------------------------------------------------------------------

describe("UnboundDraftView — the four steps", () => {
  it("shows DESIGN.md's four steps in order, one panel at a time, with a plain intro", async () => {
    const node = await render();
    expect(node.querySelector("h1")?.textContent).toBe("Draft profile: Rowan");
    expect(node.textContent).toContain(UNBOUND_DRAFT_INTRO_TEXT);
    const steps = Array.from(byTestId(node, "unbound-steps").querySelectorAll("button"));
    expect(steps.map((b) => b.textContent?.trim())).toEqual([
      "Step 1: Work to own",
      "Step 2: Operating profile",
      "Step 3: Boundaries and checks",
      "Step 4: Review plan",
    ]);
    expect(steps.every((b) => b.getAttribute("type") === "button")).toBe(true);
    expect(steps[0]!.getAttribute("aria-current")).toBe("step");
    expect(panel(node, "work").hidden).toBe(false);
    expect(panel(node, "profile").hidden).toBe(true);
    expect(panel(node, "boundaries").hidden).toBe(true);
    expect(panel(node, "review").hidden).toBe(true);
    // Every field carries its provenance label as text.
    for (const f of Array.from(panel(node, "work").querySelectorAll("[data-testid='agent-profile-field']"))) {
      expect(f.querySelector("[data-testid='agent-pm-provenance']")?.textContent?.length).toBeGreaterThan(0);
    }
    expect(panel(node, "work").textContent).toContain("From the brief");
  });

  it("is keyboard operable: arrows move between steps, activating one switches the panel, Next moves focus to its heading", async () => {
    const node = await render();
    const steps = Array.from(byTestId(node, "unbound-steps").querySelectorAll("button"));
    steps[0]!.focus();
    await key(steps[0]!, "ArrowRight");
    expect(document.activeElement).toBe(steps[1]);
    await key(steps[1]!, "End");
    expect(document.activeElement).toBe(steps[3]);
    await key(steps[3]!, "ArrowRight");
    expect(document.activeElement).toBe(steps[0]);
    await key(steps[0]!, "ArrowLeft");
    expect(document.activeElement).toBe(steps[3]);
    await key(steps[3]!, "Home");
    expect(document.activeElement).toBe(steps[0]);

    // Enter / Space on a native button is a click.
    steps[2]!.focus();
    await click(steps[2]!);
    expect(steps[2]!.getAttribute("aria-current")).toBe("step");
    expect(steps[0]!.getAttribute("aria-current")).toBeNull();
    expect(panel(node, "boundaries").hidden).toBe(false);
    expect(panel(node, "work").hidden).toBe(true);
    // Choosing a step from the step list keeps focus there; the change is announced.
    expect(document.activeElement).toBe(steps[2]);
    expect(byTestId(node, "unbound-step-status").textContent).toBe("Step 3 of 4: Boundaries and checks");

    await click(byTestId(node, "unbound-step-next"));
    expect(panel(node, "review").hidden).toBe(false);
    expect(document.activeElement?.textContent).toBe("Step 4 of 4: Review plan");
    await click(byTestId(node, "unbound-step-back"));
    expect(document.activeElement?.textContent).toBe("Step 3 of 4: Boundaries and checks");
  });

  it("puts the fields in their steps: work, operating profile (adapter choosable), boundaries and checks", async () => {
    const node = await render();
    const work = panel(node, "work");
    expect(work.textContent).toContain("Where the work comes from");
    expect(work.textContent).toContain("A new hire has no routines yet");
    expect(work.textContent).not.toContain("When to ask");
    const profile = panel(node, "profile");
    expect(profile.textContent).toContain("What it needs");
    expect(profile.textContent).toContain("Time zone");
    expect(profile.textContent).toContain("Tone");
    const adapter = field(profile, "Adapter(a company admin decides)") as HTMLSelectElement;
    expect(adapter.tagName).toBe("SELECT");
    expect(adapter.value).toBe("claude_local");
    const boundaries = panel(node, "boundaries");
    expect(boundaries.textContent).toContain("What it may do");
    expect(boundaries.textContent).toContain("When to ask");
    expect(boundaries.textContent).toContain("How we will judge the work");
    expect(boundaries.textContent).toContain("Overdue invoices");
  });

  it("keeps edits when moving between steps", async () => {
    const node = await render();
    await type(field(panel(node, "work"), "Name"), "Rowan Reyes");
    await click(byTestId(node, "unbound-step-boundaries"));
    await type(field(panel(node, "boundaries"), "When to ask"), "Disputes over $5,000");
    await click(byTestId(node, "unbound-step-work"));
    expect((field(panel(node, "work"), "Name") as HTMLInputElement).value).toBe("Rowan Reyes");
    await click(byTestId(node, "unbound-step-boundaries"));
    expect((field(panel(node, "boundaries"), "When to ask") as HTMLTextAreaElement).value).toBe("Disputes over $5,000");
    expect(node.textContent).toContain("You have unsaved changes.");
  });
});

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

describe("UnboundDraftView — Save draft", () => {
  it("saves with If-Match, says 'Draft saved', and never requests a hire", async () => {
    const node = await render();
    const draft = revision();
    const savedBody = body({ identity: { ...body().identity, name: "Rowan Reyes" } });
    mockUnbound.saveDraft.mockResolvedValue(revision({ body: savedBody, updatedAt: "2026-10-29T11:00:00.000Z" }));
    await type(field(panel(node, "work"), "Name"), "Rowan Reyes");
    const save = byTestId<HTMLButtonElement>(node, "agent-profile-save");
    save.focus();
    await click(save);

    expect(mockUnbound.saveDraft).toHaveBeenCalledTimes(1);
    const [companyId, profileId, revisionId, ifMatch, input] = mockUnbound.saveDraft.mock.calls[0]!;
    expect([companyId, profileId, revisionId, ifMatch]).toEqual(["company-1", "profile-1", "rev-1", draft.bodyHash]);
    expect(input.body.identity.name).toBe("Rowan Reyes");
    expect(input.provenance["/identity/name"].state).toBe("owner_confirmed");
    const status = byTestId(node, "agent-profile-draft-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("Draft saved");
    expect(document.activeElement).toBe(save);
    expect(node.textContent).not.toMatch(/Agent ready|Agent started|Agent hired/);
    expect(mockUnbound.propose).not.toHaveBeenCalled();
    expect(mockUnbound.create).not.toHaveBeenCalled();
    expect(mockUnbound.createDraft).not.toHaveBeenCalled();
  });

  it("on a 409 shows both versions, overwrites nothing, and saves over only when asked", async () => {
    const node = await render();
    const theirs = revision({ body: body({ identity: { ...body().identity, title: "Accounts receivable" } }), updatedAt: "2026-10-29T10:45:00.000Z" });
    mockUnbound.saveDraft.mockRejectedValueOnce(
      new ApiError("Draft changed", 409, { error: "Draft changed", code: AGENT_PROFILE_DRAFT_CONFLICT, current: theirs }),
    );
    await type(field(panel(node, "work"), "Name"), "Rowan Reyes");
    await click(byTestId(node, "agent-profile-save"));

    const conflict = byTestId(node, "agent-profile-conflict");
    expect(conflict.getAttribute("role")).toBe("alert");
    expect(conflict.textContent).toContain("Nothing was overwritten");
    expect(byTestId(node, "agent-profile-draft-status").textContent).toBe("");
    // The person's edit is still there.
    expect((field(panel(node, "work"), "Name") as HTMLInputElement).value).toBe("Rowan Reyes");

    mockUnbound.saveDraft.mockResolvedValueOnce(revision({ body: body({ identity: { ...body().identity, name: "Rowan Reyes" } }) }));
    await click(button(conflict, "Save my version over it"));
    expect(mockUnbound.saveDraft).toHaveBeenCalledTimes(2);
    expect(mockUnbound.saveDraft.mock.calls[1]![3]).toBe(theirs.bodyHash);
    expect(byTestId(node, "agent-profile-draft-status").textContent).toBe("Draft saved");
    expect(mockUnbound.propose).not.toHaveBeenCalled();
  });

  it("refuses an invalid draft locally and says which field; nothing is sent", async () => {
    const node = await render();
    await type(field(panel(node, "work"), "Name"), "");
    await click(byTestId(node, "agent-profile-save"));
    expect(byTestId(node, "agent-profile-editor-error").textContent).toContain("nothing was saved");
    expect(mockUnbound.saveDraft).not.toHaveBeenCalled();
  });

  it("exports the saved draft as Markdown, as the agent draft editor does", async () => {
    const node = await render();
    const link = byTestId<HTMLAnchorElement>(node, "unbound-export-markdown");
    expect(link.textContent).toBe("Export Markdown (saved draft)");
    expect(link.getAttribute("href")).toBe("/api/companies/company-1/agent-profiles/profile-1/revisions/rev-1/export.md");
    expect(link.getAttribute("download")).toBe("draft-profile-revision-1.md");
  });
});

// ---------------------------------------------------------------------------
// Request hire
// ---------------------------------------------------------------------------

describe("UnboundDraftView — Request hire", () => {
  it("files the hire for the saved draft, says it needs approval, and links the request", async () => {
    const node = await render("issue-1");
    await click(byTestId(node, "unbound-step-review"));
    const review = panel(node, "review");
    expect(review.textContent).toContain(HIRE_NEEDS_APPROVAL_TEXT);
    expect(review.textContent).toContain("Nothing blocks a hire request.");
    expect(byTestId(review, "unbound-review-body")).toBeTruthy();

    const proposed = revision({ state: "proposed", approvalId: "approval-7" });
    mockUnbound.propose.mockResolvedValue({ revision: proposed, approvalId: "approval-7", agentId: "agent-pending", payload: {} });
    mockUnbound.get.mockResolvedValue(
      view({ latestDraft: null, revisions: [summary(proposed)], pendingProposal: summary(proposed), hireApprovalId: "approval-7" }),
    );
    mockUnbound.revision.mockResolvedValue(proposed);
    await type(field(review, "Role"), "cfo");
    await type(field(review, "Why this role (optional)"), "Nobody owns collections today");
    await click(byTestId(review, "unbound-request-hire"));

    expect(mockUnbound.propose).toHaveBeenCalledWith("company-1", "profile-1", "rev-1", {
      role: "cfo",
      reason: "Nobody owns collections today",
      sourceIssueId: "issue-1",
    });
    expect(mockUnbound.saveDraft).not.toHaveBeenCalled();
    const status = byTestId(node, "unbound-draft-status");
    expect(status.textContent).toContain(`Hire requested for revision 1. ${HIRE_NEEDS_APPROVAL_TEXT}`);
    expect(byTestId(status, "unbound-draft-approval-link").getAttribute("href")).toBe("/approvals/approval-7");
    expect(document.activeElement).toBe(status);
    expect(node.textContent).not.toMatch(/Agent ready|Agent started|Agent hired/);
    // The page now shows the pending hire.
    expect(byTestId(node, "unbound-draft-pending").textContent).toContain(HIRE_NEEDS_APPROVAL_TEXT);
  });

  it("won't request a hire for unsaved changes", async () => {
    const node = await render();
    await type(field(panel(node, "work"), "Name"), "Rowan Reyes");
    await click(byTestId(node, "unbound-step-review"));
    const request = byTestId<HTMLButtonElement>(node, "unbound-request-hire");
    expect(request.getAttribute("aria-disabled")).toBe("true");
    expect(byTestId(node, "unbound-request-hire-hint").textContent).toContain("Save the draft first");
    expect(byTestId(node, "unbound-review-unsaved")).toBeTruthy();
    await click(request);
    expect(mockUnbound.propose).not.toHaveBeenCalled();
  });

  it("lists what blocks a hire (no adapter, a routine obligation) and goes to the step that fixes it", async () => {
    const blocked = revision({
      body: body({
        runtime: undefined,
        responsibilities: [
          { ...body().responsibilities[0]!, obligation: { kind: "routine", routineTriggerId: "00000000-0000-4000-8000-000000000001" } },
        ],
      }),
    });
    mockUnbound.get.mockResolvedValue(view({ latestDraft: blocked }));
    const node = await render();
    // With no adapter yet, the runtime disclosure starts open.
    expect(byTestId<HTMLDetailsElement>(panel(node, "profile"), "agent-profile-edit-runtime").open).toBe(true);
    await click(byTestId(node, "unbound-step-review"));
    const blockers = byTestId(node, "unbound-review-blockers-list");
    expect(blockers.textContent).toContain("Choose the adapter the new agent runs on");
    expect(blockers.textContent).toContain("“Overdue invoices” is bound to a routine");
    await click(byTestId(node, "unbound-request-hire"));
    expect(mockUnbound.propose).not.toHaveBeenCalled();
    await click(button(blockers, "Go to Operating profile"));
    expect(panel(node, "profile").hidden).toBe(false);
    expect(document.activeElement?.textContent).toBe("Step 2 of 4: Operating profile");
  });

  it("shows the server's hire refusals by field, and that nothing was requested", async () => {
    const node = await render();
    mockUnbound.propose.mockRejectedValue(
      new ApiError("This draft cannot be filed as a hire yet", 422, {
        error: "This draft cannot be filed as a hire yet",
        details: {
          code: AGENT_PROFILE_HIRE_INVALID,
          issues: [
            { path: "runtime.adapterType", message: "a hire needs the adapter type the new agent runs on" },
            { path: "responsibilities.0.obligation", message: "a new hire has no routines yet" },
            { path: "name", message: "already taken" },
          ],
        },
      }),
    );
    await click(byTestId(node, "unbound-step-review"));
    await click(byTestId(node, "unbound-request-hire"));
    const alert = byTestId(node, "unbound-hire-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("Nothing was requested.");
    // A draft field is named in the draft's words; a hire field by its path.
    expect(alert.textContent).toContain("Runtime › Adapter: a hire needs the adapter type the new agent runs on");
    expect(alert.textContent).toContain("Responsibility “Overdue invoices” › Obligation: a new hire has no routines yet");
    expect(alert.textContent).toContain("name: already taken");
  });

  it("offers a reload when the draft changed state elsewhere (409)", async () => {
    const node = await render();
    mockUnbound.propose.mockRejectedValue(new ApiError("Only a draft can be proposed", 409, { error: "Only a draft can be proposed" }));
    await click(byTestId(node, "unbound-step-review"));
    await click(byTestId(node, "unbound-request-hire"));
    const alert = byTestId(node, "unbound-hire-error");
    expect(alert.textContent).toContain("Nothing was requested.");
    const callsBefore = mockUnbound.get.mock.calls.length;
    await click(button(alert, "Reload the draft"));
    expect(mockUnbound.get.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("hides Request hire from someone who may not propose, and says who can", async () => {
    mockUnbound.get.mockResolvedValue(view({ viewer: { canEditDraft: true, canPropose: false, canWithdraw: false } }));
    const node = await render();
    await click(byTestId(node, "unbound-step-review"));
    expect(node.querySelector("[data-testid='unbound-request-hire']")).toBeNull();
    expect(byTestId(node, "unbound-review-no-hire").textContent).toContain(HIRE_NEEDS_APPROVAL_TEXT);
  });
});

// ---------------------------------------------------------------------------
// Page states
// ---------------------------------------------------------------------------

describe("UnboundDraftView — states", () => {
  it("a pending hire: says it needs approval, links the request, shows the frozen draft, and can be withdrawn", async () => {
    const proposed = revision({ state: "proposed", approvalId: "approval-7" });
    mockUnbound.get.mockResolvedValue(
      view({
        latestDraft: null,
        revisions: [summary(proposed)],
        pendingProposal: summary(proposed),
        hireApprovalId: "approval-7",
        viewer: { canEditDraft: false, canPropose: false, canWithdraw: true },
      }),
    );
    mockUnbound.revision.mockResolvedValue(proposed);
    const node = await render();
    const pending = byTestId(node, "unbound-draft-pending");
    expect(pending.textContent).toContain(`Hire requested for revision 1. ${HIRE_NEEDS_APPROVAL_TEXT}`);
    expect(byTestId(pending, "unbound-draft-pending-approval-link").getAttribute("href")).toBe("/approvals/approval-7");
    expect(byTestId(pending, "unbound-draft-pending-body")).toBeTruthy();
    expect(node.querySelector("[data-testid='unbound-draft-editor']")).toBeNull();

    mockUnbound.withdraw.mockResolvedValue({ ...proposed, state: "withdrawn" });
    await click(byTestId(pending, "unbound-draft-withdraw"));
    expect(mockUnbound.withdraw).toHaveBeenCalledWith("company-1", "profile-1", "rev-1");
    expect(byTestId(node, "unbound-draft-status").textContent).toContain("withdrawn. Nobody was hired.");
  });

  it("a profile bound by an approved hire points to the agent's Profile tab", async () => {
    mockUnbound.get.mockResolvedValue(view({ agentId: "agent-9", latestDraft: null, revisions: [summary(revision({ state: "applied", agentId: "agent-9" }))] }));
    const node = await render();
    const link = byTestId(node, "unbound-draft-bound").querySelector("a");
    expect(link?.getAttribute("href")).toBe("/agents/agent-9/profile");
    expect(node.querySelector("[data-testid='agent-profile-save']")).toBeNull();
  });

  it("read-only for someone who can't edit it", async () => {
    mockUnbound.get.mockResolvedValue(view({ viewer: { canEditDraft: false, canPropose: false, canWithdraw: false } }));
    const node = await render();
    expect(byTestId(node, "unbound-draft-readonly").textContent).toContain("Only an administrator who can create agents");
    expect(node.querySelector("[data-testid='agent-profile-save']")).toBeNull();
    expect(node.querySelector("[data-testid='unbound-request-hire']")).toBeNull();
  });

  it("no open draft after a rejection: says so and starts a new draft only when asked", async () => {
    const rejected = revision({ state: "rejected" });
    mockUnbound.get.mockResolvedValue(view({ latestDraft: null, revisions: [summary(rejected)] }));
    const node = await render();
    const closed = byTestId(node, "unbound-draft-closed");
    expect(closed.textContent).toContain("No open draft. The newest revision (1) is rejected.");
    expect(closed.textContent).toContain("Nobody was hired.");
    expect(mockUnbound.createDraft).not.toHaveBeenCalled();
    mockUnbound.createDraft.mockResolvedValue(revision({ id: "rev-2", revisionNumber: 2 }));
    await click(byTestId(closed, "unbound-draft-new"));
    expect(mockUnbound.createDraft).toHaveBeenCalledWith("company-1", "profile-1");
    expect(byTestId(node, "unbound-draft-status").textContent).toContain("Started draft revision 2");
  });

  it("explains a 403 and a 404 in words", async () => {
    mockUnbound.get.mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));
    let node = await render();
    expect(byTestId(node, "unbound-draft-restricted").textContent).toBe(UNBOUND_RESTRICTED_TEXT);
    act(() => root!.unmount());
    container?.remove();

    mockUnbound.get.mockRejectedValue(new ApiError("Draft profile not found", 404, { error: "Draft profile not found" }));
    node = await render();
    expect(byTestId(node, "unbound-draft-error").textContent).toContain("doesn't exist in this company");
  });

  it("links back to the brief it was opened from", async () => {
    const node = await render("issue-1");
    expect(byTestId(node, "unbound-draft-brief-link").getAttribute("href")).toBe("/agents/briefs/issue-1");
  });
});
