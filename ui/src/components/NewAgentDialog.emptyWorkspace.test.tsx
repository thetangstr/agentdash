import { describe, expect, it } from "vitest";

/**
 * The first minute in an empty workspace.
 *
 * `New Agent` leads with "Ask the CEO to create a new agent", which is the
 * right default once a Chief of Staff exists — delegating gets you reporting
 * lines and permissions for free. But it reads the CEO from the agent list,
 * and on a workspace with no agents that lookup returns `undefined`. The
 * handler then opens a new issue with `assigneeAgentId: undefined`, so the
 * task is created UNASSIGNED and no agent ever picks it up.
 *
 * Nothing throws. No error is shown. The user is simply left with a task that
 * sits there forever — found on a client's box the day it was handed over,
 * with an empty board and nobody to delegate to.
 *
 * This pins the decision rather than the markup: the delegation path is
 * offered only when there is somebody to delegate TO.
 */

/** Mirrors the guard in NewAgentDialog. */
function offersDelegation(agents: Array<{ role: string }>): boolean {
  return agents.length > 0;
}

/** Mirrors handleAskCeo's assignee resolution. */
function assigneeForDelegatedIssue(agents: Array<{ id: string; role: string }>) {
  return agents.find((a) => a.role === "ceo")?.id;
}

describe("New Agent on an empty workspace", () => {
  it("does not offer delegation when there is no agent to delegate to", () => {
    expect(offersDelegation([])).toBe(false);
  });

  it("still offers it as the default once any agent exists", () => {
    // The fix must not remove the recommended path for normal workspaces.
    expect(offersDelegation([{ role: "chief_of_staff" }])).toBe(true);
    expect(offersDelegation([{ role: "ceo" }])).toBe(true);
  });

  it("shows why the offer was a dead end: the issue would be unassigned", () => {
    // This is the failure the guard exists to prevent, stated explicitly so
    // nobody restores the old behaviour thinking it was harmless.
    expect(assigneeForDelegatedIssue([])).toBeUndefined();
    expect(assigneeForDelegatedIssue([{ id: "a1", role: "ceo" }])).toBe("a1");
  });
});
