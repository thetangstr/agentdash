import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { humanChannelService } from "../services/human-channels.js";
import type { StewardAgentReplierDeps } from "../services/steward-agent-replier.js";
import { whatsappConnectorService } from "../services/whatsapp-connector.js";

const PROVIDER = "whatsapp";

interface WhatsAppMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  interactive?: { type?: string; button_reply?: { id?: string } };
}

/**
 * Flatten Meta's deeply nested webhook envelope into the messages it carries.
 *
 * One POST may carry several messages across several entries, and each one is
 * deduplicated and dispatched on its own — treating the payload as a single
 * unit would let one duplicate message suppress a distinct sibling.
 */
function extractMessages(body: unknown): WhatsAppMessage[] {
  const entries = (body as { entry?: unknown[] } | undefined)?.entry;
  if (!Array.isArray(entries)) return [];
  const out: WhatsAppMessage[] = [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] } | undefined)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown[] } } | undefined)?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const message of messages) out.push(message as WhatsAppMessage);
    }
  }
  return out;
}

/**
 * A pairing token arrives as the whole body of the prefilled `wa.me` message.
 *
 * Matched on shape rather than a command prefix: WhatsApp has no `/start`
 * convention, and requiring one would mean the user editing the prefilled text.
 */
function parsePairingToken(text: string | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return /^[A-Za-z0-9_-]{32}$/.test(trimmed) ? trimmed : null;
}

/**
 * WhatsApp Cloud API webhook.
 *
 * Mounted OUTSIDE the authenticated API surface: the caller is Meta, not a
 * board user, and authenticity is the `X-Hub-Signature-256` HMAC over the raw
 * request body.
 */
export function whatsappConnectorRoutes(db: Db, deps: StewardAgentReplierDeps = {}) {
  const router = Router();
  const whatsapp = whatsappConnectorService(db, deps);
  const channels = humanChannelService(db);

  /** Meta's one-time subscription handshake. */
  router.get("/connectors/whatsapp/webhook", (req, res) => {
    const challenge = whatsapp.verifySubscription(req.query as Record<string, unknown>);
    if (challenge === null) {
      res.status(403).json({ error: "Verification failed" });
      return;
    }
    // Meta expects the raw challenge string, not JSON.
    res.status(200).type("text/plain").send(challenge);
  });

  router.post("/connectors/whatsapp/webhook", async (req, res) => {
    // Verified over the RAW bytes, before parsing or dispatch. Re-serializing
    // the parsed object would change the digest and reject authentic requests.
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from("");
    if (!whatsapp.verifySignature(rawBody, req.header("X-Hub-Signature-256") ?? undefined)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const messages = extractMessages(req.body);
    for (const message of messages) {
      try {
        await dispatchMessage(req, message);
      } catch (error) {
        logger.warn({ err: error, messageId: message.id }, "whatsapp message handling failed");
      }
    }

    // Always 200. A non-2xx makes Meta retry, which would turn an
    // authorization refusal into an unbounded redelivery loop.
    res.status(200).json({ ok: true });
  });

  async function dispatchMessage(_req: Request, message: WhatsAppMessage) {
    const wamid = message.id;
    const from = message.from;
    if (!wamid || !from) return;

    const text = message.text?.body;
    const buttonId = message.interactive?.button_reply?.id;

    // Pairing resolves its company from the challenge, because no binding
    // exists yet. Same peek → claim → consume ordering as Telegram: consuming
    // first would let a Meta redelivery report a failed pairing for one that
    // succeeded.
    const pairingToken = parsePairingToken(text);
    if (pairingToken) {
      const challenge = await channels.peekPairingChallenge(PROVIDER, pairingToken);
      if (!challenge) {
        await whatsapp.completePairing({ token: pairingToken, fromNumber: from });
        return;
      }
      const claim = await channels.claimEvent(
        PROVIDER,
        challenge.companyId,
        wamid,
        whatsapp.digest(message),
        { eventType: "pairing" },
      );
      if (!claim.claimed) return;
      try {
        await whatsapp.completePairing({ token: pairingToken, fromNumber: from });
        if (claim.eventId) await channels.markEventProcessed(claim.eventId, "processed");
      } catch (error) {
        if (claim.eventId) await channels.markEventProcessed(claim.eventId, "failed");
        throw error;
      }
      return;
    }

    const binding = await channels.resolveActiveBinding(PROVIDER, from);
    if (!binding) return;

    // `wamid` is the per-message dedup anchor. Meta redelivers on any non-2xx
    // and on its own schedule, and a redelivered button press must not decide
    // twice.
    const claim = await channels.claimEvent(
      PROVIDER,
      binding.companyId,
      wamid,
      whatsapp.digest(message),
      { eventType: buttonId ? "button_reply" : "message", bindingId: binding.id },
    );
    if (!claim.claimed) return;

    try {
      if (buttonId) {
        await whatsapp.handleButtonReply({ tokenValue: buttonId, fromNumber: from });
      } else if (typeof text === "string" && text.trim().length > 0) {
        await whatsapp.handleTextMessage({ text, fromNumber: from });
      }
      if (claim.eventId) await channels.markEventProcessed(claim.eventId, "processed");
    } catch (error) {
      if (claim.eventId) await channels.markEventProcessed(claim.eventId, "failed");
      throw error;
    }
  }

  return router;
}
