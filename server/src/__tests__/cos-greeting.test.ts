import { describe, expect, it } from "vitest";
import { buildPhase0Greeting } from "../services/onboarding-orchestrator.js";

describe("the Chief of Staff's first words", () => {
  it("names the company it works for, not the product it runs on", () => {
    // Reported as #449: a founder opening their own workspace was greeted by a
    // Chief of Staff introducing itself as working somewhere else. The rest of
    // that issue — company scoping of the conversation and its state — was
    // fixed by later rewrites; this line outlived all of them.
    const greeting = buildPhase0Greeting("Titus Shem", "MKThink");
    expect(greeting).toContain("Chief of Staff at MKThink");
    expect(greeting).not.toContain("Chief of Staff at AgentDash");
  });

  it("greets the person by their first name", () => {
    expect(buildPhase0Greeting("Titus Shem", "MKThink")).toMatch(/^Hi Titus!/);
  });

  it("falls back to the product name only for a workspace with no name yet", () => {
    expect(buildPhase0Greeting("Titus", null)).toContain("Chief of Staff at AgentDash");
    expect(buildPhase0Greeting("Titus", "   ")).toContain("Chief of Staff at AgentDash");
  });

  it("stays polite when it does not know who it is talking to", () => {
    expect(buildPhase0Greeting(null, "MKThink")).toMatch(/^Hi there!/);
  });
});
