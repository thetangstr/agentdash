import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { humanChannelService } from "../services/human-channels.js";
import { telegramConnectorService } from "../services/telegram-connector.js";

/**
 * Telegram webhook.
 *
 * Mounted OUTSIDE the authenticated API surface: the caller is Telegram, not a
 * board user, and authenticity comes from the shared secret header rather than
 * a session.
 */
export function telegramConnectorRoutes(db: Db) {
  const router = Router();
  const telegram = telegramConnectorService(db);
  const channels = humanChannelService(db);

  router.post("/connectors/telegram/webhook", async (req, res) => {
    // Verified BEFORE parsing or dispatch, per design §13.
    if (!telegram.verifyWebhookSecret(req.header("X-Telegram-Bot-Api-Secret-Token") ?? undefined)) {
      res.status(401).json({ error: "Invalid webhook secret" });
      return;
    }

    const update = (req.body ?? {}) as Record<string, unknown>;
    const updateId = update.update_id;
    if (typeof updateId !== "number") {
      // Acknowledge malformed input rather than inviting redelivery.
      res.status(200).json({ ok: true });
      return;
    }

    // Resolve the company from the binding so dedup is company-scoped.
    const callbackQuery = update.callback_query as { from?: { id?: number | string } } | undefined;
    const message = update.message as { from?: { id?: number | string } } | undefined;
    const fromId = callbackQuery?.from?.id ?? message?.from?.id;
    const binding =
      fromId != null
        ? await channels.resolveActiveBinding("telegram", String(fromId))
        : null;

    if (!binding) {
      // Unpaired or revoked: acknowledge and drop. Never dispatch.
      res.status(200).json({ ok: true });
      return;
    }

    const claim = await channels.claimEvent(
      "telegram",
      binding.companyId,
      String(updateId),
      telegram.digest(update),
      { eventType: callbackQuery ? "callback_query" : "message", bindingId: binding.id },
    );

    if (!claim.claimed) {
      // Redelivery of an already-handled update. Still answer the callback so
      // the client stops spinning, but perform no side effects.
      const callbackId = (update.callback_query as { id?: string } | undefined)?.id;
      if (callbackId) await telegram.answerCallbackQuery(callbackId, "Already handled.");
      res.status(200).json({ ok: true });
      return;
    }

    try {
      await telegram.handleUpdate(update);
      if (claim.eventId) await channels.markEventProcessed(claim.eventId, "processed");
    } catch (error) {
      logger.warn({ err: error, updateId }, "telegram update handling failed");
      if (claim.eventId) await channels.markEventProcessed(claim.eventId, "failed");
    }

    // Always 200: a non-2xx makes Telegram retry, which would turn a refusal
    // into an infinite redelivery loop.
    res.status(200).json({ ok: true });
  });

  return router;
}
