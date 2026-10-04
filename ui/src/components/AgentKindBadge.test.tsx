// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  AgentKindBadge,
  agentKind,
  agentKindExplanation,
} from "./AgentKindBadge";

// The tooltip primitive portals its content and needs a provider; the trigger is
// what this component is asserting about, so it is rendered plainly.
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div data-testid="tip">{children}</div>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Kindish = Pick<Agent, "autonomy" | "accountable">;

const stewarded: Kindish = {
  autonomy: "stewarded",
  accountable: { userId: "u1", name: "Ada", email: "ada@example.test", via: "steward" },
};

const autonomous: Kindish = {
  autonomy: "autonomous",
  accountable: { userId: "u2", name: "Rowan", email: "rowan@example.test", via: "assignment" },
};

/**
 * A personal agent nobody finished pairing. The state that used to be
 * indistinguishable from an autonomous one, which is the whole reason this
 * component exists.
 */
const unpaired: Kindish = { autonomy: "stewarded", accountable: null };

describe("agentKind", () => {
  it("separates the three states", () => {
    expect(agentKind(stewarded)).toBe("stewarded");
    expect(agentKind(autonomous)).toBe("autonomous");
    expect(agentKind(unpaired)).toBe("unpaired");
  });

  it("treats a missing autonomy field as stewarded", () => {
    // Older payloads, and rows rebuilt from config revisions, carry neither
    // field. Reading those as autonomous would claim nobody runs an agent that
    // somebody does.
    expect(agentKind({} as Kindish)).toBe("unpaired");
    expect(agentKind({ accountable: stewarded.accountable } as Kindish)).toBe("stewarded");
  });
});

describe("agentKindExplanation", () => {
  it("names the accountable person for an autonomous agent", () => {
    const text = agentKindExplanation(autonomous);
    expect(text).toMatch(/no person runs it/);
    expect(text).toMatch(/Rowan is accountable/);
  });

  it("says what a stewarded agent is, in terms of the person", () => {
    expect(agentKindExplanation(stewarded)).toMatch(/Ada runs this agent/);
  });

  // AgentDash (canary c3): the hosted Chief of Staff is stewarded but runs on
  // the workspace server — "runs from their own terminal" was false there.
  it("describes a stewarded agent on a workspace adapter as server-run, not terminal-run", () => {
    const text = agentKindExplanation({ ...stewarded, adapterType: "claude_local" });
    expect(text).toMatch(/Ada answers for what this agent does/);
    expect(text).toMatch(/workspace server/);
    expect(text).not.toMatch(/own terminal/);
  });

  // Review-1019: the `process` adapter runs its command on this machine —
  // same wording applies even though its type lacks the `_local` suffix.
  it("describes a stewarded agent on the process adapter as server-run too", () => {
    const text = agentKindExplanation({ ...stewarded, adapterType: "process" });
    expect(text).toMatch(/workspace server/);
    expect(text).not.toMatch(/own terminal/);
  });

  it("tells someone what to do about an unpaired agent", () => {
    // An explanation of a broken state that does not say how to fix it leaves
    // the reader exactly where they started.
    const text = agentKindExplanation(unpaired);
    expect(text).toMatch(/nobody is paired with it yet/);
    expect(text).toMatch(/Assign a steward, or make it autonomous/);
  });

  it("still explains an autonomous agent whose accountable person is missing", () => {
    expect(agentKindExplanation({ autonomy: "autonomous", accountable: null })).toMatch(
      /Works on its own/,
    );
  });
});

describe("AgentKindBadge", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function render(agent: Kindish) {
    act(() => {
      createRoot(container).render(<AgentKindBadge agent={agent} />);
    });
  }

  it("labels each kind distinctly, in plain words", () => {
    render(autonomous);
    expect(container.textContent).toContain("Runs solo");

    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    render(stewarded);
    expect(container.textContent).toContain("Run by Ada");

    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    render(unpaired);
    expect(container.textContent).toContain("No one runs it yet");
  });

  it("carries the same explanation in the tooltip as the panel shows", () => {
    render(autonomous);
    expect(container.querySelector('[data-testid="tip"]')?.textContent).toBe(
      agentKindExplanation(autonomous),
    );
  });
  it("shows a neutral 'No one accountable' for an unpaired agent where stewards cannot be assigned, and the other kinds as usual", () => {
    act(() => {
      createRoot(container).render(<AgentKindBadge agent={unpaired} hideUnpaired />);
    });
    expect(container.textContent).toContain("No one accountable");
    expect(container.textContent).not.toContain("No one runs it yet");
    expect(container.querySelector('[data-testid="agent-kind-unaccountable"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="agent-kind-unpaired"]')).toBeNull();

    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(<AgentKindBadge agent={stewarded} hideUnpaired />);
    });
    expect(container.textContent).toContain("Run by Ada");
  });
});
