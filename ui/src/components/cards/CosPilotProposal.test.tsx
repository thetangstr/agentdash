// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardRenderer } from "./index";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CosPilotProposal card", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const payload = {
    rationale: "Use the Chief of Staff to run a contained 30-day pilot.",
    delegationContract: {
      stakeholders: ["CBO", "Sales development lead"],
      goals: ["More qualified RFP submissions", "Reduced admin overhead"],
      preferences: ["Human approval before external submissions"],
      access: [
        {
          system: "HubSpot",
          purpose: "Qualify municipal opportunities",
          mode: "read_only",
          status: "requested",
        },
      ],
      operatingBoundaries: {
        canDo: ["Draft RFP responses"],
        requiresApproval: ["Submit RFPs", "Change billing/payroll/HR records"],
        neverDo: ["Make employment decisions"],
      },
      telemetry: ["Access used", "Drafts created", "Approval requests", "Time saved estimates"],
    },
    pilotPlan: {
      durationDays: 30,
      projectName: "30-day Chief of Staff pilot",
      heartbeatCadence: "Daily business-day brief",
      successMetrics: [
        { label: "Qualified RFP drafts", target: "3 ready for human review" },
        { label: "Time saved", target: "8 hours" },
      ],
      workstreams: [
        {
          id: "rfp",
          title: "RFP pipeline",
          outcome: "More qualified RFP drafts.",
          weeklySteps: ["Map sources", "Draft first response"],
        },
      ],
      approvalGates: ["No external submission without human approval"],
    },
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the delegation contract, pilot plan, and launch action", async () => {
    const onConfirm = vi.fn();

    await act(async () => {
      root.render(
        <CardRenderer
          cardKind="cos_pilot_proposal_v1"
          payload={payload}
          context={{ onProposalConfirm: onConfirm }}
        />,
      );
    });

    expect(container.textContent).toContain("Delegation contract");
    expect(container.textContent).toContain("30-day Chief of Staff pilot");
    expect(container.textContent).toContain("Human approval before external submissions");
    expect(container.textContent).toContain("No external submission without human approval");

    const launch = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Launch pilot"),
    );
    expect(launch).toBeTruthy();

    await act(async () => {
      launch?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("collects custom contract revision text before sending", async () => {
    const onRevise = vi.fn();

    await act(async () => {
      root.render(
        <CardRenderer
          cardKind="cos_pilot_proposal_v1"
          payload={payload}
          context={{ onProposalReject: onRevise }}
        />,
      );
    });

    const revise = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Revise contract"),
    );
    expect(revise).toBeTruthy();

    await act(async () => {
      revise?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, "Keep HubSpot read-only and make the pilot CBO-first.");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const send = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Send revision"),
    );
    await act(async () => {
      send?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRevise).toHaveBeenCalledWith(
      "Keep HubSpot read-only and make the pilot CBO-first.",
    );
  });
});
