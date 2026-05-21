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
    expect(container.textContent).toContain("Chief of Staff Agent Readiness");
    expect(container.textContent).toContain("How much context is useful enough to earn the next level of trust");
    expect(container.textContent).toContain("Every company is onboarding AI agents");
    expect(container.textContent).toContain("Not everyone is doing it right");
    expect(container.textContent).toContain("30 days");
    expect(container.textContent).toContain("2 leaders");
    expect(container.textContent).toContain("10+");
    expect(container.textContent).toContain("100%");
    expect(container.textContent).toContain("Personal AI use is already happening");
    expect(container.textContent).toContain("AgentDash and Paperclip should make this progression visible");
    expect(container.textContent).toContain("No executive inbox write access at the start");
    expect(container.textContent).not.toContain("MIFAL");
    expect(container.textContent).not.toContain("Notion");
    expect(container.textContent).not.toContain("Warp");
    expect(container.textContent).not.toContain("CodeBanana");
    expect(container.textContent).not.toContain("Claude");
    expect(container.textContent).not.toContain("Codex");
    expect(container.textContent).not.toContain("Hermes");
    expect(container.textContent).not.toContain("OpenClaw");
    expect(container.textContent).not.toContain("Teams");
    expect(container.textContent).not.toContain("M365");
    expect(container.textContent).not.toContain("OneDrive");
    expect(container.textContent).not.toContain("SharePoint");
    expect(container.textContent).not.toContain("Google Drive");
    expect(container.textContent).not.toContain("Confluence");
    expect(container.textContent).toContain("Personal Local Agent");
    expect(container.textContent).toContain("A personal AI assistant on your computer");
    expect(container.textContent).toContain("A gateway agent reachable through a group chat");
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
    expect(container.textContent).toContain("Access to the collaboration layer as an agent");
    expect(container.textContent).toContain("Collaboration access requires the right tenant permissions to be granted");
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
    expect(container.textContent).toContain("Shared file drives, wiki pages, project docs, and proposal repositories");
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
    expect(container.textContent).toContain("Start at L1, then compound the same work and memory into L2 and L3");
    expect(container.textContent).toContain("L1 to L2 to L3 without restart");
    expect(container.textContent).toContain("Start with a shared gateway");
    expect(container.textContent).toContain("Start here");
    expect(container.textContent).toContain("Add company knowledge");
    expect(container.textContent).toContain("Add governed execution");
    expect(container.textContent).toContain("Memory carried forward");
    expect(container.textContent).toContain("L1 shared threads and decisions");
    expect(container.textContent).toContain("L2 source traces and useful artifacts");
    expect(container.textContent).toContain("L3 goals, approvals, and execution history");
    expect(container.textContent).toContain("All timeframe estimates depend on how quickly the shared knowledge base can be created");
    expect(container.textContent).toContain("Executive CoS rollout");
    expect(container.textContent).toContain("Defer until Level 3");
    expect(container.textContent).not.toContain("Recommendation: Level 3 pilot");
    expect(container.textContent).not.toContain("Recommended");
    expect(container.textContent).not.toContain("Gateway feasibility");
    expect(container.textContent).not.toContain("Optional pre-pilot");
    expect(container.textContent).not.toContain("Best default for MKThink");
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
