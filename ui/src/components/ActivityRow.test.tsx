// @vitest-environment jsdom
// AgentDash (review-1015): a run stopped because the issue closed is the
// product's doing — "Board stopped Scout's run" credited a click that only
// marked the issue done. AgentDash owns the row, and the verb names the
// issue the close came from.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, Agent } from "@paperclipai/shared";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { ActivityRow } from "./ActivityRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AGENTS = new Map<string, Agent>([["agent-1", { id: "agent-1", name: "Scout" } as Agent]]);

function cancelEvent(details: Record<string, unknown>): ActivityEvent {
  return {
    id: "event-1",
    companyId: "company-1",
    actorType: "user",
    actorId: "user-1",
    action: "heartbeat.cancelled",
    entityType: "heartbeat_run",
    entityId: "run-1",
    agentId: null,
    runId: null,
    details: { agentId: "agent-1", ...details },
    createdAt: new Date(),
  } as unknown as ActivityEvent;
}

describe("ActivityRow", () => {
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

  it("credits a status-close cancel to AgentDash and names the issue", () => {
    const event = cancelEvent({ source: "issue_status_done", identifier: "ACM-3" });
    act(() =>
      root.render(<ActivityRow event={event} agentMap={AGENTS} entityNameMap={new Map()} />),
    );
    expect(container.textContent).toContain("AgentDash");
    expect(container.textContent).toContain("stopped Scout's run — ACM-3 was marked done");
    expect(container.textContent).not.toContain("Board");
  });

  it("still names the person on a manual stop", () => {
    const event = cancelEvent({});
    act(() =>
      root.render(<ActivityRow event={event} agentMap={AGENTS} entityNameMap={new Map()} />),
    );
    expect(container.textContent).toContain("Board");
    expect(container.textContent).not.toContain("AgentDash");
    expect(container.textContent).toContain("stopped Scout's run");
  });

  function rowEvent(action: string, details: Record<string, unknown>): ActivityEvent {
    return {
      id: "event-1",
      companyId: "company-1",
      actorType: "user",
      actorId: "user-1",
      action,
      entityType: "issue",
      entityId: "issue-1",
      agentId: null,
      runId: null,
      details,
      createdAt: new Date(),
    } as unknown as ActivityEvent;
  }

  // AgentDash (c4 trust): a comment that reopens a closed issue is the
  // product's doing, and an approval the system opened must not read as the
  // person asking.
  it("credits an automatic reopen to AgentDash", () => {
    const event = rowEvent("issue.updated", {
      status: "todo",
      reopened: true,
      // AgentDash (c4 trust, review #1026): the server writes autoReopened
      // only when the comment itself caused the reopen — an explicit reopen
      // intent stays with the person.
      autoReopened: true,
      reopenedFrom: "done",
      source: "comment",
    });
    act(() =>
      root.render(<ActivityRow event={event} agentMap={AGENTS} entityNameMap={new Map()} />),
    );
    expect(container.textContent).toContain("AgentDash");
    expect(container.textContent).toContain("reopened");
    expect(container.textContent).not.toContain("Board");
  });

  it("keeps an explicit reopen with the person who asked", () => {
    const event = rowEvent("issue.updated", {
      status: "todo",
      reopened: true,
      reopenedFrom: "done",
    });
    act(() =>
      root.render(<ActivityRow event={event} agentMap={AGENTS} entityNameMap={new Map()} />),
    );
    expect(container.textContent).toContain("reopened");
    expect(container.textContent).toContain("Board");
    expect(container.textContent).not.toContain("AgentDash");
  });

  it("credits a system-opened approval to AgentDash", () => {
    const event = rowEvent("approval.created", { type: "hire_agent", source: "cos_plan" });
    act(() =>
      root.render(<ActivityRow event={event} agentMap={AGENTS} entityNameMap={new Map()} />),
    );
    expect(container.textContent).toContain("AgentDash");
    expect(container.textContent).toContain("requested approval for an agent hire");
    expect(container.textContent).not.toContain("Board");
  });

  it("still names the person on an approval they opened themselves", () => {
    const event = rowEvent("approval.created", { type: "hire_agent" });
    act(() =>
      root.render(<ActivityRow event={event} agentMap={AGENTS} entityNameMap={new Map()} />),
    );
    expect(container.textContent).toContain("Board");
    expect(container.textContent).not.toContain("AgentDash");
  });

  it("renders reference chips on issue.updated and issue.comment_added rows only", () => {
    const details = {
      removedReferencedIssues: [{ id: "i2", identifier: "ACM-2", title: "Other" }],
    };
    const updated = rowEvent("issue.updated", details);
    act(() =>
      root.render(<ActivityRow event={updated} agentMap={AGENTS} entityNameMap={new Map()} />),
    );
    expect(container.textContent).toContain("Removed references");
    expect(container.textContent).toContain("updated references");

    // A comment that adds or removes issue references carries the same diff —
    // the chips stay, but no stray "Removed references …" summary line returns.
    const commented = rowEvent("issue.comment_added", {
      ...details,
      bodySnippet: "Picking this up",
    });
    act(() =>
      root.render(<ActivityRow event={commented} agentMap={AGENTS} entityNameMap={new Map()} />),
    );
    expect(container.textContent).toContain("Removed references");
    expect(container.textContent).toContain("ACM-2");
    expect(container.textContent).not.toContain("Removed references ACM-2");

    const other = rowEvent("agent.updated", details);
    act(() =>
      root.render(<ActivityRow event={other} agentMap={AGENTS} entityNameMap={new Map()} />),
    );
    expect(container.textContent).not.toContain("Removed references");
  });

  // AgentDash (APM): profile rows are written against a revision, which has no name;
  // "Board applied a profile change to 2m ago" left the agent out.
  it("names the agent a profile change belongs to, and links to its Profile tab", () => {
    const event = {
      ...rowEvent("agent_profile.applied", { revisionNumber: 2 }),
      entityType: "agent_profile_revision",
      entityId: "revision-2",
      agentId: "agent-1",
    } as ActivityEvent;
    act(() =>
      root.render(<ActivityRow event={event} agentMap={AGENTS} entityNameMap={new Map([["agent:agent-1", "Scout"]])} />),
    );
    expect(container.textContent).toContain("Board");
    expect(container.textContent).toContain("applied a profile change to Scout");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/agents/agent-1/profile");
  });

  it("says a draft for a new role is for a new role", () => {
    const event = {
      ...rowEvent("agent_profile.draft_saved", { unbound: true, revisionNumber: 1 }),
      entityType: "agent_profile_revision",
      entityId: "revision-1",
      agentId: null,
    } as ActivityEvent;
    act(() =>
      root.render(<ActivityRow event={event} agentMap={AGENTS} entityNameMap={new Map()} />),
    );
    expect(container.textContent).toContain("Board");
    expect(container.textContent).toContain("saved a draft profile for a new role");
  });

  // "Builder was refused a project by the access rules of Builder" said the name twice.
  it("words an agent's own access refusal once, with its name first", () => {
    const refusal = (actorId: string, actorType: "agent" | "user", dimension: string) =>
      ({
        ...rowEvent("authz.refused", { reasonCode: "ACCESS_POLICY_REFUSED", dimension }),
        actorType,
        actorId,
        entityType: "agent",
        entityId: "agent-1",
        agentId: "agent-1",
      }) as ActivityEvent;
    const names = new Map([["agent:agent-1", "Scout"]]);
    act(() => root.render(<ActivityRow event={refusal("agent-1", "agent", "see.projects")} agentMap={AGENTS} entityNameMap={names} />));
    // The actor's name, then the verb, and no name after it.
    expect(container.textContent).toContain("was refused a project by its access rules");
    expect(container.textContent?.match(/Scout/g)).toHaveLength(1);

    // Someone else's contact refused by the agent's inbound rules still names whose rules.
    act(() => root.render(<ActivityRow event={refusal("user-1", "user", "talk.inbound")} agentMap={AGENTS} entityNameMap={names} />));
    expect(container.textContent).toContain("Board");
    expect(container.textContent).toContain("was refused contact by the access rules of Scout");
  });
});
