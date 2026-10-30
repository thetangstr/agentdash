// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfileChangePayload } from "@paperclipai/shared";

// The profile-change renderer links to the agent's tabs; a plain anchor stands in for the company-prefixed Link.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { ApprovalPayloadRenderer, approvalLabel, HireAgentPayload, typeLabel } = await import("./ApprovalPayload");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Approval: Reply with an ASCII frog");
  });

  // AgentDash (c4-hire-ux): a hire reads the way the owner would say it — the
  // human title, never the internal role slug.
  it("reads a hire as 'Hire <name> as <title>'", () => {
    expect(approvalLabel("hire_agent", { name: "Bea", title: "Bookkeeper", role: "finance" })).toBe(
      "Hire Bea as Bookkeeper",
    );
    expect(approvalLabel("hire_agent", { name: "Bea" })).toBe("Hire Bea");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("shows the hire's model in plain words for a hermes_local payload", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="hire_agent"
          payload={{
            name: "Ava",
            role: "chief_of_staff",
            title: "Chief of Staff",
            adapterType: "hermes_local",
            adapterConfig: { model: "qwen3.8-max", provider: "alibaba-token-plan-cn" },
            metadata: { modelTier: "high" },
          }}
        />,
      );
    });
    expect(container.textContent).toContain("Qwen 3.8 Max · high tier");
    expect(container.textContent).not.toContain("qwen3.8-max");
    act(() => { root.unmount(); });
  });

  it("renders the server-stamped tier+model when the payload carries them", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <HireAgentPayload
          payload={{
            name: "Bex",
            role: "engineer",
            adapterType: "hermes_local",
            modelTier: "low",
            model: "deepseek-v4.1-flash",
          }}
        />,
      );
    });
    expect(container.textContent).toContain("DeepSeek V4.1 Flash · ops tier");
    act(() => { root.unmount(); });
  });

  it("shows NO model line for a modelless hermes_local hire — never a guessed tier", () => {
    // Review-1028 (item 6): when the server stamped nothing — tiers off,
    // BYOK, or an older payload — guessing a tier here would lie.
    const root = createRoot(container);
    act(() => {
      root.render(
        <HireAgentPayload
          payload={{ name: "Bex", role: "engineer", adapterType: "hermes_local" }}
        />,
      );
    });
    expect(container.textContent).not.toContain("Model");
    expect(container.textContent).not.toContain("tier");
    act(() => { root.unmount(); });
  });

  it("shows no model line for a non-hermes adapter", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <HireAgentPayload
          payload={{ name: "Claude", role: "engineer", adapterType: "claude_local" }}
        />,
      );
    });
    expect(container.textContent).not.toContain("Model");
    act(() => { root.unmount(); });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });
});

describe("agent_profile_change renderer (APM gate 2)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const AGENT = "11111111-1111-4111-8111-111111111111";

  function payload(overrides: Partial<AgentProfileChangePayload> = {}): AgentProfileChangePayload {
    return {
      agentId: AGENT,
      profileId: "22222222-2222-4222-8222-222222222222",
      revisionId: "33333333-3333-4333-8333-333333333333",
      revisionNumber: 4,
      basedOnRevisionId: null,
      bases: { basedOnRevisionId: null, governanceRevision: 3, configRevisionId: null },
      bodyHash: "a".repeat(64),
      diff: [
        { op: "replace", pointer: "/identity/title", before: "Analyst", after: "Head of revenue" },
        { op: "replace", pointer: "/runtime/model", before: "small", after: "large" },
        { op: "replace", pointer: "/access/see/projects", before: { mode: "listed", ids: ["p1"] }, after: { mode: "all", ids: [] } },
        { op: "replace", pointer: "/skills", before: ["crm"], after: ["crm", "billing"] },
        { op: "add", pointer: "/responsibilities/1", after: { key: "billing", title: "Billing follow-up" }, key: "billing", title: "Billing follow-up" },
      ],
      fieldAuthority: [
        { pointer: "/identity/title", required: "steward_or_accountable", reason: null },
        { pointer: "/runtime/model", required: "admin", reason: "adapter settings run on the host" },
        { pointer: "/access/see/projects", required: "admin_ceiling", reason: "asks for more than the admin's ceiling" },
        { pointer: "/skills", required: "steward_or_accountable", reason: "limited to the skills its access allows" },
        { pointer: "/responsibilities/1", required: "steward_or_accountable", reason: null },
      ],
      requiredAuthority: "admin_ceiling",
      affectedResponsibilities: ["billing"],
      accessChanges: [
        {
          dimension: "see.projects",
          change: "widens",
          clippedByCeiling: true,
          clip: { dimension: "see.projects", detail: "Asks for all projects; the ceiling allows 2 listed projects", values: ["p3"] },
          detail: "Projects: listed → all",
        },
        { dimension: "talk.agents", change: "narrows", clippedByCeiling: false, detail: "Agents: any → reports chain" },
      ],
      evidence: { cardId: "card-7", cardVersion: 2, ledgerEventIds: ["evt-a", "evt-b"] },
      reason: "The title and duties grew.",
      expectedBenefit: "Billing follow-ups stop slipping.",
      risks: "Wider project reads.",
      proposedBy: { kind: "agent", agentId: "44444444-4444-4444-8444-444444444444", runId: null },
      ...overrides,
    };
  }

  function renderPayload(p: Record<string, unknown>) {
    act(() => {
      root.render(<ApprovalPayloadRenderer type="agent_profile_change" payload={p} />);
    });
    return container.querySelector<HTMLElement>("[data-testid='agent-profile-change-payload']")!;
  }

  it("labels the approval and its type", () => {
    expect(typeLabel.agent_profile_change).toBe("Profile change");
    expect(approvalLabel("agent_profile_change", { revisionNumber: 4 })).toBe("Profile change: revision 4");
  });

  it("shows the diff with the authority each field needs and its reason", () => {
    const node = renderPayload(payload() as unknown as Record<string, unknown>);
    const entries = Array.from(node.querySelectorAll("[data-testid='agent-profile-diff-entry']")).map((li) => li.textContent ?? "");
    expect(entries).toHaveLength(5);
    expect(entries[0]).toContain("Changed: Identity › Title");
    expect(entries[0]).toContain("Needs: The steward, the accountable person or a company admin");
    expect(entries[1]).toContain("Runtime › Model");
    expect(entries[1]).toContain("Needs: A company admin — adapter settings run on the host");
    expect(entries[2]).toContain("Needs: A company admin, who raises the ceiling as a separate recorded step — asks for more than the admin's ceiling");
    expect(entries[3]).toContain("— limited to the skills its access allows");
    expect(entries[4]).toContain("Added: Responsibility “Billing follow-up”");
    expect(node.querySelector("[data-testid='agent-profile-change-required']")?.textContent).toContain(
      "A company admin, who raises the ceiling as a separate recorded step.",
    );
    expect(node.textContent).not.toContain('"pointer"');
  });

  it("names the responsibility an entry sits in from the diff's key and title, not its position", () => {
    const node = renderPayload(
      payload({
        diff: [
          {
            op: "replace",
            pointer: "/responsibilities/0/outcome",
            before: "Monday",
            after: "Monday 9:00",
            key: "weekly-pipeline-report",
            title: "Weekly pipeline report",
          },
          { op: "replace", pointer: "/responsibilities/1/escalation/when", before: "a", after: "b", key: "billing" },
          // An approval filed before entries carried the member: the position is all there is.
          { op: "replace", pointer: "/responsibilities/2/outcome", before: "a", after: "b" },
        ],
        fieldAuthority: [],
      }) as unknown as Record<string, unknown>,
    );
    const entries = Array.from(node.querySelectorAll("[data-testid='agent-profile-diff-entry']")).map((li) => li.textContent ?? "");
    expect(entries[0]).toContain("Changed: Responsibility “Weekly pipeline report” › Outcome");
    expect(entries[1]).toContain("Changed: Responsibility “billing” › Escalation › When");
    expect(entries[2]).toContain("Changed: Responsibility “#3” › Outcome");
  });

  it("highlights widening and clipping in words, not only colour", () => {
    const node = renderPayload(payload() as unknown as Record<string, unknown>);
    expect(node.querySelector("[data-testid='agent-profile-change-widening']")?.textContent).toContain(
      "1 access change widens access or is clipped by the ceiling.",
    );
    const rows = Array.from(node.querySelectorAll("[data-testid='agent-profile-change-access']"));
    expect(rows[0].getAttribute("data-flagged")).toBe("true");
    expect(rows[0].textContent).toContain("Projects it can see: Widens access · clipped by the ceiling");
    expect(rows[0].textContent).toContain("Asks for all projects; the ceiling allows 2 listed projects");
    expect(rows[0].textContent).toContain("Beyond the ceiling: p3.");
    expect(rows[1].getAttribute("data-flagged")).toBe("false");
    expect(rows[1].textContent).toContain("Agents it can reach: Narrows access");
  });

  it("says what applying will change, and that approval alone changes nothing", () => {
    const node = renderPayload(payload() as unknown as Record<string, unknown>);
    const consequences = node.querySelector("[data-testid='agent-profile-change-consequences']")?.textContent ?? "";
    expect(consequences).toContain("Its requested access is updated. The admin's ceiling still limits it.");
    expect(consequences).toContain("configuration (model, heartbeat)");
    expect(consequences).toContain("installed skills are synced, limited to the skills its access allows");
    expect(consequences).toContain("evaluation contract");
    expect(consequences).toContain("Routine bindings are checked. Routines themselves are never changed.");
    expect(consequences).toContain("Revision 4 becomes the active profile");
    expect(consequences).toContain("Nothing changes before approval.");
    expect(consequences).not.toContain("execution environment");
  });

  // APM gate 4 (P4.2): the performance manager's proposals are marked, and say the manager never decides or applies.
  it("marks a proposal the performance manager filed, and says what that role may not do", () => {
    const node = renderPayload(
      payload({
        proposedBy: { kind: "agent", agentId: "44444444-4444-4444-8444-444444444444", runId: null, capacity: "performance_manager" },
      }) as unknown as Record<string, unknown>,
    );
    expect(node.querySelector("[data-testid='agent-profile-change-manager-filed']")?.textContent).toBe("Proposed by the performance manager");
    const proposer = node.querySelector("[data-testid='agent-profile-change-proposer']")?.textContent ?? "";
    expect(proposer).toContain("The company's performance manager, an agent (44444444).");
    expect(proposer).toContain("It can never decide its own proposal.");
    expect(proposer).toContain("It never approves, applies, changes an agent's access or edits an active profile.");
  });

  it("does not mark an ordinary agent's or a person's proposal as the performance manager's", () => {
    const byAgent = renderPayload(payload() as unknown as Record<string, unknown>);
    expect(byAgent.querySelector("[data-testid='agent-profile-change-manager-filed']")).toBeNull();
    expect(byAgent.textContent).not.toContain("performance manager");
    const byPerson = renderPayload(payload({ proposedBy: { kind: "user", userId: "user-yang" } }) as unknown as Record<string, unknown>);
    expect(byPerson.querySelector("[data-testid='agent-profile-change-manager-filed']")).toBeNull();
  });

  it("lists the evidence and links to the agent's performance and profile", () => {
    const node = renderPayload(payload() as unknown as Record<string, unknown>);
    const evidence = node.querySelector<HTMLElement>("[data-testid='agent-profile-change-evidence']")!;
    expect(evidence.textContent).toContain("card-7, version 2");
    expect(evidence.textContent).toContain("evt-a, evt-b");
    const hrefs = Array.from(evidence.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([`/agents/${AGENT}/performance`, `/agents/${AGENT}/profile`]);
    expect(node.textContent).toContain("The proposing agent can never decide its own proposal.");
    expect(node.textContent).toContain("The title and duties grew.");
  });

  it("renders an older or partial payload without crashing or dumping JSON", () => {
    const node = renderPayload({ agentId: AGENT, revisionNumber: 2 });
    expect(node.textContent).toContain("Revision 2 of this agent's operating profile");
    expect(node.textContent).toContain("No change to what it may see, do, talk to or spend.");
    expect(node.textContent).toContain("No field changes are recorded in this request.");
    expect(node.textContent).toContain("No evidence was attached to this request.");
    expect(container.querySelector("pre")).toBeNull();
  });
});


// AgentDash (APM gate 5, P5.2): a hire filed from a draft profile for a new
// role carries the profile. The renderer names it, lists the work it would
// own, says approving applies it and nothing runs before, and links the draft.
describe("hire_agent with a draft profile (APM gate 5)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const PROFILE = "22222222-2222-4222-8222-222222222222";

  function hirePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: "Rowan",
      role: "general",
      title: "Collections assistant",
      adapterType: "claude_local",
      profileId: PROFILE,
      profileRevisionId: "33333333-3333-4333-8333-333333333333",
      profileRevisionNumber: 2,
      profileBodyHash: "b".repeat(64),
      profileChange: {
        agentId: "11111111-1111-4111-8111-111111111111",
        profileId: PROFILE,
        revisionId: "33333333-3333-4333-8333-333333333333",
        revisionNumber: 2,
        basedOnRevisionId: null,
        bases: { basedOnRevisionId: null, governanceRevision: null, configRevisionId: null },
        bodyHash: "b".repeat(64),
        diff: [
          { op: "add", pointer: "/responsibilities/0", after: { key: "overdue", title: "Overdue invoices" }, key: "overdue", title: "Overdue invoices" },
          { op: "replace", pointer: "/identity/title", before: "", after: "Collections assistant" },
        ],
        fieldAuthority: [],
        requiredAuthority: "steward_or_accountable",
        affectedResponsibilities: ["overdue", "dunning"],
        accessChanges: [],
        evidence: { ledgerEventIds: [] },
        reason: null,
        expectedBenefit: null,
        risks: null,
        proposedBy: { kind: "user", userId: "user-yang" },
      },
      ...overrides,
    };
  }

  function render(payload: Record<string, unknown>) {
    act(() => {
      root.render(<ApprovalPayloadRenderer type="hire_agent" payload={payload} />);
    });
    return container;
  }

  it("shows the attached profile and links to the draft", async () => {
    const { HIRE_PROFILE_APPLY_TEXT } = await import("./ApprovalPayload");
    const node = render(hirePayload());
    const section = node.querySelector<HTMLElement>("[data-testid='hire-agent-profile']")!;
    expect(section.textContent).toContain("Operating profile: draft revision 2");
    expect(section.textContent).toContain("Work it would own: Overdue invoices, dunning.");
    expect(section.textContent).toContain(HIRE_PROFILE_APPLY_TEXT);
    expect(section.querySelector("[data-testid='hire-agent-profile-link']")?.getAttribute("href")).toBe(`/agents/drafts/${PROFILE}`);
    // The ordinary hire fields still render.
    expect(node.textContent).toContain("Rowan");
    expect(node.querySelector("pre")).toBeNull();
  });

  it("an unreadable profile block still names it and links the draft, without dumping JSON", () => {
    const node = render(hirePayload({ profileChange: { nonsense: true } }));
    const section = node.querySelector<HTMLElement>("[data-testid='hire-agent-profile']")!;
    expect(section.textContent).toContain("its details couldn't be read");
    expect(section.querySelector("a")?.getAttribute("href")).toBe(`/agents/drafts/${PROFILE}`);
    expect(node.textContent).not.toContain("nonsense");
  });

  it("an ordinary hire shows no profile block", () => {
    const node = render({ name: "Bea", role: "finance", title: "Bookkeeper", adapterType: "claude_local" });
    expect(node.querySelector("[data-testid='hire-agent-profile']")).toBeNull();
  });
});
