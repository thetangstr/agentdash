import { describe, it, expect, vi } from "vitest";
import { cosInterview } from "../services/cos-interview.js";
import { FIXED_QUESTIONS, type InterviewState, type InterviewTurn } from "@paperclipai/shared";

function fresh(): InterviewState {
  return { conversationId: "conv-1", turns: [], fixedQuestionsAsked: 0, followUpsAsked: 0, status: "in_progress" };
}

describe("cosInterview.nextTurn", () => {
  it("asks the first fixed question on a fresh state without calling LLM", async () => {
    const llm = vi.fn();
    const r = await cosInterview({ llm } as any).nextTurn(fresh());
    expect(r.assistantMessage).toBe(FIXED_QUESTIONS[0]);
    expect(r.state.fixedQuestionsAsked).toBe(1);
    expect(llm).not.toHaveBeenCalled();
  });

  it("asks the second fixed question after the first user reply", async () => {
    const llm = vi.fn();
    const state: InterviewState = {
      conversationId: "conv-1",
      turns: [
        { role: "assistant", content: FIXED_QUESTIONS[0], ts: "1" },
        { role: "user", content: "B2B SaaS", ts: "2" },
      ],
      fixedQuestionsAsked: 1, followUpsAsked: 0, status: "in_progress",
    };
    const r = await cosInterview({ llm } as any).nextTurn(state);
    expect(r.assistantMessage).toBe(FIXED_QUESTIONS[1]);
    expect(r.state.fixedQuestionsAsked).toBe(2);
  });

  it("asks an LLM follow-up after fixed three are answered", async () => {
    const llm = vi.fn().mockResolvedValue({ text: "How many emails per week?", readyToPropose: false });
    const state: InterviewState = {
      conversationId: "conv-1",
      turns: longTurns(6),
      fixedQuestionsAsked: 3, followUpsAsked: 0, status: "in_progress",
    };
    const r = await cosInterview({ llm } as any).nextTurn(state);
    expect(r.assistantMessage).toContain("emails");
    expect(r.state.followUpsAsked).toBe(1);
    expect(llm).toHaveBeenCalledOnce();
  });

  it("transitions to ready_to_propose when LLM signals stop", async () => {
    const llm = vi.fn().mockResolvedValue({ text: "Got it.", readyToPropose: true });
    const state: InterviewState = {
      conversationId: "conv-1", turns: longTurns(8),
      fixedQuestionsAsked: 3, followUpsAsked: 1, status: "in_progress",
    };
    const r = await cosInterview({ llm } as any).nextTurn(state);
    expect(r.state.status).toBe("ready_to_propose");
  });

  it("exceeds_max after 4 follow-ups even if LLM keeps asking", async () => {
    const llm = vi.fn().mockResolvedValue({ text: "Another?", readyToPropose: false });
    const state: InterviewState = {
      conversationId: "conv-1", turns: longTurns(11),
      fixedQuestionsAsked: 3, followUpsAsked: 4, status: "in_progress",
    };
    const r = await cosInterview({ llm } as any).nextTurn(state);
    expect(r.state.status).toBe("exceeded_max");
    expect(r.assistantMessage).toBeNull();
  });
});

function longTurns(n: number): InterviewTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? "assistant" : "user") as InterviewTurn["role"],
    content: `placeholder ${i}`,
    ts: String(i),
  }));
}
