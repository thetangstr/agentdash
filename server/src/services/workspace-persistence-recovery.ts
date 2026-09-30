// AgentDash: server-private quarantine on original run records, not wake metadata.
import { and, eq, sql } from 'drizzle-orm';
import { heartbeatRuns, issues, type Db } from '@paperclipai/db';

export const WORKSPACE_PERSISTENCE_RECOVERY_CODE = 'workspace_persistence_uncertain';
export interface WorkspacePersistenceAttempt {
  companyId: string;
  agentId: string;
  issueId: string | null;
  workspaceId: string;
  phase: 'workspace' | 'recorder' | 'old_workspace' | 'issue_link' | 'run_context' | 'complete';
  outcome: 'pending' | 'unknown' | 'accepted' | 'rolled_back' | 'complete';
  recoveryRequired: boolean;
}

// Only the private attempt writer establishes this separate server-owned usage slot.
// Historical adapter result fields (even with a matching errorCode) are not provenance.
export const workspacePersistenceHasProvenance = sql<boolean>`(
  ${heartbeatRuns.usageJson}->>'workspacePersistenceAttemptId' is not null
  and ${heartbeatRuns.usageJson}->>'workspacePersistenceAttemptId' = ${heartbeatRuns.resultJson}->'workspacePersistence'->>'workspaceId'
)`;

// Read all original unresolved attempts: later refused/cancelled runs cannot hide one.
// Caller-owned transactions take the company mutex before this predicate read.
export async function workspacePersistenceHold(
  executor: Pick<Db, 'select'>,
  companyId: string,
  agentId: string | null,
  issueId: string | null,
) {
  const rows = await executor.select({
    runId: heartbeatRuns.id,
    agentId: heartbeatRuns.agentId,
    issueId: sql<string | null>`${heartbeatRuns.resultJson}->'workspacePersistence'->>'issueId'`,
    currentAssigneeId: issues.assigneeAgentId,
  }).from(heartbeatRuns).leftJoin(issues, and(
    eq(issues.companyId, companyId),
    sql`${issues.id}::text = ${heartbeatRuns.resultJson}->'workspacePersistence'->>'issueId'`,
  )).where(and(
    eq(heartbeatRuns.companyId, companyId),
    workspacePersistenceHasProvenance,
    sql`${heartbeatRuns.resultJson}->'workspacePersistence'->>'recoveryRequired' = 'true'`,
  ));
  return rows.find(row => row.issueId === null
    ? row.agentId === agentId
    : issueId !== null ? row.issueId === issueId
      : row.agentId === agentId || row.currentAssigneeId === agentId) ?? null;
}
