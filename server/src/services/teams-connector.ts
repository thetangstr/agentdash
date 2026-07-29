import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { channelCallbackTokens, humanChannelBindings } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { approvalAuthorityService } from "./approval-authority.js";
import { approvalService } from "./approvals.js";
import { humanChannelService } from "./human-channels.js";
import { logActivity } from "./activity-log.js";

const PROVIDER = "teams";
const CALLBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

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
    digest,
  };
}
