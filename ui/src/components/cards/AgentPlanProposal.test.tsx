// @vitest-environment jsdom
// AgentDash (scan 3, lane G): the plan card speaks plain language.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { AgentPlanProposal, PLAN_HIRED_LABEL, PLAN_SUPERSEDED_NOTE, formatPlanRole, isKnownPlanValue, planAgentTitle } from "./AgentPlanProposal";

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

  // Scan 4, lane N: written text keeps its punctuation.
  it("keeps hyphens and ampersands in written titles", () => {
    expect(formatPlanRole("Month-End Close Coordinator")).toBe("Month-End Close Coordinator");
    expect(formatPlanRole(" Client Onboarding & Process Builder ")).toBe("Client Onboarding & Process Builder");
  });
});

describe("planAgentTitle", () => {
  it("prefers the CoS-written title, verbatim and trimmed", () => {
    expect(planAgentTitle({ title: "  Client Onboarding & Process Builder ", role: "client_onboarding_process_builder" })).toBe(
      "Client Onboarding & Process Builder",
    );
    expect(planAgentTitle({ title: " ", role: "client_onboarding_process_builder" })).toBe("Client Onboarding Process Builder");
    expect(planAgentTitle({ role: "cto" })).toBe("CTO");
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
    // AgentDash (b2 polish): alignment prose stays in the chat bubble, not the card.
    expect(text).not.toContain("Short-term:");
    expect(text).not.toContain("Long-term:");
    expect(text).toContain("Targets: Proposals sent within 48 hours");
  });

  const plan = {
    rationale: "Close faster.",
    agents: [{ role: "close_coordinator", title: "Month-End Close Coordinator", name: "Marcus", adapterType: "hermes_local", responsibilities: [], kpis: [] }],
    alignmentToShortTerm: "This quarter",
    alignmentToLongTerm: "Next year",
  };
  function buttons() {
    return Array.from(container.querySelectorAll("button"));
  }
  function byLabel(label: string) {
    return buttons().find((b) => b.textContent === label) ?? null;
  }

  // Scan 4, lane N: after the hire the card stops offering "Set it up".
  it("shows Team hired with every button disabled once the plan is confirmed", () => {
    act(() => {
      root.render(<AgentPlanProposal payload={{ ...plan, confirmedAt: "2026-10-02T08:05:00Z" } as never} onConfirm={vi.fn()} onRevise={() => {}} />);
    });
    expect(container.textContent).toContain("Marcus — Month-End Close Coordinator");
    expect(byLabel("Set it up")).toBeNull();
    expect(byLabel(PLAN_HIRED_LABEL)?.disabled).toBe(true);
    expect(byLabel("Let me revise")?.disabled).toBe(true);
  });

  it("turns into Team hired after a successful Set it up", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(<AgentPlanProposal payload={plan as never} onConfirm={onConfirm} onRevise={() => {}} />);
    });
    await act(async () => byLabel("Set it up")!.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(byLabel(PLAN_HIRED_LABEL)?.disabled).toBe(true);
  });

  it("maps a 409 (already hired) to Team hired", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new ApiError("Hire already accepted", 409, { accepted: true }));
    act(() => {
      root.render(<AgentPlanProposal payload={plan as never} onConfirm={onConfirm} onRevise={() => {}} />);
    });
    await act(async () => byLabel("Set it up")!.click());
    expect(byLabel(PLAN_HIRED_LABEL)?.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  // PR #989 review: only the newest plan card offers actions.
  it("offers no actions on a plan card a newer one replaced", () => {
    act(() => {
      root.render(<AgentPlanProposal payload={plan as never} onConfirm={vi.fn()} onRevise={() => {}} superseded />);
    });
    expect(buttons()).toHaveLength(0);
    expect(container.textContent).toContain(PLAN_SUPERSEDED_NOTE);
  });

  it("maps a superseded_plan 409 to the replaced note, not Team hired", async () => {
    const onConfirm = vi.fn().mockRejectedValue(
      new ApiError("A newer plan replaced this one.", 409, { error: "x", details: { code: "superseded_plan" } }),
    );
    act(() => {
      root.render(<AgentPlanProposal payload={plan as never} onConfirm={onConfirm} onRevise={() => {}} />);
    });
    await act(async () => byLabel("Set it up")!.click());
    expect(byLabel(PLAN_HIRED_LABEL)).toBeNull();
    expect(container.textContent).toContain(PLAN_SUPERSEDED_NOTE);
  });

  it("shows any other failure and lets the person try again", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new ApiError("Your plan allows one agent.", 402, null));
    act(() => {
      root.render(<AgentPlanProposal payload={plan as never} onConfirm={onConfirm} onRevise={() => {}} />);
    });
    await act(async () => byLabel("Set it up")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your plan allows one agent.");
    expect(byLabel("Set it up")?.disabled).toBe(false);
  });
});
