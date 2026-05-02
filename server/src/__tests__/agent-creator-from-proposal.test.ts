import { describe, it, expect, vi } from "vitest";
import { agentCreatorFromProposal } from "../services/agent-creator-from-proposal.js";
import type { AgentProposal, InterviewTurn } from "@paperclipai/shared";

describe("agentCreatorFromProposal", () => {
  it("creates an agent + materializes SOUL/AGENTS/HEARTBEAT from the proposal", async () => {
    const agents = {
      create: vi.fn().mockResolvedValue({ id: "agent-2", role: "general", adapterType: "claude_local", adapterConfig: {} }),
      createApiKey: vi.fn().mockResolvedValue({ id: "k", token: "agk_x" }),
    };
    const instructions = { materializeManagedBundle: vi.fn().mockResolvedValue({ adapterConfig: {} }) };
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
        "SOUL.md": expect.stringContaining("Reese"),
        "AGENTS.md": expect.stringContaining("SDR"),
        "HEARTBEAT.md": expect.any(String),
      }),
      expect.any(Object),
    );
    expect(result.agentId).toBe("agent-2");
    expect(result.apiKey).toBeDefined();
  });
});
