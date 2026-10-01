// AgentDash: the named-human task-recovery permit is the ONLY way past a
// persisted exhausted recoveryBudget marker. These tests prove the marker
// holds against every ordinary/forged wake source, that confirm mints exactly
// one bound permit + queued run, and that consumption is exact and terminal.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentDashServer } from '../../../packages/mcp-server/src/index.js';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { activityLog, agentApiKeys, agents, agentWakeupRequests, authUsers, boardApiKeys, companies, companyMemberships, createDb, heartbeatRuns, issues, issueTreeHolds, projects } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { hashBearerToken } from '../services/board-auth.js';
import { heartbeatService } from '../services/heartbeat.ts';
import { issueService, withLockedRecoveryBudget } from '../services/issues.ts';
import { clearIssueRecoveryBudget } from '../services/issue-recovery-budget.ts';
import { applyIssueExecutionPolicyTransition } from '../services/issue-execution-policy.ts';
import { preserveIssueRecoveryBudget } from '@paperclipai/shared';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: 'done', provider: 'test', model: 'test' })),
);

vi.mock('../adapters/index.ts', async () => {
  const actual = await vi.importActual<typeof import('../adapters/index.ts')>('../adapters/index.ts');
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping task-recovery permit tests: ${embeddedPostgresSupport.reason ?? 'unsupported environment'}`);
}

describeEmbeddedPostgres('task recovery permit (named-human prepare/confirm)', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let server: Server | undefined;
  let base: string;
  // 'hold' keeps afterCommit dispatch a no-op (bound run stays queued);
  // 'throw' simulates a crash between the mint commit and dispatch.
  let suppressDispatch: 'off' | 'hold' | 'throw' = 'off';

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('task-recovery-');
    db = createDb(temp.connectionString);
    heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const gatedHeartbeat = {
      ...heartbeat,
      dispatchQueuedRunsForAgent: async (agentId: string) => {
        if (suppressDispatch === 'throw') throw new Error('simulated post-commit dispatch crash');
        if (suppressDispatch === 'hold') return [];
        return heartbeat.dispatchQueuedRunsForAgent(agentId);
      },
    };
    const bridge = await import('../routes/human-control.js');
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: 'local_trusted' }));
    app.use('/api/human-control', bridge.humanControlRoutes(db, { heartbeat: gatedHeartbeat }));
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server!.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/human-control`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await temp?.cleanup();
  });

  async function human(role = 'admin') {
    const userId = randomUUID(), token = `pcp_board_${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: 'Named human', email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    const [key] = await db.insert(boardApiKeys).values({ userId, name: 'Human harness', keyHash: hashBearerToken(token), expiresAt: new Date(Date.now() + 60000) }).returning();
    const [company] = await db.insert(companies).values({ name: 'Recovery company', issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: userId, membershipRole: role, status: 'active' });
    return { userId, token, key, company, target: { kind: 'company' as const, companyId: company.id } };
  }

  async function call(token: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  // A persisted exhausted marker on an assigned issue, with the refused run
  // and a failed prior run as real history rows.
  async function seedExhaustedIssue(h: Awaited<ReturnType<typeof human>>) {
    const agentId = randomUUID(), issueId = randomUUID(), priorRunId = randomUUID(), refusedRunId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId: h.company.id, name: 'Recoverable worker', role: 'engineer', status: 'idle',
      adapterType: 'codex_local', adapterConfig: {}, runtimeConfig: {}, permissions: {}, accountableUserId: h.userId,
    });
    await db.insert(issues).values({
      id: issueId, companyId: h.company.id, title: 'Exhausted task', status: 'blocked', priority: 'medium',
      assigneeAgentId: agentId, issueNumber: 1, identifier: `${h.company.issuePrefix}-1`,
      executionState: {
        recoveryBudget: {
          status: 'exhausted',
          exhaustedBy: ['cost'],
          usage: { automaticRetries: 1, providerTurns: 12, providerTokens: 500_000, providerCostUsd: 0.25, runtimeMs: 300_000 },
          limits: { automaticRetries: 1, providerTurns: 12, providerTokens: 500_000, providerCostUsd: 0.25, runtimeMs: 300_000 },
          exhaustedAt: '2026-03-20T00:00:00.000Z',
          sourceRunId: priorRunId,
          refusedRunId,
        },
      },
    });
    await db.insert(heartbeatRuns).values({
      id: priorRunId, companyId: h.company.id, agentId, invocationSource: 'automation', triggerDetail: 'system',
      status: 'failed', contextSnapshot: { issueId, taskId: issueId }, errorCode: 'adapter_failed', finishedAt: new Date('2026-03-19T00:00:03.000Z'),
    });
    await db.insert(heartbeatRuns).values({
      id: refusedRunId, companyId: h.company.id, agentId, invocationSource: 'automation', triggerDetail: 'system',
      status: 'cancelled', contextSnapshot: { issueId, taskId: issueId, retryOfRunId: priorRunId }, retryOfRunId: priorRunId,
      errorCode: 'task_recovery_budget_exhausted', finishedAt: new Date('2026-03-20T00:00:00.000Z'),
    });
    return { agentId, issueId, priorRunId, refusedRunId };
  }

  // wakeup() only enqueues: the exhausted-marker refusal fires when the queue
  // claims the run. Drive dispatch, then re-read the persisted run row.
  async function wakeThenClaim(agentId: string, opts: Parameters<typeof heartbeat.wakeup>[1]) {
    const wake = await heartbeat.wakeup(agentId, opts);
    await heartbeat.dispatchQueuedRunsForAgent(agentId);
    if (!wake) return null;
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.id)))[0] ?? null;
  }

  const op = (target: unknown, operationId: string, input: unknown) => ({ target, operationId, version: 1, input });
  const markerOf = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.executionState as Record<string, unknown> | undefined;
  const runsForIssue = (companyId: string, issueId: string) =>
    db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
    ));

  it('reads exhaustion state, refuses mutation at prepare, and confirm mints exactly one bound permit + queued run', async () => {
    const h = await human();
    const { agentId, issueId, priorRunId, refusedRunId } = await seedExhaustedIssue(h);

    const read = await call(h.token, '/read', op(h.target, 'task_recovery.exhausted.read', { issueId }));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ issueId, exhausted: true, sourceRunId: priorRunId, refusedRunId, pendingPermit: null, assigneeAgentId: agentId });

    const prepared = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId, outcomeCriteria: 'Agent reports one bounded remediation attempt.' }));
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);

    // Preparation is read-only: no run, no wake, no permit, marker untouched.
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, h.company.id))).toHaveLength(0);
    expect((await runsForIssue(h.company.id, issueId)).filter((r) => !['failed', 'cancelled'].includes(r.status))).toHaveLength(0);
    const markerBefore = await markerOf(issueId);
    expect((markerBefore?.recoveryBudget as Record<string, unknown>)?.remediation).toBeUndefined();

    const confirmed = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const receipt = confirmed.body.result;
    expect(receipt.authorized).toBe(true);
    expect(receipt.permit.status).toBe('consumed'); // dispatch is post-commit; the claim consumes it
    expect(receipt.permit.runId).toBe(receipt.runId);
    expect(receipt.permit.authorizedByUserId).toBe(h.userId);
    expect(receipt.permit.refusedRunId).toBe(refusedRunId);
    expect(receipt.permit.sourceRunId).toBe(priorRunId);

    // Exactly one wake + one bound run; the wake attributes the named human.
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, h.company.id));
    expect(wakes).toHaveLength(1);
    expect(wakes[0].runId).toBe(receipt.runId);
    expect(wakes[0].requestedByActorType).toBe('user');
    expect(wakes[0].requestedByActorId).toBe(h.userId);
    const boundRun = (await runsForIssue(h.company.id, issueId)).find((r) => r.id === receipt.runId)!;
    expect(boundRun.status).toBe('running'); // claimed by post-commit dispatch (autoDispatch=false => no execution)
    expect(boundRun.contextSnapshot).toMatchObject({ issueId, taskRecoveryPermit: true });
    expect(boundRun.retryOfRunId).toBeNull();
    expect(boundRun.contextSnapshot?.retryOfRunId).toBeUndefined();

    // The exhaustion marker is retained; only remediation.status moved.
    expect(await markerOf(issueId)).toMatchObject({
      recoveryBudget: {
        status: 'exhausted', refusedRunId, sourceRunId: priorRunId,
        remediation: { status: 'consumed', runId: receipt.runId, actionHandleId: confirmed.body.actionId },
      },
    });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe('blocked');

    // Attribution lands in the activity log.
    const authorized = await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_authorized')));
    expect(authorized).toHaveLength(1);
    expect(authorized[0].actorType).toBe('user');
    expect(authorized[0].actorId).toBe(h.userId);
    const consumed = await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_consumed')));
    expect(consumed).toHaveLength(1);
  });

  it.each([
    ['automation', 'system'],
    ['timer', 'system'],
    ['on_demand', 'manual'],
  ] as const)('holds the persisted exhausted marker against %s wakes and forged permits', async (source, triggerDetail) => {
    const h = await human();
    const { agentId, issueId, priorRunId } = await seedExhaustedIssue(h);

    // Forged context can never mint a permit — remediation is server-owned.
    const forged = await wakeThenClaim(agentId, {
      source: 'on_demand', triggerDetail: 'manual',
      contextSnapshot: { issueId, taskId: issueId, taskRecoveryPermit: true, recoveryPermit: { runId: 'forged' } },
      requestedByActorType: 'user', requestedByActorId: h.userId,
    });
    expect(forged?.status).toBe('cancelled');
    expect(forged?.errorCode).toBe('task_recovery_budget_exhausted');

    // Some wake sources (e.g. timer) never materialize a run at all; any run
    // that does materialize must be refused at claim.
    const wake = await wakeThenClaim(agentId, {
      source, triggerDetail, reason: 'issue_continuation_needed',
      payload: { issueId, retryOfRunId: priorRunId },
      contextSnapshot: { issueId, taskId: issueId, retryOfRunId: priorRunId },
      requestedByActorType: 'system', requestedByActorId: 'heartbeat',
    });
    if (wake) {
      expect(wake.status).toBe('cancelled');
      expect(wake.errorCode).toBe('task_recovery_budget_exhausted');
    }
    expect((await runsForIssue(h.company.id, issueId)).filter((r) => r.status === 'queued' || r.status === 'running')).toHaveLength(0);

    // Even an unlinked manual wake (the historical "remediation window") is
    // refused while a persisted marker stands.
    const manual = await wakeThenClaim(agentId, {
      source: 'on_demand', triggerDetail: 'manual', reason: 'manual remediation attempt',
      contextSnapshot: { issueId, taskId: issueId },
      requestedByActorType: 'user', requestedByActorId: h.userId,
    });
    expect(manual?.status).toBe('cancelled');
    expect(manual?.errorCode).toBe('task_recovery_budget_exhausted');
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted' } });
  });

  it('denies stale revision, changed assignee, revoked membership, wrong actor/target and replay', async () => {
    const h = await human();
    const other = await human();
    const { agentId, issueId } = await seedExhaustedIssue(h);
    const prepare = () => call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));

    const staleRevision = await prepare();
    await db.update(issues).set({ title: 'Renamed after prepare', updatedAt: new Date() }).where(eq(issues.id, issueId));
    expect((await call(h.token, '/confirm', { target: h.target, handle: staleRevision.body.handle })).status).toBe(409);

    const reassigned = await prepare();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId: h.company.id, name: 'Other', role: 'engineer', status: 'idle', adapterType: 'codex_local' });
    await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, issueId));
    expect((await call(h.token, '/confirm', { target: h.target, handle: reassigned.body.handle })).status).toBe(409);
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));

    const revoked = await prepare();
    await db.update(companyMemberships).set({ status: 'inactive' }).where(and(eq(companyMemberships.companyId, h.company.id), eq(companyMemberships.principalId, h.userId)));
    expect((await call(h.token, '/confirm', { target: h.target, handle: revoked.body.handle })).status).toBeGreaterThanOrEqual(400);
    await db.update(companyMemberships).set({ status: 'active' }).where(and(eq(companyMemberships.companyId, h.company.id), eq(companyMemberships.principalId, h.userId)));

    // Wrong key / wrong target can never consume the handle.
    const bound = await prepare();
    expect((await call(other.token, '/confirm', { target: h.target, handle: bound.body.handle })).status).toBe(404);
    expect((await call(h.token, '/confirm', { target: other.target, handle: bound.body.handle })).status).toBe(404);

    const confirmed = await call(h.token, '/confirm', { target: h.target, handle: bound.body.handle });
    expect(confirmed.status).toBe(200);
    expect((await call(h.token, '/confirm', { target: h.target, handle: bound.body.handle })).status).toBe(409); // replay denied

    // One consumed permit and one claimed run — never two.
    const runs = await runsForIssue(h.company.id, issueId);
    expect(runs.filter((r) => r.status === 'running')).toHaveLength(1);
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'consumed' } } });
  });

  it('denies unauthenticated, foreign-company and non-exhausted requests without creating anything', async () => {
    const h = await human();
    const foreign = await human();
    const { issueId } = await seedExhaustedIssue(h);

    expect((await call('', '/prepare', op(h.target, 'task_recovery.remediate', { issueId }))).status).toBeGreaterThanOrEqual(400);
    // A foreign member has no access to this company at all (403); a foreign
    // issueId under their own target resolves to nothing (404).
    expect((await call(foreign.token, '/read', op(h.target, 'task_recovery.exhausted.read', { issueId }))).status).toBe(403);
    expect((await call(foreign.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }))).status).toBe(403);
    expect((await call(foreign.token, '/prepare', op(foreign.target, 'task_recovery.remediate', { issueId }))).status).toBe(404);

    const healthyIssueId = randomUUID();
    await db.insert(issues).values({ id: healthyIssueId, companyId: h.company.id, title: 'Healthy', status: 'todo', priority: 'medium', issueNumber: 2, identifier: `${h.company.issuePrefix}-2` });
    expect((await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId: healthyIssueId }))).status).toBe(409);

    expect((await runsForIssue(h.company.id, issueId)).filter((r) => !['failed', 'cancelled'].includes(r.status))).toHaveLength(0);
  });

  it('a queued sibling run on the same issue is refused while the bound run consumes the permit', async () => {
    const h = await human();
    const { agentId, issueId } = await seedExhaustedIssue(h);

    const prepared = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
    const confirmed = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
    expect(confirmed.status).toBe(200);
    const permitRunId = confirmed.body.result.runId;

    // A queued run bound to the same issue can never consume the permit.
    const siblingId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: siblingId, companyId: h.company.id, agentId, invocationSource: 'automation', triggerDetail: 'system',
      status: 'queued', contextSnapshot: { issueId, taskId: issueId },
    });
    await heartbeat.dispatchQueuedRunsForAgent(agentId);
    const sibling = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, siblingId)))[0];
    expect(sibling.status).toBe('cancelled');
    expect(sibling.errorCode).toBe('task_recovery_budget_exhausted');
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'consumed', runId: permitRunId } } });
  });

  it('an unclaimed bound run with an expired permit is cancelled, not run', async () => {
    const h = await human();
    const { agentId, issueId } = await seedExhaustedIssue(h);

    const prepared = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId, expiresInMinutes: 1 }));
    const confirmed = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
    expect(confirmed.status).toBe(200);
    const permitRunId = confirmed.body.result.runId;

    // Rewind the run to queued and the permit to authorized-but-expired; the
    // next claim must refuse and record honest expiry evidence.
    const marker = (await markerOf(issueId))!;
    const permit = (marker.recoveryBudget as Record<string, unknown>).remediation as Record<string, unknown>;
    await db.update(heartbeatRuns).set({ status: 'queued', startedAt: null }).where(eq(heartbeatRuns.id, permitRunId));
    await db.update(issues).set({
      executionState: {
        ...marker,
        recoveryBudget: {
          ...(marker.recoveryBudget as Record<string, unknown>),
          remediation: { ...permit, status: 'authorized', expiresAt: new Date(Date.now() - 1000).toISOString(), consumedAt: null },
        },
      },
    }).where(eq(issues.id, issueId));

    await heartbeat.dispatchQueuedRunsForAgent(agentId);
    const run = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, permitRunId)))[0];
    expect(run.status).toBe('cancelled');
    expect(run.errorCode).toBe('task_recovery_budget_exhausted');
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'expired' } } });
  });

  it('a failed permitted run creates no automatic continuation and the marker stays', async () => {
    const h = await human();
    const { agentId, issueId } = await seedExhaustedIssue(h);

    const prepared = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
    const confirmed = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
    const permitRunId = confirmed.body.result.runId;

    // The one permitted run fails. Nothing may continue automatically.
    await db.update(heartbeatRuns).set({ status: 'failed', errorCode: 'adapter_failed', finishedAt: new Date() }).where(eq(heartbeatRuns.id, permitRunId));
    const retry = await wakeThenClaim(agentId, {
      source: 'automation', triggerDetail: 'system', reason: 'issue_continuation_needed',
      payload: { issueId, retryOfRunId: permitRunId },
      contextSnapshot: { issueId, taskId: issueId, retryOfRunId: permitRunId },
      requestedByActorType: 'system', requestedByActorId: 'heartbeat',
    });
    expect(retry?.status).toBe('cancelled');
    expect(retry?.errorCode).toBe('task_recovery_budget_exhausted');
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'consumed', runId: permitRunId } } });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe('blocked');
    // No live continuation remains; original refused/failed history rows are untouched.
    const live = (await runsForIssue(h.company.id, issueId)).filter((r) => r.status === 'queued' || r.status === 'running');
    expect(live).toHaveLength(0);
  });

  it.each(['pause', 'hold', 'cancel'] as const)(
    'a dead authorized permit (cancel-before-claim via %s) is finalized and a fresh prepare/confirm mints a new bound run',
    async (variant) => {
      const h = await human();
      const { agentId, issueId } = await seedExhaustedIssue(h);

      suppressDispatch = 'hold';
      let runA = '';
      try {
        const prepared = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
        const confirmed = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
        expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
        runA = confirmed.body.result.runId;

        // Nothing claimed: the permit stays authorized, the run stays queued,
        // and no consumption evidence exists (review F2).
        expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { remediation: { status: 'authorized', runId: runA } } });
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runA)))[0].status).toBe('queued');
        expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_consumed')))).toHaveLength(0);

        if (variant === 'pause') {
          // A paused agent is skipped by the dispatcher; the stranded queued
          // run is then cancelled by the board before it can ever be claimed.
          await db.update(agents).set({ status: 'paused' }).where(eq(agents.id, agentId));
          await heartbeat.dispatchQueuedRunsForAgent(agentId);
          await heartbeat.cancelRun(runA);
          await db.update(agents).set({ status: 'idle' }).where(eq(agents.id, agentId));
        } else if (variant === 'hold') {
          const [hold] = await db.insert(issueTreeHolds).values({
            companyId: h.company.id, rootIssueId: issueId, mode: 'pause', status: 'active',
            reason: 'pause recovery subtree', releasePolicy: { strategy: 'manual' },
          }).returning();
          // The claim's hold gate refuses the run BEFORE the permit CAS.
          await heartbeat.dispatchQueuedRunsForAgent(agentId);
          await db.delete(issueTreeHolds).where(eq(issueTreeHolds.id, hold.id));
        } else {
          await heartbeat.cancelRun(runA);
        }

        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runA)))[0].status).toBe('cancelled');
        if (variant === 'hold') {
          // GH #891: a start check inside the claim path refused the bound
          // run, so the system finalizes the permit as denied right away —
          // the issue page no longer says a run is waiting to start.
          expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'denied', runId: runA } } });
          const denied = await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_denied')));
          expect(denied).toHaveLength(1);
          expect(denied[0]).toMatchObject({ actorType: 'system', actorId: 'system' });
        } else {
          // Cancelled outside the claim path: dead but truthful — still
          // authorized until a fresh confirm finalizes it.
          expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'authorized', runId: runA } } });
        }
        expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_consumed')))).toHaveLength(0);
      } finally {
        suppressDispatch = 'off';
      }

      // Fresh prepare/confirm finalizes the dead permit and mints a new one.
      const prepared2 = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
      expect(prepared2.status, JSON.stringify(prepared2.body)).toBe(200);
      const confirmed2 = await call(h.token, '/confirm', { target: h.target, handle: prepared2.body.handle });
      expect(confirmed2.status, JSON.stringify(confirmed2.body)).toBe(200);
      const runB = confirmed2.body.result.runId as string;
      expect(runB).not.toBe(runA);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runB)))[0].status).toBe('running');
      expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'consumed', runId: runB } } });

      const superseded = await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_superseded')));
      // An already-denied permit needs no supersession; a dead authorized one does.
      if (variant === 'hold') {
        expect(superseded).toHaveLength(0);
      } else {
        expect(superseded).toHaveLength(1);
        expect(superseded[0].details).toMatchObject({ previousRunId: runA });
      }
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_consumed')))).toHaveLength(1);
    },
  );

  it('two handles confirmed concurrently mint exactly one permit and one bound run', async () => {
    const h = await human();
    const { agentId, issueId } = await seedExhaustedIssue(h);
    const [p1, p2] = await Promise.all([
      call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId })),
      call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId })),
    ]);
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);

    const results = await Promise.all([
      call(h.token, '/confirm', { target: h.target, handle: p1.body.handle }),
      call(h.token, '/confirm', { target: h.target, handle: p2.body.handle }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    const permitted = (await runsForIssue(h.company.id, issueId)).filter((r) => r.contextSnapshot?.taskRecoveryPermit === true);
    expect(permitted).toHaveLength(1);
    expect(permitted[0].status).toBe('running');
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'consumed', runId: permitted[0].id } } });
  });

  it('a post-commit dispatch crash leaves a recovery_required handle and one authorized permit; a later dispatch consumes it', async () => {
    const h = await human();
    const { agentId, issueId } = await seedExhaustedIssue(h);

    const prepared = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
    expect(prepared.status).toBe(200);
    suppressDispatch = 'throw';
    let confirmed: Awaited<ReturnType<typeof call>>;
    try {
      confirmed = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
    } finally {
      suppressDispatch = 'off';
    }

    // Uncertain outcome: the handle reports recovery_required and points at
    // the canonical issue for readback — it must not be replayed blindly.
    expect(confirmed.status).toBe(409);
    expect(confirmed.body.details?.status).toBe('recovery_required');
    expect(confirmed.body.details?.result?.reference?.issueId).toBe(issueId);

    // Exactly one permit + one queued run exist; nothing consumed yet.
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'authorized' } } });
    const bound = (await runsForIssue(h.company.id, issueId)).filter((r) => r.contextSnapshot?.taskRecoveryPermit === true);
    expect(bound).toHaveLength(1);
    expect(bound[0].status).toBe('queued');
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_consumed')))).toHaveLength(0);

    // Replaying the same handle creates nothing new.
    expect((await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle })).status).toBe(409);
    expect((await runsForIssue(h.company.id, issueId)).filter((r) => r.contextSnapshot?.taskRecoveryPermit === true)).toHaveLength(1);

    // Recovery path: a plain queue dispatch claims the bound run and consumes
    // the permit — no second run is ever created.
    await heartbeat.dispatchQueuedRunsForAgent(agentId);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, bound[0].id)))[0].status).toBe('running');
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'consumed', runId: bound[0].id } } });
  });

  it('a claim that loses the queued->running CAS denies the permit — never a consumed receipt', async () => {
    const h = await human();
    const { agentId, issueId } = await seedExhaustedIssue(h);

    suppressDispatch = 'hold';
    let runId = '';
    try {
      const prepared = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
      const confirmed = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      runId = confirmed.body.result.runId;
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].status).toBe('queued');
      expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { remediation: { status: 'authorized', runId } } });
    } finally {
      suppressDispatch = 'off';
    }

    // Hold the company row lock the claim transaction acquires first. Fire a
    // real board cancel while the claim is parked behind it — do NOT await it:
    // cancelRunInternal's trailing startNextQueuedRunForAgent blocks on this
    // same lock and would deadlock. Its run-status write commits early and is
    // polled visible before we release the lock, so the consume CAS inside the
    // claim tx runs first and the queued->running CAS must lose.
    let claiming: Promise<unknown> | null = null;
    let cancelling: Promise<unknown> | null = null;
    await db.transaction(async (tx) => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, h.company.id)).for('no key update');
      claiming = heartbeat.executeRun(runId); // queued -> claimQueuedRun -> blocks on the company lock
      await new Promise((r) => setTimeout(r, 500)); // let the claim reach the lock
      cancelling = heartbeat.cancelRun(runId); // do NOT await: its trailing dispatch needs this lock
      for (let i = 0; i < 200; i++) {
        const row = (await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
        if (row?.status === 'cancelled') break;
        await new Promise((r) => setTimeout(r, 25));
      }
    });
    await Promise.all([claiming, cancelling]); // both settle once the lock releases

    const run = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    expect(run.status).toBe('cancelled');
    // The marker records an honest denial — never "consumed" — and the
    // activity log carries a denied row with NO consumed row.
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'denied', runId } } });
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_consumed')))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_denied')))).toHaveLength(1);

    // The finalized permit does not block a fresh prepare/confirm.
    const prepared2 = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
    const confirmed2 = await call(h.token, '/confirm', { target: h.target, handle: prepared2.body.handle });
    expect(confirmed2.status, JSON.stringify(confirmed2.body)).toBe(200);
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'consumed' } } });
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_consumed')))).toHaveLength(1);
  });

  it('an expired authorized permit with a queued bound run is superseded by a fresh confirm', async () => {
    const h = await human();
    const { agentId, issueId } = await seedExhaustedIssue(h);

    suppressDispatch = 'hold';
    let runA = '';
    try {
      const prepared = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId, expiresInMinutes: 1 }));
      const confirmed = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      runA = confirmed.body.result.runId;
      expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { remediation: { status: 'authorized', runId: runA } } });
    } finally {
      suppressDispatch = 'off';
    }

    // The permit expires while its bound run is still queued.
    const marker = (await markerOf(issueId))!;
    const budget = marker.recoveryBudget as Record<string, unknown>;
    const permit = budget.remediation as Record<string, unknown>;
    await db.update(issues).set({
      executionState: { ...marker, recoveryBudget: { ...budget, remediation: { ...permit, expiresAt: new Date(Date.now() - 1000).toISOString() } } },
    }).where(eq(issues.id, issueId));

    // Fresh confirm: expired permit is finalized ('expired') and a new bound
    // run mints in the same transaction.
    const prepared2 = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
    expect(prepared2.status, JSON.stringify(prepared2.body)).toBe(200);
    const confirmed2 = await call(h.token, '/confirm', { target: h.target, handle: prepared2.body.handle });
    expect(confirmed2.status, JSON.stringify(confirmed2.body)).toBe(200);
    const runB = confirmed2.body.result.runId as string;
    expect(runB).not.toBe(runA);

    // Post-commit dispatch claims runA first (older): refused by the marker —
    // the remediation now binds runB — then runB claims and consumes.
    const superseded = await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_superseded')));
    expect(superseded).toHaveLength(1);
    expect(superseded[0].details).toMatchObject({ previousRunId: runA, terminalStatus: 'expired' });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runA)))[0].status).toBe('cancelled');
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runB)))[0].status).toBe('running');
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'consumed', runId: runB } } });
  });

  it('denies agent keys, assistant grants, implicit operators, expired/revoked keys, inactive members and restricted projects', async () => {
    const h = await human();
    const { agentId, issueId } = await seedExhaustedIssue(h);
    const body = () => op(h.target, 'task_recovery.remediate', { issueId });
    const denied = (status: number) => { expect(status).toBeGreaterThanOrEqual(400); expect(status).toBeLessThan(500); };

    // Agent API key: a real agent credential, never a named human.
    const agentToken = `pcp_agent_${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      agentId, companyId: h.company.id, name: 'agent key',
      keyHash: createHash('sha256').update(agentToken).digest('hex'),
    });
    denied((await call(agentToken, '/prepare', body())).status);
    denied((await call(agentToken, '/read', op(h.target, 'task_recovery.exhausted.read', { issueId }))).status);

    // Assistant-grant token: an unresolved grant credential is not a board key.
    denied((await call(`pcpa_${randomUUID()}`, '/prepare', body())).status);

    // Implicit local operator: no Authorization header at all — the harness
    // mints an implicit board actor with no verified board credential.
    const implicit = await fetch(`${base}/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()),
    });
    denied(implicit.status);

    // Expired and revoked board keys resolve to no actor at all.
    const expiredToken = `pcp_board_${randomUUID()}`;
    await db.insert(boardApiKeys).values({ userId: h.userId, name: 'expired', keyHash: hashBearerToken(expiredToken), expiresAt: new Date(Date.now() - 60_000) });
    denied((await call(expiredToken, '/prepare', body())).status);
    const revokedToken = `pcp_board_${randomUUID()}`;
    await db.insert(boardApiKeys).values({ userId: h.userId, name: 'revoked', keyHash: hashBearerToken(revokedToken), expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() });
    denied((await call(revokedToken, '/prepare', body())).status);

    // Inactive membership denies even at prepare.
    await db.update(companyMemberships).set({ status: 'inactive' }).where(and(eq(companyMemberships.companyId, h.company.id), eq(companyMemberships.principalId, h.userId)));
    expect((await call(h.token, '/prepare', body())).status).toBe(403);
    await db.update(companyMemberships).set({ status: 'active' }).where(and(eq(companyMemberships.companyId, h.company.id), eq(companyMemberships.principalId, h.userId)));

    // Restricted project the member cannot see: invisible means 404.
    const member = await human('member');
    const restricted = await seedExhaustedIssue(member);
    const [project] = await db.insert(projects).values({
      companyId: member.company.id, name: `restricted-${randomUUID().slice(0, 8)}`,
      visibility: 'restricted', createdByUserId: 'someone-else',
    }).returning();
    await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, restricted.issueId));
    expect((await call(member.token, '/prepare', op(member.target, 'task_recovery.remediate', { issueId: restricted.issueId }))).status).toBe(404);

    // Nothing was ever created for the denied attempts.
    expect((await runsForIssue(h.company.id, issueId)).filter((r) => !['failed', 'cancelled'].includes(r.status))).toHaveLength(0);
    expect(((await markerOf(issueId))?.recoveryBudget as Record<string, unknown> | undefined)?.remediation).toBeUndefined();
  });

  it('a stale plan-phase executionState write cannot erase a live permit (write-time merge under lock)', async () => {
    const h = await human();
    const { agentId, issueId } = await seedExhaustedIssue(h);

    // Plan phase reads BEFORE the permit exists — the classic lost-update setup.
    const staleRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    const staleNextState = { ...(staleRow.executionState as Record<string, unknown>), status: 'pending', workflowMarker: 'stale-plan' };

    suppressDispatch = 'hold';
    try {
      const prepared = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
      const confirmed = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
      expect(confirmed.status).toBe(200);
      const runId = confirmed.body.result.runId;
      expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { remediation: { status: 'authorized', runId } } });

      // Canonical write applies the stale whole-object patch: the locked
      // row's recoveryBudget (with the live permit) must be merged back in.
      const svc = issueService(db);
      await svc.update(issueId, { executionState: staleNextState });
      expect(await markerOf(issueId)).toMatchObject({
        status: 'pending',
        workflowMarker: 'stale-plan',
        recoveryBudget: { status: 'exhausted', remediation: { status: 'authorized', runId } },
      });
    } finally {
      suppressDispatch = 'off';
    }

    await heartbeat.dispatchQueuedRunsForAgent(agentId);
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'consumed' } } });
  });

  it('a permitted run failing through the real execute/finalize path spawns no live continuation', async () => {
    const h = await human();
    const { agentId, issueId } = await seedExhaustedIssue(h);

    const prepared = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
    const confirmed = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
    expect(confirmed.status).toBe(200);
    const runId = confirmed.body.result.runId;
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].status).toBe('running');

    // Drive the real execution path: the adapter reports failure, the real
    // finalize logic runs (including any bounded-retry policy it applies).
    mockAdapterExecute.mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false, errorMessage: 'adapter exploded', summary: null, provider: 'test', model: 'test' });
    await heartbeat.executeRun(runId);
    const failed = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    expect(['failed', 'cancelled']).toContain(failed.status);

    // Any continuation the finalize armed (scheduled_retry / queued) must be
    // refused by the retained exhausted marker when it tries to claim.
    await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 3_600_000));
    await heartbeat.dispatchQueuedRunsForAgent(agentId);
    const live = (await runsForIssue(h.company.id, issueId)).filter((r) => r.status === 'queued' || r.status === 'running' || r.status === 'scheduled_retry');
    expect(live).toHaveLength(0);
    expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'consumed', runId } } });
  });

  // Rule: confirm and claim take the company row FOR NO KEY UPDATE first, then
  // the issue row, so a confirm racing the bound run's claim serializes on
  // the company mutex instead of deadlocking (no 40P01), and never yields a
  // second permit or run. Both arrival orders are exercised.
  for (const order of ['claim-first', 'confirm-first'] as const) {
    it(`a confirm racing the bound run's claim (${order}) serializes: one consumption, the confirm is refused, no deadlock`, async () => {
      const h = await human();
      const { issueId } = await seedExhaustedIssue(h);

      suppressDispatch = 'hold';
      let runId = '';
      let preparedB: Awaited<ReturnType<typeof call>>;
      try {
        const preparedA = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
        const confirmedA = await call(h.token, '/confirm', { target: h.target, handle: preparedA.body.handle });
        expect(confirmedA.status, JSON.stringify(confirmedA.body)).toBe(200);
        runId = confirmedA.body.result.runId;
        // A second handle prepared against the live authorized permit.
        preparedB = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
        expect(preparedB.status, JSON.stringify(preparedB.body)).toBe(200);
      } finally {
        suppressDispatch = 'off';
      }

      let claiming: Promise<unknown> | null = null;
      let confirming: Promise<Awaited<ReturnType<typeof call>>> | null = null;
      await db.transaction(async (tx) => {
        await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, h.company.id)).for('no key update');
        const startClaim = () => { claiming = heartbeat.executeRun(runId); };
        const startConfirm = () => { confirming = call(h.token, '/confirm', { target: h.target, handle: preparedB.body.handle }); };
        if (order === 'claim-first') { startClaim(); await new Promise((r) => setTimeout(r, 300)); startConfirm(); }
        else { startConfirm(); await new Promise((r) => setTimeout(r, 300)); startClaim(); }
        await new Promise((r) => setTimeout(r, 300)); // both parked behind the company mutex
      });
      const [, confirmedB] = await Promise.all([claiming, confirming!]);

      // The confirm is refused as a conflict (stale preconditions or a live
      // permit), never a deadlock or server error.
      expect(confirmedB.status, JSON.stringify(confirmedB.body)).toBe(409);
      expect(JSON.stringify(confirmedB.body)).not.toMatch(/deadlock|40P01/i);

      const bound = (await runsForIssue(h.company.id, issueId)).filter((r) => r.contextSnapshot?.taskRecoveryPermit === true);
      expect(bound.map((r) => r.id)).toEqual([runId]);
      expect(['running', 'succeeded']).toContain(bound[0].status);
      expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'consumed', runId } } });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_consumed')))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_authorized')))).toHaveLength(1);
    });
  }

  it('the explicit clear finalizes a live permit as denied and cancels its bound run before removing the marker', async () => {
    const h = await human();
    const { agentId, issueId } = await seedExhaustedIssue(h);

    suppressDispatch = 'hold';
    let runId = '';
    try {
      const prepared = await call(h.token, '/prepare', op(h.target, 'task_recovery.remediate', { issueId }));
      const confirmed = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      runId = confirmed.body.result.runId;
    } finally {
      suppressDispatch = 'off';
    }

    const cleared = await clearIssueRecoveryBudget(db, { companyId: h.company.id, issueId, actorUserId: h.userId, trigger: 'explicit_action' });
    expect(cleared).not.toBeNull();
    const state = await markerOf(issueId);
    expect(state?.recoveryBudget).toBeUndefined();

    const run = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    expect(run.status).toBe('cancelled');
    expect(run.errorCode).toBe('task_recovery_permit_superseded');
    const denied = await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_denied')));
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ actorType: 'user', actorId: h.userId, runId });
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.recovery_budget_cleared')))).toHaveLength(1);

    // The cancelled bound run can never slip through later as an ordinary wake.
    await heartbeat.dispatchQueuedRunsForAgent(agentId);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].status).toBe('cancelled');
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.task_recovery_permit_consumed')))).toHaveLength(0);
  });

  it('a stale plan-phase write cannot re-add a marker the explicit clear removed', async () => {
    const h = await human();
    const { issueId } = await seedExhaustedIssue(h);
    const staleRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    const staleNextState = { ...(staleRow.executionState as Record<string, unknown>), workflowMarker: 'stale-plan' };

    expect(await clearIssueRecoveryBudget(db, { companyId: h.company.id, issueId, actorUserId: h.userId, trigger: 'explicit_action' })).not.toBeNull();
    await issueService(db).update(issueId, { executionState: staleNextState });
    const state = await markerOf(issueId);
    expect(state).toMatchObject({ workflowMarker: 'stale-plan' });
    expect(state?.recoveryBudget).toBeUndefined();
  });

  it('MCP human bridge discovers and runs the same canonical operation as HTTP', async () => {
    const h = await human();
    const { issueId } = await seedExhaustedIssue(h);
    const mcp = createAgentDashServer({ apiUrl: base.replace('/human-control', ''), apiKey: h.token, companyId: h.company.id, agentId: null, runId: null }, { toolset: 'human' });
    const client = new Client({ name: 'task-recovery-regression', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(a);
    await client.connect(b);
    try {
      const discovered = await client.callTool({ name: 'human_discover', arguments: { target: h.target, pageId: 'inbox' } });
      const discoveredBody = JSON.parse((discovered.content as Array<{ text: string }>)[0].text);
      expect(discovered.isError).toBeFalsy();
      expect(discoveredBody.operations.some((d: { operationId: string }) => d.operationId === 'task_recovery.remediate')).toBe(true);
      expect(discoveredBody.operations.some((d: { operationId: string }) => d.operationId === 'task_recovery.exhausted.read')).toBe(true);

      const prepared = await client.callTool({ name: 'human_prepare', arguments: { target: h.target, operationId: 'task_recovery.remediate', version: 1, input: { issueId } } });
      const preparedBody = JSON.parse((prepared.content as Array<{ text: string }>)[0].text);
      expect(prepared.isError).toBeFalsy();

      const confirmed = await client.callTool({ name: 'human_confirm', arguments: { target: h.target, handle: preparedBody.handle } });
      const confirmedBody = JSON.parse((confirmed.content as Array<{ text: string }>)[0].text);
      expect(confirmed.isError).toBeFalsy();
      expect(confirmedBody.result.permit.runId).toBe(confirmedBody.result.runId);
      expect(await markerOf(issueId)).toMatchObject({ recoveryBudget: { status: 'exhausted', remediation: { status: 'consumed' } } });
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});

// Pure-function regression coverage for the recoveryBudget namespace
// retention helpers (review F5) — no database required.
describe('recoveryBudget namespace retention (pure helpers)', () => {
  const exhaustedBudget = { status: 'exhausted', remediation: { status: 'authorized', runId: 'run-1' } };

  it('preserveIssueRecoveryBudget merges the LIVE namespace into any replacement state', () => {
    const live = { workflow: 'old', recoveryBudget: exhaustedBudget };
    expect(preserveIssueRecoveryBudget(live, { workflow: 'new' })).toEqual({ workflow: 'new', recoveryBudget: exhaustedBudget });
    expect(preserveIssueRecoveryBudget(live, null)).toEqual({ recoveryBudget: exhaustedBudget });
    // No live namespace → the next state passes through verbatim.
    expect(preserveIssueRecoveryBudget({ workflow: 'x' }, null)).toBeNull();
    expect(preserveIssueRecoveryBudget(null, { workflow: 'x' })).toEqual({ workflow: 'x' });
  });

  it('withLockedRecoveryBudget takes the namespace from the locked row, never from the replacement', () => {
    const locked = { workflow: 'old', recoveryBudget: exhaustedBudget };
    const stale = { status: 'exhausted', remediation: { status: 'authorized', runId: 'stale-run' } };
    expect(withLockedRecoveryBudget(locked, { workflow: 'new', recoveryBudget: stale })).toEqual({ workflow: 'new', recoveryBudget: exhaustedBudget });
    expect(withLockedRecoveryBudget(locked, null)).toEqual({ recoveryBudget: exhaustedBudget });
    // Cleared on the locked row: a stale replacement cannot re-add it.
    expect(withLockedRecoveryBudget({ workflow: 'old' }, { workflow: 'new', recoveryBudget: stale })).toEqual({ workflow: 'new' });
    expect(withLockedRecoveryBudget(null, { recoveryBudget: stale })).toBeNull();
    expect(withLockedRecoveryBudget(null, { workflow: 'x' })).toEqual({ workflow: 'x' });
    expect(withLockedRecoveryBudget({ workflow: 'x' }, null)).toBeNull();
  });

  it('a policy-clear transition retains only the recovery namespace', () => {
    const issue = {
      id: 'i1', companyId: 'c1', status: 'in_review',
      executionState: {
        status: 'pending', currentStageId: null, currentStageIndex: null, currentStageType: null,
        currentParticipant: null, returnAssignee: null, completedStageIds: [],
        lastDecisionId: null, lastDecisionOutcome: null, recoveryBudget: exhaustedBudget,
      },
      assigneeAgentId: null, assigneeUserId: null,
    };
    const { patch } = applyIssueExecutionPolicyTransition({
      issue: issue as never,
      policy: null,
      requestedAssigneePatch: {},
      actor: {},
    });
    expect(patch.executionState).toEqual({ recoveryBudget: exhaustedBudget });
  });
});
