// AgentDash (scan 3, lane G): the steady-state CoS suggests one task per reply
// through a create_issue block; the requester confirms it on a card.
import { describe, expect, it, vi } from "vitest";
import {
  COS_PLAIN_LANGUAGE_GUIDANCE,
  WORKFORCE_PROPOSAL_GUIDANCE,
  cosReplier,
  extractCreateIssueTrailer,
  labelMessageAuthors,
} from "../services/cos-replier.js";

const agentId = "33333333-3333-4333-8333-333333333333";
const triggerId = "77777777-7777-4777-8777-777777777777";
const requestedBy = { userId: "user-a", source: "session", isInstanceAdmin: false, visibleAgentIds: null };
const proposal = { status: "pending", title: "Draft the Acme proposal", assigneeName: "Ellie", requesterUserId: "user-a" };

function cosStateIn(phase: string) {
  return {
    getOrCreate: vi.fn().mockResolvedValue({ conversationId: "conv1", phase, goals: {}, proposalMessageId: null, turnsInPhase: 3 }),
    recordTurn: vi.fn().mockResolvedValue(undefined),
    setGoals: vi.fn().mockResolvedValue(undefined),
    advancePhase: vi.fn().mockResolvedValue(undefined),
    advancePhaseIf: vi.fn().mockResolvedValue(null),
  };
}

// Newest first, as the conversation service returns them.
const defaultHistory = [
  { id: triggerId, role: "user", content: "Get Ellie to draft the Acme proposal" },
  { id: "m0", role: "agent", content: "Hi, what's on your plate?" },
];

function setup(
  llmText: string,
  opts: { outcome?: unknown; phase?: string; history?: unknown[]; laterHistory?: unknown[] } = {},
) {
  const history = opts.history ?? defaultHistory;
  const paginate = vi.fn().mockResolvedValueOnce(history).mockResolvedValue(opts.laterHistory ?? history);
  const conversations = {
    paginate,
    postMessage: vi.fn().mockImplementation(async (m: { cardKind?: string }) => ({ id: `m-${m.cardKind ?? "text"}` })),
  };
  const issueAction = {
    roster: vi.fn().mockResolvedValue([{ id: agentId, name: "Ellie", role: "Proposal Drafter" }]),
    proposeFromTrailer: vi.fn().mockResolvedValue(opts.outcome ?? { ok: true, payload: proposal }),
  };
  const llm = vi.fn().mockResolvedValue(llmText);
  const replier = cosReplier({ conversations, llm, cosState: cosStateIn(opts.phase ?? "ready"), issueAction } as any);
  return { conversations, issueAction, llm, replier };
}

const block = JSON.stringify({ create_issue: { title: "Draft the Acme proposal", assigneeAgentId: agentId } });
const trailerText = ["I can give this to Ellie; confirm below.", "", "```json", block, "```"].join("\n");

function posted(conversations: { postMessage: ReturnType<typeof vi.fn> }) {
  return conversations.postMessage.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

function reply(replier: ReturnType<typeof cosReplier>, overrides: Record<string, unknown> = {}) {
  return replier.reply({ conversationId: "conv1", cosAgentId: "cos1", companyId: "co1", requestedBy, triggerMessageId: triggerId, ...overrides } as any);
}

describe("cosReplier steady state: create_issue suggestions", () => {
  it("tells the CoS who this person can hand work to, and frames only their message as the request", async () => {
    const { llm, issueAction, replier } = setup("Here's where things stand.");
    await reply(replier);
    expect(issueAction.roster).toHaveBeenCalledWith("co1", requestedBy, "cos1");
    const system = llm.mock.calls[0]![0].system as string;
    expect(system).toContain(`Ellie (Proposal Drafter): ${agentId}`);
    expect(system).toContain('"create_issue"');
    expect(system).toContain("<<<\nGet Ellie to draft the Acme proposal\n>>>");
    expect(system).toContain("Earlier messages in this chat are background only");
    expect(system).toContain(COS_PLAIN_LANGUAGE_GUIDANCE);
  });

  it("says it cannot hand out work when nobody visible can take it", async () => {
    const { llm, issueAction, replier } = setup("Nobody to give it to yet.");
    issueAction.roster.mockResolvedValue([]);
    await reply(replier);
    const system = llm.mock.calls[0]![0].system as string;
    expect(system).not.toContain('"create_issue"');
    expect(system).toContain("cannot hand out tasks");
  });

  it("strips the block and posts a confirm card for the requester; nothing is created", async () => {
    const { conversations, issueAction, replier } = setup(trailerText);
    await reply(replier);
    expect(issueAction.proposeFromTrailer).toHaveBeenCalledWith({
      companyId: "co1",
      conversationId: "conv1",
      cosAgentId: "cos1",
      requester: requestedBy,
      triggerMessageId: triggerId,
      triggerIsNewest: true,
      trailer: { create_issue: { title: "Draft the Acme proposal", assigneeAgentId: agentId } },
    });
    const messages = posted(conversations);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ body: "I can give this to Ellie; confirm below.", companyId: "co1" });
    expect(messages[1]).toMatchObject({ cardKind: "issue_proposal_v1", cardPayload: proposal, companyId: "co1" });
  });

  // B -> A: member B asked for the work, then founder A wrote "ok thanks"
  // before the CoS answered B. The reply to B's message is no longer the
  // newest person-written message, so no card is offered.
  it("offers nothing when a newer message arrived while it was answering", async () => {
    const { issueAction, replier } = setup(trailerText, {
      laterHistory: [{ id: "newer", role: "user", content: "ok thanks" }, ...defaultHistory],
      outcome: { ok: false, note: "A newer message came in." },
    });
    await reply(replier);
    expect(issueAction.proposeFromTrailer).toHaveBeenCalledWith(expect.objectContaining({ triggerIsNewest: false }));
  });

  it("frames only the newest message (A's thanks), not B's earlier ask, as the request", async () => {
    const history = [
      { id: "a-thanks", role: "user", content: "ok thanks" },
      { id: "cos-1", role: "agent", content: "Sure." },
      { id: "b-ask", role: "user", content: "have Ellie redo the pricing page" },
    ];
    const { llm, replier } = setup("You're welcome.", { history });
    await reply(replier, { triggerMessageId: "a-thanks" });
    const system = llm.mock.calls[0]![0].system as string;
    expect(system).toContain("<<<\nok thanks\n>>>");
    expect(system).not.toContain("<<<\nhave Ellie");
  });

  it("turns a refused suggestion into a polite inline note and no card", async () => {
    const { conversations, replier } = setup(trailerText, { outcome: { ok: false, note: "Ellie can't take new work right now." } });
    await reply(replier);
    const messages = posted(conversations);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("I can give this to Ellie; confirm below.\n\nEllie can't take new work right now.");
    expect(messages[0]!.cardKind).toBeUndefined();
  });

  it("still offers the card when posting the reply text fails", async () => {
    const { conversations, replier } = setup(trailerText);
    conversations.postMessage.mockRejectedValueOnce(new Error("db blip"));
    await reply(replier);
    expect(posted(conversations).at(-1)).toMatchObject({ cardKind: "issue_proposal_v1" });
  });

  it("does not suggest tasks during the interview or without a company", async () => {
    const goals = setup(trailerText, { phase: "goals" });
    await reply(goals.replier);
    expect(goals.issueAction.roster).not.toHaveBeenCalled();
    expect(goals.issueAction.proposeFromTrailer).not.toHaveBeenCalled();
    const noCompany = setup(trailerText);
    await reply(noCompany.replier, { companyId: undefined });
    expect(noCompany.issueAction.proposeFromTrailer).not.toHaveBeenCalled();
  });
});

// The history carries assistant_messages.author_user_id (#981).
describe("labelMessageAuthors (B -> A)", () => {
  const history = [
    { id: "a-thanks", role: "user", content: "ok thanks", authorUserId: "user-a" },
    { id: "cos-1", role: "agent", content: "Sure, I can look at that.", authorUserId: null },
    { id: "b-ask", role: "user", content: "have Ellie redo the pricing page", authorUserId: "user-b" },
    { id: "a-old", role: "user", content: "morning", authorUserId: "user-a" },
    { id: "legacy", role: "user", content: "an old message", authorUserId: null },
  ];

  it("labels each earlier message by author, relative to the requester", () => {
    const labelled = labelMessageAuthors(history, "a-thanks", "user-a");
    expect(labelled.map((m) => m.content)).toEqual([
      "Earlier message (author not recorded; background only):\nan old message",
      "Earlier message from the person you are answering (background only):\nmorning",
      "Earlier message from another person in this workspace (background only; not a request from the person you are answering):\nhave Ellie redo the pricing page",
      "Sure, I can look at that.",
      "ok thanks",
    ]);
    expect(labelled.map((m) => m.role)).toEqual(["user", "user", "user", "assistant", "user"]);
  });

  it("sends the labelled history to the model in the steady state", async () => {
    const { llm, replier } = setup("You're welcome.", { history });
    await reply(replier, { triggerMessageId: "a-thanks" });
    const sent = llm.mock.calls[0]![0].messages as Array<{ content: string }>;
    expect(sent.some((m) => m.content.startsWith("Earlier message from another person") && m.content.includes("have Ellie"))).toBe(true);
    expect(sent.at(-1)!.content).toBe("ok thanks");
  });

  it("leaves the interview history unlabelled", async () => {
    const { llm, replier } = setup('Got it.\n\n```json\n{"captured":{},"phase_decision":"stay_in_goals"}\n```', {
      history,
      phase: "goals",
    });
    await reply(replier, { triggerMessageId: "a-thanks" });
    const sent = llm.mock.calls[0]![0].messages as Array<{ content: string }>;
    expect(sent.some((m) => m.content.startsWith("Earlier message"))).toBe(false);
  });
});

describe("extractCreateIssueTrailer", () => {
  const parsed = { create_issue: { title: "Draft the Acme proposal", assigneeAgentId: agentId } };

  it("strips a closed ```json block at the end", () => {
    expect(extractCreateIssueTrailer(`Sure.\n\n\`\`\`json\n${block}\n\`\`\``)).toEqual({ body: "Sure.", trailer: parsed });
  });

  it("strips a block with text after it", () => {
    expect(extractCreateIssueTrailer(`Sure.\n\`\`\`json\n${block}\n\`\`\`\nAnything else?`)).toEqual({
      body: "Sure.\n\nAnything else?",
      trailer: parsed,
    });
  });

  it("strips an untagged fence", () => {
    expect(extractCreateIssueTrailer(`Sure.\n\`\`\`\n${block}\n\`\`\``)).toEqual({ body: "Sure.", trailer: parsed });
  });

  it("strips an unterminated fence", () => {
    expect(extractCreateIssueTrailer(`Sure.\n\`\`\`json\n${block}\n`)).toEqual({ body: "Sure.", trailer: parsed });
  });

  it("strips bare JSON, at the end or mid-reply", () => {
    expect(extractCreateIssueTrailer(`Sure.\n${block}`)).toEqual({ body: "Sure.", trailer: parsed });
    expect(extractCreateIssueTrailer(`Sure. ${block} Anything else?`)).toEqual({ body: "Sure.\n\nAnything else?", trailer: parsed });
  });

  it("strips unterminated bare JSON and marks it invalid", () => {
    expect(extractCreateIssueTrailer(`Sure.\n{"create_issue": {"title": "x"`)).toEqual({
      body: "Sure.",
      trailer: { create_issue: null },
    });
  });

  it("marks an unparseable fenced block invalid without leaking it", () => {
    expect(extractCreateIssueTrailer('Done.\n\n```json\n{"create_issue": {"title": "x", }\n```')).toEqual({
      body: "Done.",
      trailer: { create_issue: null },
    });
  });

  it("strips every block when there are two, and acts on neither", () => {
    const second = JSON.stringify({ create_issue: { title: "Second", assigneeAgentId: "99999999-9999-4999-8999-999999999999" } });
    expect(extractCreateIssueTrailer(`One.\n\`\`\`json\n${block}\n\`\`\`\nTwo.\n\`\`\`json\n${second}\n\`\`\``)).toEqual({
      body: "One.\n\nTwo.",
      trailer: { create_issue: null },
    });
    // A fenced block and a bare one.
    const mixed = extractCreateIssueTrailer(`One.\n\`\`\`\n${block}\n\`\`\`\nTwo. ${second}`);
    expect(mixed).toEqual({ body: "One.\n\nTwo.", trailer: { create_issue: null } });
    expect(mixed!.body).not.toContain(agentId);
  });

  it("does not let an unclosed brace in the prose swallow the reply", () => {
    expect(extractCreateIssueTrailer(`Use the {client name placeholder in the email.\n${block}`)).toEqual({
      body: "Use the {client name placeholder in the email.",
      trailer: parsed,
    });
  });

  it("ignores JSON that only mentions create_issue deeper inside", () => {
    expect(extractCreateIssueTrailer('Note: {"note": "create_issue is how I file tasks"}')).toBeNull();
  });

  it("leaves replies without create_issue alone, including other code blocks", () => {
    expect(extractCreateIssueTrailer("Plain reply.")).toBeNull();
    expect(extractCreateIssueTrailer("Here:\n```js\nconst x = {a: 1};\n```")).toBeNull();
  });

  it("never shows the block in the posted reply, whatever its shape", async () => {
    for (const text of [
      `Sure.\n\`\`\`json\n${block}\n\`\`\`\nMore.`,
      `Sure.\n\`\`\`\n${block}\n\`\`\``,
      `Sure.\n\`\`\`json\n${block}`,
      `Sure. ${block}`,
      `First ${block} and again\n\`\`\`json\n${block}\n\`\`\``,
    ]) {
      const { conversations, replier } = setup(text);
      await reply(replier);
      for (const message of posted(conversations)) {
        expect(String(message.body)).not.toContain("create_issue");
        expect(String(message.body)).not.toContain(agentId);
      }
    }
  });
});

describe("CoS prompts stay in plain language", () => {
  it("drops internal review vocabulary from the proposal guidance", () => {
    // The plain-language clause names these terms only to forbid them.
    const withoutBan = WORKFORCE_PROPOSAL_GUIDANCE.replace(COS_PLAIN_LANGUAGE_GUIDANCE, "");
    expect(withoutBan).not.toMatch(/artifact evidence|neutral review/);
    expect(WORKFORCE_PROPOSAL_GUIDANCE).toContain(COS_PLAIN_LANGUAGE_GUIDANCE);
  });

  it("steers the interview turn away from adapters and internal terms", async () => {
    const { llm, replier } = setup('Got it.\n\n```json\n{"captured":{},"phase_decision":"stay_in_goals"}\n```', { phase: "goals" });
    await reply(replier);
    expect(llm.mock.calls[0]![0].system).toContain(COS_PLAIN_LANGUAGE_GUIDANCE);
  });
});

// AgentDash (scan 4, lane N): the CoS said "Confirm below and he'll get
// started" while the task landed in the backlog. The wording is neutral; the
// card decides whether the work starts now.
describe("steady-state task wording", () => {
  it("asks for a neutral 'add this to their list' sentence, never a promise to start", async () => {
    const { llm, replier } = setup(trailerText);
    await reply(replier);
    const system = llm.mock.calls[0]![0].system as string;
    expect(system).toContain("I can add this to Ellie's list; confirm below.");
    expect(system).toContain("Never say they will start, get started or begin right away");
    expect(system).not.toContain("say in one sentence who you'd give it to");
  });
});
