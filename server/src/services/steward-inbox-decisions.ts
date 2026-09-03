import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, channelCallbackTokens } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { approvalAuthorityService } from "./approval-authority.js";
import { approvalDecisionEffectsService } from "./approval-decision-effects.js";
import { approvalService } from "./index.js";
import {
  STEWARD_INBOX_TOKEN_PROVIDER,
  stewardInboxService,
} from "./steward-inbox.js";

/**
 * AgentDash-MK: resolving an approval from a steward inbox — stage 3.
 *
 * Its own module rather than part of `steward-inbox.ts`, because the effects
 * service already imports that one to record `approval.resolved`. Putting the
 * decision beside the log would make the cycle.
 *
 * The rule this exists to satisfy: **the endpoint credential decides nothing.**
 * `bridge_endpoint` reaches an explicit allowlist of routes and is minted as
 * `type: "none"` so every ordinary authorization helper refuses it. What
 * authorizes a decision here is a handle that was minted for one endpoint, one
 * approval, one revision and one decision, and is spent exactly once — the
 * same shape a Teams card token already has. Authority is then re-resolved
 * against the endpoint's OWNER, so the token proves delivery and the person
 * proves permission.
 */
export function stewardInboxDecisionService(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    autoDispatchQueuedRuns?: boolean;
  } = {},
) {
  const inbox = stewardInboxService(db);
  const authority = approvalAuthorityService(db);
  const approvalsSvc = approvalService(db);
  const effects = approvalDecisionEffectsService(db, options);

  /**
   * Spend a token, or refuse.
   *
   * A conditional UPDATE, so two concurrent redemptions of one handle cannot
   * both succeed — the same technique the bridge uses to stop two pollers
   * claiming one task. Expiry and prior consumption are part of the condition
   * rather than a read-then-check, which would race.
   */
  async function consumeToken(token: string, endpointId: string) {
    const now = new Date();
    return db
      .update(channelCallbackTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(channelCallbackTokens.token, token),
          eq(channelCallbackTokens.provider, STEWARD_INBOX_TOKEN_PROVIDER),
          // Bound to the machine it was delivered to. A handle that reaches
          // another of this person's endpoints is inert there.
          eq(channelCallbackTokens.bridgeEndpointId, endpointId),
          isNull(channelCallbackTokens.consumedAt),
          gt(channelCallbackTokens.expiresAt, now),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Decide one approval from one machine.
   *
   * Returns a refusal rather than throwing for the ordinary cases a steward can
   * actually hit — a spent handle, a superseded revision, an approval that
   * someone else already decided. Those are outcomes to render, not faults.
   */
  async function decide(
    endpointId: string,
    token: string,
  ): Promise<{
    ok: boolean;
    decision?: "approved" | "rejected";
    approvalId?: string;
    reason?: string;
  }> {
    const endpoint = await inbox.requireInboxEndpoint(endpointId);
    const record = await consumeToken(token, endpointId);
    if (!record || record.companyId !== endpoint.companyId) {
      return { ok: false, reason: "This action is no longer valid. Sync again." };
    }

    const approval = await approvalsSvc.getById(record.approvalId);
    if (!approval || approval.companyId !== endpoint.companyId) {
      return { ok: false, reason: "That request no longer exists." };
    }

    const decision = record.decision === "approved" ? "approved" : "rejected";

    try {
      const context = await authority.requireDecisionAuthority(
        approval,
        {
          userId: endpoint.userId,
          source: "session",
          isInstanceAdmin: false,
          type: "board",
        } as never,
        {
          // Echoing the revision the handle was minted against is what makes a
          // resubmit safe: the service refuses a decision aimed at a revision
          // that is no longer current.
          revision: record.approvalRevision,
          idempotencyKey: `bridge-inbox-${record.token}`,
          channel: STEWARD_INBOX_TOKEN_PROVIDER,
        } as never,
      );
      const meta = {
        revision: context.revision,
        channel: context.channel,
        idempotencyKey: context.idempotencyKey,
        actorRole: context.role,
      };

      const result =
        decision === "approved"
          ? await approvalsSvc.approve(record.approvalId, endpoint.userId, null, meta)
          : await approvalsSvc.reject(record.approvalId, endpoint.userId, null, meta);

      // The reason stage 3 waited for the effects extraction. Deciding without
      // this leaves a gated bridge task `awaiting_approval` for ever, a held
      // fact answer unreleased, and a two-seat sign-off stuck — which is
      // precisely what deciding from Teams still did.
      if (decision === "approved") {
        await effects.afterApprove(result.approval, result.applied, {
          actorUserId: endpoint.userId,
          decisionNote: null,
        });
      } else {
        await effects.afterReject(result.approval, result.applied, {
          actorUserId: endpoint.userId,
          decisionNote: null,
        });
      }

      return { ok: true, decision, approvalId: record.approvalId };
    } catch (error) {
      const status = (error as { status?: number }).status;
      logger.info(
        { err: error, approvalId: record.approvalId, endpointId },
        "steward inbox decision refused",
      );
      return {
        ok: false,
        approvalId: record.approvalId,
        reason:
          status === 409
            ? "This request changed since you saw it. Sync again and re-read it."
            : "You are not permitted to decide this.",
      };
    }
  }

  return { decide };
}
