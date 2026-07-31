import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, companies, connections, connectorSendExecutions } from "@paperclipai/db";
import { isUniqueViolation } from "../lib/pg-error.js";
import { logger } from "../middleware/logger.js";
import { agentStewardshipService } from "./agent-stewardships.js";
import { connectorService } from "./connectors.js";
import { hubspotConnectorService } from "./hubspot-connector.js";
import { logActivity } from "./activity-log.js";

/**
 * AgentDash-MK: execute a `connector_send` after its steward approved it.
 *
 * Everything here exists because of the gap between deciding and doing.
 * Authority checked at request time is stale by the time a human presses
 * approve — a ceiling may have narrowed, a connection may have been revoked, a
 * stewardship may have moved. So every check is re-run HERE, against current
 * state, and the request-time check is only there to fail fast for the agent.
 *
 * Ordering is the other half. The execution row is claimed BEFORE the provider
 * call, carrying `outcome_unknown`. A crash between claim and update therefore
 * leaves exactly the truth: we asked, and we do not know what happened. The
 * unique index on `approval_id` means a second attempt cannot claim, so an
 * ambiguous outcome can never be "resolved" by retrying — for a CRM of record a
 * duplicate is worse than a gap, and only a human can tell the two apart.
 */
export function connectorSendExecutionService(db: Db) {
  const connectors = connectorService(db);
  const hubspot = hubspotConnectorService(db);
  const stewardships = agentStewardshipService(db);

  /** Record a refusal that happened before any provider call was made. */
  async function recordRefusal(
    approval: typeof approvals.$inferSelect,
    payload: Record<string, unknown>,
    reason: string,
  ) {
    try {
      await db.insert(connectorSendExecutions).values({
        companyId: approval.companyId,
        approvalId: approval.id,
        connectionId: (payload.connectionId as string | undefined) ?? null,
        requestedByAgentId: approval.requestedByAgentId,
        provider: String(payload.provider ?? "hubspot"),
        objectType: String(payload.objectType ?? "unknown"),
        operation: String(payload.operation ?? "unknown"),
        payloadDigest: String(payload.payloadDigest ?? ""),
        outcome: "failed",
        reason,
      });
    } catch (error) {
      // Already claimed: another attempt got there first, which is the
      // behaviour we want. Nothing to add.
      if (!isUniqueViolation(error)) throw error;
    }
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "system",
      actorId: "connector-send",
      agentId: approval.requestedByAgentId,
      action: "connector_send.refused",
      entityType: "approval",
      entityId: approval.id,
      details: { reason },
    });
  }

  /**
   * Run an approved connector_send. Never throws: it is a side effect of
   * deciding an approval, and a provider outage must not turn a recorded human
   * decision into a failed request.
   */
  async function executeForApproval(approvalId: string): Promise<void> {
    try {
      const approval = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .then((rows) => rows[0] ?? null);
      if (!approval || approval.type !== "connector_send") return;
      if (approval.status !== "approved") return;

      const company = await db
        .select({ productProfile: companies.productProfile })
        .from(companies)
        .where(eq(companies.id, approval.companyId))
        .then((rows) => rows[0] ?? null);
      if (company?.productProfile !== "agentdash_mk") return;

      const payload = (approval.payload ?? {}) as Record<string, unknown>;

      // Already executed (or being executed). The unique index is the real
      // guard; this read just avoids the pointless work and the noisy error.
      const existing = await db
        .select({ id: connectorSendExecutions.id })
        .from(connectorSendExecutions)
        .where(eq(connectorSendExecutions.approvalId, approval.id))
        .then((rows) => rows[0] ?? null);
      if (existing) return;

      // --- re-resolution, all against CURRENT state ------------------------

      if (approval.expiresAt && approval.expiresAt.getTime() < Date.now()) {
        await recordRefusal(approval, payload, "approval_expired");
        return;
      }

      const agentId = approval.requestedByAgentId;
      if (!agentId) {
        await recordRefusal(approval, payload, "no_requesting_agent");
        return;
      }

      // A stewardship that moved between the decision and now means the person
      // who approved may no longer hold authority over this agent.
      const steward = await stewardships.activeByAgent(approval.companyId, agentId);
      if (!steward) {
        await recordRefusal(approval, payload, "no_active_steward");
        return;
      }

      // The ceiling, again. This is the check the whole native-connector
      // argument rests on, so it runs at the moment of the act, not before it.
      const acting = await connectors.resolveActingAs(
        approval.companyId,
        agentId,
        "send",
        String(payload.provider ?? "hubspot"),
      );
      if (!acting.ok) {
        await recordRefusal(approval, payload, acting.blocked.reason);
        return;
      }

      // The connection must still be the one that was approved. A different
      // connection is a different credential acting under an old decision.
      const approvedConnectionId = payload.connectionId as string | undefined;
      if (approvedConnectionId && approvedConnectionId !== acting.resolution.connectionId) {
        await recordRefusal(approval, payload, "connection_changed");
        return;
      }

      const connection = await db
        .select({ status: connections.status, revokedAt: connections.revokedAt })
        .from(connections)
        .where(eq(connections.id, acting.resolution.connectionId))
        .then((rows) => rows[0] ?? null);
      if (!connection || connection.revokedAt || connection.status !== "active") {
        await recordRefusal(approval, payload, "connection_unavailable");
        return;
      }

      // --- claim, then act -------------------------------------------------

      let claimed: { id: string } | null = null;
      try {
        claimed = await db
          .insert(connectorSendExecutions)
          .values({
            companyId: approval.companyId,
            approvalId: approval.id,
            connectionId: acting.resolution.connectionId,
            requestedByAgentId: agentId,
            provider: String(payload.provider ?? "hubspot"),
            objectType: String(payload.objectType ?? "unknown"),
            operation: String(payload.operation ?? "unknown"),
            payloadDigest: String(payload.payloadDigest ?? ""),
            // The honest pre-call state. If this process dies mid-flight, this
            // is what the record should say and it already says it.
            outcome: "outcome_unknown",
            reason: "claimed",
          })
          .returning({ id: connectorSendExecutions.id })
          .then((rows) => rows[0] ?? null);
      } catch (error) {
        if (isUniqueViolation(error)) return;
        throw error;
      }
      if (!claimed) return;

      const properties = (payload.properties ?? {}) as Record<string, unknown>;
      const result = await hubspot.executeWrite({
        connectionId: acting.resolution.connectionId,
        objectType: String(payload.objectType),
        operation: payload.operation === "update" ? "update" : "create",
        objectId: (payload.objectId as string | null) ?? null,
        properties,
      });

      await db
        .update(connectorSendExecutions)
        .set({
          outcome: result.outcome,
          externalId: result.outcome === "succeeded" ? result.externalId : null,
          reason: result.outcome === "succeeded" ? null : result.reason,
          executedAt: new Date(),
        })
        .where(eq(connectorSendExecutions.id, claimed.id));

      // Reference-and-counts only. The properties are already on the approval,
      // which has redaction on every read path; copying them into the activity
      // log would put CRM data in a second store with different access rules.
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "system",
        actorId: "connector-send",
        agentId,
        action: `connector_send.${result.outcome}`,
        entityType: "approval",
        entityId: approval.id,
        details: {
          provider: payload.provider,
          objectType: payload.objectType,
          operation: payload.operation,
          connectionId: acting.resolution.connectionId,
          payloadDigest: payload.payloadDigest,
          externalId: result.outcome === "succeeded" ? result.externalId : null,
        },
      });
    } catch (error) {
      logger.warn({ err: error, approvalId }, "connector send execution failed");
    }
  }

  return { executeForApproval };
}
