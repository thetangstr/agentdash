import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  companies,
  connections,
  connectorSendExecutions,
  workflowEvents,
} from "@paperclipai/db";
import { checkConnectorSendPayload, classifyAction, CONNECTOR_SEND_PROVIDERS } from "@paperclipai/shared";
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
 * What happened when an approved `connector_send` was run, for the caller that
 * must tell the requester and the steward. `null` from the executor means
 * nothing was attempted (not a connector_send, off-profile, or already run by
 * another attempt), so there is nothing new to report.
 */
export interface ConnectorSendExecutionReport {
  outcome: "succeeded" | "failed" | "outcome_unknown";
  /** True when a check refused the send before any provider call was made. */
  refused: boolean;
  /** Machine-readable reason, as recorded on the execution row. */
  reason: string | null;
  /**
   * The provider the payload named, sanitized and truncated (see
   * `recordedProvider`), or null when it named none. Agent-written, so text
   * for a person shows it only when it is a known connector.
   */
  provider: string | null;
  /**
   * The agent-facing explanation of a payload refusal (the same text the 422
   * gives at creation). For the requesting agent only: it is instructions
   * written to an agent, and never goes into text a person reads.
   */
  detail: string | null;
}

/** Plain-language text for the refusal and failure reasons the executor records. */
const REASON_TEXT: Record<string, string> = {
  approval_expired: "the approval had expired before it was decided",
  no_requesting_agent: "the approval has no requesting agent to act for",
  destructive_action_blocked: "this agent's policy blocks destructive actions, and this write counts as one",
  no_active_steward: "the requesting agent no longer has an active steward",
  no_connection: "there is no usable connection for this provider",
  provider_not_allowed: "this agent's ceiling does not allow this provider",
  data_scope_not_allowed: "this agent's ceiling does not allow this data scope",
  connection_changed: "the connection changed after the request was filed",
  connection_unavailable: "the connection is revoked or not active",
  connection_unreadable: "the connection's credential could not be read",
  executor_error: "the executor hit an internal error; check the execution record before retrying",
  executor_error_before_send: "the executor hit an internal error before the send was attempted",
  transport_failure: "the connection to the provider dropped before it answered",
  provider_timeout: "the provider did not answer in time",
  // Payload refusals (checkConnectorSendPayload problems), worded for the
  // person reading them rather than for the agent that wrote the payload.
  teams_not_supported: "it asked for a Teams message, and AgentDash has no connector that sends to Teams",
  provider_missing: "the request did not say which connector should send it",
  provider_unsupported: "the request named a connector that cannot send",
  object_type_invalid: "the request was missing details the connector needs",
  operation_invalid: "the request was missing details the connector needs",
  object_id_required: "the request was missing details the connector needs",
  properties_invalid: "the request was missing details the connector needs",
};

function reasonText(reason: string): string {
  const known = REASON_TEXT[reason];
  if (known) return known;
  const http = /^provider_(\d{3})$/.exec(reason);
  if (http) return `the provider answered HTTP ${http[1]}`;
  return `reason: ${reason}`;
}

/**
 * One line a person can act on: what happened to the send and why.
 * Reference-and-reason only — never the payload being sent, never the
 * agent-facing `detail`, and never an agent-written provider string: a
 * provider is named only when it is a connector AgentDash actually has.
 */
export function describeConnectorSendOutcome(report: ConnectorSendExecutionReport): string {
  const why = report.reason ? reasonText(report.reason) : null;
  const known =
    report.provider && (CONNECTOR_SEND_PROVIDERS as readonly string[]).includes(report.provider);
  const provider = known ? ` through ${report.provider}` : "";
  if (report.outcome === "succeeded") return `The approved send${provider} was delivered.`;
  if (report.outcome === "outcome_unknown") {
    return (
      `The approved send${provider} may or may not have been delivered${why ? ` (${why})` : ""}. ` +
      "Do not retry it: a steward must reconcile the outcome first."
    );
  }
  const verb = report.refused ? "was refused before anything was sent" : "failed";
  return `The approved send${provider} ${verb}${why ? `: ${why}` : ""}. Nothing was delivered.`;
}

/**
 * The provider string an execution row records. A payload that named none
 * records "unspecified" — never a guessed provider, which is how a Teams
 * request used to be filed as a failed HubSpot write.
 */
function recordedProvider(payload: Record<string, unknown>): string {
  // Agent-written text lands in a table other surfaces render, so it is kept
  // to identifier characters and a bounded length.
  const cleaned =
    typeof payload.provider === "string"
      ? payload.provider.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40)
      : "";
  return cleaned.length > 0 ? cleaned : "unspecified";
}

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
    detail: string | null = null,
  ): Promise<ConnectorSendExecutionReport | null> {
    try {
      await db.insert(connectorSendExecutions).values({
        companyId: approval.companyId,
        approvalId: approval.id,
        connectionId: (payload.connectionId as string | undefined) ?? null,
        requestedByAgentId: approval.requestedByAgentId,
        provider: recordedProvider(payload),
        objectType: String(payload.objectType ?? "unknown"),
        operation: String(payload.operation ?? "unknown"),
        payloadDigest: String(payload.payloadDigest ?? ""),
        outcome: "failed",
        reason,
      });
    } catch (error) {
      // Already claimed: another attempt got there first, which is the
      // behaviour we want. Nothing to add, and nothing new to report.
      if (!isUniqueViolation(error)) throw error;
      return null;
    }
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "system",
      actorId: "connector-send",
      agentId: approval.requestedByAgentId,
      action: "connector_send.refused",
      entityType: "approval",
      entityId: approval.id,
      details: { reason, provider: recordedProvider(payload) },
    });
    return {
      outcome: "failed",
      refused: true,
      reason,
      provider: recordedProvider(payload) === "unspecified" ? null : recordedProvider(payload),
      detail,
    };
  }

  /**
   * Run an approved connector_send. Never throws: it is a side effect of
   * deciding an approval, and a provider outage must not turn a recorded human
   * decision into a failed request.
   *
   * Returns what happened so the caller can tell the requester and the
   * steward; `null` when nothing was attempted.
   */
  async function executeForApproval(approvalId: string): Promise<ConnectorSendExecutionReport | null> {
    // Set once the provider has answered, so an error after that point cannot
    // be reported as a send that never happened.
    let report: ConnectorSendExecutionReport | null = null;
    let attemptedProvider: string | null = null;
    // Set once this call owns the attempt (no execution row existed), so an
    // error before then reports nothing rather than a duplicate outcome.
    let attempted = false;
    // AgentDash (GH #863 item 5): set only once the claim row is written, the
    // point after which the provider may have been called. An error before it
    // (a transient DB error on a check or on the claim insert itself) sent
    // nothing and left no row to reconcile, so it must not be reported as
    // "outcome unknown, do not refile".
    let claimWritten = false;
    try {
      const approval = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .then((rows) => rows[0] ?? null);
      if (!approval || approval.type !== "connector_send") return null;
      if (approval.status !== "approved") return null;

      const company = await db
        .select({ productProfile: companies.productProfile })
        .from(companies)
        .where(eq(companies.id, approval.companyId))
        .then((rows) => rows[0] ?? null);
      if (company?.productProfile !== "agentdash_mk") return null;

      const payload = (approval.payload ?? {}) as Record<string, unknown>;

      // Already executed (or being executed). The unique index is the real
      // guard; this read just avoids the pointless work and the noisy error.
      const existing = await db
        .select({ id: connectorSendExecutions.id })
        .from(connectorSendExecutions)
        .where(eq(connectorSendExecutions.approvalId, approval.id))
        .then((rows) => rows[0] ?? null);
      if (existing) return null;
      attempted = true;

      // --- the payload must name something an executor can run -------------
      //
      // Checked at creation too, but approvals filed before that check existed
      // are still in the table. A payload with no provider is refused as what
      // it is; it is never executed as a guess at one.
      const shape = checkConnectorSendPayload(payload);
      if (!shape.ok) {
        return await recordRefusal(approval, payload, shape.problem, shape.message);
      }
      const provider = shape.provider;
      attemptedProvider = provider;

      // --- re-resolution, all against CURRENT state ------------------------

      if (approval.expiresAt && approval.expiresAt.getTime() < Date.now()) {
        return await recordRefusal(approval, payload, "approval_expired");
      }

      const agentId = approval.requestedByAgentId;
      if (!agentId) {
        return await recordRefusal(approval, payload, "no_requesting_agent");
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
      const operation = payload.operation === "update" ? "update" : "create";
      const objectType = String(payload.objectType);
      const policy = await governance.resolveAgentPolicy(approval.companyId, agentId);
      if (policy) {
        const classification = classifyAction({
          kind: "connector",
          provider,
          operation,
        });
        const mode = policy.destructiveActions;
        if (classification.destructive && mode === "blocked") {
          const refused = await recordRefusal(approval, payload, "destructive_action_blocked");
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
          return refused;
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
        return await recordRefusal(approval, payload, "no_active_steward");
      }

      // The ceiling, again. This is the check the whole native-connector
      // argument rests on, so it runs at the moment of the act, not before it.
      const acting = await connectors.resolveActingAs(approval.companyId, agentId, "send", provider);
      if (!acting.ok) {
        return await recordRefusal(approval, payload, acting.blocked.reason);
      }

      // The connection must still be the one that was approved. A different
      // connection is a different credential acting under an old decision.
      const approvedConnectionId = payload.connectionId as string | undefined;
      if (approvedConnectionId && approvedConnectionId !== acting.resolution.connectionId) {
        return await recordRefusal(approval, payload, "connection_changed");
      }

      const connection = await db
        .select({ status: connections.status, revokedAt: connections.revokedAt })
        .from(connections)
        .where(eq(connections.id, acting.resolution.connectionId))
        .then((rows) => rows[0] ?? null);
      if (!connection || connection.revokedAt || connection.status !== "active") {
        return await recordRefusal(approval, payload, "connection_unavailable");
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
            provider,
            objectType,
            operation,
            payloadDigest: String(payload.payloadDigest ?? ""),
            // The honest pre-call state. If this process dies mid-flight, this
            // is what the record should say and it already says it.
            outcome: "outcome_unknown",
            reason: "claimed",
          })
          .returning({ id: connectorSendExecutions.id })
          .then((rows) => rows[0] ?? null);
      } catch (error) {
        if (isUniqueViolation(error)) return null;
        throw error;
      }
      if (!claimed) return null;
      claimWritten = true;

      const properties = (payload.properties ?? {}) as Record<string, unknown>;
      const result = await hubspot.executeWrite({
        connectionId: acting.resolution.connectionId,
        objectType,
        operation,
        objectId: (payload.objectId as string | null) ?? null,
        properties,
      });
      report = {
        outcome: result.outcome,
        refused: false,
        reason: result.outcome === "succeeded" ? null : result.reason,
        provider,
        detail: null,
      };

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
          provider,
          objectType,
          operation,
          connectionId: acting.resolution.connectionId,
          payloadDigest: payload.payloadDigest,
          externalId: result.outcome === "succeeded" ? result.externalId : null,
        },
      });
      return report;
    } catch (error) {
      logger.warn({ err: error, approvalId }, "connector send execution failed");
      // Before the provider answered, an error means we cannot say the send
      // happened, and the requester must not be left believing it did.
      if (report) return report;
      // Before this call owned the attempt (the approval or company read
      // failed), nothing was tried and there is no execution row, so there is
      // no outcome to report and the wake stays a plain approval.
      if (!attempted) return null;
      if (!claimWritten) {
        return {
          outcome: "failed",
          refused: false,
          reason: "executor_error_before_send",
          provider: attemptedProvider,
          detail: null,
        };
      }
      return {
        outcome: "outcome_unknown",
        refused: false,
        reason: "executor_error",
        provider: attemptedProvider,
        detail: null,
      };
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
