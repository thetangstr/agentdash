// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoSPilotTrustDeck } from "./CoSPilotTrustDeck";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CoSPilotTrustDeck", () => {
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

  it("renders individual level slides and the summary progression", () => {
    act(() => {
      root.render(<CoSPilotTrustDeck />);
    });

    expect(container.textContent).toContain("Context + Trust = Capability");
    expect(container.textContent).toContain("Personal Local Agent");
    expect(container.textContent).toContain("Claude, Claude Code, Codex");
    expect(container.textContent).toContain("Hermes or OpenClaw");
    expect(container.textContent).toContain("AgentDash / Paperclip");
    expect(container.textContent).toContain("goals and OKRs");
    expect(container.textContent).toContain("Executive Chief of Staff");
    expect(container.textContent).toContain("The executive operating loop");
    expect(container.textContent).toContain("Approved context");
    expect(container.textContent).toContain("Visible operating work");
    expect(container.textContent).toContain("What the Chief of Staff gives back");
    expect(container.textContent).toContain("Meeting briefs");
    expect(container.textContent).toContain("Signal triage");
    expect(container.textContent).toContain("Opportunity motion");
    expect(container.textContent).toContain("Sharper prep");
    expect(container.textContent).toContain("Shots on goal");
    expect(container.textContent).toContain("Communicable Agent");
    expect(container.textContent).toContain("multiple humans can talk to the same agent");
    expect(container.textContent).toContain("Mac mini on your company network");
    expect(container.textContent).toContain("Access to Teams as an agent");
    expect(container.textContent).toContain("Each M365 implementation could have different limits");
    expect(container.textContent).toContain("Company-Aware Gateway Agent");
    expect(container.textContent).toContain("Level 1 plus approved company knowledge");
    expect(container.textContent).toContain("Level 1 inputs");
    expect(container.textContent).toContain("Gateway agent");
    expect(container.textContent).toContain("Company knowledge database");
    expect(container.textContent).toContain("Useful artifacts");
    expect(container.textContent).toContain("Open questions");
    expect(container.textContent).not.toContain("Grounded work");
    expect(container.textContent).not.toContain("Missing inputs");
    expect(container.textContent).toContain("Access to a shared company database");
    expect(container.textContent).toContain("OneDrive / SharePoint / Google Drive / Confluence / Notion");
    expect(container.textContent).toContain("Managed Agent Operating System");
    expect(container.textContent).toContain("Outcomes + deliverables");
    expect(container.textContent).toContain("Everything from Level 2");
    expect(container.textContent).toContain("AgentDash or equivalent agent operating system");
    expect(container.textContent).toContain("Cloud or local deployment");
    expect(container.textContent).toContain("Qualified RFP packages");
    expect(container.textContent).toContain("Admin pilot charters");
    expect(container.textContent).toContain("Executive briefings");
    expect(container.textContent).toContain("Level 3 plus approved executive context and access");
    expect(container.textContent).toContain("Level 3 foundation");
    expect(container.textContent).toContain("Executive context + access");
    expect(container.textContent).toContain("Everything from Level 3");
    expect(container.textContent).toContain("What is needed");
    expect(container.textContent).toContain("What unlocks");
    expect(container.textContent).toContain("Tokens");
    expect(container.textContent).toContain("Use frontier lab LLM models to power");
    expect(container.textContent).toContain("A simple maturity path");
    expect(container.textContent).toContain("Where to start");
    expect(container.textContent).toContain("Recommendation: Level 3 pilot");
    expect(container.textContent).toContain("Gateway feasibility");
    expect(container.textContent).toContain("Optional pre-pilot");
    expect(container.textContent).toContain("Access-safe first proof");
    expect(container.textContent).toContain("Business outcome pilot");
    expect(container.textContent).toContain("Best default for MKThink");
    expect(container.textContent).toContain("Executive CoS rollout");
    expect(container.textContent).toContain("Defer until Level 3");
    expect(container.textContent).not.toContain("The clean pitch");
    expect(container.textContent).not.toContain("Pilot decision");
    expect(container.textContent).toContain("6-12 weeks");
    expect(container.textContent).not.toContain("Cost");
    expect(container.textContent).not.toContain("Demo prompt");
  });

  it("renders the inbox access scenarios inside Level 4 without a separate inbox slide", () => {
    act(() => {
      root.render(<CoSPilotTrustDeck />);
    });

    const level4 = container.querySelector("#level-4");

    expect(level4).not.toBeNull();
    expect(level4?.textContent).toContain("Level 4 inbox access");
    expect(level4?.textContent).toContain("Executive context");
    expect(container.textContent).toContain("Scoped Read-Only Inbox");
    expect(container.textContent).toContain("Draft-Only Executive Inbox");
    expect(container.querySelector("#inbox")).toBeNull();
    expect(container.textContent).not.toContain("Build an AgentDash demo seed for MKThink");
    expect(container.textContent).not.toContain("Titus CoS");
    expect(container.textContent).not.toContain("BD Opportunity Scout agents");
    expect(container.textContent).not.toContain("Proposal Builder agents");
  });
});
