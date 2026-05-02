import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { unauthorized, badRequest } from "../errors.js";
import {
  conversationService,
  conversationDispatch,
  agentService,
  cosReplier,
  agentSummoner,
} from "../services/index.js";

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

  const llmStub = async (_input: any): Promise<string> => {
    // TODO: wire real LLM (Anthropic SDK). Stub for now.
    return "Got it. (stub reply — wire real LLM in onboarding plan)";
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
      adapterFor: (_t: string) => ({
        execute: async () => ({ output: "Stub agent reply" }),
      }),
    }),
    replier: cosReplier({ conversations: svc, llm: llmStub } as any),
    cosResolver,
  });

  // POST /api/conversations/:id/messages
  router.post("/:id/messages", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const { body, companyId } = req.body as { body: string; companyId?: string };
    if (typeof body !== "string" || !body.trim()) {
      throw badRequest("Message body required");
    }
    const resolvedCompanyId: string =
      companyId ??
      req.actor.companyId ??
      req.actor.companyIds?.[0] ??
      "";
    const msg = await svc.postMessage({
      conversationId: req.params.id,
      authorKind: "user",
      authorId: req.actor.userId,
      body,
      companyId: resolvedCompanyId || undefined,
    });
    void dispatcher
      .onMessage({
        messageId: msg.id,
        conversationId: req.params.id,
        companyId: resolvedCompanyId,
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
    const before =
      typeof req.query.before === "string" ? req.query.before : undefined;
    const limit = Math.min(
      parseInt(String(req.query.limit ?? "50"), 10) || 50,
      200,
    );
    const messages = await svc.paginate(req.params.id, { before, limit });
    res.json(messages);
  });

  // PATCH /api/conversations/:id/read
  router.patch("/:id/read", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign-in required");
    }
    const { lastReadMessageId, companyId } = req.body as {
      lastReadMessageId: string;
      companyId?: string;
    };
    if (!lastReadMessageId) {
      throw badRequest("lastReadMessageId required");
    }
    const resolvedCompanyId: string =
      companyId ??
      req.actor.companyId ??
      req.actor.companyIds?.[0] ??
      "";
    await svc.setReadPointer(
      req.params.id,
      req.actor.userId,
      lastReadMessageId,
      resolvedCompanyId || undefined,
    );
    res.status(204).end();
  });

  // GET /api/conversations/:id/participants
  router.get("/:id/participants", async (req, res) => {
    const ps = await svc.listParticipants(req.params.id);
    res.json(ps);
  });

  return router;
}
