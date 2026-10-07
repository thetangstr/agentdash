// AgentDash: named-human task-recovery permit. A prepare/confirm pair lets one
// named human authorize exactly ONE remediation run on the SAME exhausted
// issue. The permit is durable evidence written onto the issue's persisted
// recoveryBudget marker — it never deletes the marker, resets the ledger, or
// enables any automatic continuation. This is deliberately a different system
// from human-question recovery: a question recovers blocked INPUT; this
// authorizes one bounded EXECUTION attempt against an exhausted budget.
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { agentStewardships, agents, companyMemberships, heartbeatRuns, issues, principalPermissionGrants } from '@paperclipai/db';
import {
  humanJsonSchema,
  taskRecoveryExhaustedIssueSchema,
  taskRecoveryIssueInputSchema,
  taskRecoveryPermitSchema,
  taskRecoveryRemediateInputSchema,
  taskRecoveryRemediateReceiptSchema,
  type HumanOperationDescriptor,
  type TaskRecoveryPermit,
  type TaskRecoveryRemediateReceipt,
} from '@paperclipai/shared';
import { conflict, forbidden, notFound } from '../../errors.js';
import { assertProjectIdVisible } from '../../routes/visibility.js';
import { actorHumanRole } from '../../routes/authz.js';
import { insertActivity } from '../activity-log.js';
import type { heartbeatService } from '../heartbeat.js';
import type { HumanOperation, HumanOperationContext, HumanRecoveryReference } from '../human-control.js';
import { humanCompany } from './workforce.js';
import { isBoardAssignmentOnlyAgent } from '../agent-wake-policy.js';

const TASK_RECOVERY_PERMIT_DEFAULT_TTL_MINUTES = 15;

type TaskRecoveryHeartbeat = Pick<
  ReturnType<typeof heartbeatService>,
  'enqueueTaskRecoveryPermitRun' | 'dispatchQueuedRunsForAgent'
>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recoveryMarker(issue: { executionState: unknown }): Record<string, unknown> {
  return asRecord(asRecord(issue.executionState).recoveryBudget);
}

async function loadIssue(ctx: HumanOperationContext, issueId: string) {
  const companyId = humanCompany(ctx);
  const query = ctx.db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  const [issue] = await (ctx.lock ? query.for('update') : query);
  if (!issue || issue.hiddenAt) throw notFound('Issue not found');

  const [member] = await ctx.db
    .select()
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, 'user'),
      eq(companyMemberships.principalId, ctx.req.actor.userId ?? ''),
      eq(companyMemberships.status, 'active'),
    ));
  if (!member) throw forbidden('Active named company membership required');
  await assertProjectIdVisible(ctx.db, ctx.req, companyId, issue.projectId);
  return issue;
}

/**
 * AgentDash (GH #891, F4 decision): who may authorize a run on an exhausted
 * issue. Seeing the issue is not enough — letting an agent spend past its
 * exhausted recovery budget is a decision about that agent, so it needs the
 * authority to manage the issue's assignee agent:
 *   - a company admin (or an instance admin), or
 *   - a person with the agents:create grant (the agent-administrator
 *     predicate used across governance), or
 *   - the agent's own people: its active steward, its accountable human, or
 *     the person who created it.
 * A plain member with none of those (including a legacy "viewer" row, which
 * normalizes to member) can see the banner but cannot authorize. The rows read
 * here are witnessed by the human-control authority stage (agent, stewardship,
 * membership and agents:create grant), so a change between review and
 * confirmation refuses the confirmation.
 */
export async function assertCanAuthorizeTaskRecovery(
  ctx: HumanOperationContext,
  issue: Pick<typeof issues.$inferSelect, 'companyId' | 'assigneeAgentId'>,
) {
  const req = ctx.req;
  const userId = req.actor.userId;
  if (!userId) throw forbidden('A named board user is required to authorize a run');
  if (req.actor.isInstanceAdmin) return;
  if (actorHumanRole(req, issue.companyId) === 'admin') return;
  const [grant] = await ctx.db
    .select({ id: principalPermissionGrants.id })
    .from(principalPermissionGrants)
    .where(and(
      eq(principalPermissionGrants.companyId, issue.companyId),
      eq(principalPermissionGrants.principalType, 'user'),
      eq(principalPermissionGrants.principalId, userId),
      eq(principalPermissionGrants.permissionKey, 'agents:create'),
    ));
  if (grant) return;
  if (issue.assigneeAgentId) {
    const [agent] = await ctx.db
      .select({ createdByUserId: agents.createdByUserId, accountableUserId: agents.accountableUserId })
      .from(agents)
      .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)));
    if (agent && (agent.createdByUserId === userId || agent.accountableUserId === userId)) return;
    const [steward] = await ctx.db
      .select({ id: agentStewardships.id })
      .from(agentStewardships)
      .where(and(
        eq(agentStewardships.companyId, issue.companyId),
        eq(agentStewardships.agentId, issue.assigneeAgentId),
        eq(agentStewardships.userId, userId),
        isNull(agentStewardships.endedAt),
      ));
    if (steward) return;
  }
  throw forbidden(
    "Only a company admin, or a person who manages this issue's agent (its steward, accountable person or creator), can authorize a run.",
  );
}

async function projectIssue(ctx: HumanOperationContext, issue: typeof issues.$inferSelect) {
  const marker = recoveryMarker(issue);
  const permit = taskRecoveryPermitSchema.safeParse(marker.remediation);
  const assignee = issue.assigneeAgentId
    ? await ctx.db
        .select({ name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)))
        .then((rows) => rows[0] ?? null)
    : null;
  return {
    issueId: issue.id,
    companyId: issue.companyId,
    identifier: issue.identifier ?? null,
    title: issue.title,
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    assigneeAgentName: assignee?.name ?? null,
    exhausted: marker.status === 'exhausted',
    exhaustedAt: typeof marker.exhaustedAt === 'string' ? marker.exhaustedAt : null,
    exhaustedBy: Array.isArray(marker.exhaustedBy)
      ? marker.exhaustedBy.filter((value): value is string => typeof value === 'string')
      : [],
    sourceRunId: typeof marker.sourceRunId === 'string' ? marker.sourceRunId : null,
    refusedRunId: typeof marker.refusedRunId === 'string' ? marker.refusedRunId : null,
    usage: marker.usage && typeof marker.usage === 'object' && !Array.isArray(marker.usage)
      ? (marker.usage as Record<string, unknown>)
      : null,
    pendingPermit: permit.success ? permit.data : null,
  };
}

function markerPreconditions(issue: typeof issues.$inferSelect) {
  const marker = recoveryMarker(issue);
  const remediation = taskRecoveryPermitSchema.safeParse(marker.remediation);
  return {
    issueUpdatedAt: issue.updatedAt.toISOString(),
    issueStatus: issue.status,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    exhaustedAt: typeof marker.exhaustedAt === 'string' ? marker.exhaustedAt : null,
    sourceRunId: typeof marker.sourceRunId === 'string' ? marker.sourceRunId : null,
    refusedRunId: typeof marker.refusedRunId === 'string' ? marker.refusedRunId : null,
    exhaustedBy: Array.isArray(marker.exhaustedBy)
      ? marker.exhaustedBy.filter((value): value is string => typeof value === 'string')
      : [],
    // A live authorized permit means an identical confirmation is already
    // pending; a second handle must fail its precondition check.
    pendingPermitStatus: remediation.success ? remediation.data.status : null,
  };
}

export function taskRecoveryHumanOperations(heartbeat: TaskRecoveryHeartbeat): HumanOperation[] {
  function operation(
    operationId: HumanOperationDescriptor['operationId'],
    input: z.AnyZodObject,
    output: z.ZodTypeAny,
    handler: Pick<HumanOperation, 'read' | 'execute' | 'afterCommit'>,
  ): HumanOperation {
    return {
      descriptor: {
        operationId,
        version: 1,
        pageId: 'inbox',
        actionId: operationId.slice('task_recovery.'.length),
        targetKind: 'company',
        behavior: handler.read ? 'read' : 'prepare_confirm',
        // GH #891 (F4): authorizing needs authority over the issue's agent.
        authority: operationId === 'task_recovery.remediate' ? 'agent_management' : 'company_access',
        confirmation: handler.read ? 'none' : 'human_readback',
        inputSchema: humanJsonSchema(input),
        outputSchema: humanJsonSchema(output),
        content: { fullText: true, pagination: 'none' },
      },
      input,
      output,
      ...handler,
      authorize() {},
      async resolve(ctx, p) {
        const issue = await loadIssue(ctx, p.issueId as string);
        const marker = recoveryMarker(issue);
        if (marker.status !== 'exhausted') {
          throw conflict('Issue recovery budget is not exhausted; there is nothing to remediate.');
        }
        await assertCanAuthorizeTaskRecovery(ctx, issue);
        // AgentDash (review F1): an authorized permit does not refuse resolve.
        // Liveness is enforced under the issue lock at confirmation, where a
        // dead permit (expired, or its bound run terminal/cancelled before
        // claim) is finalized before a fresh permit is minted. The projected
        // pendingPermitStatus precondition still blocks a second live handle.
        return {
          payload: { ...p },
          readback: {
            issue: await projectIssue(ctx, issue),
            effects: [
              'Authorize exactly one remediation run on this issue for its current assignee; the run is bound before it can be claimed.',
              'The exhausted recovery marker, failed/refused run history, and all ordinary run gates remain in force; no automatic continuation is created.',
            ],
          },
          preconditions: markerPreconditions(issue),
        };
      },
    };
  }

  async function currentReceipt(ctx: HumanOperationContext, issueId: string, fallback: unknown) {
    const issue = await loadIssue(ctx, issueId);
    const stored = taskRecoveryPermitSchema.safeParse(recoveryMarker(issue).remediation);
    const receipt = fallback as TaskRecoveryRemediateReceipt | undefined;
    const permit = stored.success ? stored.data : receipt?.permit ?? null;
    const runId = permit?.runId ?? receipt?.runId ?? null;
    const run = runId
      ? await ctx.db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, issue.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    return {
      authorized: true as const,
      permit: permit!,
      runId: runId!,
      wakeupRequestId: permit?.wakeupRequestId ?? receipt?.wakeupRequestId ?? null!,
      runStatus: run?.status ?? 'queued',
      expiresAt: permit?.expiresAt ?? receipt?.expiresAt ?? null!,
    };
  }

  return [
    operation('task_recovery.exhausted.read', taskRecoveryIssueInputSchema, taskRecoveryExhaustedIssueSchema, {
      read: async (ctx, p) => projectIssue(ctx, await loadIssue(ctx, p.issueId as string)),
    }),
    {
      ...operation('task_recovery.remediate', taskRecoveryRemediateInputSchema, taskRecoveryRemediateReceiptSchema, {
        execute: async (ctx, p, actionId) => {
          const companyId = humanCompany(ctx);
          const issue = await loadIssue(ctx, p.issueId as string);
          const marker = recoveryMarker(issue);
          if (marker.status !== 'exhausted') {
            throw conflict('Issue recovery budget is not exhausted; there is nothing to remediate.');
          }
          const assigneeAgentId = issue.assigneeAgentId;
          if (!assigneeAgentId) {
            throw conflict('Issue has no assignee agent to run the remediation.');
          }
          const [assignee] = await ctx.db
            .select({ id: agents.id, status: agents.status, runtimeConfig: agents.runtimeConfig, metadata: agents.metadata })
            .from(agents)
            .where(and(eq(agents.id, assigneeAgentId), eq(agents.companyId, companyId)));
          if (!assignee || assignee.status === 'paused' || assignee.status === 'terminated' || assignee.status === 'pending_approval') {
            throw conflict('Issue assignee agent is not invokable in its current state.');
          }
          // AgentDash (wake policy): the permit run is created directly, past
          // the heartbeat guard, and is not an issue assignment — so a
          // board_assignment_only agent refuses it here, before anything is
          // written. Reassigning the issue is that agent's only way to start.
          if (isBoardAssignmentOnlyAgent(assignee)) {
            throw conflict('This agent only starts runs when a board member assigns it an issue; reassign the issue instead of remediating it.');
          }

          const now = new Date();
          // AgentDash (GH #891): which transport confirmed it. Attribution is
          // the authenticated user either way; neither is consent evidence.
          const authorizedVia = ctx.req.actor.source === 'session' ? 'session' as const : 'board_key' as const;

          // AgentDash (review F1): an earlier authorized permit may be dead —
          // expired, or its bound run cancelled/terminal before it could be
          // claimed. Finalize it under the same issue lock and record the
          // supersession so this confirmation can mint a fresh permit; a LIVE
          // permit still refuses.
          const storedPermit = taskRecoveryPermitSchema.safeParse(marker.remediation);
          if (storedPermit.success && storedPermit.data.status === 'authorized') {
            const previous = storedPermit.data;
            const expired = Number.isNaN(Date.parse(previous.expiresAt)) || Date.parse(previous.expiresAt) <= now.getTime();
            const boundRun = await ctx.db
              .select({ status: heartbeatRuns.status })
              .from(heartbeatRuns)
              .where(and(eq(heartbeatRuns.id, previous.runId), eq(heartbeatRuns.companyId, companyId)))
              .then((rows) => rows[0] ?? null);
            // queued/scheduled_retry can still be claimed; running means the
            // claim transaction has it and the consume CAS is deciding — both
            // are live. Anything else (or a missing row) can never claim.
            const runLive = boundRun && (boundRun.status === 'queued' || boundRun.status === 'scheduled_retry' || boundRun.status === 'running');
            const runDead = !runLive;
            if (!expired && !runDead) {
              throw conflict('A task-recovery permit is already authorized for this issue; its run is bound and cannot be duplicated.');
            }
            const terminal = expired
              ? { status: 'expired', expiredAt: now.toISOString(), denialReason: 'permit expired before its bound run was claimed' }
              : { status: 'denied', deniedAt: now.toISOString(), denialReason: 'bound run ended before claiming the permit' };
            await ctx.db
              .update(issues)
              .set({
                executionState: sql`jsonb_set(coalesce(${issues.executionState}, '{}'::jsonb), '{recoveryBudget,remediation}', ${JSON.stringify({ ...previous, ...terminal })}::jsonb)`,
                updatedAt: now,
              })
              .where(and(
                eq(issues.id, issue.id),
                sql`${issues.executionState} -> 'recoveryBudget' -> 'remediation' ->> 'status' = 'authorized'`,
                sql`${issues.executionState} -> 'recoveryBudget' -> 'remediation' ->> 'runId' = ${previous.runId}`,
              ));
            ctx.acceptance!.publications.push(await insertActivity(ctx.acceptance!.executor, {
              companyId,
              actorType: 'user',
              actorId: ctx.req.actor.userId!,
              agentId: previous.assigneeAgentId,
              runId: previous.runId,
              action: 'issue.task_recovery_permit_superseded',
              entityType: 'issue',
              entityId: issue.id,
              details: {
                previousRunId: previous.runId,
                previousActionHandleId: previous.actionHandleId ?? null,
                terminalStatus: terminal.status,
                denialReason: terminal.denialReason,
              },
            }, ctx.beforeWrite));
          }

          const expiresInMinutes = typeof p.expiresInMinutes === 'number' ? p.expiresInMinutes : TASK_RECOVERY_PERMIT_DEFAULT_TTL_MINUTES;
          const expiresAt = new Date(now.getTime() + expiresInMinutes * 60_000);
          const outcomeCriteria = typeof p.outcomeCriteria === 'string' && p.outcomeCriteria.trim()
            ? p.outcomeCriteria.trim()
            : null;

          // The run and its wake row are created inside THIS transaction, so
          // the permit written below and the exact bound run commit or roll
          // back together. Dispatch only ever happens after commit.
          const { wakeupRequest, run } = await heartbeat.enqueueTaskRecoveryPermitRun(ctx.db, {
            companyId,
            issueId: issue.id,
            agentId: assigneeAgentId,
            requestedByUserId: ctx.req.actor.userId!,
            idempotencyKey: `task-recovery-permit:${actionId}`,
            projectId: issue.projectId,
            outcomeCriteria,
          });

          const permit: TaskRecoveryPermit = {
            kind: 'task_recovery_permit',
            version: 1,
            status: 'authorized',
            issueId: issue.id,
            companyId,
            runId: run.id,
            wakeupRequestId: wakeupRequest.id,
            assigneeAgentId,
            issueUpdatedAt: issue.updatedAt.toISOString(),
            exhaustedAt: typeof marker.exhaustedAt === 'string' ? marker.exhaustedAt : null,
            sourceRunId: typeof marker.sourceRunId === 'string' ? marker.sourceRunId : null,
            refusedRunId: typeof marker.refusedRunId === 'string' ? marker.refusedRunId : null,
            exhaustedBy: Array.isArray(marker.exhaustedBy)
              ? marker.exhaustedBy.filter((value): value is string => typeof value === 'string')
              : [],
            authorizedByUserId: ctx.req.actor.userId!,
            actionHandleId: actionId,
            authorizedVia,
            authorizedAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
            outcomeCriteria,
          };

          // Atomic authorization: the marker must still read exhausted, the
          // pinned assignee must still hold, and no other authorized permit
          // may exist. Zero rows means the confirmation is refused and every
          // write above rolls back with it.
          const [updated] = await ctx.db
            .update(issues)
            .set({
              executionState: sql`jsonb_set(coalesce(${issues.executionState}, '{}'::jsonb), '{recoveryBudget,remediation}', ${JSON.stringify(permit)}::jsonb)`,
              updatedAt: now,
            })
            .where(and(
              eq(issues.id, issue.id),
              eq(issues.companyId, companyId),
              eq(issues.assigneeAgentId, assigneeAgentId),
              sql`${issues.executionState} -> 'recoveryBudget' ->> 'status' = 'exhausted'`,
              sql`coalesce(${issues.executionState} -> 'recoveryBudget' -> 'remediation' ->> 'status', '') <> 'authorized'`,
            ))
            .returning({ id: issues.id });
          if (!updated) {
            throw conflict('The exhausted recovery marker changed before this confirmation committed; prepare again against the current marker.');
          }

          ctx.acceptance!.publications.push(await insertActivity(ctx.acceptance!.executor, {
            companyId,
            actorType: 'user',
            actorId: ctx.req.actor.userId!,
            agentId: assigneeAgentId,
            runId: run.id,
            action: 'issue.task_recovery_authorized',
            entityType: 'issue',
            entityId: issue.id,
            details: {
              runId: run.id,
              wakeupRequestId: wakeupRequest.id,
              actionHandleId: actionId,
              grantedVia: authorizedVia, // key must not contain "auth" (activity redaction)
              expiresAt: permit.expiresAt,
              sourceRunId: permit.sourceRunId,
              refusedRunId: permit.refusedRunId,
              outcomeCriteria,
            },
          }, ctx.beforeWrite));

          return {
            authorized: true as const,
            permit,
            runId: run.id,
            wakeupRequestId: wakeupRequest.id,
            runStatus: 'queued',
            expiresAt: permit.expiresAt,
          };
        },
        afterCommit: async (ctx, _p, value) => {
          const receipt = value as TaskRecoveryRemediateReceipt;
          // Dispatch is deliberately post-commit: the claim path consumes the
          // permit, and a rolled-back transaction must never have dispatched.
          await heartbeat.dispatchQueuedRunsForAgent(receipt.permit.assigneeAgentId);
          return value;
        },
      }),
      recoveryReference: (value) => ({ issueId: (value as TaskRecoveryRemediateReceipt).permit.issueId }),
      async authorizeRecovery(ctx, p, reference) {
        const issue = await loadIssue(ctx, p.issueId as string);
        if (reference.issueId !== issue.id) return null;
        return { issueId: issue.id } satisfies HumanRecoveryReference;
      },
      async currentOutput(ctx, p, value) {
        return currentReceipt(ctx, p.issueId as string, value);
      },
    },
  ];
}
