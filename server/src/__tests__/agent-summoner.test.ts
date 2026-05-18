import { describe, it, expect, vi } from "vitest";
import { agentSummoner, buildSummonedAgentFallbackReply } from "../services/agent-summoner.js";

describe("agentSummoner.summon", () => {
  it("loads context, runs adapter, posts reply authored by the summoned agent", async () => {
    const conversations = {
      paginate: vi.fn().mockResolvedValue([{ role: "user", content: "What's status?" }]),
      postMessage: vi.fn().mockResolvedValue({ id: "m1" }),
    };
    const agents = {
      getById: vi.fn().mockResolvedValue({ id: "a1", name: "Reese", adapterType: "claude_local", adapterConfig: {} }),
    };
    const adapter = { execute: vi.fn().mockResolvedValue({ output: "I have 12 drafts ready, 3 sent." }) };

    await agentSummoner({
      conversations, agents, adapterFor: () => adapter,
    } as any).summon({
      conversationId: "conv1", agentId: "a1", triggeringMessageId: "u1", companyId: "company-1",
    });

    expect(adapter.execute).toHaveBeenCalled();
    expect(conversations.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv1", authorKind: "agent", authorId: "a1",
      companyId: "company-1",
      body: "I have 12 drafts ready, 3 sent.",
    }));
  });

  it("throws when agent not found", async () => {
    const summoner = agentSummoner({
      conversations: { paginate: vi.fn().mockResolvedValue([]) },
      agents: { getById: vi.fn().mockResolvedValue(null) },
      adapterFor: vi.fn(),
    } as any);
    await expect(
      summoner.summon({ conversationId: "c", companyId: "company-1", agentId: "missing", triggeringMessageId: "t" })
    ).rejects.toThrow(/not found/);
  });

  it("builds a contextual local fallback reply for onboarding mentions", () => {
    const reply = buildSummonedAgentFallbackReply({
      agent: { name: "Iris", role: "implementation_coordinator" },
      prompt: [
        "USER: we are launching soc 2 onboarding in 90 days.",
        "USER: @Iris what should you do first for our pilot onboarding goal?",
      ].join("\n"),
    });

    expect(reply).toContain("pilot onboarding goal");
    expect(reply).toContain("Iris");
    expect(reply).toContain("3 pilot customers");
    expect(reply).not.toContain("Stub agent reply");
  });
});
