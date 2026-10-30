import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { agentCreatorFromProposal } from "../services/agent-creator-from-proposal.js";

// AgentDash: Agent Performance Management gate 4 (P4.1) — the
// `performance-manager-guidance` block reaches both prompt surfaces (AGENTS.md
// "Adding Agent-Facing Features"): the default bundle, and the proposal
// renderer that composes it. Same approach as
// operating-profile-guidance-prompt.test.ts: exercise the generated prompt.

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(here, "..");
const OPEN = "<!-- AgentDash: performance-manager-guidance — DO NOT REMOVE OR REORDER THIS BLOCK -->";
const CLOSE = "<!-- /AgentDash: performance-manager-guidance -->";

const surfaces = [
  { name: "default", content: readFileSync(path.join(serverSrc, "onboarding-assets/default/AGENTS.md"), "utf8") },
  { name: "agent-creator-from-proposal", content: "" },
];

beforeAll(async () => {
  await agentCreatorFromProposal({
    agents: {
      getById: async () => ({ companyId: "company", adapterType: "codex_local" }),
      create: async () => ({ id: "new-agent", pausedAt: new Date() }),
      completeMaterialization: async () => ({}),
      createApiKey: async () => ({}),
    },
    instructions: {
      materializeManagedBundle: async (_agent: unknown, files: Record<string, string>) => {
        surfaces[1]!.content = files["AGENTS.md"]!;
        return { adapterConfig: {} };
      },
    },
  } as never).create({
    companyId: "company",
    reportsToAgentId: "leader",
    proposal: { name: "Sam", role: "Writer", oneLineOkr: "Prepare a campaign", rationale: "Launch support" },
    transcript: [],
  });
});

function block(content: string): string {
  const start = content.indexOf(OPEN);
  const end = content.indexOf(CLOSE);
  expect(start, "block opens").toBeGreaterThanOrEqual(0);
  expect(end, "block closes after it opens").toBeGreaterThan(start);
  return content.slice(start, end);
}

describe("performance-manager-guidance prompt surface", () => {
  it("is present exactly once in every surface, right after the operating-profile guidance", () => {
    for (const surface of surfaces) {
      expect(surface.content.split(OPEN).length - 1, `${surface.name} carries the block once`).toBe(1);
      expect(surface.content.split(CLOSE).length - 1, `${surface.name} closes the block once`).toBe(1);
      expect(surface.content.indexOf(OPEN), `${surface.name} keeps operating-profile-guidance first`).toBeGreaterThan(
        surface.content.indexOf("<!-- /AgentDash: operating-profile-guidance -->"),
      );
    }
  });

  it("applies only when the flag says so, and tells the manager each rule of the build spec in HTTP and JSON terms", () => {
    for (const surface of surfaces) {
      const text = block(surface.content).replace(/\s+/g, " ");
      // Applies only when performanceManager is true.
      expect(text, surface.name).toContain("`GET /api/agents/me/profile` returns `\"performanceManager\": true`");
      expect(text, surface.name).toContain("Every other agent skips it");
      expect(text, surface.name).toContain("`GET /api/companies/:companyId/performance-manager`");
      // Read the cards.
      expect(text, surface.name).toContain("**Read the cards.**");
      expect(text, surface.name).toContain("`GET /api/companies/:companyId/evaluation/agents`");
      expect(text, surface.name).toContain('"visibility": "not_visible"');
      // Propose only with cited evidence.
      expect(text, surface.name).toContain("**Propose only with cited evidence.**");
      expect(text, surface.name).toContain("`POST /api/companies/:companyId/agents/:agentId/profile/revisions`");
      expect(text, surface.name).toContain('"evidence": { "cardVersion": 3, "ledgerEventIds": ["..."] }');
      expect(text, surface.name).toContain("agent_profile_change");
      // Never act on recommendations itself; pause means recommend.
      expect(text, surface.name).toContain("**Never act on recommendations yourself.**");
      expect(text, surface.name).toContain("`POST /api/companies/:companyId/evaluation/agents/:agentId/recommendations`");
      expect(text, surface.name).toContain('"kind": "continue" | "narrow" | "repair" | "pause" | "gather_evidence"');
      expect(text, surface.name).toContain("AGENT_RECOMMENDATION_EVIDENCE_INVALID");
      expect(text, surface.name).toContain('"pause" means recommend a pause: it never pauses the agent');
      // APM gate 5: plan a brief; never hire.
      expect(text, surface.name).toContain("**Plan a brief; never hire.**");
      expect(text, surface.name).toContain("`GET /api/issues/:issueId/documents/agent-work-brief`");
      expect(text, surface.name).toContain("`PUT /api/issues/:issueId/documents/scenario-manifest`");
      expect(text, surface.name).toContain('"recommendation": "reuse" | "bounded_change" | "new_role" | "deterministic_workflow" | "human_owned"');
      expect(text, surface.name).toContain("AGENT_SCENARIO_MANIFEST_INVALID");
      expect(text, surface.name).toContain("`POST /api/companies/:companyId/agent-profiles`");
      expect(text, surface.name).toContain("nothing is hired and no agent runs until a person approves it");
      // Never approve.
      expect(text, surface.name).toContain("**Never approve.**");
      expect(text, surface.name).toContain("You cannot approve, reject, apply or resume a profile change");
      expect(text, surface.name).toMatch(/`ask_user_questions` card, or a plain comment/);
      // Its own record, described without a causal claim.
      expect(text, surface.name).toContain("`GET /api/companies/:companyId/evaluation/performance-manager/record`");
      expect(text, surface.name).toContain("it does not say the change caused the difference");
    }
  });

  it("stays adapter-neutral", () => {
    for (const surface of surfaces) {
      const text = block(surface.content);
      expect(text, `${surface.name} describes a UI gesture`).not.toMatch(/\b(click|button|tab|toggle|drag)\b/i);
      expect(text, `${surface.name} names an adapter`).not.toMatch(/\b(claude|codex|cursor|gemini|opencode|openclaw|hermes)\b/i);
    }
  });

  it("names the block in the proposal renderer's surface notes", () => {
    const source = readFileSync(path.join(serverSrc, "services/agent-creator-from-proposal.ts"), "utf8");
    expect(source).toContain("AgentDash: performance-manager-guidance (APM gate 4) is inherited from the");
    expect(source).toContain('APM gate 5 adds "plan a brief; never hire"');
  });
});
