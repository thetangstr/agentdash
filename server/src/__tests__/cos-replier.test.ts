import { describe, it, expect, vi, afterEach } from "vitest";
import {
  announcesPlan,
  cosReplier,
  parseTrailer,
  defaultAgentPlanAdapterType,
} from "../services/cos-replier.js";

describe("cosReplier.defaultAgentPlanAdapterType", () => {
  const originalValue = process.env.AGENTDASH_DEFAULT_ADAPTER;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.AGENTDASH_DEFAULT_ADAPTER;
    } else {
      process.env.AGENTDASH_DEFAULT_ADAPTER = originalValue;
    }
  });

  it("honors AGENTDASH_DEFAULT_ADAPTER when it names a known adapter", () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "claude_local";
    expect(defaultAgentPlanAdapterType()).toBe("claude_local");
  });

  it("falls back to hermes_local for an unknown adapter value", () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "garbage";
    expect(defaultAgentPlanAdapterType()).toBe("hermes_local");
  });

  it("rejects partial adapter names that only appear inside the prompt string", () => {
    // The old string-based check matched any substring of the rendered list;
    // "local" must NOT validate against the array-based check.
    process.env.AGENTDASH_DEFAULT_ADAPTER = "local";
    expect(defaultAgentPlanAdapterType()).toBe("hermes_local");
  });

  it("falls back to hermes_local when unset", () => {
    delete process.env.AGENTDASH_DEFAULT_ADAPTER;
    expect(defaultAgentPlanAdapterType()).toBe("hermes_local");
  });
});

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
  // Regression (CoS replies only appeared after a reload): every CoS post
  // carries the companyId, so the conversation service publishes
  // message.created and the open chat shows the reply live.
  it("posts the reply with the companyId so the open chat gets message.created", async () => {
    const conversations = {
      paginate: vi.fn().mockResolvedValue([{ role: "user", content: "Quick check: are you there?" }]),
      postMessage: vi.fn().mockResolvedValue({ id: "m1" }),
    };
    const llm = vi.fn().mockResolvedValue("Yes, I'm here.");
    await cosReplier({ conversations, llm } as any).reply({ conversationId: "conv1", cosAgentId: "cos1", companyId: "co1" });
    expect(conversations.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv1", body: "Yes, I'm here.", companyId: "co1" }),
    );
  });

  it("keeps a 'CoS couldn't reply' card out of the model's history", async () => {
    const conversations = {
      paginate: vi.fn().mockResolvedValue([
        { role: "agent", content: "CoS couldn't reply: hermes_local: no balance. Retry", cardKind: "cos_dispatch_error_v1" },
        { role: "user", content: "Quick check: are you there?" },
      ]),
      postMessage: vi.fn().mockResolvedValue({ id: "m1" }),
    };
    const llm = vi.fn().mockResolvedValue("Yes.");
    await cosReplier({ conversations, llm } as any).reply({ conversationId: "conv1", cosAgentId: "cos1" });
    const sent = llm.mock.calls[0][0].messages as Array<{ content: string }>;
    expect(sent.map((m) => m.content)).toEqual(["Quick check: are you there?"]);
  });

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
    // No db/companyId provided -> metering is skipped (meter arg is undefined).
    expect(llm).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.any(Array),
      }),
      undefined,
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

  it("forwards a metering context to the LLM when db + companyId are provided (G3)", async () => {
    const conversations = {
      paginate: vi.fn().mockResolvedValue([{ role: "user", content: "hi" }]),
      postMessage: vi.fn().mockResolvedValue({ id: "m1" }),
    };
    const llm = vi.fn().mockResolvedValue("reply");
    const db = {} as any;

    await cosReplier({ conversations, llm, db } as any).reply({
      conversationId: "conv1",
      cosAgentId: "cos1",
      companyId: "co1",
    });

    expect(llm).toHaveBeenCalledWith(
      expect.objectContaining({ messages: expect.any(Array) }),
      { db, companyId: "co1", agentId: "cos1" },
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
      advancePhaseIf: vi.fn().mockResolvedValue({ phase: "plan" }),
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
    expect(cosState.advancePhaseIf).toHaveBeenCalledWith("conv1", "goals", "plan");
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

    expect(llm.mock.calls[0][0].system).toContain("hermes_local");

    // The intro comes first so the chat reads it above the card (they used to
    // be created 2ms apart in the other order, so the card sat above its intro).
    expect(conversations.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        body: "Here's the team I'd build out — want me to set them up, or revise?",
      }),
    );
    expect(conversations.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cardKind: "agent_plan_proposal_v1",
        cardPayload: planPayload,
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

// AgentDash (first-session test, Lane A item 1): the CoS said "Let me pull
// together the working plan" and then nothing arrived until the user nudged it.
describe("cosReplier.reply (plan arrives in the same turn)", () => {
  const planPayload = {
    rationale: "research + content first",
    agents: [
      { role: "research_analyst", name: "Rae", adapterType: "hermes_local", responsibilities: ["map the market"], kpis: ["brief weekly"] },
      { role: "content_lead", name: "Cole", adapterType: "hermes_local", responsibilities: ["write posts"], kpis: ["2 posts/week"] },
    ],
    alignmentToShortTerm: "launch",
    alignmentToLongTerm: "grow",
  };
  const planReply = [
    "Here's the team I'd start with. Want me to set them up, or revise?",
    "",
    "```json",
    JSON.stringify({ phase_decision: "stay_in_plan", plan: planPayload }),
    "```",
  ].join("\n");
  const advancingGoalsBody =
    "So: launch in 90 days, a self-running content engine in a year, two people. Let me pull together the working plan.";
  const advancingGoalsReply = [
    advancingGoalsBody,
    "```json",
    JSON.stringify({
      captured: { shortTerm: "launch in 90 days", longTerm: "self-running content engine", constraints: { teamSize: 2, budget: "lean" } },
      phase_decision: "advance_to_plan",
    }),
    "```",
  ].join("\n");
  const isPlanPrompt = (input: { system: string }) => input.system.includes("Propose a concrete agent team");

  // A conversation + state fake that behaves like the real services: the
  // phase move is a compare-and-set and hasCard reads what was posted.
  function makeWorld(initialGoals: Record<string, unknown> = {}) {
    const posted: any[] = [];
    let n = 0;
    const world = {
      phase: "goals" as string,
      goals: { ...initialGoals } as Record<string, any>,
      failCardPosts: 0,
    };
    const conversations = {
      paginate: vi.fn(async () => [{ role: "user", content: "Two of us, small budget, keep it lean." }]),
      postMessage: vi.fn(async (msg: any) => {
        if (msg.cardKind && world.failCardPosts > 0) {
          world.failCardPosts -= 1;
          throw new Error("db down");
        }
        await Promise.resolve();
        const row = { ...msg, id: msg.cardKind ? `card-${++n}` : `msg-${++n}` };
        posted.push(row);
        return row;
      }),
      hasCard: vi.fn(async (_id: string, kind: string) => posted.some((m) => m.cardKind === kind)),
    };
    const cosState = {
      getOrCreate: vi.fn(async () => ({
        conversationId: "conv1",
        phase: world.phase,
        goals: world.goals,
        proposalMessageId: null,
        turnsInPhase: 3,
      })),
      recordTurn: vi.fn(async () => undefined),
      setGoals: vi.fn(async (_id: string, patch: any) => {
        world.goals = { ...world.goals, ...patch };
      }),
      advancePhase: vi.fn(async (_id: string, next: string) => {
        world.phase = next;
      }),
      advancePhaseIf: vi.fn(async (_id: string, from: string, next: string) => {
        await Promise.resolve();
        if (world.phase !== from) return null;
        world.phase = next;
        return { phase: next };
      }),
    };
    return { world, posted, conversations, cosState };
  }

  it("posts the plan card in the same turn when the goals reply advances", async () => {
    const { posted, conversations, cosState, world } = makeWorld();
    const llm = vi.fn().mockResolvedValueOnce(advancingGoalsReply).mockResolvedValueOnce(planReply);

    await cosReplier({ conversations, llm, cosState } as any).reply({ conversationId: "conv1", cosAgentId: "cos1" });

    expect(llm).toHaveBeenCalledTimes(2);
    // The follow-up turn runs the plan prompt with the goals captured this turn.
    expect(llm.mock.calls[1][0].system).toContain("launch in 90 days");
    expect(isPlanPrompt(llm.mock.calls[1][0])).toBe(true);
    expect(posted.map((m) => m.cardKind ?? m.body)).toEqual([
      advancingGoalsBody,
      "Here's the team I'd start with. Want me to set them up, or revise?",
      "agent_plan_proposal_v1",
    ]);
    expect(cosState.advancePhaseIf).toHaveBeenCalledWith("conv1", "goals", "plan");
    expect(cosState.advancePhase).toHaveBeenCalledWith("conv1", "plan", { proposalMessageId: "card-3" });
    expect(world.phase).toBe("plan");
  });

  // AgentDash (scan 4, lane N): the CoS named an agent after the founder.
  it("tells the plan turn who works here and renames an agent that still takes a member's name", async () => {
    const { posted, conversations, cosState } = makeWorld();
    const llm = vi.fn().mockResolvedValueOnce(advancingGoalsReply).mockResolvedValueOnce(planReply);
    const memberNames = vi.fn().mockResolvedValue(["Rae Lindqvist"]);

    await cosReplier({ conversations, llm, cosState, memberNames } as any).reply({
      conversationId: "conv1",
      cosAgentId: "cos1",
      companyId: "co1",
    });

    expect(memberNames).toHaveBeenCalledWith("co1");
    const planSystem = llm.mock.calls[1][0].system as string;
    expect(planSystem).toContain('"Rae Lindqvist"');
    expect(planSystem).toContain("do not list the agents");
    expect(planSystem).toContain('"title"');
    const card = posted.find((m) => m.cardKind === "agent_plan_proposal_v1");
    expect(card.cardPayload.agents.map((a: any) => a.name)).toEqual(["Avery", "Cole"]);
  });

  it("treats a plan announcement as an advance once the goals are complete, even without the decision flag", async () => {
    const { posted, conversations, cosState } = makeWorld({ shortTerm: "launch", longTerm: "grow" });
    const goalsReply = [
      "Got it, budget stays lean. Let me pull together the working plan.",
      "```json",
      JSON.stringify({ captured: { constraints: { budget: "lean" } }, phase_decision: "stay_in_goals" }),
      "```",
    ].join("\n");
    const llm = vi.fn().mockResolvedValueOnce(goalsReply).mockResolvedValueOnce(planReply);

    await cosReplier({ conversations, llm, cosState } as any).reply({ conversationId: "conv1", cosAgentId: "cos1" });

    expect(llm).toHaveBeenCalledTimes(2);
    expect(posted.filter((m) => m.cardKind === "agent_plan_proposal_v1")).toHaveLength(1);
  });

  it("does not treat a mention of the team as a plan announcement", async () => {
    const { posted, conversations, cosState, world } = makeWorld({ shortTerm: "launch", longTerm: "grow" });
    const goalsReply = [
      "Budget noted. Let me ask about your current team.",
      "```json",
      JSON.stringify({ captured: { constraints: { budget: "lean" } }, phase_decision: "stay_in_goals" }),
      "```",
    ].join("\n");
    const llm = vi.fn().mockResolvedValueOnce(goalsReply);

    await cosReplier({ conversations, llm, cosState } as any).reply({ conversationId: "conv1", cosAgentId: "cos1" });

    expect(llm).toHaveBeenCalledTimes(1);
    expect(world.phase).toBe("goals");
    expect(posted.map((m) => m.body)).toEqual(["Budget noted. Let me ask about your current team."]);
  });

  it("keeps interviewing when the goals are incomplete", async () => {
    const { posted, conversations, cosState } = makeWorld();
    const goalsReply = [
      "Launch in 90 days, noted. What does success look like a year out?",
      "```json",
      JSON.stringify({ captured: { shortTerm: "launch" }, phase_decision: "stay_in_goals" }),
      "```",
    ].join("\n");
    const llm = vi.fn().mockResolvedValueOnce(goalsReply);

    await cosReplier({ conversations, llm, cosState } as any).reply({ conversationId: "conv1", cosAgentId: "cos1" });

    expect(llm).toHaveBeenCalledTimes(1);
    expect(cosState.advancePhaseIf).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
  });

  // Review of #953: two messages at once must not yield two plan cards.
  it("yields one plan card when two messages are answered at once", async () => {
    const { posted, conversations, cosState } = makeWorld();
    const llm = vi.fn(async (input: { system: string }) => (isPlanPrompt(input) ? planReply : advancingGoalsReply));
    const replier = cosReplier({ conversations, llm, cosState } as any);

    await Promise.all([
      replier.reply({ conversationId: "conv1", cosAgentId: "cos1" }),
      replier.reply({ conversationId: "conv1", cosAgentId: "cos1" }),
    ]);

    expect(posted.filter((m) => m.cardKind === "agent_plan_proposal_v1")).toHaveLength(1);
    // Two goals turns, one plan turn.
    expect(llm.mock.calls.filter(([input]) => isPlanPrompt(input))).toHaveLength(1);
  });

  it("skips the plan step when a plan card already exists", async () => {
    const { posted, conversations, cosState } = makeWorld();
    posted.push({ id: "old-card", cardKind: "agent_plan_proposal_v1", cardPayload: planPayload });
    const llm = vi.fn().mockResolvedValueOnce(advancingGoalsReply).mockResolvedValueOnce(planReply);

    await cosReplier({ conversations, llm, cosState } as any).reply({ conversationId: "conv1", cosAgentId: "cos1" });

    expect(llm).toHaveBeenCalledTimes(1);
    expect(posted.filter((m) => m.cardKind === "agent_plan_proposal_v1")).toHaveLength(1);
  });

  // Review of #953: a failed card post is caught, the phase goes back to
  // goals, and the next message retries cleanly.
  it("returns the phase to goals when the plan card cannot be posted, and the next message retries", async () => {
    const { world, posted, conversations, cosState } = makeWorld();
    world.failCardPosts = 1;
    const llm = vi.fn(async (input: { system: string }) => (isPlanPrompt(input) ? planReply : advancingGoalsReply));
    const replier = cosReplier({ conversations, llm, cosState } as any);

    await expect(replier.reply({ conversationId: "conv1", cosAgentId: "cos1" })).resolves.toBeDefined();
    expect(cosState.advancePhaseIf).toHaveBeenCalledWith("conv1", "plan", "goals");
    expect(world.phase).toBe("goals");
    expect(posted.filter((m) => m.cardKind)).toHaveLength(0);

    await replier.reply({ conversationId: "conv1", cosAgentId: "cos1" });
    expect(world.phase).toBe("plan");
    expect(posted.filter((m) => m.cardKind === "agent_plan_proposal_v1")).toHaveLength(1);
  });

  it("returns the phase to goals when the follow-up plan turn yields no plan", async () => {
    const { world, posted, conversations, cosState } = makeWorld();
    const llm = vi.fn().mockResolvedValueOnce(advancingGoalsReply).mockResolvedValueOnce("Hmm, let me think.");

    await cosReplier({ conversations, llm, cosState } as any).reply({ conversationId: "conv1", cosAgentId: "cos1" });

    expect(world.phase).toBe("goals");
    expect(posted.filter((m) => m.cardKind)).toHaveLength(0);
  });

  it("posts the dispatch error card (with Retry target) when the follow-up plan call throws", async () => {
    const { world, posted, conversations, cosState } = makeWorld();
    const llm = vi
      .fn()
      .mockResolvedValueOnce(advancingGoalsReply)
      .mockRejectedValueOnce(new Error("hermes exited 1: HTTP 429: Insufficient balance or no resource package"));

    await cosReplier({ conversations, llm, cosState } as any).reply({
      conversationId: "conv1",
      cosAgentId: "cos1",
      companyId: "co1",
      triggerMessageId: "u1",
    });

    expect(world.phase).toBe("goals");
    const card = posted.find((m) => m.cardKind === "cos_dispatch_error_v1");
    expect(card).toBeDefined();
    expect(card!.cardPayload).toMatchObject({ retryMessageId: "u1" });
  });

  it("catches a failed card post in the plan phase and still answers", async () => {
    const { world, posted, conversations, cosState } = makeWorld();
    world.phase = "plan";
    world.failCardPosts = 1;
    const llm = vi.fn().mockResolvedValueOnce(planReply);

    await expect(
      cosReplier({ conversations, llm, cosState } as any).reply({ conversationId: "conv1", cosAgentId: "cos1" }),
    ).resolves.toBeDefined();

    expect(world.phase).toBe("plan");
    expect(posted.map((m) => m.body)).toEqual(["Here's the team I'd start with. Want me to set them up, or revise?"]);
  });
});

describe("announcesPlan", () => {
  it("matches plan-specific announcements", () => {
    for (const text of [
      "Let me pull together the working plan.",
      "I'll put together a plan for you.",
      "Let me put the plan together.",
      "I'll draft a proposal now.",
      "Give me a second to draw up a team plan.",
      "I'm building your plan.",
    ]) {
      expect(announcesPlan(text), text).toBe(true);
    }
  });

  it("does not match team mentions, questions or plain plan talk", () => {
    for (const text of [
      "Let me ask about your current team.",
      "I'll work with your team on that.",
      "Tell me about the team you have today.",
      "What's your plan for hiring?",
      "Should I put together a plan?",
      "Do you already have a budget plan?",
      "Got it. What would you build first?",
    ]) {
      expect(announcesPlan(text), text).toBe(false);
    }
  });
});
