import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { agentCreatorFromProposal } from "../services/agent-creator-from-proposal.js";

// AgentDash: Agent Performance Management gate 2 (P2.4) — the
// `operating-profile-guidance` block reaches both prompt surfaces (AGENTS.md
// "Adding Agent-Facing Features"): the default bundle, and the proposal
// renderer that composes it. Same rendering approach as
// agent-instruction-bundles.test.ts: exercise the generated prompt.

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(here, "..");
const OPEN = "<!-- AgentDash: operating-profile-guidance — DO NOT REMOVE OR REORDER THIS BLOCK -->";
const CLOSE = "<!-- /AgentDash: operating-profile-guidance -->";

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

describe("operating-profile-guidance prompt surface", () => {
  it("is present exactly once in every surface, after the access self-view block", () => {
    for (const surface of surfaces) {
      expect(surface.content.split(OPEN).length - 1, `${surface.name} carries the block once`).toBe(1);
      expect(surface.content.indexOf(OPEN), `${surface.name} keeps access-self-view first`).toBeGreaterThan(
        surface.content.indexOf("<!-- /AgentDash: access-self-view -->"),
      );
      // The per-agent data block is the server's to render; the default bundle never ships one.
      expect(surface.content, `${surface.name} ships no per-agent block`).not.toMatch(/<!--\s*AgentDash:\s*operating-profile(\s|-->)/);
    }
  });

  it("tells every agent each rule of overview LLD §7, in HTTP and JSON terms", () => {
    for (const surface of surfaces) {
      const text = block(surface.content).replace(/\s+/g, " ");
      // The profile block is the authority; read the structured forms.
      expect(text, surface.name).toContain("authority for your duties, what is not yours to do, and your style");
      expect(text, surface.name).toContain("`GET /api/agents/me/profile`");
      expect(text, surface.name).toContain("`GET /api/agents/me/access`");
      // Map unmapped work when you start it; say so when nothing fits.
      expect(text, surface.name).toContain("`GET /api/companies/:companyId/issues/:issueId/responsibility`");
      expect(text, surface.name).toContain("`POST /api/companies/:companyId/issues/:issueId/responsibility`");
      expect(text, surface.name).toContain('"responsibilityKey"');
      expect(text, surface.name).toContain("AGENT_PROFILE_UNKNOWN_RESPONSIBILITY");
      expect(text, surface.name).toContain("If no responsibility fits");
      // On ACCESS_POLICY_REFUSED, don't route around it; record the blocker (card OR comment).
      expect(text, surface.name).toContain("ACCESS_POLICY_REFUSED");
      expect(text, surface.name).toContain("Do not route around it");
      expect(text, surface.name).toMatch(/`ask_user_questions` card, or a plain comment/);
      expect(text, surface.name).toContain("agent_profile_change");
      // APM gate 3 (P3.4): the full refusal body, the always-open escalation path,
      // and the enforced refusals that are not a 403 (filtered, withheld, dropped, not started).
      expect(text, surface.name).toContain("`allowedSummary`");
      expect(text, surface.name).toContain("always reachable, whatever your rules say");
      expect(text, surface.name).toContain("Some refusals are not a `403`");
      expect(text, surface.name).toContain("a wake to an agent you may not contact is not delivered");
      expect(text, surface.name).toContain("a run on an issue outside your access does not start");
      // Don't edit the block on disk.
      expect(text, surface.name).toContain("Do not edit the `operating-profile` block on disk");
      // Feedback is not acceptance.
      expect(text, surface.name).toContain("Feedback is not acceptance");
    }
  });

  it("stays adapter-neutral and does not repeat the access self-view rules", () => {
    for (const surface of surfaces) {
      const text = block(surface.content);
      expect(text, `${surface.name} describes a UI gesture`).not.toMatch(/\b(click|button|tab|toggle|drag)\b/i);
      // access-self-view already explains the inventory fields; this block points at it instead.
      expect(text, surface.name).toContain("`access-self-view` rules above");
      expect(text, surface.name).not.toContain("alwaysReachable");
    }
  });

  it("names the block in the proposal renderer's surface notes", () => {
    const source = readFileSync(path.join(serverSrc, "services/agent-creator-from-proposal.ts"), "utf8");
    expect(source).toContain("AgentDash: operating-profile-guidance (APM gate 2) is inherited from the");
  });
});
