// AgentDash (Test Drive): unit tests for the autonomous-company designer —
// prompt builders + tolerant parsers + fallback (no DB, no network).

import { describe, expect, it } from "vitest";
import {
  buildCompanyDesignPrompt,
  parseCompanyDesign,
  fallbackCompanyDesign,
  buildAgentTaskPrompt,
  parseAgentArtifact,
  type CompanyIntake,
} from "../services/trial-company-designer.ts";

const INTAKE: CompanyIntake = {
  whatYouDo: "We run a logistics SaaS for mid-market freight brokers",
  goal: "land 20 new design partners this quarter",
  blocker: "no outbound motion yet",
};

const VALID_DESIGN = {
  companyName: "FreightPilot",
  mission: "Help freight brokers move faster with autonomous ops.",
  agents: [
    {
      ref: "outbound-gtm",
      name: "Scout",
      role: "outbound_sales",
      category: "outbound · gtm",
      charter: "Owns finding and opening conversations with target brokers.",
      firstTaskTitle: "Draft the first outbound sequence",
      firstTaskBrief: "Define the ICP and write a 3-touch sequence.",
    },
    {
      ref: "market-research",
      name: "Atlas",
      role: "market_research",
      category: "research · market",
      charter: "Owns market and competitor intelligence.",
      firstTaskTitle: "Map the landscape",
      firstTaskBrief: "Produce a concise market landscape.",
    },
    {
      ref: "content",
      name: "Quill",
      role: "content",
      category: "content · brand",
      charter: "Owns the story and content.",
      firstTaskTitle: "Draft a launch narrative",
      firstTaskBrief: "Write positioning + 3 content ideas.",
    },
  ],
};

describe("buildCompanyDesignPrompt", () => {
  it("includes every intake field in the user message", () => {
    const prompt = buildCompanyDesignPrompt(INTAKE);
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msg = prompt.messages[0].content;
    expect(msg).toContain("logistics SaaS");
    expect(msg).toContain("20 new design partners");
    expect(msg).toContain("no outbound motion yet");
    expect(prompt.system).toContain("Chief of Staff");
  });

  it("omits the blocker line when not provided", () => {
    const prompt = buildCompanyDesignPrompt({ whatYouDo: "x", goal: "y" });
    expect(prompt.messages[0].content).not.toContain("Biggest blocker");
  });
});

describe("parseCompanyDesign", () => {
  it("parses a bare JSON object", () => {
    const design = parseCompanyDesign(JSON.stringify(VALID_DESIGN), INTAKE);
    expect(design.companyName).toBe("FreightPilot");
    expect(design.agents).toHaveLength(3);
    expect(design.agents[0].name).toBe("Scout");
    expect(design.agents[0].ref).toBe("outbound-gtm");
  });

  it("parses JSON inside a ```json code fence", () => {
    const raw = "```json\n" + JSON.stringify(VALID_DESIGN) + "\n```";
    const design = parseCompanyDesign(raw, INTAKE);
    expect(design.agents).toHaveLength(3);
  });

  it("parses JSON embedded in surrounding prose", () => {
    const raw = "Here is the team:\n\n" + JSON.stringify(VALID_DESIGN) + "\n\nHope that helps!";
    const design = parseCompanyDesign(raw, INTAKE);
    expect(design.agents).toHaveLength(3);
    expect(design.companyName).toBe("FreightPilot");
  });

  it("caps the roster at 4 agents", () => {
    const five = {
      ...VALID_DESIGN,
      agents: [
        ...VALID_DESIGN.agents,
        { ref: "ops", name: "Pace", role: "ops", category: "ops", charter: "Owns ops.", firstTaskTitle: "t", firstTaskBrief: "b" },
        { ref: "fin", name: "Penny", role: "finance", category: "finance", charter: "Owns finance.", firstTaskTitle: "t", firstTaskBrief: "b" },
      ],
    };
    const design = parseCompanyDesign(JSON.stringify(five), INTAKE);
    expect(design.agents.length).toBeLessThanOrEqual(4);
    expect(design.agents.length).toBeGreaterThanOrEqual(3);
  });

  it("tops up to >=3 agents when the model returns too few", () => {
    const one = { companyName: "Solo", mission: "m", agents: [VALID_DESIGN.agents[0]] };
    const design = parseCompanyDesign(JSON.stringify(one), INTAKE);
    expect(design.agents.length).toBeGreaterThanOrEqual(3);
    expect(design.agents[0].name).toBe("Scout");
    // refs stay unique after top-up.
    const refs = design.agents.map((a) => a.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("falls back to a usable team when no JSON is present", () => {
    const design = parseCompanyDesign("I cannot produce JSON, sorry.", INTAKE);
    expect(design.agents.length).toBeGreaterThanOrEqual(3);
    expect(design.companyName).toBeTruthy();
    expect(design.mission).toContain("logistics SaaS");
  });

  it("derives a ref from the name when ref is missing", () => {
    const noRef = {
      companyName: "C",
      mission: "m",
      agents: VALID_DESIGN.agents.map(({ ref, ...rest }) => rest),
    };
    const design = parseCompanyDesign(JSON.stringify(noRef), INTAKE);
    expect(design.agents[0].ref).toBeTruthy();
  });
});

describe("fallbackCompanyDesign", () => {
  it("always returns at least 3 agents with unique refs", () => {
    const design = fallbackCompanyDesign(INTAKE);
    expect(design.agents.length).toBeGreaterThanOrEqual(3);
    const refs = design.agents.map((a) => a.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("works with no intake", () => {
    const design = fallbackCompanyDesign();
    expect(design.agents.length).toBeGreaterThanOrEqual(3);
  });
});

describe("buildAgentTaskPrompt", () => {
  it("weaves company + agent identity into the system prompt", () => {
    const prompt = buildAgentTaskPrompt(
      { name: "FreightPilot", mission: "move freight faster" },
      VALID_DESIGN.agents[0],
    );
    expect(prompt.system).toContain("Scout");
    expect(prompt.system).toContain("outbound_sales");
    expect(prompt.system).toContain("FreightPilot");
    expect(prompt.system).toContain("Markdown");
    expect(prompt.messages[0].content).toContain("Draft the first outbound sequence");
  });
});

describe("parseAgentArtifact", () => {
  const agent = { name: "Scout", firstTaskTitle: "Draft the outbound sequence" };

  it("returns markdown and derives the title from the first H1", () => {
    const raw = "# Outbound Sequence Plan\n\nHere is the plan...\n\n- step 1\n- step 2";
    const out = parseAgentArtifact(raw, agent);
    expect(out.title).toBe("Outbound Sequence Plan");
    expect(out.content.markdown).toContain("step 1");
  });

  it("strips an outer markdown code fence", () => {
    const raw = "```markdown\n# Plan\n\nbody text\n```";
    const out = parseAgentArtifact(raw, agent);
    expect(out.content.markdown.startsWith("```")).toBe(false);
    expect(out.content.markdown).toContain("body text");
    expect(out.title).toBe("Plan");
  });

  it("falls back to the task title when there is no H1", () => {
    const raw = "Just some plain text with no heading that is fairly long and descriptive of the work.";
    const out = parseAgentArtifact(raw, agent);
    expect(out.title).toBeTruthy();
    expect(out.content.markdown).toContain("plain text");
  });

  it("produces a sensible placeholder on empty output", () => {
    const out = parseAgentArtifact("", agent);
    expect(out.title).toBe(agent.firstTaskTitle);
    expect(out.content.markdown).toContain("Scout");
  });
});
