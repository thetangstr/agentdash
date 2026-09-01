import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  companies,
  connections,
  connectorSendExecutions,
  workflowEvents,
} from "@paperclipai/db";
import { classifyAction } from "@paperclipai/shared";
import { isUniqueViolation } from "../lib/pg-error.js";
import { logger } from "../middleware/logger.js";
import { agentGovernanceService } from "./agent-governance.js";
import { agentStewardshipService } from "./agent-stewardships.js";
import { connectorService } from "./connectors.js";
import { hubspotConnectorService } from "./hubspot-connector.js";
import { workflowEventsService } from "./workflow-events.js";
import { logActivity } from "./activity-log.js";

/**
 * AgentDash-MK T4: the pipeline key a reconcile event lands under.
 *
 * Names a KIND of work — resolving ambiguous connector sends — and nobody who
 * does it, matching the measurement substrate's rule. Every reconcile event
 * shares it so the operator surface can find them, and `runId` is the execution
 * id, which is the row it settles rather than a person.
 */
const RECONCILE_PIPELINE_ID = "connector_send:reconcile";
const RECONCILE_STEP_KEY = "reconcile";

export type ReconcileVerdict = "confirmed_delivered" | "confirmed_failed";

/**
 * The result of a reconcile attempt. `not_found` is a missing/wrong-company
 * execution; `conflict` covers a stale revision and a refused verdict flip.
 * The route maps these to 404/409 so a stale button cannot masquerade as a
 * fresh decision.
 */
export type ReconcileResult =
  | { status: "ok"; verdict: ReconcileVerdict; idempotent: boolean }
  | { status: "not_found" }
  | { status: "conflict"; reason: "stale_revision" | "already_reconciled" | "not_reconcilable" };

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
  const governance = agentGovernanceService(db);
  const workflow = workflowEventsService(db);

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

      /**
       * AgentDash-MK T5a: destructive-action enforcement at the apply path.
       *
       * The mode binds to the classifier's placement of `(provider, operation)`.
       * A HubSpot write is `unclassified_write` — it fails closed to destructive
       * — and every destructive class under a `blocked` ceiling is refused HERE,
       * before any provider call. `approval_required` needs nothing more of this
       * path: reaching it means a steward already decided through the approval
       * service, which is the only decision boundary; the send proceeds. A
       * `safe_read` proceeds unconditionally.
       *
       * `resolveAgentPolicy` returns null off-profile, but this path is already
       * gated to `agentdash_mk` above, so on any real call it is non-null.
       */
      const provider = String(payload.provider ?? "hubspot");
      const policy = await governance.resolveAgentPolicy(approval.companyId, agentId);
      if (policy) {
        const classification = classifyAction({
          kind: "connector",
          provider,
          operation: String(payload.operation ?? "unknown"),
        });
        const mode = policy.destructiveActions;
        if (classification.destructive && mode === "blocked") {
          await recordRefusal(approval, payload, "destructive_action_blocked");
          await workflow.emit({
            companyId: approval.companyId,
            pipelineId: `connector_send:${provider}`,
            runId: approval.id,
            stepKey: "authorization",
            eventType: "destructive_action_gated",
            actorKind: "agent",
            payload: {
              surface: "connector_send",
              actionClass: classification.class,
              mode,
              decision: "refused",
            },
          });
          return;
        }
        // Not refused: the send proceeds. Record the verdict as an audit row on
        // the same run before the work happens.
        await workflow.emit({
          companyId: approval.companyId,
          pipelineId: `connector_send:${provider}`,
          runId: approval.id,
          stepKey: "authorization",
          eventType: "destructive_action_gated",
          actorKind: "agent",
          payload: {
            surface: "connector_send",
            actionClass: classification.class,
            mode,
            decision: "allowed",
          },
        });
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

  /**
   * The set of execution ids this company has already reconciled.
   *
   * "Already reconciled" is derived from the presence of a reconcile event, not
   * from a status column: the execution row keeps saying `outcome_unknown`
   * because that is still the true machine outcome — a human's belief that a
   * write landed is a different fact from the provider confirming it, and
   * overwriting one with the other would lose exactly the case this table
   * exists to preserve.
   */
  async function reconciledExecutionIds(companyId: string): Promise<Set<string>> {
    const rows = await db
      .select({ runId: workflowEvents.runId })
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.companyId, companyId),
          eq(workflowEvents.pipelineId, RECONCILE_PIPELINE_ID),
          eq(workflowEvents.eventType, "outcome_reconciled"),
        ),
      );
    return new Set(rows.map((row) => row.runId));
  }

  /**
   * The unresolved `outcome_unknown` rows a caller may act on.
   *
   * `agentIds` scopes to a steward's own agent(s); passing `null` is the
   * owner/admin view over every agent in the company. Rows that already carry a
   * reconcile event are excluded — that is what makes reconciling one remove it
   * from the list. Reference-not-content: no payload, no external id text.
   */
  async function listUnresolved(
    companyId: string,
    agentIds: string[] | null,
  ): Promise<
    Array<{
      id: string;
      provider: string;
      objectType: string;
      operation: string;
      outcome: string;
      reason: string | null;
      requestedByAgentId: string | null;
      executedAt: Date;
      /** The state the reconcile button must echo back; 0 while unresolved. */
      revision: number;
    }>
  > {
    if (agentIds !== null && agentIds.length === 0) return [];
    const rows = await db
      .select({
        id: connectorSendExecutions.id,
        provider: connectorSendExecutions.provider,
        objectType: connectorSendExecutions.objectType,
        operation: connectorSendExecutions.operation,
        outcome: connectorSendExecutions.outcome,
        reason: connectorSendExecutions.reason,
        requestedByAgentId: connectorSendExecutions.requestedByAgentId,
        executedAt: connectorSendExecutions.executedAt,
      })
      .from(connectorSendExecutions)
      .where(
        and(
          eq(connectorSendExecutions.companyId, companyId),
          eq(connectorSendExecutions.outcome, "outcome_unknown"),
          ...(agentIds !== null
            ? [inArray(connectorSendExecutions.requestedByAgentId, agentIds)]
            : []),
        ),
      )
      .orderBy(desc(connectorSendExecutions.executedAt));

    const reconciled = await reconciledExecutionIds(companyId);
    return rows
      .filter((row) => !reconciled.has(row.id))
      .map((row) => ({ ...row, revision: 0 }));
  }

  /** One unresolved execution, scoped to the company. Null off-company. */
  async function getUnresolvedById(companyId: string, executionId: string) {
    return db
      .select()
      .from(connectorSendExecutions)
      .where(
        and(
          eq(connectorSendExecutions.id, executionId),
          eq(connectorSendExecutions.companyId, companyId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Record a human's verdict on an ambiguous send.
   *
   * This is an AUDIT record and nothing else: it writes a workflow event (the
   * measurement substrate, actorKind `human`, no person) and an activity-log
   * entry (which is allowed to name the acting user). It never touches the
   * provider — resending stays with the approvals flow, the single decision
   * boundary. It is idempotent and revision-bound so a stale button cannot flip
   * a verdict decided after the button was rendered.
   */
  async function reconcile(input: {
    companyId: string;
    executionId: string;
    actingUserId: string;
    verdict: ReconcileVerdict;
    revision: number;
  }): Promise<ReconcileResult> {
    const execution = await getUnresolvedById(input.companyId, input.executionId);
    if (!execution) return { status: "not_found" };

    // The authoritative verdict is the first one recorded. Reading it also
    // yields the current revision (the count of reconcile events for this row).
    const prior = await db
      .select({ payload: workflowEvents.payload })
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.companyId, input.companyId),
          eq(workflowEvents.pipelineId, RECONCILE_PIPELINE_ID),
          eq(workflowEvents.eventType, "outcome_reconciled"),
          eq(workflowEvents.runId, input.executionId),
        ),
      );
    if (prior.length > 0) {
      const priorVerdict = (prior[0].payload as { verdict?: string }).verdict;
      // A replay of the same verdict is harmless and returns success; a
      // different verdict is a stale button trying to flip a decided row.
      if (priorVerdict === input.verdict) {
        return { status: "ok", verdict: input.verdict, idempotent: true };
      }
      return { status: "conflict", reason: "already_reconciled" };
    }

    // Not yet reconciled: the current revision is 0. A button rendered against
    // any other state is stale and must not decide.
    if (input.revision !== 0) return { status: "conflict", reason: "stale_revision" };
    if (execution.outcome !== "outcome_unknown") {
      return { status: "conflict", reason: "not_reconcilable" };
    }

    // Measurement first: what kind of actor acted (human) and the verdict.
    await workflow.emit({
      companyId: input.companyId,
      pipelineId: RECONCILE_PIPELINE_ID,
      runId: input.executionId,
      stepKey: RECONCILE_STEP_KEY,
      eventType: "outcome_reconciled",
      actorKind: "human",
      payload: { verdict: input.verdict, executionId: input.executionId },
    });

    // Actor attribution belongs in the audit trail that is allowed to name a
    // person. Reference-not-content: the provider/object/operation are the
    // execution's own reference fields, never its payload.
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.actingUserId,
      agentId: execution.requestedByAgentId,
      action: "connector_send.reconciled",
      entityType: "connector_send_execution",
      entityId: input.executionId,
      details: {
        verdict: input.verdict,
        provider: execution.provider,
        objectType: execution.objectType,
        operation: execution.operation,
      },
    });

    return { status: "ok", verdict: input.verdict, idempotent: false };
  }

  return { executeForApproval, listUnresolved, getUnresolvedById, reconcile };
}
