// @vitest-environment jsdom
// AgentDash (scan 3, lane G): the plan card speaks plain language.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentPlanProposal, formatPlanRole, isKnownPlanValue } from "./AgentPlanProposal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("formatPlanRole", () => {
  it("title-cases role slugs", () => {
    expect(formatPlanRole("proposal_drafter")).toBe("Proposal Drafter");
    expect(formatPlanRole("lead-researcher")).toBe("Lead Researcher");
  });

  it("uses the product's label for a known role", () => {
    expect(formatPlanRole("cto")).toBe("CTO");
  });

  it("keeps a role that is already written for people", () => {
    expect(formatPlanRole("Head of Growth")).toBe("Head of Growth");
    expect(formatPlanRole("")).toBe("");
  });
});

describe("isKnownPlanValue", () => {
  it("drops Unknown and empty values", () => {
    expect(isKnownPlanValue("Unknown")).toBe(false);
    expect(isKnownPlanValue(" unknown. ")).toBe(false);
    expect(isKnownPlanValue("")).toBe(false);
    expect(isKnownPlanValue(undefined)).toBe(false);
    expect(isKnownPlanValue("Win three bids")).toBe(true);
  });
});

describe("AgentPlanProposal", () => {
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

  it("shows people-facing roles and hides adapters and Unknown fields", () => {
    act(() => {
      root.render(
        <AgentPlanProposal
          payload={{
            rationale: "Two people to win more bids.",
            agents: [
              {
                role: "proposal_drafter",
                name: "Ellie",
                adapterType: "hermes_local",
                responsibilities: ["Draft proposals for open inquiries"],
                kpis: ["Proposals sent within 48 hours", "Unknown"],
              },
            ],
            alignmentToShortTerm: "Unknown",
            alignmentToLongTerm: "Builds a repeatable sales motion",
          } as never}
          onConfirm={() => {}}
          onRevise={() => {}}
        />,
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Ellie — Proposal Drafter");
    expect(text).not.toContain("proposal_drafter");
    expect(text).not.toContain("hermes_local");
    expect(text).not.toContain("Unknown");
    expect(text).not.toContain("Outcome measurements");
    expect(text).not.toContain("Short-term:");
    expect(text).toContain("Long-term: Builds a repeatable sales motion");
    expect(text).toContain("Targets: Proposals sent within 48 hours");
  });
});
