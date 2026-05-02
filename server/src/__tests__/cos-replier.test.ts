import { describe, it, expect, vi } from "vitest";
import { cosReplier } from "../services/cos-replier.js";

describe("cosReplier.reply", () => {
  it("loads last 20 messages, calls LLM, posts the reply authored by CoS", async () => {
    const conversations = {
      paginate: vi.fn().mockResolvedValue([
        { role: "user", content: "What's our outbound volume?" },
      ]),
      postMessage: vi.fn().mockResolvedValue({ id: "m1" }),
    };
    const llm = vi.fn().mockResolvedValue("Outbound volume sits around 80/week today.");

    await cosReplier({ conversations, llm } as any).reply({
      conversationId: "conv1",
      cosAgentId: "cos1",
    });

    expect(conversations.paginate).toHaveBeenCalledWith("conv1", { limit: 20 });
    expect(llm).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.any(Array),
    }));
    expect(conversations.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv1", authorKind: "agent", authorId: "cos1",
      body: "Outbound volume sits around 80/week today.",
    }));
  });
});
