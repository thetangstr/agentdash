import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  onboardingOrchestrator,
  cosInterview,
  agentProposer,
  agentCreatorFromProposal,
  conversationService,
  agentService,
  accessService,
  companyService,
  agentInstructionsService,
} from "../services/index.js";
import { unauthorized, badRequest } from "../errors.js";
import { FIXED_QUESTIONS, type InterviewState, type InterviewTurn } from "@paperclipai/shared";

export function onboardingV2Routes(db: Db) {
  const router = Router();
  const conversations = conversationService(db);
  const agents = agentService(db);

  const users = {
    getById: async (id: string) => {
      const rows = await db
        .select()
        .from(authUsers)
        .where(eq(authUsers.id, id));
      return rows[0] ?? null;
    },
  };

  const orch = onboardingOrchestrator({
    access: accessService(db),
    companies: companyService(db),
    agents,
    instructions: agentInstructionsService(),
    conversations,
    users,
  });

  // POST /api/onboarding/bootstrap
  router.post("/bootstrap", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const result = await orch.bootstrap(req.actor.userId);
    // Seed the first CoS message (post the first fixed question to the conversation).
    const firstMessage = `Welcome to AgentDash. Let's get you set up. ${FIXED_QUESTIONS[0]}`;
    await conversations.postMessage({
      conversationId: result.conversationId,
      authorKind: "agent",
      authorId: result.cosAgentId,
      body: firstMessage,
      cardKind: "interview_question_v1",
      cardPayload: { question: FIXED_QUESTIONS[0], fixedIndex: 0 },
    });
    res.json({ ...result, firstMessage });
  });

  // POST /api/onboarding/interview/turn
  router.post("/interview/turn", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const { conversationId, userMessage, cosAgentId } = req.body as {
      conversationId: string;
      userMessage: string;
      companyId: string;
      cosAgentId: string;
    };
    if (!conversationId || !userMessage?.trim()) {
      throw badRequest("conversationId and userMessage required");
    }
    // 1. Append user message.
    await conversations.postMessage({
      conversationId,
      authorKind: "user",
      authorId: req.actor.userId,
      body: userMessage,
    });
    // 2. Load state from DB (rebuild from existing messages).
    const state = await loadInterviewState(db, conversationId);
    // 3. Drive next turn.
    const interview = cosInterview({ llm: defaultStubLlm });
    const next = await interview.nextTurn(state);
    // 4. Append assistant message.
    if (next.assistantMessage && cosAgentId) {
      await conversations.postMessage({
        conversationId,
        authorKind: "agent",
        authorId: cosAgentId,
        body: next.assistantMessage,
      });
    }
    res.json({ assistantMessage: next.assistantMessage, state: next.state });
  });

  // POST /api/onboarding/agent/confirm
  router.post("/agent/confirm", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const { conversationId, reportsToAgentId, companyId } = req.body as {
      conversationId: string;
      reportsToAgentId: string;
      companyId: string;
    };
    if (!conversationId || !reportsToAgentId || !companyId) {
      throw badRequest("conversationId, reportsToAgentId, and companyId required");
    }
    const transcript = await loadInterviewTranscript(db, conversationId);
    const proposal = await agentProposer({ llm: defaultStubProposer }).propose(
      transcript.length > 0 ? transcript : [{ role: "user", content: "stub", ts: new Date().toISOString() }],
    );
    const result = await agentCreatorFromProposal({
      agents,
      instructions: agentInstructionsService(),
    }).create({ companyId, reportsToAgentId, proposal, transcript });
    // Append a CoS message announcing the hire as a proposal_card_v1.
    await conversations.postMessage({
      conversationId,
      authorKind: "agent",
      authorId: reportsToAgentId,
      body: `${proposal.name} (${proposal.role}) is on your team. ${proposal.oneLineOkr}.`,
      cardKind: "proposal_card_v1",
      cardPayload: proposal as unknown as Record<string, unknown>,
    });
    res.status(201).json({
      agent: { id: result.agentId, name: proposal.name, title: proposal.role },
      apiKey: result.apiKey,
      proposal,
    });
  });

  // POST /api/onboarding/invites
  router.post("/invites", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const { emails } = req.body as {
      conversationId: string;
      companyId: string;
      emails: string[];
    };
    if (!Array.isArray(emails)) {
      throw badRequest("emails must be an array");
    }
    const inviteIds: string[] = [];
    const errors: Array<{ email: string; reason: string }> = [];
    // TODO: wire upstream invite service when available.
    // grep -rn "invitation\|invite" server/src/services/ shows no standalone invite service yet.
    for (const email of emails) {
      errors.push({ email, reason: "invite-service-not-wired-yet" });
    }
    res.json({ inviteIds, errors });
  });

  return router;
}

// --- helpers ---

async function loadInterviewState(db: Db, conversationId: string): Promise<InterviewState> {
  const svc = conversationService(db);
  const recent = await svc.paginate(conversationId, { limit: 100 });
  // paginate returns desc by created_at; reverse to chronological
  const ordered = [...recent].reverse();
  const turns: InterviewTurn[] = ordered.map((m: any) => ({
    role: (m.role === "agent" ? "assistant" : m.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
    content: m.content ?? "",
    ts:
      typeof m.createdAt === "string"
        ? m.createdAt
        : new Date(m.createdAt ?? Date.now()).toISOString(),
  }));
  // Re-derive counters by counting fixed questions asked and follow-ups.
  const fixedAsked = FIXED_QUESTIONS.filter((q) =>
    turns.some((t) => t.role === "assistant" && t.content.includes(q)),
  ).length;
  const assistantTurns = turns.filter((t) => t.role === "assistant").length;
  const followUpsAsked = Math.max(0, assistantTurns - fixedAsked);
  return {
    conversationId,
    turns,
    fixedQuestionsAsked: fixedAsked,
    followUpsAsked,
    status: "in_progress",
  };
}

async function loadInterviewTranscript(db: Db, conversationId: string): Promise<InterviewTurn[]> {
  const state = await loadInterviewState(db, conversationId);
  return state.turns;
}

async function defaultStubLlm(
  _input: Parameters<
    Parameters<typeof cosInterview>[0]["llm"]
  >[0],
): ReturnType<Parameters<typeof cosInterview>[0]["llm"]> {
  return {
    text: "Got it — I have what I need to propose your first hire.",
    readyToPropose: true,
  };
}

async function defaultStubProposer(_transcript: InterviewTurn[]) {
  return {
    name: "Sam",
    role: "general assistant",
    oneLineOkr: "Help with whatever the user needs in their first 90 days.",
    rationale:
      "Stub fallback proposal — wire real LLM when ANTHROPIC_API_KEY is configured.",
  };
}
