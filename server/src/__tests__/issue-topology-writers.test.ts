import type { Request } from 'express';
import { issuePatchActions, type IssuePatchContext } from '../services/issue-patch-actions.js';
import { issueCurrentAuthority } from '../services/issue-current-authority.js';
import { insertActivity, type ActivityPublication } from '../services/activity-log.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { activityLog, agents, heartbeatRuns, companies, createDb, executionWorkspaces, instanceSettings, issueThreadInteractions, issueComments, issueRelations, issues, projects, type Db } from '@paperclipai/db';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';
import { issueService } from '../services/issues.js';
import { projectService } from '../services/projects.js';
import { companyService } from '../services/companies.js';
import { publishLiveEvent } from '../services/live-events.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));

describe('central topology writers on PostgreSQL', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('topology-writers-'); db = createDb(temp.connectionString); await db.insert(instanceSettings).values({ experimental: { enableIsolatedWorkspaces: true } }); });
  // timeout: 5 lets any straggler query finish before sockets close — a
  // force-ended pending query surfaces as CONNECTION_DESTROYED mid-cleanup.
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await temp?.cleanup(); });
  async function fixture() {
    const [company, foreign] = await db.insert(companies).values(['Local', 'Private company'].map(name => ({ name, issuePrefix: randomUUID().slice(0, 8) }))).returning();
    const [project, otherProject] = await db.insert(projects).values(['Target', 'Other'].map(name => ({ companyId: company.id, name }))).returning();
    const [parent, child] = await db.insert(issues).values([{ companyId: company.id, projectId: project.id, title: 'Parent' }, { companyId: company.id, projectId: otherProject.id, title: 'Child' }]).returning();
    const [foreignIssue] = await db.insert(issues).values({ companyId: foreign.id, title: 'Private issue' }).returning();
    await db.insert(issueComments).values({ companyId: company.id, issueId: parent.id, body: 'Must survive refusal' });
    return { company, foreign, project, otherProject, parent, child, foreignIssue };
  }
  async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
    return { issues: await db.select().from(issues).where(eq(issues.companyId, f.company.id)), foreign: await db.select().from(issues).where(eq(issues.companyId, f.foreign.id)), comments: await db.select().from(issueComments).where(eq(issueComments.issueId, f.parent.id)), audits: await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id)), workspaces: await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.sourceIssueId, f.parent.id)) };
  }
  it.each(['company-transfer', 'foreign-parent'] as const)('generic plugin-shaped %s refuses privately without writes', async kind => {
    const f = await fixture(), before = await snapshot(f);
    const patch: Record<string, unknown> = kind === 'company-transfer' ? { companyId: f.foreign.id } : { parentId: f.foreignIssue.id };
    await expect(issueService(db).update(f.child.id, patch)).rejects.toMatchObject({ status: 422 });
    expect(await snapshot(f)).toEqual(before);
  });
  it.each(['issue', 'project', 'company'] as const)('%s refuses incoming foreign children and sources before cleanup', async owner => {
    for (const kind of ['child', 'source']) {
      const f = await fixture();
      if (kind === 'child') await db.update(issues).set({ parentId: f.parent.id }).where(eq(issues.id, f.foreignIssue.id));
      else await db.insert(executionWorkspaces).values({ companyId: f.foreign.id, projectId: f.project.id, sourceIssueId: f.parent.id, name: 'Private workspace', mode: 'shared_workspace', strategyType: 'project_primary' });
      const before = await snapshot(f); vi.mocked(publishLiveEvent).mockClear();
      const remove = owner === 'issue' ? issueService(db).remove(f.parent.id) : owner === 'project' ? projectService(db).remove(f.project.id, { withIssues: true }) : companyService(db).remove(f.company.id);
      await expect(remove).rejects.toMatchObject({ status: 409, message: 'Issue topology is unavailable for deletion' });
      expect(await snapshot(f)).toEqual(before); expect(publishLiveEvent).not.toHaveBeenCalled();
    }
  });
  it('supplied child and parent blocker roll back on actual executor without root commit', async () => {
    const f = await fixture(), before = await snapshot(f);
    await expect(db.transaction(async tx => {
      const child = await issueService(db).createChild(f.parent.id, { title: 'Atomic child', blockParentUntilDone: true }, { executor: tx as unknown as Db, publications: [] });
      expect(await tx.select().from(issueRelations).where(eq(issueRelations.issueId, child.issue.id))).toHaveLength(1);
      expect(await snapshot(f)).toEqual(before);
      throw new Error('outer rollback');
    })).rejects.toThrow('outer rollback');
    expect(await snapshot(f)).toEqual(before);
  });
  it('cross-project parenting and local null repair preserve compatibility', async () => {
    const f = await fixture();
    expect(await issueService(db).update(f.child.id, { parentId: f.parent.id })).toMatchObject({ parentId: f.parent.id });
    await db.update(issues).set({ parentId: f.foreignIssue.id }).where(eq(issues.id, f.child.id));
    expect(await issueService(db).update(f.child.id, { parentId: null })).toMatchObject({ parentId: null });
  });
  it('supplied suggestion delegation rolls claim, children and caller audit back together', async () => {
    const f = await fixture(), svc = issueThreadInteractionService(db);
    const interaction = await svc.create(f.parent, { kind: 'suggest_tasks', payload: { version: 1, tasks: [{ clientKey: 'first', title: 'First' }, { clientKey: 'second', title: 'Second', parentClientKey: 'first' }] } }, { userId: 'local-board' });
    const before = await snapshot(f); const publications: ActivityPublication[] = []; vi.mocked(publishLiveEvent).mockClear();
    await expect(db.transaction(async tx => {
      const result = await svc.acceptInteraction(f.parent, interaction.id, {}, { userId: 'local-board' }, { executor: tx as unknown as Db, publications });
      publications.push(await insertActivity(tx, { companyId: f.company.id, actorType: 'system', actorId: 'test', action: 'suggestion.test', entityType: 'issue', entityId: f.parent.id }));
      expect(publishLiveEvent).not.toHaveBeenCalled();
      expect(result.createdIssues).toHaveLength(2);
      expect((await tx.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0].status).toBe('accepted');
      expect(await snapshot(f)).toEqual(before);
      throw new Error('rollback suggestion');
    })).rejects.toThrow('rollback suggestion');
    expect(await snapshot(f)).toEqual(before);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0].status).toBe('pending');
  });

  function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { open, promise }; }
  // Poll pg_stat_activity until the contender is observed waiting on the
  // lock owner's `companies ... for update`. On a loaded CI box the contender
  // can need several seconds just to reach its lock statement — a 4s deadline
  // plus a setImmediate spin both expired early and flooded the pool with
  // polls. The owner holds the lock until `release` opens, so the real bound
  // is "the contender reaches its lock attempt"; 20s only fails on a genuine
  // wedge, and we stop polling as soon as the contender settles.
  async function blockedBy(ownerPid: number, label: string, contender: Promise<unknown>) {
    const deadline = Date.now() + 20_000;
    let done = false;
    void contender.then(() => { done = true; }, () => { done = true; });
    while (Date.now() < deadline && !done) {
      const [row] = await db.execute(sql`select pid, query, pg_blocking_pids(pid) blockers from pg_stat_activity where ${ownerPid} = any(pg_blocking_pids(pid))`);
      if (row) { expect(Number(row.pid)).not.toBe(ownerPid); console.log(JSON.stringify({ label, ownerPid, waiter: row })); return row; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`No observed company lock wait: ${label}`);
  }
  it.each(['create', 'child', 'reparent', 'remove', 'project', 'company', 'suggestion'] as const)('%s participates in both orders against actual canonical acceptance', async operation => {
    for (const order of ['writer-first', 'acceptance-first']) {
      const f = await fixture(), ready = gate(), release = gate(); let ownerPid = 0;
      // Both deletion source SET NULL and project cascade include a normal self-origin source.
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.company.id, projectId: f.project.id, sourceIssueId: f.parent.id, name: 'Self-origin', mode: 'shared_workspace', strategyType: 'project_primary' }).returning();
      await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, f.parent.id));
      const [childWorkspace] = await db.insert(executionWorkspaces).values({ companyId: f.company.id, projectId: f.otherProject.id, sourceIssueId: f.parent.id, name: 'Surviving source', mode: 'shared_workspace', strategyType: 'project_primary' }).returning();
      await db.update(issues).set({ executionWorkspaceId: childWorkspace.id, parentId: f.parent.id }).where(eq(issues.id, f.child.id));
      const interaction = operation === 'suggestion' ? await issueThreadInteractionService(db).create(f.parent, { kind: 'suggest_tasks', payload: { version: 1, tasks: [{ clientKey: 'task', title: 'Suggested' }] } }, { userId: 'local-board' }) : null;
      const writerRoot = new Proxy(db, { get(target, key, receiver) {
        if (key !== 'transaction') return Reflect.get(target, key, receiver);
        return (work: (tx: unknown) => Promise<unknown>) => target.transaction(async tx => {
          const pid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
          await tx.execute(sql`set local statement_timeout = '8s'`);
          const result = await work(tx);
          if (order === 'writer-first') { ownerPid = pid; ready.open(); await release.promise; }
          return result;
        });
      } });
      const write = () => {
        const svc = issueService(writerRoot);
        if (operation === 'create') return svc.create(f.company.id, { title: 'Created', parentId: f.parent.id });
        if (operation === 'child') return svc.createChild(f.parent.id, { title: 'Created child', blockParentUntilDone: true });
        if (operation === 'reparent') return svc.update(f.child.id, { parentId: null });
        if (operation === 'remove') return svc.remove(f.parent.id);
        if (operation === 'project') return projectService(writerRoot).remove(f.project.id, { withIssues: true });
        if (operation === 'company') return companyService(writerRoot).remove(f.company.id);
        return issueThreadInteractionService(writerRoot).acceptSuggestedTasks(f.parent, interaction!.id, {}, { userId: 'local-board' });
      };
      const authority = issueCurrentAuthority({ actor: { type: 'board', source: 'local_implicit' } } as Request);
      const context: IssuePatchContext = {
        issueId: f.child.id, companyId: f.company.id, actor: { actorType: 'user', actorId: 'local', agentId: null, runId: null }, actorKind: 'board', intent: { title: 'Accepted' }, attribution: {},
        validate: async () => undefined, validateResume: async () => undefined, validateAssignment: async () => undefined,
        stageAuthority: async (...args) => {
          const guard = await authority(...args);
          if (order === 'acceptance-first') { ownerPid = Number((await args[0].execute(sql`select pg_backend_pid() as pid`))[0].pid); ready.open(); await release.promise; }
          return guard;
        },
      };
      const effects = { cancelRun: vi.fn(), wakeup: vi.fn(), reportRunActivity: vi.fn() };
      const accept = () => issuePatchActions(db, effects as any).accept(context);
      const first = (order === 'writer-first' ? write() : accept());
      await Promise.race([ready.promise, first.then(() => { throw new Error('Owner returned before barrier'); })]);
      const second = order === 'writer-first' ? accept() : write();
      const results = Promise.allSettled([first, second]);
      // A contender that settles without ever blocking means the lock was
      // never contended — report that instead of polling to the deadline.
      try { expect(String((await blockedBy(ownerPid, `${operation}/${order}`, Promise.resolve(second))).query)).toMatch(/companies.*for (?:no key )?update/i); }
      finally { release.open(); }
      const settled = await results;
      expect(settled[0].status).toBe('fulfilled');
      if (operation === 'company' && order === 'writer-first') expect(settled[1].status).toBe('rejected');
      else expect(settled[1]).toMatchObject({ status: 'fulfilled' });
      const remaining = await db.select().from(issues).where(eq(issues.companyId, f.company.id));
      if (operation === 'company') expect(remaining).toEqual([]);
      else {
        expect(remaining.find(row => row.id === f.child.id)?.title).toBe('Accepted');
        if (['remove', 'project', 'reparent'].includes(operation)) expect(remaining.find(row => row.id === f.child.id)?.parentId).toBeNull();
        if (['create', 'child', 'suggestion'].includes(operation)) expect(remaining.filter(row => row.parentId === f.parent.id)).toHaveLength(2);
      }
      const workspaces = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id));
      if (operation === 'remove') expect(workspaces[0].sourceIssueId).toBeNull();
      if (['remove', 'project'].includes(operation)) expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, childWorkspace.id)))[0].sourceIssueId).toBeNull();
      if (['project', 'company'].includes(operation)) expect(workspaces).toEqual([]);
      expect(effects.wakeup).not.toHaveBeenCalled();
    }
  });
  it.each(['create', 'child', 'remove', 'project', 'company', 'suggestion'] as const)('%s unknown commit acknowledgment never replays or compensates', async operation => {
    const f = await fixture(); let callbacks = 0;
    const interaction = operation === 'suggestion' ? await issueThreadInteractionService(db).create(f.parent, { kind: 'suggest_tasks', payload: { version: 1, tasks: [{ clientKey: 'task', title: 'Suggested' }] } }, { userId: 'local-board' }) : null;
    const root = new Proxy(db, { get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      return async (work: (tx: unknown) => Promise<unknown>) => { await target.transaction(async tx => { callbacks++; return work(tx); }); throw new Error('lost commit acknowledgment'); };
    } });
    const svc = issueService(root);
    const write = operation === 'create' ? svc.create(f.company.id, { title: 'Unknown' }) : operation === 'child' ? svc.createChild(f.parent.id, { title: 'Unknown child', blockParentUntilDone: true }) : operation === 'remove' ? svc.remove(f.parent.id) : operation === 'project' ? projectService(root).remove(f.project.id, { withIssues: true }) : operation === 'company' ? companyService(root).remove(f.company.id) : issueThreadInteractionService(root).acceptSuggestedTasks(f.parent, interaction!.id, {}, { userId: 'local-board' });
    await expect(write).rejects.toMatchObject({ status: 409, details: { persistenceOutcome: 'unknown' } }); expect(callbacks).toBe(1);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toHaveLength(operation === 'company' ? 0 : ['remove', 'project'].includes(operation) ? 1 : 3);
  });
  it('root child known callback rejection rolls creation and blocker changes back', async () => {
    const f = await fixture(), before = await snapshot(f);
    await expect(issueService(db).createChild(f.parent.id, { title: 'Invalid', blockParentUntilDone: true, blockedByIssueIds: [f.foreignIssue.id] })).rejects.toMatchObject({ status: 422 });
    expect(await snapshot(f)).toEqual(before);
  });

  it('explicit supplied create/child/remove uses only its executor and rolls all rows and audits back', async () => {
    const f = await fixture(), before = await snapshot(f), publications: ActivityPublication[] = [];
    const forbiddenRoot = new Proxy(db, { get(target, key, receiver) {
      if (['transaction', 'select', 'insert', 'update', 'delete', 'execute'].includes(String(key))) return () => { throw new Error(`Unexpected root ${String(key)}`); };
      return Reflect.get(target, key, receiver);
    } });
    vi.mocked(publishLiveEvent).mockClear();
    await expect(db.transaction(async tx => {
      await tx.select().from(companies).where(eq(companies.id, f.company.id)).for('update');
      const accepted = { executor: tx as unknown as Db, publications }, svc = issueService(forbiddenRoot);
      const created = await svc.create(f.company.id, { title: 'Supplied' }, accepted);
      await svc.createChild(f.parent.id, { title: 'Supplied child', blockParentUntilDone: true }, accepted);
      await svc.remove(f.child.id, accepted);
      publications.push(await insertActivity(tx, { companyId: f.company.id, actorType: 'system', actorId: 'test', action: 'topology.test', entityType: 'issue', entityId: created.id }));
      expect(await snapshot(f)).toEqual(before); expect(publishLiveEvent).not.toHaveBeenCalled();
      throw new Error('rollback all topology');
    })).rejects.toThrow('rollback all topology');
    expect(await snapshot(f)).toEqual(before); expect(publications).toHaveLength(1); expect(publishLiveEvent).not.toHaveBeenCalled();
  });
  it('child blocker cycle rejection is atomic and existing parent blockers survive success', async () => {
    const f = await fixture(), svc = issueService(db), before = await snapshot(f);
    await expect(svc.createChild(f.parent.id, { title: 'Cycle', blockedByIssueIds: [f.parent.id], blockParentUntilDone: true })).rejects.toMatchObject({ status: 422 });
    expect(await snapshot(f)).toEqual(before);
    await svc.update(f.parent.id, { blockedByIssueIds: [f.child.id] });
    const created = await svc.createChild(f.parent.id, { title: 'Additional blocker', blockParentUntilDone: true });
    expect((await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, f.parent.id))).map(row => row.issueId).sort()).toEqual([f.child.id, created.issue.id].sort());
  });
  it('suggestion child-count failure rolls earlier selected children and its claim back', async () => {
    const f = await fixture(), svc = issueThreadInteractionService(db);
    await db.insert(issues).values(Array.from({ length: 24 }, (_, i) => ({ companyId: f.company.id, parentId: f.parent.id, title: `Existing ${i}` })));
    const interaction = await svc.create(f.parent, { kind: 'suggest_tasks', payload: { version: 1, tasks: [{ clientKey: 'a', title: 'Twenty-fifth' }, { clientKey: 'b', title: 'Too many' }] } }, { userId: 'local-board' });
    const before = await snapshot(f);
    await expect(svc.acceptSuggestedTasks(f.parent, interaction.id, {}, { userId: 'local-board' })).rejects.toMatchObject({ status: 422 });
    expect(await snapshot(f)).toEqual(before);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0].status).toBe('pending');
  });

  it.each(['issue', 'project'] as const)('%s source deletion preserves original uncertainty marker and stamp', async owner => {
    const f = await fixture();
    const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'Original agent', role: 'engineer', adapterType: 'process', adapterConfig: {} }).returning();
    const workspaceId = randomUUID();
    const [original] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, status: 'failed', errorCode: 'workspace_persistence_uncertain', usageJson: { workspacePersistenceAttemptId: workspaceId }, resultJson: { workspacePersistence: { companyId: f.company.id, agentId: agent.id, issueId: f.parent.id, workspaceId, phase: 'workspace', outcome: 'unknown', recoveryRequired: true } } }).returning();
    if (owner === 'issue') await issueService(db).remove(f.parent.id); else await projectService(db).remove(f.project.id, { withIssues: true });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, original.id)))[0]).toEqual(original);
  });

});
