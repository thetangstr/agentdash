import { companyLockQuery, observeExpectedWaiter } from './helpers/observed-lock-wait.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '../middleware/logger.js';
import { heartbeatService, pickUsageBaseline } from '../services/heartbeat.js';
import { workspacePersistenceHold } from '../services/workspace-persistence-recovery.js';
import { tokenCeilingService } from '../services/token-ceiling.js';
import { evaluateTaskRecoveryBudget } from '../services/task-recovery-budget.js';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { activityLog, agents, companies, companyMemberships, createDb, executionWorkspaces, heartbeatRuns, agentRuns, agentWakeupRequests, instanceSettings, issues, projects, type Db } from '@paperclipai/db';
import { executionWorkspaceService } from '../services/execution-workspaces.js';
import { issueService } from '../services/issues.js';
import { issuePatchActions, type IssuePatchContext } from '../services/issue-patch-actions.js';
import { issueCurrentAuthority } from '../services/issue-current-authority.js';
import { insertActivity, type ActivityPublication } from '../services/activity-log.js';
import { publishLiveEvent } from '../services/live-events.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));
const runtime = vi.hoisted(() => ({ realize: vi.fn(), cleanup: vi.fn(), execute: vi.fn(), attached: vi.fn(), released: vi.fn() }));
vi.mock('../services/workspace-runtime.js', async () => ({
  ...await vi.importActual<typeof import('../services/workspace-runtime.js')>('../services/workspace-runtime.js'),
  realizeExecutionWorkspace: runtime.realize,
  cleanupExecutionWorkspaceArtifacts: runtime.cleanup,
  releaseRuntimeServicesForRun: runtime.released,
}));
vi.mock('../adapters/index.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js');
  return { ...actual, getServerAdapter: (type: string) => ({ ...actual.getServerAdapter(type), execute: runtime.execute, supportsLocalAgentJwt: false }) };
});
vi.mock('../services/workspace-operations.js', async () => {
  const actual = await vi.importActual<typeof import('../services/workspace-operations.js')>('../services/workspace-operations.js');
  return { ...actual, workspaceOperationService: (db: Db) => {
    const service = actual.workspaceOperationService(db);
    return { ...service, createRecorder: (...args: Parameters<typeof service.createRecorder>) => {
      const recorder = service.createRecorder(...args);
      return { ...recorder, attachExecutionWorkspaceId: async (id: string | null) => { await recorder.attachExecutionWorkspaceId(id); await runtime.attached(); } };
    } };
  } };
});
vi.mock('../telemetry.js', () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));


function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

describe('workspace writers on actual PostgreSQL', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('workspace-writer-order-'); db = createDb(temp.connectionString); await db.insert(instanceSettings).values({ experimental: { enableIsolatedWorkspaces: true } }); });
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); });
  async function fixture() {
    const [company, foreign] = await db.insert(companies).values(['Local', 'Private foreign company'].map(name => ({ name, issuePrefix: randomUUID().slice(0, 8) }))).returning();
    const [project, otherProject] = await db.insert(projects).values(['Workspace project', 'Other project'].map(name => ({ companyId: company.id, name }))).returning();
    const [issue, other] = await db.insert(issues).values([
      { companyId: company.id, projectId: project.id, title: 'Self-origin issue' },
      { companyId: company.id, projectId: otherProject.id, title: 'Other same-company source' },
    ]).returning();
    const [foreignIssue] = await db.insert(issues).values({ companyId: foreign.id, title: 'Private foreign issue' }).returning();
    const input = { companyId: company.id, projectId: project.id, sourceIssueId: issue.id, name: 'Workspace', mode: 'shared_workspace', strategyType: 'project_primary' };
    const [workspace] = await db.insert(executionWorkspaces).values(input).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id, executionWorkspacePreference: 'reuse_existing' }).where(eq(issues.id, issue.id));
    return { company, foreign, project, issue, other, foreignIssue, input, workspace };
  }
  async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      workspaces: await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.company.id)),
      issues: await db.select().from(issues).where(eq(issues.companyId, f.company.id)),
      audit: await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id)),
    };
  }
  async function blockedBy(ownerPid: number, label: string, contender: Promise<unknown>) {
    const row = await observeExpectedWaiter({
      sample: () => db.execute(sql`select pid, query, pg_blocking_pids(pid) blockers from pg_stat_activity where ${ownerPid} = any(pg_blocking_pids(pid))`),
      ownerPid, label, contender, timeoutMs: 3000, expectedQuery: companyLockQuery,
    });
    console.log(JSON.stringify({ label, ownerPid, waiter: row }));
    return row;
  }

  it.each(['create-foreign', 'create-missing', 'update-foreign', 'update-missing', 'transfer'] as const)('%s refuses privately before mutation', async kind => {
    const f = await fixture(), before = await snapshot(f), svc = executionWorkspaceService(db);
    const sourceIssueId = kind.endsWith('missing') ? randomUUID() : f.foreignIssue.id;
    const operation = kind.startsWith('create') ? svc.create({ ...f.input, sourceIssueId }) : svc.update(f.workspace.id, kind === 'transfer' ? { companyId: f.foreign.id } : { sourceIssueId });
    await expect(operation).rejects.toMatchObject({ status: 400 });
    expect(await snapshot(f)).toEqual(before);
  });
  it('preserves legacy reads and repeated source while allowing null and same-company different-project reassignment', async () => {
    const f = await fixture(), svc = executionWorkspaceService(db);
    await db.update(executionWorkspaces).set({ sourceIssueId: f.foreignIssue.id }).where(eq(executionWorkspaces.id, f.workspace.id));
    expect(await svc.getById(f.workspace.id)).toMatchObject({ sourceIssueId: f.foreignIssue.id });
    expect(await svc.update(f.workspace.id, { sourceIssueId: f.foreignIssue.id, status: 'idle', companyId: f.company.id })).toMatchObject({ status: 'idle', sourceIssueId: f.foreignIssue.id });
    expect(await svc.update(f.workspace.id, { sourceIssueId: null })).toMatchObject({ sourceIssueId: null });
    expect(await svc.update(f.workspace.id, { sourceIssueId: f.other.id })).toMatchObject({ sourceIssueId: f.other.id, projectId: f.project.id });
    expect(await svc.update(randomUUID(), { status: 'idle' })).toBeNull();
  });

  it('supplied create/update and staged caller audit roll back on the distinct executor without root writes or publications', async () => {
    const f = await fixture(), before = await snapshot(f), publications: ActivityPublication[] = [];
    vi.mocked(publishLiveEvent).mockClear();
    await expect(db.transaction(async tx => {
      const acceptance = { executor: tx as unknown as Db, publications };
      const created = await executionWorkspaceService(db).create(f.input, acceptance);
      await executionWorkspaceService(db).update(f.workspace.id, { sourceIssueId: f.other.id }, acceptance);
      publications.push(await insertActivity(tx, { companyId: f.company.id, actorType: 'system', actorId: 'test', action: 'workspace.test', entityType: 'execution_workspace', entityId: created!.id }));
      expect((await tx.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.company.id)))).toHaveLength(2);
      expect(await snapshot(f)).toEqual(before);
      expect(publishLiveEvent).not.toHaveBeenCalled();
      throw new Error('outer rollback');
    })).rejects.toThrow('outer rollback');
    expect(await snapshot(f)).toEqual(before);
    expect(publications).toHaveLength(1);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it.each(['rollback', 'unknown-ack'] as const)('root %s retains truthful state with no replay', async outcome => {
    const f = await fixture(); let callbacks = 0;
    const root = new Proxy(db, { get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      return async (work: (tx: unknown) => Promise<unknown>) => {
        const result = await target.transaction(async tx => {
          callbacks++;
          const result = await work(tx);
          if (outcome === 'rollback') throw new Error('commit rejected');
          return result;
        });
        if (outcome === 'unknown-ack') throw new Error('connection lost after commit');
        return result;
      };
    } });
    await expect(executionWorkspaceService(root).create(f.input)).rejects.toMatchObject({ status: 409, details: { persistenceOutcome: 'unknown' } });
    expect(callbacks).toBe(1);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.company.id))).toHaveLength(outcome === 'rollback' ? 1 : 2);
  });

  it.each(['create', 'reassign', 'metadata-root', 'metadata-supplied'] as const)('%s orders both ways against canonical workspace SHARE and issue acceptance', async operation => {
    for (const order of ['writer-first', 'acceptance-first'] as const) {
      const f = await fixture(), ready = gate(), release = gate();
      if (operation === 'reassign') await db.update(executionWorkspaces).set({ sourceIssueId: f.other.id }).where(eq(executionWorkspaces.id, f.workspace.id));
      let ownerPid = 0;
      const writerRoot = new Proxy(db, { get(target, key, receiver) {
        if (key !== 'transaction') return Reflect.get(target, key, receiver);
        return (work: (tx: unknown) => Promise<unknown>) => target.transaction(async tx => {
          const pid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
          const result = await work(tx);
          if (order === 'writer-first') { ownerPid = pid; ready.open(); await release.promise; }
          return result;
        });
      } });
      const write = () => {
        if (operation === 'create') return executionWorkspaceService(writerRoot).create(f.input);
        if (operation === 'reassign') return executionWorkspaceService(writerRoot).update(f.workspace.id, { sourceIssueId: f.issue.id });
        const patch = { executionWorkspaceSettings: { mode: 'shared_workspace' as const, workspaceStrategy: { type: 'project_primary' as const, teardownCommand: 'test-teardown' } } };
        if (operation === 'metadata-root') return issueService(writerRoot).update(f.issue.id, patch);
        return writerRoot.transaction(tx => issueService(db).update(f.issue.id, patch, tx));
      };
      const authority = issueCurrentAuthority({ actor: { type: 'board', source: 'local_implicit' } } as Request);
      const context: IssuePatchContext = {
        issueId: f.issue.id, companyId: f.company.id, actor: { actorType: 'user', actorId: 'local', agentId: null, runId: null }, actorKind: 'board',
        intent: { title: 'Accepted' }, attribution: {}, validate: async () => undefined, validateResume: async () => undefined, validateAssignment: async () => undefined,
        stageAuthority: async (...args) => {
          const guard = await authority(...args);
          if (order === 'acceptance-first') {
            ownerPid = Number((await args[0].execute(sql`select pg_backend_pid() as pid`))[0].pid);
            ready.open(); await release.promise;
          }
          return guard;
        },
      };
      const actions = issuePatchActions(db, { cancelRun: vi.fn(), wakeup: vi.fn(), reportRunActivity: vi.fn() } as any);
      let writing: Promise<unknown>, accepting: Promise<unknown>;
      if (order === 'writer-first') { writing = write(); await ready.promise; accepting = actions.accept(context); }
      else { accepting = actions.accept(context); await ready.promise; writing = write(); }
      // Attach handlers before inspecting locks, so failures cannot become unhandled rejections.
      const results = Promise.allSettled([writing, accepting]);
      try {
        const wait = await blockedBy(ownerPid, `${operation}/${order}`, order === 'writer-first' ? accepting : writing);
        expect(String(wait.query)).toMatch(/companies.*for (?:no key )?update/i);
      } finally { release.open(); await results; }
      expect((await results).map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const state = await snapshot(f);
      expect(state.issues.find(i => i.id === f.issue.id)?.title).toBe('Accepted');
      expect(state.workspaces.find(w => w.id === f.workspace.id)?.sourceIssueId).toBe(f.issue.id);
      if (operation.startsWith('metadata')) expect(state.workspaces[0].metadata).toMatchObject({ config: { teardownCommand: 'test-teardown' } });
      if (operation === 'create') expect(state.workspaces).toHaveLength(2);
    }
  });

  it.each(['missing', 'rebound'] as const)('refreshes workspace identity after waiting for company (%s)', async change => {
    const f = await fixture(), held = gate(), release = gate(); let ownerPid = 0;
    const owner = db.transaction(async tx => {
      ownerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
      await tx.select().from(companies).where(eq(companies.id, f.company.id)).for('no key update');
      held.open(); await release.promise;
      // Deliberately unparticipating legacy writes inject changed binding; not a certified deletion owner.
      if (change === 'missing') await tx.delete(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
      else await tx.update(executionWorkspaces).set({ companyId: f.foreign.id }).where(eq(executionWorkspaces.id, f.workspace.id));
    });
    await held.promise;
    const pending = executionWorkspaceService(db).update(f.workspace.id, { name: 'Must not write' }).then(value => ({ value }), error => ({ error }));
    try { await blockedBy(ownerPid, `workspace-refresh/${change}`, pending); } finally { release.open(); await Promise.allSettled([owner, pending]); }
    await owner;
    expect(await pending).toMatchObject({ error: { status: 409 } });
    const rows = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
    expect(rows.some(row => row.name === 'Must not write')).toBe(false);
  });

  it('resolves a source deleted before acceptance without workspace or audit changes', async () => {
    const f = await fixture();
    await db.delete(issues).where(eq(issues.id, f.other.id));
    const before = await snapshot(f);
    await expect(executionWorkspaceService(db).create({ ...f.input, sourceIssueId: f.other.id })).rejects.toMatchObject({ status: 400 });
    expect(await snapshot(f)).toEqual(before);
  });

  it('metadata and accepted issue mutation roll back together, including failed guards', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    await expect(db.transaction(async tx => {
      await issueService(db).update(f.issue.id, { title: 'Uncommitted', executionWorkspaceSettings: { workspaceStrategy: { type: 'project_primary' as const, teardownCommand: 'staged' } } }, tx);
      expect((await tx.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id)))[0].metadata).toMatchObject({ config: { teardownCommand: 'staged' } });
      expect(await snapshot(f)).toEqual(before);
      throw new Error('rollback metadata and issue');
    })).rejects.toThrow('rollback metadata');
    expect(await snapshot(f)).toEqual(before);
    await expect(issueService(db).update(f.issue.id, { executionWorkspaceId: randomUUID(), executionWorkspaceSettings: { workspaceStrategy: { type: 'project_primary' as const, teardownCommand: 'refused' } } })).rejects.toBeDefined();
    expect(await snapshot(f)).toEqual(before);
  });


  it.each(['issue', 'agent'] as const)('durable %s quarantine denies queued/manual/unscoped work and preserves unrelated scope', async scope => {
    const f = await fixture();
    const [agent, otherAgent] = await db.insert(agents).values(['Affected', 'Unrelated'].map(name => ({ companyId: f.company.id, name, adapterType: 'codex_local', runtimeConfig: { heartbeat: { enabled: name === 'Affected', intervalSec: 1, requireWork: false, sweepIntervalSec: 1 } } }))).returning();
    await db.update(issues).set({ assigneeAgentId: agent.id, status: 'todo' }).where(eq(issues.id, f.issue.id));
    const [original] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, status: 'failed', errorCode: 'workspace_persistence_uncertain', usageJson: { workspacePersistenceAttemptId: f.workspace.id }, resultJson: {
      workspacePersistence: { companyId: f.company.id, agentId: agent.id, issueId: scope === 'issue' ? f.issue.id : null, workspaceId: f.workspace.id, phase: 'workspace', outcome: 'unknown', recoveryRequired: true },
    } }).returning();
    const svc = heartbeatService(db, { autoDispatchQueuedRuns: false });
    expect(await svc.invoke(agent.id, 'on_demand', { issueId: f.issue.id, workspacePersistence: { recoveryRequired: false } }, 'manual', { actorType: 'user', actorId: 'owner' })).toBeNull();
    expect(await svc.invoke(agent.id, 'timer', {})).toBeNull();
    const [prequeued] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, status: 'queued', contextSnapshot: { issueId: f.issue.id } }).returning();
    await svc.resumeQueuedRuns();
    expect((await svc.getRun(prequeued.id))?.status).toBe('cancelled');
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, original.id)))[0].resultJson).toEqual(original.resultJson);
    const [scheduled] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, status: 'scheduled_retry', scheduledRetryAt: new Date(0), contextSnapshot: { issueId: f.issue.id } }).returning();
    await svc.promoteDueScheduledRetries();
    await svc.resumeQueuedRuns();
    expect((await svc.getRun(scheduled.id))?.status).toBe('cancelled');
    await svc.tickTimers(new Date(Date.now() + 60000));
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id))).toHaveLength(3);
    const before = await snapshot(f);
    await svc.reconcileStrandedAssignedIssues();
    await svc.reconcileIssueGraphLiveness({ force: true });
    expect(await snapshot(f)).toEqual(before);
    // Reassignment also quarantines unscoped automation for the current assignee.
    if (scope === 'issue') {
      await db.update(issues).set({ assigneeAgentId: otherAgent.id }).where(eq(issues.id, f.issue.id));
      expect(await svc.invoke(otherAgent.id, 'timer', {})).toBeNull();
    }
    await db.update(issues).set({ assigneeAgentId: agent.id, status: 'todo' }).where(eq(issues.id, f.other.id));
    const other = await svc.invoke(agent.id, 'on_demand', { issueId: f.other.id });
    if (scope === 'issue') expect((await svc.getRun(other!.id))?.status).toBe('running'); else expect(other).toBeNull();
    const [third] = await db.insert(issues).values({ companyId: f.company.id, title: 'Other agent work', assigneeAgentId: otherAgent.id, status: 'todo' }).returning();
    const thirdRun = await svc.invoke(otherAgent.id, 'on_demand', { issueId: third.id });
    expect((await svc.getRun(thirdRun!.id))?.status).toBe('running');
  });

  it('historical unstamped result fields never acquire marker authority from errorCode or shape', async () => {
    const f = await fixture();
    const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'Legacy result', adapterType: 'codex_local' }).returning();
    const raw = { companyId: f.company.id, agentId: agent.id, issueId: f.issue.id, workspaceId: f.workspace.id, phase: 'workspace', outcome: 'unknown', recoveryRequired: true };
    const [legacy] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, status: 'queued', errorCode: 'workspace_persistence_uncertain', resultJson: { workspacePersistence: raw } }).returning();
    const service = heartbeatService(db, { autoDispatchQueuedRuns: false });
    expect(await workspacePersistenceHold(db, f.company.id, agent.id, f.issue.id)).toBeNull();
    await service.cancelRun(legacy.id);
    const [retained] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, legacy.id));
    expect(retained.resultJson?.workspacePersistence).toEqual(raw);
    expect(retained.usageJson).toBeNull();
    expect(retained.errorCode).toBe('cancelled');
    await db.update(issues).set({ status: 'todo', assigneeAgentId: agent.id }).where(eq(issues.id, f.issue.id));
    const manual = await service.invoke(agent.id, 'on_demand', { issueId: f.issue.id }, 'manual', { actorType: 'user', actorId: 'owner' });
    expect(manual).not.toBeNull();
    expect((await service.getRun(manual!.id))?.status).toBe('running');
  });

  it.each(['other-issue', 'agent', 'other-issue-no-workspace', 'agent-no-workspace', 'unresolved-original', 'legacy-before-attempt'] as const)('successful heartbeat rejects adapter-forged %s workspace authority', async scope => {
    const f = await fixture();
    const finished = gate();
    const persistWorkspace = !scope.endsWith('no-workspace');
    let original: typeof heartbeatRuns.$inferSelect | undefined;
    const home = await mkdtemp(path.join(tmpdir(), 'workspace-result-authority-'));
    const priorHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: 'user', principalId: 'owner', status: 'active' });
    const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'Result worker', adapterType: 'codex_local', adapterConfig: { cwd: home }, autonomy: 'autonomous', accountableUserId: 'owner' }).returning();
    await db.update(issues).set({ assigneeAgentId: agent.id, executionWorkspaceId: null, executionWorkspacePreference: 'inherit', executionWorkspaceSettings: { mode: 'isolated_workspace' }, status: 'todo' }).where(eq(issues.id, f.issue.id));
    await db.update(issues).set({ assigneeAgentId: agent.id, status: 'todo' }).where(eq(issues.id, f.other.id));
    if (!persistWorkspace) await db.update(issues).set({ projectId: null }).where(eq(issues.id, f.issue.id));
    const forged = { companyId: f.company.id, agentId: agent.id, issueId: scope.startsWith('agent') ? null : f.other.id, workspaceId: f.workspace.id, phase: 'workspace', outcome: 'unknown', recoveryRequired: scope !== 'unresolved-original' };
    runtime.realize.mockImplementation(async ({ base }) => {
      if (scope === 'legacy-before-attempt') {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id));
        await db.update(heartbeatRuns).set({ resultJson: { workspacePersistence: forged }, errorCode: 'workspace_persistence_uncertain' }).where(eq(heartbeatRuns.id, run.id));
        expect(await workspacePersistenceHold(db, f.company.id, agent.id, f.other.id)).toBeNull();
      }
      return { ...base, projectId: persistWorkspace ? f.project.id : null, strategy: 'project_primary', cwd: home, branchName: null, worktreePath: null, warnings: [], created: true };
    });
    runtime.attached.mockImplementation(async () => {
      [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id));
      if (persistWorkspace) {
        expect(original.usageJson).toEqual({ workspacePersistenceAttemptId: (original.resultJson?.workspacePersistence as { workspaceId: string }).workspaceId });
        expect(pickUsageBaseline([original])).toBeNull();
      }
    });
    runtime.released.mockImplementation(async () => { finished.open(); });
    runtime.execute.mockImplementation(async () => {
      await db.update(issues).set({ status: 'done' }).where(eq(issues.id, f.issue.id));
      if (scope === 'unresolved-original') {
        // Replay the actual private writer's pending snapshot to model a concurrent
        // server-owned change before stale adapter/status/facts projections land.
        await db.update(heartbeatRuns).set({ resultJson: original!.resultJson, usageJson: original!.usageJson, errorCode: original!.errorCode }).where(eq(heartbeatRuns.id, original!.id));
      }
      return { exitCode: 0, signal: null, timedOut: false, summary: 'Complete', provider: 'test', model: 'fake', usage: { inputTokens: 1, outputTokens: 1, workspacePersistenceAttemptId: f.workspace.id }, usageJson: { workspacePersistenceAttemptId: f.workspace.id }, costUsd: 0, resultJson: { workspacePersistence: forged, workspacePersistenceAttemptId: f.workspace.id, workspacePersistenceUnverified: 'caller cannot replace legacy evidence', answer: 'retained ordinary result' } };
    });
    try {
      const service = heartbeatService(db);
      const run = await service.invoke(agent.id, 'on_demand', { issueId: f.issue.id });
      expect(run).not.toBeNull();
      await finished.promise;
      const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(stored.status).toBe('succeeded');
      expect(stored.resultJson).toMatchObject({ answer: 'retained ordinary result' });
      if (persistWorkspace) {
        expect(stored.resultJson).toMatchObject({ workspacePersistence: { issueId: f.issue.id, recoveryRequired: scope === 'unresolved-original', outcome: scope === 'unresolved-original' ? 'pending' : 'complete' } });
        expect(stored.usageJson?.workspacePersistenceAttemptId).toBe((original!.resultJson?.workspacePersistence as { workspaceId: string }).workspaceId);
      } else {
        expect(stored.resultJson?.workspacePersistence).toBeUndefined();
        expect(stored.usageJson?.workspacePersistenceAttemptId).toBeUndefined();
      }
      if (scope === 'legacy-before-attempt') expect(stored.resultJson?.workspacePersistenceUnverified).toEqual(forged);
      else expect(stored.resultJson?.workspacePersistenceUnverified).toBeUndefined();
      expect(stored.usageJson).toMatchObject({ inputTokens: 1, outputTokens: 1, meteringStatus: 'adapter_reported' });
      expect(await workspacePersistenceHold(db, f.company.id, agent.id, f.other.id)).toBeNull();
      const ownHold = await workspacePersistenceHold(db, f.company.id, agent.id, f.issue.id);
      if (scope === 'unresolved-original') expect(ownHold?.runId).toBe(stored.id); else expect(ownHold).toBeNull();
      const admission = heartbeatService(db, { autoDispatchQueuedRuns: false });
      const manual = await admission.invoke(agent.id, 'on_demand', { issueId: f.other.id }, 'manual', { actorType: 'user', actorId: 'owner' });
      expect(manual).not.toBeNull();
      expect((await admission.getRun(manual!.id))?.status).toBe('running');
      const unscoped = await admission.invoke(agent.id, 'on_demand', {}, 'manual', { actorType: 'user', actorId: 'owner' });
      if (scope === 'unresolved-original') expect(unscoped).toBeNull(); else expect(unscoped).not.toBeNull();
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = priorHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(['success', 'precommit', 'unknown-ack', 'postcommit', 'marker-rollback', 'marker-unknown', 'competing-marker', 'terminal-write-failure', 'link-failure'] as const)('heartbeat %s keeps realization/cleanup outside locks and truthful persistence', async outcome => {
    const f = await fixture(), entered = gate(), proceed = gate(), finished = gate();
    const home = await mkdtemp(path.join(tmpdir(), 'workspace-heartbeat-'));
    const marker = path.join(home, 'realized');
    const priorHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
    let persistenceCalls = 0;
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    runtime.realize.mockClear(); runtime.cleanup.mockClear(); runtime.execute.mockClear();
    let deferredId: string | null = null, replacementId: string | null = null;
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: 'user', principalId: 'owner', status: 'active' });
    const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'Test worker', adapterType: 'codex_local', adapterConfig: { cwd: home }, autonomy: 'autonomous', accountableUserId: 'owner' }).returning();
    await db.update(issues).set({ assigneeAgentId: agent.id, executionWorkspaceId: null, executionWorkspacePreference: 'inherit', executionWorkspaceSettings: { mode: 'isolated_workspace' }, status: 'todo' }).where(eq(issues.id, f.issue.id));
    runtime.released.mockImplementation(async () => { finished.open(); });
    runtime.realize.mockImplementation(async ({ base }) => {
      await writeFile(marker, 'materialized');
      entered.open(); await proceed.promise;
      if (outcome === 'precommit' || outcome === 'marker-rollback') await db.update(issues).set({ status: 'done' }).where(eq(issues.id, f.issue.id));
      return { ...base, projectId: f.project.id, strategy: 'project_primary', cwd: home, branchName: null, worktreePath: null, warnings: [], created: true };
    });
    runtime.cleanup.mockImplementation(async () => {
      await db.transaction(async tx => {
        await tx.select().from(companies).where(eq(companies.id, f.company.id)).for('no key update', { noWait: true });
      });
      await rm(marker);
    });
    runtime.attached.mockImplementation(async () => {
      if (outcome === 'postcommit') {
        const [replacement] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, status: 'running', contextSnapshot: { issueId: f.issue.id } }).returning();
        replacementId = replacement.id;
        await db.update(issues).set({ executionRunId: replacement.id }).where(eq(issues.id, f.issue.id));
        throw new Error('recorder failure after accepted workspace');
      }
    });
    runtime.execute.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, summary: 'Test complete', provider: 'test', model: 'fake', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 });
    const root = new Proxy(db, { get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      return async (work: (tx: unknown) => Promise<unknown>) => {
        let workspaceWrite = false, markerWrite = false;
        const result = await target.transaction(async tx => work(new Proxy(tx, { get(t, k, r) {
          if (k === 'update') return (table: unknown) => {
            const builder = (t.update as Function)(table), set = builder.set.bind(builder);
            builder.set = (value: Record<string, unknown>) => {
              if (table === issues && value.executionWorkspaceId && outcome === 'link-failure') throw new Error('issue link callback failed');
              if (table === heartbeatRuns && value.status === 'failed' && outcome === 'terminal-write-failure') throw new Error('terminal status write unavailable');
              if (table === heartbeatRuns && value.resultJson && value.errorCode === 'workspace_persistence_uncertain') {
                markerWrite = true;
                if (outcome === 'marker-rollback') throw new Error('marker transaction refused');
              }
              return set(value);
            };
            return builder;
          };
          if (k !== 'insert') return Reflect.get(t, k, r);
          return (table: unknown) => {
            const builder = (t.insert as Function)(table);
            if (table !== executionWorkspaces) return builder;
            workspaceWrite = true; persistenceCalls++;
            // Marker is durable and separately visible before the workspace transaction writes.
            // The returning fault below runs only after this actual INSERT.

            const values = builder.values.bind(builder);
            builder.values = (...args: unknown[]) => {
              const query = values(...args), returning = query.returning.bind(query);
              query.returning = (...selection: unknown[]) => {
                const rows = returning(...selection);
                return Promise.resolve(rows).then(async value => {
                  const originals = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id));
                  expect(originals.some(row => { const marker = row.resultJson?.workspacePersistence as Record<string, unknown> | undefined; return marker?.recoveryRequired === true && marker.workspaceId === (args[0] as { id: string }).id; })).toBe(true);
                  if (outcome === 'precommit') throw new Error('workspace callback failed after staged insert'); return value; });
              };
              return query;
            };
            return builder;
          };
        } })));
        if (markerWrite && outcome === 'marker-unknown') throw new Error('lost marker acknowledgement');
        if (workspaceWrite && ['unknown-ack', 'terminal-write-failure'].includes(outcome)) throw new Error('lost workspace commit acknowledgement');
        return result;
      };
    } });
    const heartbeat = heartbeatService(root);
    let queued: Awaited<ReturnType<typeof heartbeat.invoke>>;
    try {
      queued = await heartbeat.invoke(agent.id, 'on_demand', { issueId: f.issue.id });
      expect(queued).not.toBeNull();
      await vi.waitFor(() => expect(runtime.realize).toHaveBeenCalledTimes(1), { timeout: 8000 });
      await entered.promise;
      // An independent backend can take the company mutex while FS/provider realization is suspended.
      await db.transaction(async tx => {
        const pid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
        await tx.select().from(companies).where(eq(companies.id, f.company.id)).for('no key update', { noWait: true });
        console.log(JSON.stringify({ label: `heartbeat/${outcome}/realization-unlocked`, probePid: pid }));
      });
      if (outcome === 'competing-marker') {
        await db.update(heartbeatRuns).set({ usageJson: { workspacePersistenceAttemptId: f.workspace.id }, resultJson: { workspacePersistence: { companyId: f.company.id, agentId: agent.id, issueId: f.issue.id, workspaceId: f.workspace.id, phase: 'workspace', outcome: 'unknown', recoveryRequired: true } } }).where(eq(heartbeatRuns.id, queued!.id));
      }
      if (outcome === 'unknown-ack') {
        const [deferred] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: agent.id, source: 'automation', status: 'deferred_issue_execution', payload: { issueId: f.issue.id } }).returning();
        deferredId = deferred.id;
      }
      proceed.open();
      await vi.waitFor(async () => { expect((await heartbeat.getRun(queued!.id))?.status).toBe(outcome === 'success' ? 'succeeded' : outcome === 'terminal-write-failure' ? 'running' : 'failed'); }, { timeout: 12000, interval: 50 });
      await finished.promise;
      await heartbeat.resumeQueuedRuns();
      if (['unknown-ack', 'postcommit', 'marker-unknown', 'competing-marker', 'terminal-write-failure', 'link-failure'].includes(outcome)) {
        const original = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)))[0];
        expect(original.resultJson).toMatchObject({ workspacePersistence: { recoveryRequired: true, issueId: f.issue.id } });
        if (outcome === 'competing-marker') expect(original.resultJson).toMatchObject({ workspacePersistence: { workspaceId: f.workspace.id, outcome: 'unknown' } });
        if (outcome === 'unknown-ack') {
          const workspaceId = (original.resultJson?.workspacePersistence as { workspaceId: string }).workspaceId;
          expect(original.usageJson).toEqual({ workspacePersistenceAttemptId: workspaceId });
          expect(pickUsageBaseline([original])).toBeNull();
          expect(evaluateTaskRecoveryBudget([original])).toEqual(evaluateTaskRecoveryBudget([{ ...original, usageJson: null }]));
          expect(original.resultJson).toMatchObject({ runFacts: { meteringStatus: 'unmetered_no_session', inputTokens: null, outputTokens: null } });
          await db.update(heartbeatRuns).set({ resultJson: { ...original.resultJson, runFacts: { ...(original.resultJson?.runFacts as object), wakeReason: 'timer' } } }).where(eq(heartbeatRuns.id, original.id));
          const window = await tokenCeilingService(db).dailyUsage(agent, new Date());
          expect(window).toMatchObject({ totalTokens: 0, meteredRuns: 0, unmeteredRuns: 1, unmeteredPausableRuns: 1 });
        }
        expect(await heartbeat.invoke(agent.id, 'on_demand', { issueId: f.issue.id, workspacePersistence: { recoveryRequired: false } }, 'manual', { actorType: 'user', actorId: 'owner' })).toBeNull();
      }
      const rows = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.company.id));
      expect(persistenceCalls).toBe(outcome.startsWith('marker-') || outcome === 'competing-marker' ? 0 : 1);
      expect(runtime.realize).toHaveBeenCalledTimes(1);
      expect(runtime.execute).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
      expect(logged.mock.calls).toHaveLength(outcome === 'success' ? 0 : 1);
      if (outcome !== 'success') expect(logged.mock.calls[0][1]).toBe('heartbeat execution setup failed');
      if (deferredId) expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferredId)))[0].status).toBe('deferred_issue_execution');
      expect(rows).toHaveLength(outcome === 'precommit' || outcome.startsWith('marker-') || outcome === 'competing-marker' ? 1 : 2);
      if (outcome === 'precommit') await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(marker, 'utf8')).toBe('materialized');
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
      if (outcome === 'success') expect(rows.find(w => w.id === issue.executionWorkspaceId)?.sourceIssueId).toBe(issue.id);
      else expect(issue.executionWorkspaceId).toBeNull();
      expect(issue.executionRunId).toBe(replacementId);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id))).toHaveLength(replacementId ? 2 : 1);
    } finally {
      proceed.open();
      logged.mockRestore();
      if (priorHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = priorHome;
      await rm(home, { recursive: true, force: true });
    }
  });

});
