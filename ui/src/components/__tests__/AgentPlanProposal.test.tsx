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

  it("renders all agents and CTAs without repeating the plan prose", async () => {
    const onConfirm = vi.fn();
    const onRevise = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AgentPlanProposal payload={samplePayload} onConfirm={onConfirm} onRevise={onRevise} />,
      );
    });

    expect(container.textContent).toContain("Ellie");
    expect(container.textContent).toContain("Quinn");
    // Scan 3, lane G: plain language — title-cased roles, no adapter chip.
    expect(container.textContent).toContain("Engineering Lead");
    expect(container.textContent).not.toContain("claude_local");
    // AgentDash (b2 polish): the rationale repeats the chat bubble and is not
    // re-rendered; the short/long-term alignment lines stay on the card.
    expect(container.textContent).not.toContain("Hits short-term ship goal");
    expect(container.textContent).toContain("ships v2");
    expect(container.textContent).toContain("lays groundwork");

    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(2);
    const setItUp = Array.from(buttons).find((b) => b.textContent?.includes("Set it up"))!;
    const revise = Array.from(buttons).find((b) => b.textContent?.includes("Let me revise"))!;
    expect(setItUp).toBeDefined();
    expect(revise).toBeDefined();

    // Scan 4, lane N: a confirmed plan disables "Let me revise", so the revise
    // flow is exercised first and "Set it up" last.
    // PR #210: "Let me revise" no longer fires onRevise immediately — it opens
    // an inline textarea + Send / Cancel form. Exercise the full flow:
    //   1. click "Let me revise" → form opens (textarea + Send button)
    //   2. type a revision into the textarea
    //   3. click "Send revision" → onRevise(text) fires
    await act(async () => {
      revise.click();
    });
    expect(onRevise).not.toHaveBeenCalled();
    const reviseForm = container.querySelector('[data-testid="plan-revise-form"]');
    expect(reviseForm).toBeTruthy();

    const textarea = reviseForm!.querySelector("textarea")!;
    expect(textarea).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea, "drop the QA");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const sendBtn = Array.from(reviseForm!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Send revision"),
    )!;
    expect(sendBtn).toBeDefined();
    await act(async () => {
      sendBtn.click();
    });
    expect(onRevise).toHaveBeenCalledOnce();
    expect(onRevise).toHaveBeenCalledWith("drop the QA");

    // The buttons re-render once the revise form closes; find Set it up again.
    const setItUpAgain = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Set it up"))!;
    await act(async () => {
      setItUpAgain.click();
    });
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Team hired");

    await act(async () => {
      root.unmount();
    });
  });

  // AgentDash (cos-followups review): a company that gates hires on board
  // approval gets pendingApproval back — "Team hired" would claim a team
  // that cannot work yet.
  it("says 'Sent for approval' when the hires are waiting on board approval", async () => {
    const onConfirm = vi.fn().mockResolvedValue({ pendingApproval: true, approvalIds: ["ap1"] });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AgentPlanProposal payload={samplePayload} onConfirm={onConfirm} onRevise={vi.fn()} />,
      );
    });

    const setItUp = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Set it up"),
    )!;
    await act(async () => {
      setItUp.click();
    });

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Sent for approval");
    expect(container.textContent).not.toContain("Team hired");

    await act(async () => {
      root.unmount();
    });
  });

  // AgentDash (review-1025 item 2): the card persists pendingApproval when it
  // is marked confirmed, so a reload or a second tab still reads "Sent for
  // approval" — the response object is gone by then.
  it("still says 'Sent for approval' when the card was persisted pending approval", async () => {
    const persisted: AgentPlanProposalV1Payload = {
      ...samplePayload,
      confirmedAt: "2026-10-04T00:00:00.000Z",
      confirmedAgentIds: ["a1", "a2"],
      pendingApproval: true,
    };
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AgentPlanProposal payload={persisted} onConfirm={vi.fn()} onRevise={vi.fn()} />,
      );
    });

    expect(container.textContent).toContain("Sent for approval");
    expect(container.textContent).not.toContain("Team hired");

    await act(async () => {
      root.unmount();
    });
  });

  // AgentDash (cos-followups-2 item 4): once the board decides, the card
  // leaves "Sent for approval" — a rejection reads "Not approved", never
  // back to "Team hired".
  it("says 'Not approved' when the board rejected the hires", async () => {
    const rejected: AgentPlanProposalV1Payload = {
      ...samplePayload,
      confirmedAt: "2026-10-04T00:00:00.000Z",
      confirmedAgentIds: ["a1", "a2"],
      pendingApproval: false,
      approvalRejected: true,
    };
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AgentPlanProposal payload={rejected} onConfirm={vi.fn()} onRevise={vi.fn()} />,
      );
    });

    expect(container.textContent).toContain("Not approved");
    expect(container.textContent).not.toContain("Team hired");
    expect(container.textContent).not.toContain("Sent for approval");

    await act(async () => {
      root.unmount();
    });
  });

  it("says 'Team hired' once every approval landed approved", async () => {
    const approved: AgentPlanProposalV1Payload = {
      ...samplePayload,
      confirmedAt: "2026-10-04T00:00:00.000Z",
      confirmedAgentIds: ["a1", "a2"],
      pendingApproval: false,
      approvalRejected: false,
    };
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AgentPlanProposal payload={approved} onConfirm={vi.fn()} onRevise={vi.fn()} />,
      );
    });

    expect(container.textContent).toContain("Team hired");
    expect(container.textContent).not.toContain("Not approved");
    expect(container.textContent).not.toContain("Sent for approval");

    await act(async () => {
      root.unmount();
    });
  });

  // AgentDash (review-1025 item 5): a 409 carrying details.repair is the
  // repair contract — a hire half-materialized, not a hired team. Show what
  // the server said instead of "Team hired".
  it("shows the server's message on a repair 409 instead of 'Team hired'", async () => {
    const { ApiError } = await import("../../api/client");
    const onConfirm = vi.fn().mockRejectedValue(
      new ApiError(
        "Hire accepted but configuration needs repair; use the existing agents, do not hire again",
        409,
        { error: "Hire accepted but configuration needs repair", details: { accepted: true, agentIds: ["a1"], repair: "Use instructions-bundle PATCH…" } },
      ),
    );
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AgentPlanProposal payload={samplePayload} onConfirm={onConfirm} onRevise={vi.fn()} />,
      );
    });

    const setItUp = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Set it up"),
    )!;
    await act(async () => {
      setItUp.click();
    });

    expect(container.textContent).not.toContain("Team hired");
    expect(container.textContent).toContain("configuration needs repair");

    await act(async () => {
      root.unmount();
    });
  });
});
