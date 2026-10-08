import { companyLockQuery, observeExpectedWaiter } from './helpers/observed-lock-wait.js';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { companies, createDb, instanceSettings, issues, projects, projectWorkspaces, type Db } from '@paperclipai/db';
import { applyMergePlan } from '../../../cli/src/commands/worktree.js';
import { issuePatchActions, type IssuePatchContext } from '../services/issue-patch-actions.js';
import { issueCurrentAuthority } from '../services/issue-current-authority.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));

describe('actual CLI topology apply vs canonical acceptance', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('cli-topology-order-'); db = createDb(temp.connectionString); await db.insert(instanceSettings).values({}); });
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); });
  function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { open, promise }; }
  it.each(['writer-first', 'acceptance-first'])('%s observes distinct company-lock wait before project/workspace/child insertion', async order => {
    const [company] = await db.insert(companies).values({ name: 'CLI ordering', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [parent] = await db.insert(issues).values({ companyId: company.id, title: 'Canonical parent' }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: 'Imported project' }).returning();
    const [workspace] = await db.insert(projectWorkspaces).values({ companyId: company.id, projectId: project.id, name: 'Imported workspace', sourceType: 'local_path', cwd: '/disposable/not-executed' }).returning();
    await db.delete(projectWorkspaces).where(eq(projectWorkspaces.id, workspace.id)); await db.delete(projects).where(eq(projects.id, project.id));
    const childId = randomUUID(); const plan: any = { projectImports: [{ source: project, targetGoalId: null, targetLeadAgentId: null, workspaces: [workspace] }], issuePlans: [{ action: 'insert', source: { ...parent, id: childId, parentId: parent.id, title: 'Imported child' }, targetProjectId: project.id, targetProjectWorkspaceId: workspace.id, targetGoalId: null, targetStatus: 'backlog', targetAssigneeAgentId: null, targetCreatedByAgentId: null }], commentPlans: [], documentPlans: [], attachmentPlans: [] };
    const storage = { provider: 'local_disk' as const, identity: 'fixture', getObject: vi.fn(), putObject: vi.fn(), createObjectIfAbsent: vi.fn() };
    const ready = gate(), release = gate(); let ownerPid = 0;
    const root = new Proxy(db, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return (work: any) => target.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '6s'`); const result = await work(tx);
      if (order === 'writer-first') { ownerPid = Number((await tx.execute(sql`select pg_backend_pid() pid`))[0].pid); ready.open(); await release.promise; }
      return result;
    }); } });
    const authority = issueCurrentAuthority({ actor: { type: 'board', source: 'local_implicit' } } as Request);
    const context: IssuePatchContext = { issueId: parent.id, companyId: company.id, actor: { actorType: 'user', actorId: 'local', agentId: null, runId: null }, actorKind: 'board', intent: { title: 'Accepted parent' }, attribution: {}, validate: async () => undefined, validateResume: async () => undefined, validateAssignment: async () => undefined,
      stageAuthority: async (...args) => { const guard = await authority(...args); if (order === 'acceptance-first') { ownerPid = Number((await args[0].execute(sql`select pg_backend_pid() pid`))[0].pid); ready.open(); await release.promise; } return guard; } };
    const write = () => applyMergePlan({ sourceStorages: [storage], targetStorage: storage, targetDb: root, company, plan });
    const accept = () => issuePatchActions(db, { wakeup: vi.fn(), cancelRun: vi.fn(), reportRunActivity: vi.fn() } as any).accept(context);
    const first = order === 'writer-first' ? write() : accept(); await Promise.race([ready.promise, first.then(() => { throw new Error('Owner escaped barrier'); })]);
    const second = order === 'writer-first' ? accept() : write(); const settled = Promise.allSettled([first, second]); let blocked: any;
    try { blocked = await observeExpectedWaiter({ sample: () => db.execute(sql`select pid, query, pg_blocking_pids(pid) blockers from pg_stat_activity where ${ownerPid} = any(pg_blocking_pids(pid))`), ownerPid, contender: second, label: order, expectedQuery: companyLockQuery, timeoutMs: 4000 });
      expect(blocked).toBeTruthy(); expect(Number(blocked.pid)).not.toBe(ownerPid); expect(blocked.query).toMatch(/companies.*for (?:no key )?update/i); console.log(JSON.stringify({ order, ownerPid, waiter: blocked }));
      expect(await db.select().from(projects).where(eq(projects.id, project.id))).toEqual([]); expect(await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, workspace.id))).toEqual([]); expect(await db.select().from(issues).where(eq(issues.id, childId))).toEqual([]);
    } finally { release.open(); await settled; }
    const results = await settled; expect(results.map(row => row.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await db.select().from(issues).where(eq(issues.id, childId))).toEqual([expect.objectContaining({ parentId: parent.id, projectId: project.id, projectWorkspaceId: workspace.id })]);
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(1); expect(await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, workspace.id))).toHaveLength(1);
  });
});
