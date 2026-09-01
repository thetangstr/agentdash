// The @mention summoner used to answer with a hardcoded string.
//
// `conversations.ts` wired it as
//   adapterFor: (_t) => ({ execute: async () => ({ output: "Stub agent reply" }) })
// while the `replier` immediately beside it was already routed through a real
// model via `dispatchLLM`. So the capability was present and the summoner simply
// bypassed it: every @mention in the product produced placeholder text, and
// because the chat *looked* like it worked, the defect survived.
//
// These tests pin the two properties that keep it from coming back: a summoned
// agent answers through the same dispatch the CoS uses, governed by its own
// mandate, and a failure is visible rather than papered over with filler.

import { describe, expect, it, vi } from "vitest";

import { agentSummoner, llmSummonAdapter } from "../services/agent-summoner.js";

const agent = {
  id: "agent-1",
  name: "Delivery",
  role: "engineer",
  adapterType: "process",
};

const mandateText = `# Delivery — MKThink

## What you must never do
- Never contact a client directly. You draft; a person sends.`;

function instructionsWith(content: string | null, entryFile: string | null = "AGENTS.md") {
  return {
    getBundle: vi.fn().mockResolvedValue({ entryFile }),
    readFile: vi.fn().mockResolvedValue({ content }),
  };
}

describe("llmSummonAdapter", () => {
  it("sends the agent's mandate as the system prompt", async () => {
    // The point of the mandate wizard: the file the owner produced is what
    // governs the reply. A summoned agent that ignores its own mandate is worse
    // than one that stays silent — it reads as though the limits were seen and
    // overruled.
    const dispatch = vi.fn().mockResolvedValue("Two commitments are at risk.");
    const adapter = llmSummonAdapter({ instructions: instructionsWith(mandateText), dispatch });

    await adapter.execute({ agent, prompt: "What is at risk?" });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].system).toBe(mandateText);
    expect(dispatch.mock.calls[0][0].messages).toEqual([
      { role: "user", content: "What is at risk?" },
    ]);
  });

  it("returns the model's own words, never a canned string", async () => {
    const dispatch = vi.fn().mockResolvedValue("Northgate and Riverside.");
    const adapter = llmSummonAdapter({ instructions: instructionsWith(mandateText), dispatch });

    const result = await adapter.execute({ agent, prompt: "Which ones?" });

    expect(result.output).toBe("Northgate and Riverside.");
    expect(result.output).not.toContain("Stub");
  });

  it("still answers when an agent has no mandate on file", async () => {
    // Agents created before the mandate wizard have an empty bundle, and
    // `readFile` throws notFound for them. That is the common case on any
    // existing instance, so it must degrade to a weaker reply, not a failure.
    const dispatch = vi.fn().mockResolvedValue("I can look into that.");
    const instructions = {
      getBundle: vi.fn().mockResolvedValue({ entryFile: "AGENTS.md" }),
      readFile: vi.fn().mockRejectedValue(new Error("Instructions file not found")),
    };
    const adapter = llmSummonAdapter({ instructions, dispatch });

    const result = await adapter.execute({ agent, prompt: "Can you help?" });

    expect(result.output).toBe("I can look into that.");
    const system = dispatch.mock.calls[0][0].system;
    expect(system).toContain("Delivery");
    expect(system).toContain("no mandate on file");
  });

  it("falls back when the bundle has no entry file at all", async () => {
    const dispatch = vi.fn().mockResolvedValue("Noted.");
    const adapter = llmSummonAdapter({
      instructions: instructionsWith(null, null),
      dispatch,
    });

    await adapter.execute({ agent, prompt: "Hello" });

    expect(dispatch.mock.calls[0][0].system).toContain("no mandate on file");
  });

  it("treats a whitespace-only mandate as absent", async () => {
    const dispatch = vi.fn().mockResolvedValue("Noted.");
    const adapter = llmSummonAdapter({ instructions: instructionsWith("   \n  "), dispatch });

    await adapter.execute({ agent, prompt: "Hello" });

    expect(dispatch.mock.calls[0][0].system).toContain("no mandate on file");
  });

  /**
   * The anti-regression that matters most. The original defect was not that the
   * reply was wrong — it was that a failure was indistinguishable from success.
   */
  it("throws on an empty completion rather than inventing filler", async () => {
    const adapter = llmSummonAdapter({
      instructions: instructionsWith(mandateText),
      dispatch: vi.fn().mockResolvedValue("   "),
    });

    await expect(adapter.execute({ agent, prompt: "?" })).rejects.toThrow(/empty reply/i);
  });

  it("lets a dispatch failure propagate", async () => {
    // An unconfigured or unreachable adapter must surface. Swallowing it and
    // posting placeholder text is exactly how this went unnoticed.
    const adapter = llmSummonAdapter({
      instructions: instructionsWith(mandateText),
      dispatch: vi.fn().mockRejectedValue(new Error("Unsupported adapter: nope")),
    });

    await expect(adapter.execute({ agent, prompt: "?" })).rejects.toThrow(/Unsupported adapter/);
  });
});

describe("agentSummoner posts what the adapter produced", () => {
  it("attributes the reply to the agent and posts the model's text", async () => {
    const conversations = {
      paginate: vi.fn().mockResolvedValue([
        { role: "user", content: "@Delivery what is at risk?" },
      ]),
      postMessage: vi.fn().mockResolvedValue({ id: "msg-2" }),
    };
    const dispatch = vi.fn().mockResolvedValue("Northgate schematic is at risk.");
    const summoner = agentSummoner({
      conversations,
      agents: { getById: vi.fn().mockResolvedValue(agent) },
      adapterFor: () =>
        llmSummonAdapter({ instructions: instructionsWith(mandateText), dispatch }),
    });

    await summoner.summon({
      conversationId: "conv-1",
      agentId: "agent-1",
      triggeringMessageId: "msg-1",
    });

    expect(conversations.postMessage).toHaveBeenCalledWith({
      conversationId: "conv-1",
      authorKind: "agent",
      authorId: "agent-1",
      body: "Northgate schematic is at risk.",
    });
  });

  it("says the answer failed rather than leaving silence", async () => {
    // Silence is indistinguishable from being ignored: the person @-mentions an
    // agent, nothing appears, and the failure is visible only in a server log
    // they are not reading. Reporting "I could not answer" invents nothing — it
    // is this agent's own failure — and it cannot be mistaken for an answer.
    const conversations = {
      paginate: vi.fn().mockResolvedValue([{ role: "user", content: "@Delivery ?" }]),
      postMessage: vi.fn(),
    };
    const summoner = agentSummoner({
      conversations,
      agents: { getById: vi.fn().mockResolvedValue(agent) },
      adapterFor: () =>
        llmSummonAdapter({
          instructions: instructionsWith(mandateText),
          dispatch: vi.fn().mockRejectedValue(new Error("model down")),
        }),
    });

    await expect(
      summoner.summon({
        conversationId: "conv-1",
        agentId: "agent-1",
        triggeringMessageId: "msg-1",
      }),
    ).rejects.toThrow(/model down/);

    // Posted, and unmistakably not an answer.
    expect(conversations.postMessage).toHaveBeenCalledTimes(1);
    const posted = conversations.postMessage.mock.calls[0][0] as { body: string };
    expect(posted.body).toContain("could not answer");
    expect(posted.body).toContain("nothing here is an answer");
    expect(posted.body).toContain("model down");
  });
});
