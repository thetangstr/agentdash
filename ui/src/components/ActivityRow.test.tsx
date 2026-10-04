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
});
