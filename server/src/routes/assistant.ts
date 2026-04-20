/**
 * Routes for the Assistant Chatbot.
 * SSE streaming chat + conversation management endpoints.
 * AgentDash: assistant chatbot routes
 */
import { Router } from "express";
import type { Db } from "@agentdash/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { chat, listConversations, getConversationMessages, archiveConversation } from "../services/assistant.js";
import type { ToolContext } from "../services/assistant-tools.js";
import { logger } from "../middleware/logger.js";

function httpStatus(err: unknown): number {
  const e = err as { statusCode?: number; status?: number };
  return e.statusCode ?? e.status ?? 500;
}

export function assistantRoutes(db: Db) {
  const router = Router();

  // POST /companies/:companyId/assistant/chat — SSE streaming chat
  router.post("/companies/:companyId/assistant/chat", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const { message, conversationId } = req.body as {
        message: string;
        conversationId?: string;
      };

      if (!message || typeof message !== "string") {
        res.status(400).json({ error: "message is required" });
        return;
      }

      const actor = req.actor;
      const userId = actor.type === "board" ? (actor.userId ?? "unknown") : "unknown";
      const userName = actor.type === "board" ? (actor.userId ?? "User") : "User";

      const toolContext: ToolContext = {
        userId,
        companyId,
        companyIds: actor.type === "board" ? (actor.companyIds ?? [companyId]) : [companyId],
        isInstanceAdmin: actor.type === "board" ? Boolean(actor.isInstanceAdmin) : false,
        source: actor.type === "board" ? (actor.source ?? "session") : "agent",
      };

      // Set SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      // Handle client disconnect
      let aborted = false;
      req.on("close", () => {
        aborted = true;
      });

      const generator = chat(db, {
        userId,
        companyId,
        conversationId: conversationId ?? null,
        message,
        userName,
        toolContext,
      });

      for await (const chunk of generator) {
        if (aborted) break;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      if (!aborted) {
        res.write("data: [DONE]\n\n");
      }

      res.end();
    } catch (err: unknown) {
      logger.error({ err }, "Assistant chat error");
      const message = err instanceof Error ? err.message : "Internal server error";
      if (!res.headersSent) {
        res.status(httpStatus(err)).json({ error: message });
      } else {
        res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        res.end();
      }
    }
  });

  // GET /companies/:companyId/assistant/conversations — list user's conversations
  router.get("/companies/:companyId/assistant/conversations", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const actor = req.actor;
      const userId = actor.type === "board" ? (actor.userId ?? "unknown") : "unknown";

      const conversations = await listConversations(db, userId, companyId);
      res.json(conversations);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(httpStatus(err)).json({ error: message });
    }
  });

  // GET /companies/:companyId/assistant/conversations/:id/messages — get messages
  router.get("/companies/:companyId/assistant/conversations/:id/messages", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const conversationId = req.params.id as string;
      const actor = req.actor;
      const userId = actor.type === "board" ? (actor.userId ?? "unknown") : "unknown";
      const messages = await getConversationMessages(db, conversationId, companyId, userId);
      res.json(messages);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(httpStatus(err)).json({ error: message });
    }
  });

  // DELETE /companies/:companyId/assistant/conversations/:id — archive conversation
  router.delete("/companies/:companyId/assistant/conversations/:id", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const conversationId = req.params.id as string;
      await archiveConversation(db, conversationId, companyId);
      res.status(204).end();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(httpStatus(err)).json({ error: message });
    }
  });

  return router;
}
