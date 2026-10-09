import { describe, expect, it } from "vitest";
import { stewardedRoutingNotice } from "./stewarded-routing-notice";

describe("stewardedRoutingNotice", () => {
  const agents = new Map([["agent-a", { name: "Agent A" }]]);
  const people = new Map([["steward-a", "Steward A"]]);

  it("names the agent and whose agent it is", () => {
    expect(
      stewardedRoutingNotice({ fromUserId: "steward-a", toAgentId: "agent-a" }, agents, people),
    ).toBe("Assigned to Agent A, Steward A's agent");
  });

  it("falls back to generic words when a name is unknown", () => {
    expect(stewardedRoutingNotice({ fromUserId: "someone", toAgentId: "other" }, agents, people)).toBe(
      "Assigned to their agent, this person's agent",
    );
  });

  it("says nothing when the assignment was not routed", () => {
    expect(stewardedRoutingNotice(undefined, agents, people)).toBeNull();
    expect(stewardedRoutingNotice(null, agents, people)).toBeNull();
  });
});
