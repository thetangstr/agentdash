import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, channelCallbackTokens, channelPairingChallenges } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { approvalAuthorityService } from "./approval-authority.js";
import { approvalService } from "./approvals.js";
import { humanChannelService } from "./human-channels.js";
import { stewardAgentReplier, type StewardAgentReplierDeps } from "./steward-agent-replier.js";
import { logActivity } from "./activity-log.js";

const TELEGRAM_API = "https://api.telegram.org";
const CALLBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER = "telegram";

export interface IssueCallbackTokenInput {
  companyId: string;
  approvalId: string;
  revision: number;
  decision: "approved" | "rejected";
  bindingId?: string | null;
}

export function telegramConnectorService(db: Db, deps: StewardAgentReplierDeps = {}) {
  const channels = humanChannelService(db);
  const replier = stewardAgentReplier(db, deps);
  const approvalsSvc = approvalService(db);
  const authority = approvalAuthorityService(db);

  function botToken() {
    return process.env.TELEGRAM_BOT_TOKEN ?? null;
  }

  /** Constant-time-ish comparison of the configured webhook secret. */
  function verifyWebhookSecret(headerValue: string | undefined): boolean {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected) return false;
    if (!headerValue) return false;
    if (headerValue.length !== expected.length) return false;
    let mismatch = 0;
    for (let i = 0; i < expected.length; i += 1) {
      mismatch |= expected.charCodeAt(i) ^ headerValue.charCodeAt(i);
    }
    return mismatch === 0;
  }

  async function callTelegram(method: string, body: Record<string, unknown>) {
    const token = botToken();
    if (!token) {
      logger.warn({ method }, "telegram bot token missing; skipping outbound call");
      return null;
    }
    try {
      const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return response;
    } catch (error) {
      logger.warn({ err: error, method }, "telegram api call failed");
      return null;
    }
  }

  /**
   * Register the webhook. Subscribes to `message` and `callback_query` only —
   * a narrower surface than the default, so unexpected update types never reach
   * dispatch at all.
   */
  async function setWebhook(url: string) {
    return callTelegram("setWebhook", {
      url,
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    });
  }

  /** Mint an opaque handle; all authority stays server-side against it. */
  async function issueCallbackToken(input: IssueCallbackTokenInput): Promise<string> {
    // 18 random bytes -> 24 base64url chars, comfortably inside Telegram's
    // 64-byte callback_data cap with room for nothing else, which is the point.
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

  async function buildApprovalKeyboard(input: {
    companyId: string;
    approvalId: string;
    revision: number;
    bindingId?: string | null;
  }) {
    const [approve, reject] = await Promise.all([
      issueCallbackToken({ ...input, decision: "approved" }),
      issueCallbackToken({ ...input, decision: "rejected" }),
    ]);
    return {
      inline_keyboard: [
        [
          { text: "Approve", callback_data: approve },
          { text: "Reject", callback_data: reject },
        ],
      ],
    };
  }

  /** Resolve an unconsumed, unexpired token. */
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

  async function answerCallbackQuery(callbackQueryId: string, text?: string) {
    // Always answered: an unanswered callback leaves Telegram's client spinning.
    await callTelegram("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  /** Outbound text to one chat. Best-effort: a delivery failure never throws. */
  async function sendMessage(chatId: string | number, text: string) {
    await callTelegram("sendMessage", { chat_id: chatId, text });
  }

  /** Outbound approval card: the same message plus the decision keyboard. */
  async function sendApprovalCard(
    chatId: string | number,
    text: string,
    replyMarkup: Awaited<ReturnType<typeof buildApprovalKeyboard>>,
  ) {
    await callTelegram("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
  }

  function digest(payload: unknown) {
    return `sha256:${createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex")}`;
  }

  /**
   * Handle one inbound update.
   *
   * Everything fails closed and still returns 200: Telegram retries any
   * non-2xx, so surfacing an authorization refusal as an error would turn a
   * denied action into an infinite redelivery loop.
   */
  async function handleUpdate(update: Record<string, unknown>): Promise<void> {
    const callbackQuery = update.callback_query as Record<string, unknown> | undefined;
    const message = update.message as Record<string, unknown> | undefined;

    if (callbackQuery) {
      const callbackId = String(callbackQuery.id ?? "");
      const from = callbackQuery.from as { id?: number | string } | undefined;
      const externalUserId = from?.id != null ? String(from.id) : null;
      const tokenValue = typeof callbackQuery.data === "string" ? callbackQuery.data : null;

      if (!externalUserId || !tokenValue) {
        await answerCallbackQuery(callbackId, "This action is no longer available.");
        return;
      }

      const binding = await channels.resolveActiveBinding(PROVIDER, externalUserId);
      if (!binding) {
        // Revoked or never paired: never route to an agent.
        await answerCallbackQuery(callbackId, "This channel is no longer connected.");
        return;
      }

      const record = await consumeCallbackToken(tokenValue);
      if (!record || record.companyId !== binding.companyId) {
        await answerCallbackQuery(callbackId, "This action has expired.");
        return;
      }

      const approval = await approvalsSvc.getById(record.approvalId);
      if (!approval || approval.companyId !== binding.companyId) {
        await answerCallbackQuery(callbackId, "That request no longer exists.");
        return;
      }

      try {
        // The SAME decision boundary the web uses. Provider routes never touch
        // approval rows directly.
        const context = await authority.requireDecisionAuthority(
          approval,
          { userId: binding.userId, source: "session", isInstanceAdmin: false, type: "board" } as never,
          {
            revision: record.approvalRevision,
            idempotencyKey: `telegram-${record.token}`,
            channel: "telegram",
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
        await answerCallbackQuery(
          callbackId,
          record.decision === "approved" ? "Approved." : "Rejected.",
        );
      } catch (error) {
        const status = (error as { status?: number }).status;
        // A stale revision or a lost stewardship is a legitimate refusal, not a
        // server fault — tell the human and stop.
        logger.info({ err: error, approvalId: record.approvalId }, "telegram decision refused");
        await answerCallbackQuery(
          callbackId,
          status === 409 ? "This request changed; open AgentDash to review." : "Not permitted.",
        );
      }
      return;
    }

    if (message) {
      const from = message.from as { id?: number | string; is_bot?: boolean } | undefined;
      const chat = message.chat as { id?: number | string; type?: string } | undefined;
      const externalUserId = from?.id != null ? String(from.id) : null;
      if (!externalUserId) return;

      // Two bots in one chat will answer each other until a rate limit stops
      // them. Checked before anything else on the message path.
      if (from?.is_bot === true) return;

      // A binding authenticates ONE human, not a room. Answering in a group
      // would disclose that human's agent's replies to everyone present.
      const isPrivateChat = (chat?.type ?? "private") === "private";

      const binding = await channels.resolveActiveBinding(PROVIDER, externalUserId);
      if (!binding) {
        // Unpaired identities are dropped silently rather than answered, so the
        // bot cannot be used to probe which accounts exist.
        return;
      }

      if (!isPrivateChat) return;

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

      const text = typeof message.text === "string" ? message.text : "";
      // `/start` with no token from an already-paired user is a greeting, not a
      // question; answering it with the LLM would bill a token for "hi".
      if (text.trim().startsWith("/start")) {
        await sendMessage(chat?.id ?? externalUserId, "You are connected. Ask me anything.");
        return;
      }

      const answer = await replier.reply(binding, text);
      if (answer) {
        await sendMessage(chat?.id ?? externalUserId, answer);
      }
    }
  }

  /**
   * Complete a pairing from a `/start <token>` deep link.
   *
   * The caller has already claimed the update for deduplication, so this may be
   * called at most once per inbound update.
   */
  async function completePairing(input: {
    token: string;
    externalUserId: string;
    chatId: string | number | null;
    chatType: string;
    isBot: boolean;
  }): Promise<{ paired: boolean }> {
    if (input.isBot) return { paired: false };

    // Pairing in a group would bind one human's agent to a room everyone can
    // act in. Refused explicitly, and the refusal is not silent, because the
    // person who opened the link deserves to know why nothing happened.
    if (input.chatType !== "private") {
      await sendMessage(
        input.chatId ?? input.externalUserId,
        "Open this link in a direct chat with me, not in a group.",
      );
      return { paired: false };
    }

    const challenge = await channels.consumePairingChallenge(PROVIDER, input.token);
    if (!challenge) {
      // Unknown, expired, or already spent. All three get the same answer: a
      // distinct message per case would confirm which tokens exist.
      await sendMessage(
        input.chatId ?? input.externalUserId,
        "That link is no longer valid. Generate a new one from AgentDash.",
      );
      return { paired: false };
    }

    try {
      const binding = await channels.verifyBinding(challenge.companyId, {
        provider: PROVIDER,
        userId: challenge.userId,
        externalUserId: input.externalUserId,
        externalConversationId: input.chatId != null ? String(input.chatId) : null,
      });
      await db
        .update(channelPairingChallenges)
        .set({ bindingId: binding.id })
        .where(eq(channelPairingChallenges.id, challenge.id));

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

      await sendMessage(
        input.chatId ?? input.externalUserId,
        "Connected. I'll bring you approvals here, and you can ask me anything.",
      );
      return { paired: true };
    } catch (error) {
      // A conflicting active binding, a revoked stewardship, or a provider the
      // ceiling stopped allowing between minting and redemption. The challenge
      // is already spent, which is correct: a failed redemption must not leave
      // a live token behind.
      logger.info({ err: error, provider: PROVIDER }, "telegram pairing refused");
      await sendMessage(
        input.chatId ?? input.externalUserId,
        "I couldn't connect this account. Check with your workspace administrator.",
      );
      return { paired: false };
    }
  }

  return {
    verifyWebhookSecret,
    setWebhook,
    completePairing,
    sendMessage,
    sendApprovalCard,
    issueCallbackToken,
    buildApprovalKeyboard,
    consumeCallbackToken,
    answerCallbackQuery,
    handleUpdate,
    digest,
  };
}
