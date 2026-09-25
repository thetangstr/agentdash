import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { type Db, deepInterviewSpecs as deepInterviewSpecsTable } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { unauthorized, badRequest, notFound } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess } from "./authz.js";
import {
  conversationService,
  conversationDispatch,
  agentService,
  cosReplier,
  cosOnboardingStateService,
  agentSummoner,
  agentInstructionsService,
} from "../services/index.js";
import { llmSummonAdapter } from "../services/agent-summoner.js";
import type { DeepInterviewSpecsService } from "../services/cos-replier.js";
import { dispatchLLM } from "../services/dispatch-llm.js";

const COMPANY_INBOX_TITLE = "Company Inbox";

export function conversationRoutes(db: Db) {
  const router = Router();
  const svc = conversationService(db);
  const agents = agentService(db);

  const cosResolver = {
    findByCompany: async (companyId: string) => {
      const all = await agents.list(companyId);
      return all.find((a: any) => a.role === "chief_of_staff") ?? null;
    },
  };

  const dispatcher = conversationDispatch({
    conversations: svc,
    agents: {
      listForCompany: (companyId: string) => agents.list(companyId),
      getById: (id: string) => agents.getById(id),
    },
    summoner: agentSummoner({
      conversations: svc,
      agents: { getById: (id: string) => agents.getById(id) },
      // One adapter for every `adapterType`, deliberately: `dispatchLLM` already
      // selects the model from AGENTDASH_DEFAULT_ADAPTER, which is the same
      // selection the `replier` below uses. Branching on the agent's own
      // `adapterType` here would let a summoned agent answer through a different
      // model than the CoS in the same conversation, for no stated reason.
      adapterFor: (_t: string) =>
        llmSummonAdapter({
          instructions: agentInstructionsService(),
          dispatch: (input) => dispatchLLM(input),
        }),
    }),
    // dispatchLLM routes to the CoS chat adapter selected via `agentdash setup`
    // (AGENTDASH_DEFAULT_ADAPTER). Defaults to claude_api; also supports
    // hermes_local and claude_local. Unsupported adapters fail explicitly.
    replier: cosReplier({
      conversations: svc,
      llm: dispatchLLM,
      db, // AgentDash (Cloud SKU, G3): enables usage metering of CoS replies
      cosState: cosOnboardingStateService(db),
      deepInterviewSpecs: deepInterviewSpecsLoader(db),
    } as any),
    cosResolver,
  });

  // AgentDash (security): every `/:id` route resolves the conversation first
  // and authorizes against the conversation's own company. The company is
  // never taken from the request body — a caller-supplied companyId used to
  // pick which company's live-event stream a message was broadcast on.
  async function loadAuthorizedConversation(req: Request) {
    // Authenticate before the lookup, so an anonymous caller cannot tell an
    // existing conversation id (401) from a missing one (404).
    assertAuthenticated(req);
    const conversation = await svc.getById(req.params.id as string);
    if (!conversation) {
      throw notFound("Conversation not found");
    }
    assertCompanyAccess(req, conversation.companyId);
    return conversation;
  }

  // GET /api/conversations/companies/:companyId/inbox
  router.get("/companies/:companyId/inbox", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    let conversation = await svc.findByCompany(companyId, { title: COMPANY_INBOX_TITLE });
    if (!conversation) {
      conversation = await svc.create({
        companyId,
        userId: req.actor.userId,
        title: COMPANY_INBOX_TITLE,
      });
      await svc.addParticipant(conversation.id, req.actor.userId, "owner");
    }
    res.json(conversation);
  });

  // POST /api/conversations/:id/messages
  router.post("/:id/messages", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const { body } = req.body as { body: string };
    if (typeof body !== "string" || !body.trim()) {
      throw badRequest("Message body required");
    }
    const conversation = await loadAuthorizedConversation(req);
    const companyId = conversation.companyId;
    const msg = await svc.postMessage({
      conversationId: conversation.id,
      authorKind: "user",
      authorId: req.actor.userId,
      body,
      companyId,
    });
    void dispatcher
      .onMessage({
        messageId: msg.id,
        conversationId: conversation.id,
        companyId,
        authorUserId: req.actor.userId,
        body,
      })
      .catch((err: unknown) => {
        logger.error({ err, conversationId: req.params.id }, "conversation dispatch failed");
      });
    res.status(201).json(msg);
  });

  // GET /api/conversations/:id/messages?before=<ts>&limit=50
  router.get("/:id/messages", async (req, res) => {
    const conversation = await loadAuthorizedConversation(req);
    const before =
      typeof req.query.before === "string" ? req.query.before : undefined;
    const limit = Math.min(
      parseInt(String(req.query.limit ?? "50"), 10) || 50,
      200,
    );
    const messages = await svc.paginate(conversation.id, { before, limit });
    res.json(messages);
  });

  // PATCH /api/conversations/:id/read
  router.patch("/:id/read", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const { lastReadMessageId } = req.body as { lastReadMessageId: string };
    if (!lastReadMessageId) {
      throw badRequest("lastReadMessageId required");
    }
    const conversation = await loadAuthorizedConversation(req);
    const updated = await svc.setReadPointer(
      conversation.id,
      req.actor.userId,
      lastReadMessageId,
      conversation.companyId,
    );
    if (!updated) {
      throw badRequest("lastReadMessageId is not a message in this conversation");
    }
    res.status(204).end();
  });

  // GET /api/conversations/:id/participants
  router.get("/:id/participants", async (req, res) => {
    const conversation = await loadAuthorizedConversation(req);
    const ps = await svc.listParticipants(conversation.id);
    res.json(ps);
  });

  return router;
}

// AgentDash (Phase F): minimal spec loader the cos-replier uses to fetch a
// crystallized deep_interview_specs row by id. Kept inline here (not a full
// service) because no other call site reads specs in v1.
function deepInterviewSpecsLoader(db: Db): DeepInterviewSpecsService {
  return {
    getById: async (specId: string) => {
      const rows = await db
        .select()
        .from(deepInterviewSpecsTable)
        .where(eq(deepInterviewSpecsTable.id, specId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        goal: row.goal,
        constraints: Array.isArray(row.constraints) ? (row.constraints as unknown[]) : [],
        criteria: Array.isArray(row.criteria) ? (row.criteria as unknown[]) : [],
      };
    },
  };
}
