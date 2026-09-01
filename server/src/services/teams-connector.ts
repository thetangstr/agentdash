import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  channelCallbackTokens,
  channelPairingChallenges,
  humanChannelBindings,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { approvalAuthorityService } from "./approval-authority.js";
import { approvalService } from "./approvals.js";
import { humanChannelService } from "./human-channels.js";
import { logActivity } from "./activity-log.js";

const PROVIDER = "teams";
const CALLBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Default Entra authority for a Bot Framework client credential.
 *
 * Overridable via `TEAMS_BOT_TOKEN_URL` because this is genuinely per-
 * deployment: a multi-tenant bot uses the `botframework.com` authority, a
 * single-tenant one uses `login.microsoftonline.com/{tenantId}/…`, and which of
 * those applies is decided by the app registration, not by us. See the note in
 * `routes/teams-connector.ts` about why single-tenant is the only path still
 * open.
 */
const DEFAULT_BOT_TOKEN_URL = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const BOT_SCOPE = "https://api.botframework.com/.default";

/**
 * The prefix a pairing message carries.
 *
 * Teams has no `/start` deep-link convention, so the install link prefills
 * `pair <token>` and this is what the bot looks for. A bare token would be
 * indistinguishable from someone pasting a code into a chat, and treating every
 * opaque-looking message as a redemption attempt would turn the bot into an
 * oracle for which tokens exist.
 */
const PAIRING_PREFIX = "pair";

/** Extract a pairing token from an inbound message, or null if it is not one. */
export function parseTeamsPairingToken(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const match = new RegExp(`^${PAIRING_PREFIX}\\s+(\\S+)\\s*$`, "i").exec(text.trim());
  return match ? match[1]! : null;
}

/**
 * The link a human follows to pair.
 *
 * `message` is prefilled, so the token travels inside the one artifact the user
 * is meant to handle. The raw token is never returned beside it — the same rule
 * Telegram and WhatsApp pairing already follow, and for the same reason: a token
 * echoed separately ends up in a log line or a copy-paste the link never reaches.
 */
export function teamsPairingLink(botAppId: string, token: string): string {
  return (
    `https://teams.microsoft.com/l/chat/0/0?users=28:${encodeURIComponent(botAppId)}` +
    `&message=${encodeURIComponent(`${PAIRING_PREFIX} ${token}`)}`
  );
}

/** Adaptive Card action — `Action.Execute` only; `Action.Submit` is legacy. */
export interface AdaptiveCardExecuteAction {
  type: "Action.Execute";
  title: string;
  verb: string;
  data: Record<string, unknown>;
}

export interface AdaptiveCard {
  type: "AdaptiveCard";
  version: string;
  body: Array<Record<string, unknown>>;
  actions: AdaptiveCardExecuteAction[];
}

/** Identity the SDK validated out of the inbound bearer token. */
export interface TeamsVerifiedActor {
  tenantId: string | null;
  aadObjectId: string | null;
}

export function teamsConnectorService(db: Db) {
  const channels = humanChannelService(db);
  const approvalsSvc = approvalService(db);
  const authority = approvalAuthorityService(db);

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
   * Approval card.
   *
   * `Action.Execute` rather than `Action.Submit`: Submit is the legacy path and
   * cannot carry a server-refreshed card response. The action data holds only
   * an opaque handle, so the card is not itself the authority.
   */
  async function buildApprovalCard(input: {
    companyId: string;
    approvalId: string;
    revision: number;
    bindingId?: string | null;
    summary: string;
  }): Promise<AdaptiveCard> {
    const [approveToken, rejectToken] = await Promise.all([
      issueCallbackToken({ ...input, decision: "approved" }),
      issueCallbackToken({ ...input, decision: "rejected" }),
    ]);
    return {
      type: "AdaptiveCard",
      version: "1.5",
      body: [
        { type: "TextBlock", text: "Approval requested", weight: "Bolder", wrap: true },
        { type: "TextBlock", text: input.summary, wrap: true },
      ],
      actions: [
        {
          type: "Action.Execute",
          title: "Approve",
          verb: "agentdash.approval.decide",
          data: { token: approveToken },
        },
        {
          type: "Action.Execute",
          title: "Reject",
          verb: "agentdash.approval.decide",
          data: { token: rejectToken },
        },
      ],
    };
  }

  async function consumeCallbackToken(token: string) {
    const now = new Date();
    return db
      .update(channelCallbackTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(channelCallbackTokens.token, token),
          eq(channelCallbackTokens.provider, PROVIDER),
          isNull(channelCallbackTokens.consumedAt),
          gt(channelCallbackTokens.expiresAt, now),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  /** Conversation coordinates for a proactive (agent-initiated) message. */
  async function resolveConversationReference(companyId: string, userId: string) {
    const binding = await db
      .select()
      .from(humanChannelBindings)
      .where(
        and(
          eq(humanChannelBindings.companyId, companyId),
          eq(humanChannelBindings.userId, userId),
          eq(humanChannelBindings.provider, PROVIDER),
          isNull(humanChannelBindings.revokedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!binding) return null;
    const metadata = (binding.metadata ?? {}) as Record<string, unknown>;
    return {
      conversationId: binding.externalConversationId,
      serviceUrl: typeof metadata.serviceUrl === "string" ? metadata.serviceUrl : null,
      tenantId: binding.externalTenantId,
      agentId: binding.agentId,
    };
  }

  function digest(payload: unknown) {
    return `sha256:${createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex")}`;
  }

  // ---------------------------------------------------------------------------
  // Outbound: proactive messages
  //
  // A "proactive" message is one the bot initiates rather than one it sends in
  // reply, and it is the only shape that can carry an approval to a steward who
  // is not currently typing. It needs conversation coordinates the bot cannot
  // invent — hence `resolveConversationReference`, which reads them off the
  // binding the account itself established during pairing.
  // ---------------------------------------------------------------------------

  async function botAccessToken(): Promise<string | null> {
    const appId = process.env.TEAMS_BOT_APP_ID?.trim();
    const password = process.env.TEAMS_BOT_APP_PASSWORD?.trim();
    if (!appId || !password) {
      logger.warn("teams bot credentials missing; skipping outbound activity");
      return null;
    }
    const url = process.env.TEAMS_BOT_TOKEN_URL?.trim() || DEFAULT_BOT_TOKEN_URL;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: appId,
          client_secret: password,
          scope: BOT_SCOPE,
        }).toString(),
      });
      const body = (await response.json()) as { access_token?: unknown };
      return typeof body.access_token === "string" ? body.access_token : null;
    } catch (error) {
      logger.warn({ err: error }, "teams bot token request failed");
      return null;
    }
  }

  /**
   * POST one activity into an existing conversation.
   *
   * Never throws. Delivery is a side effect of creating an approval, and an
   * unreachable Teams must not take the governed-action flow down with it.
   */
  async function sendActivity(
    reference: { conversationId: string | null; serviceUrl: string | null },
    activity: Record<string, unknown>,
  ): Promise<{ delivered: boolean; reason?: string }> {
    if (!reference.serviceUrl || !reference.conversationId) {
      // A binding without coordinates cannot be messaged proactively. Reported
      // rather than treated as delivered: an undelivered card must stay
      // distinguishable from a steward who has not answered yet.
      return { delivered: false, reason: "no_conversation_reference" };
    }
    const token = await botAccessToken();
    if (!token) return { delivered: false, reason: "not_configured" };

    const base = reference.serviceUrl.endsWith("/")
      ? reference.serviceUrl
      : `${reference.serviceUrl}/`;
    const url = `${base}v3/conversations/${encodeURIComponent(reference.conversationId)}/activities`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(activity),
      });
      if (!response.ok) {
        logger.warn({ status: response.status }, "teams activity rejected");
        return { delivered: false, reason: `http_${response.status}` };
      }
      return { delivered: true };
    } catch (error) {
      logger.warn({ err: error }, "teams activity send failed");
      return { delivered: false, reason: "send_failed" };
    }
  }

  /**
   * Deliver a plain notice — a stalled escalation, a lapsed lease.
   *
   * No actions, deliberately. A notice carries no authority, so it carries no
   * handle either; anything decidable goes through an approval card and the
   * approvals service behind it. A button on a notice would be a second
   * decision path, and there is exactly one.
   */
  async function sendNotice(
    companyId: string,
    userId: string,
    text: string,
  ): Promise<{ delivered: boolean; reason?: string }> {
    const reference = await resolveConversationReference(companyId, userId);
    if (!reference) return { delivered: false, reason: "no_active_binding" };
    return sendActivity(reference, { type: "message", text });
  }

  /**
   * Complete a pairing from a token the account sent itself.
   *
   * Identity comes entirely from the validated activity — the AAD object id and
   * the tenant — never from anything a human typed. Redeeming the token from
   * that account IS the proof of control, which is why `teams` stays out of the
   * self-assertable set in `routes/human-channels.ts`.
   */
  async function completePairing(input: {
    token: string;
    aadObjectId: string;
    tenantId: string | null;
    conversationId: string | null;
    serviceUrl: string | null;
  }): Promise<{ paired: boolean }> {
    const challenge = await channels.consumePairingChallenge(PROVIDER, input.token);
    if (!challenge) {
      // Unknown, expired, or already spent. One answer for all three: a distinct
      // message per case would confirm which tokens exist.
      await sendActivity(
        { conversationId: input.conversationId, serviceUrl: input.serviceUrl },
        {
          type: "message",
          text: "That link is no longer valid. Generate a new one from AgentDash.",
        },
      );
      return { paired: false };
    }

    try {
      const binding = await channels.verifyBinding(challenge.companyId, {
        provider: PROVIDER,
        userId: challenge.userId,
        externalTenantId: input.tenantId,
        externalUserId: input.aadObjectId,
        externalConversationId: input.conversationId,
        // The proactive send needs a service url and there is no other honest
        // source for one; it is recorded from the verified activity, not from a
        // configuration file that could point at a different tenant's endpoint.
        metadata: input.serviceUrl ? { serviceUrl: input.serviceUrl } : null,
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

      await sendActivity(
        { conversationId: input.conversationId, serviceUrl: input.serviceUrl },
        { type: "message", text: "Connected. I'll bring you approvals here." },
      );
      return { paired: true };
    } catch (error) {
      // A conflicting active binding, a lost stewardship, or a provider the
      // ceiling stopped allowing between minting and redemption. The challenge
      // is already spent, which is correct: a failed redemption must not leave a
      // live token behind.
      logger.info({ err: error, provider: PROVIDER }, "teams pairing refused");
      await sendActivity(
        { conversationId: input.conversationId, serviceUrl: input.serviceUrl },
        {
          type: "message",
          text: "I couldn't connect this account. Check with your workspace administrator.",
        },
      );
      return { paired: false };
    }
  }

  /**
   * Decide an approval from a card action.
   *
   * Every scrap of authority is re-resolved here: tenant, acting identity,
   * active binding, current stewardship, approval revision, and terminal state.
   * A mismatch on any of them fails closed.
   */
  async function decideFromCardAction(input: {
    actor: TeamsVerifiedActor;
    token: string;
  }): Promise<{ ok: boolean; message: string }> {
    const { actor, token } = input;
    if (!actor.aadObjectId) return { ok: false, message: "Unrecognized sender." };

    const binding = await channels.resolveActiveBinding(PROVIDER, actor.aadObjectId);
    if (!binding) return { ok: false, message: "This channel is no longer connected." };

    // Tenant is part of identity, not decoration: the same AAD object id in a
    // different tenant is a different principal.
    if (binding.externalTenantId && binding.externalTenantId !== actor.tenantId) {
      logger.warn({ bindingId: binding.id }, "teams tenant mismatch; refusing decision");
      return { ok: false, message: "This account is not connected here." };
    }

    const record = await consumeCallbackToken(token);
    if (!record || record.companyId !== binding.companyId) {
      return { ok: false, message: "This action has expired." };
    }

    const approval = await approvalsSvc.getById(record.approvalId);
    if (!approval || approval.companyId !== binding.companyId) {
      return { ok: false, message: "That request no longer exists." };
    }

    try {
      const context = await authority.requireDecisionAuthority(
        approval,
        { userId: binding.userId, source: "session", isInstanceAdmin: false, type: "board" } as never,
        {
          revision: record.approvalRevision,
          idempotencyKey: `teams-${record.token}`,
          channel: "teams",
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
      return {
        ok: true,
        message: record.decision === "approved" ? "Approved." : "Rejected.",
      };
    } catch (error) {
      const status = (error as { status?: number }).status;
      logger.info({ err: error, approvalId: record.approvalId }, "teams decision refused");
      return {
        ok: false,
        message:
          status === 409 ? "This request changed; open AgentDash to review." : "Not permitted.",
      };
    }
  }

  return {
    issueCallbackToken,
    buildApprovalCard,
    consumeCallbackToken,
    resolveConversationReference,
    decideFromCardAction,
    sendActivity,
    sendNotice,
    completePairing,
    digest,
  };
}
