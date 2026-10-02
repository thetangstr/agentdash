import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { type Db, deepInterviewSpecs as deepInterviewSpecsTable } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { unauthorized, badRequest, notFound, forbidden } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess } from "./authz.js";
import {
  companyService,
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
import { postDispatchFailure } from "../services/cos-dispatch-failure.js";
import { buildPhase0Greeting } from "../services/onboarding-orchestrator.js";

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

  // AgentDash (first-session test, Lane A item 4): a fresh company's inbox used
  // to open empty, so the founder faced a blank Ask page. The CoS opens the
  // inbox with the interview's first question, but only for a genuinely fresh
  // company (#953 review):
  // - no conversation existed before this inbox, so no CoS interview has run
  //   (cos onboarding state is per conversation, so none exists either) and a
  //   founder who finished the /cos interview is never greeted again;
  // - the company has never hired: its only agent, terminated ones included,
  //   is the Chief of Staff.
  // Best effort: a failure here never blocks returning the inbox.
  async function postCosOpener(companyId: string, conversationId: string) {
    try {
      const all = await agents.list(companyId, { includeTerminated: true });
      const cos = all.find((a: any) => a.role === "chief_of_staff");
      if (!cos || all.some((a: any) => a.role !== "chief_of_staff")) return;
      let companyName: string | null = null;
      try {
        companyName = (await companyService(db).getById(companyId))?.name ?? null;
      } catch {
        // The greeting falls back to the product name.
      }
      await svc.postMessage({
        conversationId,
        authorKind: "agent",
        authorId: cos.id,
        body: buildPhase0Greeting(null, companyName),
        companyId,
      });
    } catch (err) {
      logger.warn({ err, companyId, conversationId }, "could not post the CoS opener");
    }
  }

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
      // Any earlier conversation (e.g. the /cos bootstrap one) means the
      // company is not fresh: it already has its CoS thread and greeting.
      const earlierConversation = await svc.findByCompany(companyId);
      conversation = await svc.create({
        companyId,
        userId: req.actor.userId,
        title: COMPANY_INBOX_TITLE,
      });
      await svc.addParticipant(conversation.id, req.actor.userId, "owner");
      if (!earlierConversation) await postCosOpener(companyId, conversation.id);
    }
    res.json(conversation);
  });

  // AgentDash (P0, v2026.1002.0): a failed dispatch is never silent. The
  // error is logged as before AND posted into the conversation as a
  // `cos_dispatch_error_v1` card ("CoS couldn't reply: <reason>. Retry"),
  // which publishes `message.created` so the open chat drops its "thinking"
  // state and offers Retry.
  function dispatchInBackground(input: {
    messageId: string;
    conversationId: string;
    companyId: string;
    authorUserId: string;
    body: string;
  }) {
    void dispatcher.onMessage(input).catch(async (err: unknown) => {
      logger.error({ err, conversationId: input.conversationId }, "conversation dispatch failed");
      try {
        const cos = await cosResolver.findByCompany(input.companyId);
        await postDispatchFailure(svc, {
          conversationId: input.conversationId,
          companyId: input.companyId,
          authorId: cos?.id ?? "system",
          retryMessageId: input.messageId,
          err,
        });
      } catch (postErr) {
        logger.error(
          { err: postErr, conversationId: input.conversationId },
          "could not post the dispatch failure into the conversation",
        );
      }
    });
  }

  // POST /api/conversations/:id/messages/:messageId/retry
  // Re-runs the dispatch for one of the person's own earlier messages (the
  // Retry on a dispatch error card) without posting the message again.
  router.post("/:id/messages/:messageId/retry", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const conversation = await loadAuthorizedConversation(req);
    const message = await svc.getMessage(conversation.id, req.params.messageId as string);
    if (!message || message.role !== "user") {
      throw notFound("Message not found");
    }
    // The CoS acts with the authority of the person who sent the words, so
    // only that person may re-run them. company access (above) is not enough:
    // a teammate must not retry someone else's message under their own
    // identity. Messages from before the author was recorded are not retryable;
    // the person sends them again.
    if (!message.authorUserId || message.authorUserId !== req.actor.userId) {
      throw forbidden("Only the person who sent this message can retry it");
    }
    dispatchInBackground({
      messageId: message.id,
      conversationId: conversation.id,
      companyId: conversation.companyId,
      authorUserId: req.actor.userId,
      body: message.content,
    });
    res.status(202).json({ ok: true, messageId: message.id });
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
    dispatchInBackground({
      messageId: msg.id,
      conversationId: conversation.id,
      companyId,
      authorUserId: req.actor.userId,
      body,
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
