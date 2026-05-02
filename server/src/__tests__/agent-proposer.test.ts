import { describe, it, expect, vi } from "vitest";
import { agentProposer } from "../services/agent-proposer.js";
import type { InterviewTurn } from "@paperclipai/shared";

describe("agentProposer.propose", () => {
  it("returns a typed AgentProposal from a canned transcript", async () => {
    const llm = vi.fn().mockResolvedValue({
      name: "Reese", role: "SDR", oneLineOkr: "Book 200 meetings", rationale: "B2B outbound",
    });
    const transcript: InterviewTurn[] = [
      { role: "assistant", content: "What's your business?", ts: "1" },
      { role: "user", content: "B2B SaaS, mid-market.", ts: "2" },
    ];
    const proposal = await agentProposer({ llm } as any).propose(transcript);
    expect(proposal).toMatchObject({
      name: "Reese", role: "SDR",
      oneLineOkr: expect.any(String), rationale: expect.any(String),
    });
  });

  it("rejects empty transcripts", async () => {
    const llm = vi.fn();
    await expect(agentProposer({ llm } as any).propose([])).rejects.toThrow(/empty/i);
  });
});
