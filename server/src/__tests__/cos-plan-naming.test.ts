// AgentDash (scan 4, lane N): plan cards never name an agent after a person in
// the company, keep the CoS-written titles verbatim, and the plan prompts ask
// for a one-line intro instead of re-listing the team.
import { describe, expect, it } from "vitest";
import type { AgentPlanProposalV1Payload } from "@paperclipai/shared";
import {
  PLAN_FALLBACK_AGENT_NAMES,
  PLAN_INTRO_GUIDANCE,
  memberNameKeys,
  planNamingGuidance,
  preparePlanForPosting,
} from "../services/cos-plan-naming.js";

function plan(agents: Array<{ name: string; title?: string; role?: string }>): AgentPlanProposalV1Payload {
  return {
    rationale: "Dana handles email so Marcus can run the close.",
    alignmentToShortTerm: "Dana absorbs the routine email volume.",
    alignmentToLongTerm: "Dana and Marcus free up capacity.",
    agents: agents.map((a) => ({
      name: a.name,
      role: a.role ?? "general",
      ...(a.title !== undefined ? { title: a.title } : {}),
      adapterType: "hermes_local",
      responsibilities: [`${a.name} sorts the inbox`],
      kpis: ["Replies within a day"],
    })),
  } as AgentPlanProposalV1Payload;
}

describe("memberNameKeys", () => {
  it("takes full and first names, case-insensitively", () => {
    expect([...memberNameKeys(["Dana Whitfield", "  ", "lee"])]).toEqual(["dana whitfield", "dana", "lee"]);
  });
});

describe("preparePlanForPosting", () => {
  it("renames an agent that has a member's first name, everywhere the plan says it", () => {
    const result = preparePlanForPosting(
      plan([{ name: "Dana", title: "Client Email Triage Lead" }, { name: "Marcus" }]),
      "Dana, Client Email Triage Lead, sorts your inbox.",
      ["Dana Whitfield"],
    );
    const replacement = PLAN_FALLBACK_AGENT_NAMES[0];
    expect(result.renamed).toEqual([{ from: "Dana", to: replacement }]);
    expect(result.plan.agents.map((a) => a.name)).toEqual([replacement, "Marcus"]);
    expect(result.plan.rationale).toBe(`${replacement} handles email so Marcus can run the close.`);
    expect(result.plan.alignmentToShortTerm).toBe(`${replacement} absorbs the routine email volume.`);
    expect(result.plan.alignmentToLongTerm).toBe(`${replacement} and Marcus free up capacity.`);
    expect(result.plan.agents[0]!.responsibilities).toEqual([`${replacement} sorts the inbox`]);
    expect(result.body).toBe(`${replacement}, Client Email Triage Lead, sorts your inbox.`);
  });

  it("matches a full name and ignores case; leaves unrelated words alone", () => {
    const result = preparePlanForPosting(plan([{ name: "dana whitfield" }]), "Danave stays.", ["Dana Whitfield"]);
    expect(result.plan.agents[0]!.name).toBe(PLAN_FALLBACK_AGENT_NAMES[0]);
    expect(result.body).toBe("Danave stays.");
  });

  it("never picks a fallback that is a member's or another agent's name", () => {
    const [first, second] = PLAN_FALLBACK_AGENT_NAMES;
    const result = preparePlanForPosting(plan([{ name: "Dana" }, { name: second! }]), "", ["Dana Whitfield", `${first} Smith`]);
    expect(result.plan.agents.map((a) => a.name)).toEqual([PLAN_FALLBACK_AGENT_NAMES[2], second]);
  });

  it("changes nothing when no name collides, and keeps titles verbatim (trimmed)", () => {
    const input = plan([{ name: "Priya", title: "  Client Onboarding & Process Builder  " }, { name: "Marcus", title: "Month-End Close Coordinator" }]);
    const result = preparePlanForPosting(input, "One line.", ["Dana Whitfield"]);
    expect(result.renamed).toEqual([]);
    expect(result.plan.agents.map((a) => a.title)).toEqual(["Client Onboarding & Process Builder", "Month-End Close Coordinator"]);
    expect(result.plan.rationale).toBe(input.rationale);
    expect(result.body).toBe("One line.");
  });

  it("drops an empty title so the card falls back to the role", () => {
    const result = preparePlanForPosting(plan([{ name: "Priya", title: "   " }]), "", []);
    expect(result.plan.agents[0]).not.toHaveProperty("title");
  });
});

describe("plan prompt guidance", () => {
  it("names the people to avoid and asks for a verbatim title", () => {
    const text = planNamingGuidance(["Dana Whitfield", ""]);
    expect(text).toContain('"Dana Whitfield"');
    expect(text).toContain("Never give an agent any of their names");
    expect(text).toContain('"title"');
    expect(planNamingGuidance([])).not.toContain("These people work in this company");
  });

  it("asks for a one-line intro instead of re-listing the team", () => {
    expect(PLAN_INTRO_GUIDANCE).toContain("ONE short sentence");
    expect(PLAN_INTRO_GUIDANCE).toContain("do not list the agents");
  });
});
