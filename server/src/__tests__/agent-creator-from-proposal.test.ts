import { readFile } from "node:fs/promises";
import { describe, it, expect, vi } from "vitest";
import { agentCreatorFromProposal } from "../services/agent-creator-from-proposal.js";
import type { AgentProposal, InterviewTurn } from "@paperclipai/shared";

describe("agentCreatorFromProposal", () => {
  it("creates an agent with the canonical worker bundle plus proposal context", async () => {
    const agents = {
      completeMaterialization: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      getById: vi.fn().mockResolvedValue({ id: "cos-1", companyId: "c1", adapterType: "claude_local" }),
      create: vi.fn().mockResolvedValue({ id: "agent-2", pausedAt: new Date(), role: "general", adapterType: "claude_local", adapterConfig: {} }),
      createApiKey: vi.fn().mockResolvedValue({ id: "k", token: "agk_x" }),
    };
    const instructions = { materializeManagedBundle: vi.fn(async (_agent: unknown, _files: Record<string, string>, _options: unknown) => ({ adapterConfig: {} })) };
    const proposal: AgentProposal = {
      name: "Reese", role: "SDR", oneLineOkr: "Book 200 meetings", rationale: "outbound",
    };
    const transcript: InterviewTurn[] = [{ role: "user", content: "B2B SaaS", ts: "1" }];

    const result = await agentCreatorFromProposal({ agents, instructions } as any).create({
      companyId: "c1", reportsToAgentId: "cos-1", proposal, transcript,
    });

    expect(agents.create).toHaveBeenCalledWith("c1", expect.objectContaining({
      name: "Reese", role: "general", title: "SDR", reportsTo: "cos-1",
    }));
    expect(instructions.materializeManagedBundle).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        "SOUL.md": await readFile(new URL("../onboarding-assets/default/SOUL.md", import.meta.url), "utf8"),
        "TOOLS.md": await readFile(new URL("../onboarding-assets/default/TOOLS.md", import.meta.url), "utf8"),
        "AGENTS.md": expect.stringContaining("SDR"),
        "HEARTBEAT.md": expect.any(String),
      }),
      expect.any(Object),
    );
    const bundle = instructions.materializeManagedBundle.mock.calls[0][1];
    expect(bundle["AGENTS.md"]).toContain("## Execution Contract");
    expect(bundle["AGENTS.md"]).toContain("Reese");
    expect(bundle["AGENTS.md"]).toContain("B2B SaaS");
    expect(result.agentId).toBe("agent-2");
    expect(result.apiKey).toBeDefined();
  });
});
