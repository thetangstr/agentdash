import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { channelCallbackTokens, humanChannelBindings } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { approvalAuthorityService } from "./approval-authority.js";
import { approvalService } from "./approvals.js";
import { humanChannelService } from "./human-channels.js";
import { stewardAgentReplier, type StewardAgentReplierDeps } from "./steward-agent-replier.js";
import { logActivity } from "./activity-log.js";

/**
 * AgentDash-MK: WhatsApp Cloud API connector.
 *
 * Shaped after the Telegram connector on purpose — same opaque callback tokens,
 * same shared decision boundary, same pairing-challenge table — so the two
 * cannot drift into different security properties for the same product promise.
 *
 * Two things genuinely differ:
 *
 * 1. **The 24-hour window.** A business may send free-form messages only within
 *    24 hours of the user's last inbound message; outside it, only pre-approved
 *    templates. `human_channel_bindings.last_inbound_at` records the boundary.
 * 2. **Identity is a phone number**, which is guessable in a way a Telegram
 *    user id is not. The pairing ceremony never accepts a user-supplied number:
 *    the user sends the token FROM their phone, which is what proves they hold
 *    it. See `whatsappPairingLink`.
 */

const GRAPH_API = "https://graph.facebook.com/v21.0";
const CALLBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROVIDER = "whatsapp";

/**
 * Verify `X-Hub-Signature-256` over the RAW body.
 *
 * Raw bytes, not the re-serialized object: any key reordering or whitespace
 * difference from `JSON.parse` → `JSON.stringify` changes the digest and would
 * reject every authentic request.
 */
export function verifyWhatsAppSignature(
  appSecret: string,
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
): boolean {
  if (!appSecret || !signatureHeader) return false;
  if (!signatureHeader.startsWith("sha256=")) return false;

  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  const mine = Buffer.from(expected, "utf8");
  const theirs = Buffer.from(signatureHeader, "utf8");
  if (mine.length !== theirs.length) return false;
  return timingSafeEqual(mine, theirs);
}

/**
 * The pairing link a user opens on their phone.
 *
 * `wa.me/<business>?text=<token>` prefills a message the user sends from their
 * own handset. That inbound message is what proves they control the number —
 * so no surface, anywhere, accepts a phone number a human typed in. Phone
 * numbers are guessable and a mis-paired binding leaks both the content of
 * approvals and the authority to decide them.
 */
export function whatsappPairingLink(businessNumber: string, token: string): string {
  return `https://wa.me/${businessNumber.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(token)}`;
}

export function whatsappConnectorService(db: Db, deps: StewardAgentReplierDeps = {}) {
  const channels = humanChannelService(db);
  const replier = stewardAgentReplier(db, deps);
  const approvalsSvc = approvalService(db);
  const authority = approvalAuthorityService(db);

  function accessToken() {
    return process.env.WHATSAPP_ACCESS_TOKEN ?? null;
  }

  function phoneNumberId() {
    return process.env.WHATSAPP_PHONE_NUMBER_ID ?? null;
  }

  function appSecret() {
    return process.env.WHATSAPP_APP_SECRET ?? "";
  }

  function verifySignature(rawBody: Buffer | string, header: string | undefined) {
    return verifyWhatsAppSignature(appSecret(), rawBody, header);
  }

  /** GET handshake. Meta calls this once when the webhook URL is registered. */
  function verifySubscription(query: Record<string, unknown>): string | null {
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!expected) return null;
    if (query["hub.mode"] !== "subscribe") return null;
    const supplied = query["hub.verify_token"];
    if (typeof supplied !== "string") return null;
    const mine = Buffer.from(expected, "utf8");
    const theirs = Buffer.from(supplied, "utf8");
    if (mine.length !== theirs.length || !timingSafeEqual(mine, theirs)) return null;
    const challenge = query["hub.challenge"];
    return typeof challenge === "string" ? challenge : null;
  }

  async function callGraph(path: string, body: Record<string, unknown>) {
    const token = accessToken();
    const phoneId = phoneNumberId();
    if (!token || !phoneId) {
      logger.warn({ path }, "whatsapp credentials missing; skipping outbound call");
      return null;
    }
    try {
      return await fetch(`${GRAPH_API}/${phoneId}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch (error) {
      logger.warn({ err: error, path }, "whatsapp api call failed");
      return null;
    }
  }

  function digest(payload: unknown) {
    return `sha256:${createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex")}`;
  }

  /** Is this binding still inside the 24-hour free-form messaging window? */
  function isWithinMessagingWindow(lastInboundAt: Date | null | undefined): boolean {
    if (!lastInboundAt) return false;
    return Date.now() - new Date(lastInboundAt).getTime() < MESSAGING_WINDOW_MS;
  }

  async function sendText(to: string, text: string) {
    await callGraph("messages", {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    });
  }

  /**
   * Mint an opaque handle for one decision. Identical shape to Telegram's:
   * the button is never the authority, only a lookup key.
   */
  async function issueCallbackToken(input: {
    companyId: string;
    approvalId: string;
    revision: number;
    decision: "approved" | "rejected";
    bindingId?: string | null;
  }): Promise<string> {
    const token = randomBytes(18).toString("base64url");
    await db.insert(channelCallbackTokens).values({
      token,
      companyId: input.companyId,
      approvalId: input.approvalId,
      bindingId: input.bindingId ?? null,
      approvalRevision: input.revision,
      decision: input.decision,
      provider: PROVIDER,
      expiresAt: new Date(Date.now() + CALLBACK_TOKEN_TTL_MS),
    });
    return token;
  }

  /**
   * Deliver an approval card.
   *
   * In-window we can send interactive reply buttons. Out of window we cannot
   * send free-form content at all, so we do NOT quietly downgrade to a text
   * message that Meta would reject — we report that nothing was delivered, and
   * the caller records it. Silently failing here would be indistinguishable
   * from a steward ignoring an approval.
   */
  async function sendApprovalCard(input: {
    companyId: string;
    approvalId: string;
    revision: number;
    binding: typeof humanChannelBindings.$inferSelect;
    text: string;
  }): Promise<{ delivered: boolean; reason?: string }> {
    if (!isWithinMessagingWindow(input.binding.lastInboundAt)) {
      // Out-of-window delivery needs a Meta-reviewed utility template, which is
      // an operator provisioning step this build does not assume. Skip loudly.
      return { delivered: false, reason: "outside_24h_window" };
    }

    const [approve, reject] = await Promise.all([
      issueCallbackToken({ ...input, decision: "approved", bindingId: input.binding.id }),
      issueCallbackToken({ ...input, decision: "rejected", bindingId: input.binding.id }),
    ]);

    await callGraph("messages", {
      messaging_product: "whatsapp",
      to: input.binding.externalUserId,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: input.text },
        action: {
          buttons: [
            // WhatsApp caps reply-button ids at 256 bytes; a 24-char base64url
            // handle is far inside that, and carries nothing but the handle.
            { type: "reply", reply: { id: approve, title: "Approve" } },
            { type: "reply", reply: { id: reject, title: "Reject" } },
          ],
        },
      },
    });
    return { delivered: true };
  }

  async function consumeCallbackToken(token: string) {
    const now = new Date();
    return db
      .update(channelCallbackTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(channelCallbackTokens.token, token),
          isNull(channelCallbackTokens.consumedAt),
          gt(channelCallbackTokens.expiresAt, now),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function noteInbound(bindingId: string) {
    await db
      .update(humanChannelBindings)
      .set({ lastInboundAt: new Date(), updatedAt: new Date() })
      .where(eq(humanChannelBindings.id, bindingId));
  }

  /**
   * Complete a pairing from a token the user sent from their own handset.
   *
   * The sender's number comes from the verified webhook payload, never from
   * anything a human typed, so redeeming the token IS the proof of control.
   */
  async function completePairing(input: {
    token: string;
    fromNumber: string;
  }): Promise<{ paired: boolean }> {
    const challenge = await channels.consumePairingChallenge(PROVIDER, input.token);
    if (!challenge) {
      await sendText(
        input.fromNumber,
        "That link is no longer valid. Generate a new one from AgentDash.",
      );
      return { paired: false };
    }

    try {
      const binding = await channels.verifyBinding(challenge.companyId, {
        provider: PROVIDER,
        userId: challenge.userId,
        externalUserId: input.fromNumber,
        externalConversationId: input.fromNumber,
      });
      // The pairing message is itself an inbound message, so it opens the
      // 24-hour window — without this the first approval card after pairing
      // would be refused as out-of-window.
      await noteInbound(binding.id);
      await logActivity(db, {
        companyId: binding.companyId,
        actorType: "user",
        actorId: binding.userId,
        action: "human_channel.binding_verified",
        entityType: "human_channel_binding",
        entityId: binding.id,
        agentId: binding.agentId,
        details: { provider: PROVIDER, via: "pairing_challenge" },
      });
      await sendText(
        input.fromNumber,
        "Connected. I'll bring you approvals here, and you can ask me anything.",
      );
      return { paired: true };
    } catch (error) {
      logger.info({ err: error, provider: PROVIDER }, "whatsapp pairing refused");
      await sendText(
        input.fromNumber,
        "I couldn't connect this account. Check with your workspace administrator.",
      );
      return { paired: false };
    }
  }

  /** Decide an approval from an interactive button reply. */
  async function handleButtonReply(input: {
    tokenValue: string;
    fromNumber: string;
  }): Promise<void> {
    const binding = await channels.resolveActiveBinding(PROVIDER, input.fromNumber);
    if (!binding) return;

    const record = await consumeCallbackToken(input.tokenValue);
    if (!record || record.companyId !== binding.companyId) {
      await sendText(input.fromNumber, "That request has expired.");
      return;
    }

    const approval = await approvalsSvc.getById(record.approvalId);
    if (!approval || approval.companyId !== binding.companyId) {
      await sendText(input.fromNumber, "That request no longer exists.");
      return;
    }

    try {
      // The SAME decision boundary the web and Telegram use.
      const context = await authority.requireDecisionAuthority(
        approval,
        { userId: binding.userId, source: "session", isInstanceAdmin: false, type: "board" } as never,
        {
          revision: record.approvalRevision,
          idempotencyKey: `whatsapp-${record.token}`,
          channel: PROVIDER,
        },
      );
      const meta = {
        revision: context.revision,
        channel: context.channel,
        idempotencyKey: context.idempotencyKey,
        actorRole: context.role,
      };
      const result =
        record.decision === "approved"
          ? await approvalsSvc.approve(record.approvalId, binding.userId, null, meta)
          : await approvalsSvc.reject(record.approvalId, binding.userId, null, meta);

      if (result.applied) {
        await logActivity(db, {
          companyId: binding.companyId,
          actorType: "user",
          actorId: binding.userId,
          action: record.decision === "approved" ? "approval.approved" : "approval.rejected",
          entityType: "approval",
          entityId: record.approvalId,
          agentId: approval.requestedByAgentId,
          details: { channel: PROVIDER, revision: record.approvalRevision },
        });
      }
      await sendText(
        input.fromNumber,
        record.decision === "approved" ? "Approved." : "Rejected.",
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      logger.info({ err: error, approvalId: record.approvalId }, "whatsapp decision refused");
      await sendText(
        input.fromNumber,
        status === 409 ? "This request changed; open AgentDash to review." : "Not permitted.",
      );
    }
  }

  /** Answer a paired human's free-form message as their agent. */
  async function handleTextMessage(input: { text: string; fromNumber: string }): Promise<void> {
    const binding = await channels.resolveActiveBinding(PROVIDER, input.fromNumber);
    if (!binding) {
      // Unpaired numbers are dropped silently; answering would confirm which
      // numbers are registered to someone probing them.
      return;
    }
    await noteInbound(binding.id);
    await logActivity(db, {
      companyId: binding.companyId,
      actorType: "user",
      actorId: binding.userId,
      action: "human_channel.message_received",
      entityType: "human_channel_binding",
      entityId: binding.id,
      agentId: binding.agentId,
      details: { provider: PROVIDER },
    });

    const answer = await replier.reply(binding, input.text);
    if (answer) await sendText(input.fromNumber, answer);
  }

  return {
    verifySignature,
    verifySubscription,
    digest,
    isWithinMessagingWindow,
    sendText,
    sendApprovalCard,
    issueCallbackToken,
    consumeCallbackToken,
    completePairing,
    handleButtonReply,
    handleTextMessage,
  };
}
