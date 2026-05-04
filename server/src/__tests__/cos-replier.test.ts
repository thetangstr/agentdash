import { describe, it, expect, vi } from "vitest";
import { cosReplier, parseTrailer } from "../services/cos-replier.js";

describe("cosReplier.parseTrailer", () => {
  it("extracts a fenced ```json trailer and strips it from the body", () => {
    const raw = [
      "Got it. Short-term you want to ship v2; long-term a self-running ops org.",
      "How urgent is the Q3 deadline?",
      "",
      "```json",
      '{ "captured": { "shortTerm": "ship v2 by Q3" }, "phase_decision": "stay_in_goals" }',
      "```",
    ].join("\n");
    const { body, trailer } = parseTrailer(raw);
    expect(body).toBe(
      "Got it. Short-term you want to ship v2; long-term a self-running ops org.\nHow urgent is the Q3 deadline?",
    );
    expect(trailer).toEqual({
      captured: { shortTerm: "ship v2 by Q3" },
      phase_decision: "stay_in_goals",
    });
  });

  it("returns the body unchanged with trailer=null when no JSON block is present", () => {
    const raw = "Just a plain reply with no JSON trailer.";
    const { body, trailer } = parseTrailer(raw);
    expect(body).toBe(raw);
    expect(trailer).toBeNull();
  });

  it("tolerates malformed JSON by returning trailer=null and the original body", () => {
    const raw = "Hello there.\n\n```json\n{ this is not valid }\n```";
    const { body, trailer } = parseTrailer(raw);
    expect(trailer).toBeNull();
    expect(body).toBe(raw.trimEnd());
  });

  it("ignores fenced JSON that isn't at the very end of the message", () => {
    const raw = "```json\n{}\n```\nthen more talk after";
    const { body, trailer } = parseTrailer(raw);
    expect(trailer).toBeNull();
    expect(body).toBe(raw);
  });
});

describe("cosReplier.reply (legacy single-arg path)", () => {
  it("loads last 20 messages, calls LLM, posts the reply authored by CoS", async () => {
    const conversations = {
      paginate: vi.fn().mockResolvedValue([
        { role: "user", content: "What's our outbound volume?" },
      ]),
      postMessage: vi.fn().mockResolvedValue({ id: "m1" }),
    };
    // No cosState passed => steady-state prompt path; no JSON trailer required.
    const llm = vi.fn().mockResolvedValue("Outbound volume sits around 80/week today.");

    await cosReplier({ conversations, llm } as any).reply({
      conversationId: "conv1",
      cosAgentId: "cos1",
    });

    expect(conversations.paginate).toHaveBeenCalledWith("conv1", { limit: 20 });
    expect(llm).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.any(Array),
      }),
    );
    expect(conversations.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv1",
        authorKind: "agent",
        authorId: "cos1",
        body: "Outbound volume sits around 80/week today.",
      }),
    );
  });
});

describe("cosReplier.reply (phase-aware path)", () => {
  function makeConversations(messages: Array<{ role: string; content: string }>) {
    return {
      paginate: vi.fn().mockResolvedValue(messages),
      postMessage: vi.fn().mockResolvedValue({ id: "msg-card" }),
    };
  }

  it("captures goals + advances to plan when the trailer says advance_to_plan", async () => {
    const conversations = makeConversations([
      { role: "user", content: "Ship v2 by Q3, build self-running ops by next year, eng team is 12." },
    ]);
    const cosState = {
      getOrCreate: vi.fn().mockResolvedValue({
        conversationId: "conv1",
        phase: "goals",
        goals: {},
        proposalMessageId: null,
        turnsInPhase: 0,
      }),
      recordTurn: vi.fn().mockResolvedValue(undefined),
      setGoals: vi.fn().mockResolvedValue(undefined),
      advancePhase: vi.fn().mockResolvedValue(undefined),
    };
    const llm = vi.fn().mockResolvedValue(
      [
        "Got it.",
        "",
        "```json",
        JSON.stringify({
          captured: { shortTerm: "ship v2", longTerm: "self-running ops", constraints: { teamSize: 12 } },
          phase_decision: "advance_to_plan",
        }),
        "```",
      ].join("\n"),
    );

    await cosReplier({ conversations, llm, cosState } as any).reply({
      conversationId: "conv1",
      cosAgentId: "cos1",
    });

    expect(cosState.setGoals).toHaveBeenCalledWith("conv1", {
      shortTerm: "ship v2",
      longTerm: "self-running ops",
      constraints: { teamSize: 12 },
    });
    expect(cosState.advancePhase).toHaveBeenCalledWith("conv1", "plan");
    // Body posted is just the visible part — fenced JSON stripped.
    expect(conversations.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Got it.", authorKind: "agent" }),
    );
  });

  it("posts a plan card + visible body when in plan phase with a valid plan payload", async () => {
    const conversations = makeConversations([
      { role: "user", content: "Looks good." },
    ]);
    const cosState = {
      getOrCreate: vi.fn().mockResolvedValue({
        conversationId: "conv1",
        phase: "plan",
        goals: { shortTerm: "ship v2", longTerm: "ops org" },
        proposalMessageId: null,
        turnsInPhase: 0,
      }),
      recordTurn: vi.fn().mockResolvedValue(undefined),
      setGoals: vi.fn().mockResolvedValue(undefined),
      advancePhase: vi.fn().mockResolvedValue(undefined),
    };
    const planPayload = {
      rationale: "ship v2 + seed ops",
      agents: [
        {
          role: "engineering_lead",
          name: "Ellie",
          adapterType: "claude_local",
          responsibilities: ["own dashboard"],
          kpis: ["ship Q3"],
        },
      ],
      alignmentToShortTerm: "ships v2",
      alignmentToLongTerm: "lays groundwork",
    };
    const llm = vi.fn().mockResolvedValue(
      [
        "Here's the team I'd build out — want me to set them up, or revise?",
        "",
        "```json",
        JSON.stringify({ phase_decision: "stay_in_plan", plan: planPayload }),
        "```",
      ].join("\n"),
    );

    await cosReplier({ conversations, llm, cosState } as any).reply({
      conversationId: "conv1",
      cosAgentId: "cos1",
    });

    // First postMessage should be the card (empty body, agent_plan_proposal_v1).
    expect(conversations.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cardKind: "agent_plan_proposal_v1",
        cardPayload: planPayload,
      }),
    );
    // Second postMessage should be the visible body.
    expect(conversations.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        body: "Here's the team I'd build out — want me to set them up, or revise?",
      }),
    );
    expect(cosState.advancePhase).toHaveBeenCalledWith("conv1", "plan", {
      proposalMessageId: "msg-card",
    });
  });

  it("falls through gracefully when LLM omits a JSON trailer in goals phase", async () => {
    const conversations = makeConversations([{ role: "user", content: "hi" }]);
    const cosState = {
      getOrCreate: vi.fn().mockResolvedValue({
        conversationId: "conv1",
        phase: "goals",
        goals: {},
        proposalMessageId: null,
        turnsInPhase: 0,
      }),
      recordTurn: vi.fn().mockResolvedValue(undefined),
      setGoals: vi.fn().mockResolvedValue(undefined),
      advancePhase: vi.fn().mockResolvedValue(undefined),
    };
    const llm = vi.fn().mockResolvedValue("Tell me more about your team.");
    await cosReplier({ conversations, llm, cosState } as any).reply({
      conversationId: "conv1",
      cosAgentId: "cos1",
    });

    expect(cosState.setGoals).not.toHaveBeenCalled();
    expect(cosState.advancePhase).not.toHaveBeenCalled();
    expect(conversations.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Tell me more about your team." }),
    );
  });
});
