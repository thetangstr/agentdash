import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { humanChannelService } from "../services/human-channels.js";
import type { StewardAgentReplierDeps } from "../services/steward-agent-replier.js";
import { telegramConnectorService } from "../services/telegram-connector.js";

/**
 * Extract the pairing token from `/start <token>`.
 *
 * Returns null for a bare `/start`, which an already-paired user sends every
 * time they reopen the chat — treating that as a failed pairing attempt would
 * answer a greeting with an error.
 */
function parsePairingToken(text: string | undefined): string | null {
  if (typeof text !== "string") return null;
  const match = /^\/start(?:@\S+)?\s+(\S+)\s*$/.exec(text.trim());
  return match ? match[1] : null;
}

/**
 * Telegram webhook.
 *
 * Mounted OUTSIDE the authenticated API surface: the caller is Telegram, not a
 * board user, and authenticity comes from the shared secret header rather than
 * a session.
 */
export function telegramConnectorRoutes(db: Db, deps: StewardAgentReplierDeps = {}) {
  const router = Router();
  const telegram = telegramConnectorService(db, deps);
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
    const message = update.message as {
      text?: string;
      from?: { id?: number | string; is_bot?: boolean };
      chat?: { id?: number | string; type?: string };
    } | undefined;
    const fromId = callbackQuery?.from?.id ?? message?.from?.id;

    // A `/start <token>` deep link arrives BEFORE any binding exists, so it
    // cannot resolve its company the way every other update does. The token
    // carries that: peek at the challenge to learn the company, claim the
    // update against it for deduplication, and only then spend the token.
    //
    // That ordering is what makes a Telegram redelivery safe. Consuming before
    // claiming would let the retry find the token already spent and tell the
    // user their pairing failed — for a pairing that in fact succeeded.
    const pairingToken = parsePairingToken(message?.text);
    if (pairingToken && fromId != null) {
      const challenge = await channels.peekPairingChallenge("telegram", pairingToken);
      if (!challenge) {
        // Unknown, expired, or spent. Hand it to the connector anyway so the
        // person who opened a dead link is told, rather than met with silence.
        await telegram.completePairing({
          token: pairingToken,
          externalUserId: String(fromId),
          chatId: message?.chat?.id ?? null,
          chatType: message?.chat?.type ?? "private",
          isBot: message?.from?.is_bot === true,
        });
        res.status(200).json({ ok: true });
        return;
      }

      const pairClaim = await channels.claimEvent(
        "telegram",
        challenge.companyId,
        String(updateId),
        telegram.digest(update),
        { eventType: "pairing" },
      );
      if (!pairClaim.claimed) {
        res.status(200).json({ ok: true });
        return;
      }

      try {
        await telegram.completePairing({
          token: pairingToken,
          externalUserId: String(fromId),
          chatId: message?.chat?.id ?? null,
          chatType: message?.chat?.type ?? "private",
          isBot: message?.from?.is_bot === true,
        });
        if (pairClaim.eventId) await channels.markEventProcessed(pairClaim.eventId, "processed");
      } catch (error) {
        logger.warn({ err: error, updateId }, "telegram pairing failed");
        if (pairClaim.eventId) await channels.markEventProcessed(pairClaim.eventId, "failed");
      }
      res.status(200).json({ ok: true });
      return;
    }

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
