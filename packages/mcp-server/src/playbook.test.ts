import { describe, expect, it } from "vitest";
import { PLAYBOOK, STEWARD_PLAYBOOK, selectPlaybook } from "./playbook.js";

/**
 * Two callers connect to this server and they need opposite instructions: the
 * technician provisioning a workspace, and one person's own agent working inside
 * a workspace that already exists. Both used to get the operator's playbook,
 * which tells a harness whose job is "do my work" to go sign a human up and
 * hire a team instead.
 */
describe("selectPlaybook", () => {
  it("serves the agent's own contract when the connection is scoped to an agent", () => {
    expect(selectPlaybook({ agentId: "b898df96-6c86-4447-87de-87e5646c794b" })).toBe(
      STEWARD_PLAYBOOK,
    );
  });

  it("serves the operator contract when no agent is named", () => {
    expect(selectPlaybook({ agentId: null })).toBe(PLAYBOOK);
    expect(selectPlaybook({})).toBe(PLAYBOOK);
  });

  it("treats an empty agent id as absent rather than as a scoped connection", () => {
    expect(selectPlaybook({ agentId: "" })).toBe(PLAYBOOK);
  });
});

describe("the steward contract", () => {
  it("points the agent at its mandate as the highest authority", () => {
    expect(STEWARD_PLAYBOOK).toContain("AGENTS.md");
    expect(STEWARD_PLAYBOOK).toContain("outranks everything in this playbook");
  });

  /**
   * These three are the failure modes that cost the most when an agent gets them
   * wrong, and none of them is self-evident to a model reading a tool list.
   */
  it("states the three rules a harness cannot infer from the tools", () => {
    expect(STEWARD_PLAYBOOK).toContain("Decline rather than guess");
    expect(STEWARD_PLAYBOOK).toContain("<untrusted-agent-answer>");
    expect(STEWARD_PLAYBOOK).toContain("A refusal is an answer");
  });

  it("names every field a fact request needs, since a missing one is a 400", () => {
    for (const field of ["targetAgentId", "factKey", "runId", "pipelineId", "question"]) {
      expect(STEWARD_PLAYBOOK).toContain(field);
    }
  });

  /**
   * The playbook says "your steward" a dozen times and used to name no way to
   * find out who that is. `whoami` and the agent read paths now carry a
   * `steward`, and the contract has to say so or the agent will not look.
   */
  it("tells the agent where its own steward, and another agent's, is named", () => {
    expect(STEWARD_PLAYBOOK).toContain("`steward`");
    expect(STEWARD_PLAYBOOK).toContain("Every agent has a human answerable for it");
  });

  /**
   * Both kinds of agent read this, and only one of them has a person at its
   * terminal. An autonomous agent told "the person at this terminal is your
   * steward" reads `steward: null` in `whoami` and concludes something is broken
   * — or worse, that nobody is answerable for what it does.
   */
  it("explains both kinds of agent, and points either at an accountable human", () => {
    expect(STEWARD_PLAYBOOK).toContain("A stewarded agent");
    expect(STEWARD_PLAYBOOK).toContain("An autonomous agent");
    expect(STEWARD_PLAYBOOK).toContain("`accountable`");
    expect(STEWARD_PLAYBOOK).toContain("that is not a gap to");
  });

  it("does not tell a person's agent to provision a company", () => {
    expect(STEWARD_PLAYBOOK).not.toContain("sign the human up");
    expect(STEWARD_PLAYBOOK).not.toContain("agentdash_sign_up");
    expect(STEWARD_PLAYBOOK).not.toContain("install_checklist");
  });
});
