// AgentDash: server-private quarantine on original run records, not wake metadata.
import { and, eq, sql } from 'drizzle-orm';
import { companies, heartbeatRuns, issues, type Db } from '@paperclipai/db';
import { insertActivity, publishActivity, type ActivityPublication } from './activity-log.js';

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

/**
 * AgentDash (#881 review P3): the audited human exit from a workspace
 * quarantine. An attempt is recorded with recoveryRequired before persistence,
 * so a restart or an uncertain commit between the two leaves the issue (or,
 * with no issue, the agent) held. After a person has checked the workspace and
 * issue, this marks the matching unresolved attempts resolved. It never
 * deletes workspace files and never replays the run.
 */
export async function clearWorkspacePersistenceHold(db: Db, input: {
  companyId: string;
  issueId: string | null;
  agentId: string | null;
  actorUserId: string;
  note?: string | null;
}) {
  if (!input.issueId && !input.agentId) throw new Error('issueId or agentId is required');
  const publications: ActivityPublication[] = [];
  const clearedRunIds = await db.transaction(async tx => {
    // Same company mutex as the attempt writer and claim admission.
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, input.companyId)).for('no key update');
    const rows = await tx.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        workspacePersistenceHasProvenance,
        sql`${heartbeatRuns.resultJson}->'workspacePersistence'->>'recoveryRequired' = 'true'`,
      )).for('update');
    const matching = rows.filter(row => {
      const attempt = (row.resultJson as { workspacePersistence?: { issueId?: string | null } } | null)?.workspacePersistence;
      const attemptIssueId = attempt?.issueId ?? null;
      return input.issueId ? attemptIssueId === input.issueId : attemptIssueId === null && row.agentId === input.agentId;
    });
    const resolvedAt = new Date().toISOString();
    for (const row of matching) {
      const result = (row.resultJson ?? {}) as Record<string, unknown>;
      const attempt = (result.workspacePersistence ?? {}) as Record<string, unknown>;
      await tx.update(heartbeatRuns).set({
        resultJson: { ...result, workspacePersistence: { ...attempt, recoveryRequired: false, outcome: 'resolved_by_board',
          resolvedByUserId: input.actorUserId, resolvedAt, previousOutcome: attempt.outcome ?? null } },
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, row.id));
    }
    if (matching.length > 0) {
      publications.push(await insertActivity(tx, {
        companyId: input.companyId, actorType: 'user', actorId: input.actorUserId,
        action: 'workspace.persistence_recovery_cleared',
        entityType: input.issueId ? 'issue' : 'agent', entityId: (input.issueId ?? input.agentId)!,
        details: { runIds: matching.map(row => row.id), issueId: input.issueId, agentId: input.agentId, note: input.note ?? null },
      }));
    }
    return matching.map(row => row.id);
  });
  for (const publication of publications) publishActivity(publication);
  return { clearedRunIds };
}
