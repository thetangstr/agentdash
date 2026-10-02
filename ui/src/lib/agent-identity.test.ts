import { describe, expect, it } from "vitest";
import { agentIdentityLine, agentPickerSubtitle, humanizeAgentRole, humanizeAgentTitle } from "./agent-identity";

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
    expect(agentIdentityLine({ role: "researcher", title: "research_analyst" })).toBe("Research Analyst · Researcher");
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

  it("gives pickers the title, or the role when there is none", () => {
    expect(agentPickerSubtitle({ role: "general", title: "proposal_drafter" })).toBe("Proposal Drafter");
    expect(agentPickerSubtitle({ role: "chief_of_staff", title: null })).toBe("Chief of Staff");
    expect(agentPickerSubtitle({ role: null, title: null })).toBe("");
    expect(agentPickerSubtitle({ role: "general", title: null })).toBe("");
    expect(agentPickerSubtitle({ role: "pm", title: "Client Email Coordinator" })).toBe("Client Email Coordinator");
  });
});
