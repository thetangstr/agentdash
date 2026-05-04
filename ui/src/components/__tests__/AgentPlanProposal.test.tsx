// @vitest-environment jsdom
// AgentDash: chat substrate — AgentPlanProposal render test (Phase C)

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPlanProposal } from "../cards/AgentPlanProposal";
import type { AgentPlanProposalV1Payload } from "@paperclipai/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const samplePayload: AgentPlanProposalV1Payload = {
  rationale: "Hits short-term ship goal AND seeds the long-term ops org.",
  agents: [
    {
      role: "engineering_lead",
      name: "Ellie",
      adapterType: "claude_local",
      responsibilities: ["own dashboard"],
      kpis: ["ship Q3"],
    },
    {
      role: "qa",
      name: "Quinn",
      adapterType: "claude_local",
      responsibilities: ["test nightly"],
      kpis: ["zero P0 escapes"],
    },
  ],
  alignmentToShortTerm: "ships v2",
  alignmentToLongTerm: "lays groundwork",
};

describe("AgentPlanProposal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders rationale, all agents, alignment, and CTAs", async () => {
    const onConfirm = vi.fn();
    const onRevise = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AgentPlanProposal payload={samplePayload} onConfirm={onConfirm} onRevise={onRevise} />,
      );
    });

    expect(container.textContent).toContain("Hits short-term ship goal");
    expect(container.textContent).toContain("Ellie");
    expect(container.textContent).toContain("Quinn");
    expect(container.textContent).toContain("claude_local");
    expect(container.textContent).toContain("ships v2");
    expect(container.textContent).toContain("lays groundwork");

    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(2);
    const setItUp = Array.from(buttons).find((b) => b.textContent?.includes("Set it up"))!;
    const revise = Array.from(buttons).find((b) => b.textContent?.includes("Let me revise"))!;
    expect(setItUp).toBeDefined();
    expect(revise).toBeDefined();

    await act(async () => {
      setItUp.click();
    });
    expect(onConfirm).toHaveBeenCalledOnce();

    await act(async () => {
      revise.click();
    });
    expect(onRevise).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
    });
  });
});
