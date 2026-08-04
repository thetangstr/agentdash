import type { ReconcileConnectorSendExecution } from "@paperclipai/shared";
import { api } from "./client";

/**
 * AgentDash-MK T4: the `outcome_unknown` operator surface (audit item 14).
 *
 * Typed client for the two T4a routes. The list route is company-scoped,
 * profile-gated (404 off `agentdash_mk`), and authorized server-side to
 * owner/admin or the requesting steward — a member who is none of those gets a
 * 403, which the UI surfaces as a refusal rather than an empty list. Reconcile
 * records a human's verdict as an AUDIT record; it never resends. `revision` is
 * the state the row was rendered against, echoed back so a stale button cannot
 * flip a verdict decided after it was shown.
 */

export type ReconcileVerdict = ReconcileConnectorSendExecution["verdict"];

/** One unresolved ambiguous connector write awaiting a human's verdict. */
export interface ConnectorSendExecutionRow {
  id: string;
  provider: string;
  objectType: string;
  operation: string;
  outcome: string;
  reason: string | null;
  requestedByAgentId: string | null;
  /** ISO timestamp (Date serialized over JSON). */
  executedAt: string;
  /** The state the reconcile button must echo back; 0 while unresolved. */
  revision: number;
}

export interface ReconcileResult {
  id: string;
  verdict: ReconcileVerdict;
  idempotent: boolean;
}

export const connectorSendExecutionsApi = {
  /** Owner/admin see every unresolved row; a steward only their own agent's. */
  listUnresolved: (companyId: string) =>
    api.get<{ items: ConnectorSendExecutionRow[] }>(
      `/companies/${companyId}/connector-send-executions?status=outcome_unknown`,
    ),
  /** Record a human verdict against the row's current revision. Does NOT resend. */
  reconcile: (
    companyId: string,
    executionId: string,
    data: ReconcileConnectorSendExecution,
  ) =>
    api.post<ReconcileResult>(
      `/companies/${companyId}/connector-send-executions/${executionId}/reconcile`,
      data,
    ),
};
