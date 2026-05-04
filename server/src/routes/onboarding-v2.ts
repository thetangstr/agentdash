import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { authUsers, assistantConversations, assistantMessages } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
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
  cosOnboardingStateService,
} from "../services/index.js";
import { unauthorized, badRequest, notFound } from "../errors.js";
import {
  FIXED_QUESTIONS,
  type AgentPlanProposalV1Payload,
  type InterviewState,
  type InterviewTurn,
} from "@paperclipai/shared";

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
  // The orchestrator owns the welcome sequence end-to-end (posted atomically
  // inside the fresh-conversation branch of bootstrap()). The route just
  // returns IDs; clients fetch the messages via /api/conversations/:id/messages.
  router.post("/bootstrap", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const result = await orch.bootstrap(req.actor.userId);
    res.json(result);
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

  // POST /api/onboarding/agent/reject
  router.post("/agent/reject", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const { conversationId, cosAgentId, reason } = req.body as {
      conversationId: string;
      cosAgentId: string;
      reason?: string;
    };
    if (!conversationId || !cosAgentId) {
      throw badRequest("conversationId and cosAgentId required");
    }
    // Append a user message capturing the rejection reason.
    await conversations.postMessage({
      conversationId,
      authorKind: "user",
      authorId: req.actor.userId,
      body: reason ?? "Try a different proposal.",
    });
    // Append a CoS acknowledgement.
    await conversations.postMessage({
      conversationId,
      authorKind: "agent",
      authorId: cosAgentId,
      body: "Got it — let me think differently. One sec.",
    });
    res.json({ ok: true });
  });

  // POST /api/onboarding/confirm-plan
  // Reads the latest agent_plan_proposal_v1 message in the conversation,
  // creates one agent per payload entry, materializes the chief_of_staff
  // instructions bundle, posts a closing message, and flips cos_state to ready.
  router.post("/confirm-plan", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const { conversationId } = req.body as { conversationId?: string };
    if (!conversationId) throw badRequest("conversationId required");

    const convoRows = await db
      .select()
      .from(assistantConversations)
      .where(eq(assistantConversations.id, conversationId));
    const convo = convoRows[0];
    if (!convo) throw notFound("Conversation not found");
    const companyId = convo.companyId;

    const planRows = await db
      .select()
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.conversationId, conversationId),
          eq(assistantMessages.cardKind, "agent_plan_proposal_v1"),
        ),
      )
      .orderBy(desc(assistantMessages.createdAt))
      .limit(1);
    const planMsg = planRows[0];
    if (!planMsg) throw notFound("No plan card found in this conversation");
    const payload = planMsg.cardPayload as AgentPlanProposalV1Payload | null;
    if (!payload || !Array.isArray(payload.agents) || payload.agents.length === 0) {
      throw badRequest("Plan card has no agents to materialize");
    }

    const cosState = cosOnboardingStateService(db);
    await cosState.advancePhase(conversationId, "materializing");

    // Find the CoS agent for this company so the new hires reportTo it.
    const allAgents = await agents.list(companyId);
    const cos = allAgents.find((a: any) => a.role === "chief_of_staff") ?? null;
    const reportsToAgentId = cos?.id ?? null;

    const instructions = agentInstructionsService();
    const createdAgentIds: string[] = [];
    for (const planAgent of payload.agents) {
      const created = await agents.create(companyId, {
        name: planAgent.name,
        role: "general",
        title: planAgent.role,
        adapterType: planAgent.adapterType,
        adapterConfig: {},
        reportsTo: reportsToAgentId,
        status: "idle",
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      });
      const responsibilities = (planAgent.responsibilities ?? []).map((r) => `- ${r}`).join("\n");
      const kpis = (planAgent.kpis ?? []).map((k) => `- ${k}`).join("\n");
      const agentsMd = `# AGENTS.md — ${planAgent.name}

## Role
${planAgent.role}

## Why you exist
${payload.rationale}

## Primary Responsibilities
${responsibilities || "- (none captured)"}

## KPIs
${kpis || "- (none captured)"}

## Alignment
- Short-term: ${payload.alignmentToShortTerm}
- Long-term: ${payload.alignmentToLongTerm}

## Collaboration
- Report status to your boss in the shared CoS thread.
- Ask for clarification when requirements are ambiguous.
`;
      await instructions.materializeManagedBundle(
        created,
        { "AGENTS.md": agentsMd },
        { entryFile: "AGENTS.md", replaceExisting: false },
      );
      createdAgentIds.push(created.id);
    }

    if (cos) {
      await conversations.postMessage({
        conversationId,
        authorKind: "agent",
        authorId: cos.id,
        body: "Done — your team's ready. You can talk to any of them via @mention, or stay here and route through me.",
      });
    }

    await cosState.advancePhase(conversationId, "ready");

    res.status(201).json({ companyId, createdAgentIds });
  });

  // POST /api/onboarding/revise-plan
  // Phase F (revision loop) is deferred — see
  // docs/superpowers/specs/2026-05-04-cos-onboarding-conversation-design.md.
  // Stub returns 501 so the UI's "Let me revise" button has a wired target.
  router.post("/revise-plan", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    res.status(501).json({
      error: "not_implemented",
      message: "Plan revision loop is not implemented yet (Phase F).",
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
