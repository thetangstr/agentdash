import { describe, expect, it } from "vitest";
import {
  agentHireOrigin,
  agentIdentityLine,
  agentIdentityLineUnderName,
  agentPickerSubtitle,
  agentPickerSubtitleUnderName,
  humanizeAgentRole,
  humanizeAgentTitle,
} from "./agent-identity";

describe("agent identity copy", () => {
  it("never shows a raw slug", () => {
    expect(humanizeAgentRole("chief_of_staff")).toBe("Chief of Staff");
    expect(humanizeAgentRole("devops")).toBe("DevOps");
    expect(humanizeAgentRole("custom_role")).toBe("Custom Role");
    expect(humanizeAgentTitle("research_analyst")).toBe("Research Analyst");
    expect(humanizeAgentTitle("proposal_drafter")).toBe("Proposal Drafter");
    expect(humanizeAgentTitle("qa_lead")).toBe("QA Lead");
    expect(humanizeAgentTitle("Head of Growth")).toBe("Head of Growth");
  });

  it("puts the title first, then the humanized role", () => {
    expect(agentIdentityLine({ role: "researcher", title: "research_analyst" })).toBe("Research Analyst");
    // Executive roles read as their family beside a title.
    expect(agentIdentityLine({ role: "cmo", title: "Content Lead" })).toBe("Content Lead · Marketing");
    expect(agentIdentityLine({ role: "cfo", title: "Close Checklist Manager" })).toBe("Close Checklist Manager · Finance");
    expect(agentIdentityLine({ role: "cfo", title: "Finance Assistant" })).toBe("Finance Assistant");
    expect(agentIdentityLine({ role: "cfo", title: null })).toBe("CFO");
  });

  it("drops a role that adds nothing", () => {
    // "General - research_analyst" was the scan 3 header.
    expect(agentIdentityLine({ role: "general", title: "research_analyst" })).toBe("Research Analyst");
    expect(agentIdentityLine({ role: "chief_of_staff", title: "Chief of Staff" })).toBe("Chief of Staff");
    expect(agentIdentityLine({ role: "chief_of_staff", title: null })).toBe("Chief of Staff");
    expect(agentIdentityLine({ role: "general", title: null })).toBe("General");
    // Scan 4: "Month End Close Coordinator · PM" and "General - Close Checklist Manager".
    expect(agentIdentityLine({ role: "pm", title: "Month End Close Coordinator" })).toBe("Month End Close Coordinator");
    expect(agentIdentityLine({ role: "general", title: "Close Checklist Manager" })).toBe("Close Checklist Manager");
    expect(agentIdentityLine({ role: "researcher", title: "Senior Researcher" })).toBe("Senior Researcher");
  });

  it("drops a role that shares the title's stem", () => {
    // Batch 2 canary: "Research Analyst · Researcher" was the suffix repeating
    // a word the title already said.
    expect(agentIdentityLine({ role: "researcher", title: "Research Analyst" })).toBe("Research Analyst");
    // A family whose stem is in the title is the same repetition.
    expect(agentIdentityLine({ role: "cto", title: "Tech Lead" })).toBe("Tech Lead");
    // Unrelated stems still earn the suffix.
    expect(agentIdentityLine({ role: "researcher", title: "Client Correspondence" })).toBe(
      "Client Correspondence · Researcher",
    );
    // A short title word must not match either: "e" is not "Engineer"'s stem.
    expect(agentIdentityLine({ role: "engineer", title: "E-commerce Lead" })).toBe(
      "E-commerce Lead · Engineer",
    );
  });

  it("gives pickers the title, or the role when there is none", () => {
    expect(agentPickerSubtitle({ role: "general", title: "proposal_drafter" })).toBe("Proposal Drafter");
    expect(agentPickerSubtitle({ role: "chief_of_staff", title: null })).toBe("Chief of Staff");
    expect(agentPickerSubtitle({ role: null, title: null })).toBe("");
    expect(agentPickerSubtitle({ role: "general", title: null })).toBe("");
    expect(agentPickerSubtitle({ role: "pm", title: "Client Email Coordinator" })).toBe("Client Email Coordinator");
  });

  it("hides a line or subtitle that just restates the agent's name", () => {
    // The CoS agents the canary scanned: name "Chief of Staff", no title.
    expect(agentIdentityLineUnderName({ name: "Chief of Staff", role: "chief_of_staff", title: null })).toBe("");
    expect(agentPickerSubtitleUnderName({ name: "Chief of Staff", role: "chief_of_staff", title: null })).toBe("");
    expect(agentIdentityLineUnderName({ name: "Ivy", role: "general", title: "proposal_drafter" })).toBe(
      "Proposal Drafter",
    );
    expect(agentPickerSubtitleUnderName({ name: "Ivy", role: "general", title: "proposal_drafter" })).toBe(
      "Proposal Drafter",
    );
    expect(agentIdentityLineUnderName({ name: "Maya", role: "chief_of_staff", title: null })).toBe("Chief of Staff");
    expect(agentIdentityLineUnderName({ name: null, role: "general", title: null })).toBe("General");
  });
});

// AgentDash (c4-hire-ux): who the "Created by" line credits.
describe("agentHireOrigin", () => {
  it("reads the Chief of Staff as set up with the workspace, never hired", () => {
    expect(agentHireOrigin({ role: "chief_of_staff", createdByUserId: "u1" })).toEqual({ kind: "cos" });
  });

  it("credits the confirming person on a stamped CoS plan hire", () => {
    expect(
      agentHireOrigin({
        role: "finance",
        createdByUserId: "u-dana",
        metadata: { onboardingMaterialization: "complete" },
      }),
    ).toEqual({ kind: "person", userId: "u-dana", viaCos: true });
  });

  it("falls back to the accountable person on pre-stamp CoS hires", () => {
    expect(
      agentHireOrigin({
        role: "engineer",
        createdByUserId: null,
        accountable: { userId: "u-dana" },
        metadata: { onboardingMaterialization: "resumed_incomplete" },
      }),
    ).toEqual({ kind: "person", userId: "u-dana", viaCos: true });
  });

  it("says 'hired through the Chief of Staff' when a CoS hire has no person to credit", () => {
    expect(
      agentHireOrigin({ role: "engineer", metadata: { onboardingMaterialization: "pending" } }),
    ).toEqual({ kind: "cosUnattributed" });
  });

  it("keeps the review-queue label and reason for automatic hires", () => {
    expect(
      agentHireOrigin({ role: "engineer", metadata: { autoHired: true, autoHireReason: "neutrality_conflict" } }),
    ).toEqual({ kind: "reviewQueue", reason: "neutrality_conflict" });
  });

  it("stays 'Hired by an agent' for an ordinary unattributed hire", () => {
    expect(agentHireOrigin({ role: "engineer" })).toEqual({ kind: "agent" });
    // A creator stamp without the CoS marker is a direct (non-CoS) credit.
    expect(agentHireOrigin({ role: "engineer", createdByUserId: "u1" })).toEqual({
      kind: "person",
      userId: "u1",
      viaCos: false,
    });
  });
});
