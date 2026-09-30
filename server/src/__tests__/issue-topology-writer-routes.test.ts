import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { activityLog, companies, createDb, executionWorkspaces, instanceSettings, issueComments, issueThreadInteractions, issues, projects, type Db } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { issueRoutes } from '../routes/issues.js';
import { projectRoutes } from '../routes/projects.js';
import { companyRoutes } from '../routes/companies.js';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';
import { buildHostServices } from '../services/plugin-host-services.js';
import { publishLiveEvent } from '../services/live-events.js';
import type { StorageService } from '../storage/types.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
const effects = vi.hoisted(() => ({ wakeup: vi.fn(async () => null), cancelRun: vi.fn(), reportRunActivity: vi.fn(), cancelIssueRuns: vi.fn(async () => []), resumeIssue: vi.fn() }));
vi.mock('../services/heartbeat.js', () => ({ heartbeatService: () => effects }));
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));

describe('topology canonical HTTP with actual middleware and PostgreSQL', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, server: Server, base: string;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('topology-http-'); db = createDb(temp.connectionString);
    await db.insert(instanceSettings).values({ experimental: { enableIsolatedWorkspaces: true } });
    const app = express(); app.use(express.json()); app.use(actorMiddleware(db, { deploymentMode: 'local_trusted' }));
    app.use('/api', issueRoutes(db, { deleteObject: vi.fn() } as unknown as StorageService));
    app.use('/api', projectRoutes(db)); app.use('/api/companies', companyRoutes(db)); app.use(errorHandler);
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); });
  async function fixture() {
    const [company, foreign] = await db.insert(companies).values(['HTTP local', 'Private company'].map(name => ({ name, issuePrefix: randomUUID().slice(0, 8) }))).returning();
    const [project, otherProject] = await db.insert(projects).values(['Target', 'Other'].map(name => ({ companyId: company.id, name }))).returning();
    const [parent, other] = await db.insert(issues).values([{ companyId: company.id, projectId: project.id, title: 'Parent' }, { companyId: company.id, projectId: otherProject.id, title: 'Other' }]).returning();
    const [foreignIssue] = await db.insert(issues).values({ companyId: foreign.id, title: 'Private title' }).returning();
    return { company, foreign, project, otherProject, parent, other, foreignIssue };
  }
  const request = (path: string, method: string, body?: unknown) => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  it('creates, reparents across projects, creates a child and deletes through canonical routes', async () => {
    const f = await fixture();
    const created = await request(`/companies/${f.company.id}/issues`, 'POST', { title: 'Created', projectId: f.otherProject.id, parentId: f.parent.id, status: 'backlog' });
    expect(created.status).toBe(201); const issue = await created.json(); expect(issue.parentId).toBe(f.parent.id);
    expect((await request(`/issues/${issue.id}`, 'PATCH', { parentId: f.other.id })).status).toBe(200);
    const child = await request(`/issues/${f.parent.id}/children`, 'POST', { title: 'Child', blockParentUntilDone: true }); expect(child.status).toBe(201);
    expect((await request(`/issues/${issue.id}`, 'DELETE')).status).toBe(200);
    expect(await db.select().from(issues).where(eq(issues.id, issue.id))).toEqual([]);
    expect((await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).map(row => row.action)).toContain('issue.deleted');
  });
  it.each(['create', 'patch', 'plugin'] as const)('%s foreign parent refuses without disclosing or mutating private state', async kind => {
    const f = await fixture(); vi.mocked(publishLiveEvent).mockClear(); effects.wakeup.mockClear();
    if (kind === 'plugin') {
      const host = buildHostServices(db, randomUUID(), 'topology-test', { forPlugin: () => ({ clear: vi.fn() }) } as any);
      try {
        await expect(host.issues.update({ companyId: f.company.id, issueId: f.parent.id, patch: { parentId: f.foreignIssue.id } })).rejects.toMatchObject({ status: 422 });
        await expect(host.issues.update({ companyId: f.company.id, issueId: f.parent.id, patch: { companyId: f.foreign.id } })).rejects.toMatchObject({ status: 422 });
      } finally { host.dispose(); }
    } else {
      const response = await request(kind === 'create' ? `/companies/${f.company.id}/issues` : `/issues/${f.parent.id}`, kind === 'create' ? 'POST' : 'PATCH', { ...(kind === 'create' ? { title: 'Refuse' } : {}), parentId: f.foreignIssue.id });
      expect([404, 422]).toContain(response.status); const body = await response.text(); expect(body).not.toContain(f.foreignIssue.id); expect(body).not.toContain(f.foreignIssue.title);
    }
    expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toHaveLength(2);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]); expect(effects.wakeup).not.toHaveBeenCalled(); expect(publishLiveEvent).not.toHaveBeenCalled();
  });
  it.each(['issue', 'project', 'company'] as const)('%s HTTP deletion privately refuses foreign child/source before cleanup', async owner => {
    for (const kind of ['child', 'source']) {
      const f = await fixture();
      await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.parent.id, body: 'Preserve' });
      if (kind === 'child') await db.update(issues).set({ parentId: f.parent.id }).where(eq(issues.id, f.foreignIssue.id));
      else await db.insert(executionWorkspaces).values({ companyId: f.foreign.id, projectId: f.project.id, sourceIssueId: f.parent.id, name: 'Private workspace', mode: 'shared_workspace', strategyType: 'project_primary' });
      vi.mocked(publishLiveEvent).mockClear(); effects.wakeup.mockClear();
      const response = await request(owner === 'issue' ? `/issues/${f.parent.id}` : owner === 'project' ? `/projects/${f.project.id}?withIssues=true` : `/companies/${f.company.id}`, 'DELETE');
      expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'Issue topology is unavailable for deletion' });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.parent.id))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]); expect(publishLiveEvent).not.toHaveBeenCalled(); expect(effects.wakeup).not.toHaveBeenCalled();
    }
  });
  it('accepts selected suggestions once and rejects an invalid parent without a claim or partial children', async () => {
    const f = await fixture(), svc = issueThreadInteractionService(db);
    for (const invalid of [false, true]) {
      const interaction = await svc.create(f.parent, { kind: 'suggest_tasks', payload: { version: 1, tasks: [{ clientKey: 'a', title: 'Selected', ...(invalid ? { parentId: f.foreignIssue.id } : {}) }, { clientKey: 'b', title: 'Unselected' }] } }, { userId: 'local-board' });
      const before = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
      const response = await request(`/issues/${f.parent.id}/interactions/${interaction.id}/accept`, 'POST', { selectedClientKeys: ['a'] }); expect(response.status).toBe(invalid ? 422 : 200);
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0].status).toBe(invalid ? 'pending' : 'accepted');
      if (invalid) expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual(before);
      else expect((await request(`/issues/${f.parent.id}/interactions/${interaction.id}/accept`, 'POST', {})).status).toBe(409);
    }
    expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toHaveLength(3);
  });
  it('deletes empty project, project with issues and company with ordinary HTTP responses', async () => {
    const f = await fixture();
    const [empty] = await db.insert(projects).values({ companyId: f.company.id, name: 'Empty' }).returning();
    expect((await request(`/projects/${empty.id}`, 'DELETE')).status).toBe(200);
    expect((await request(`/projects/${f.project.id}?withIssues=true`, 'DELETE')).status).toBe(200);
    expect((await request(`/companies/${f.company.id}`, 'DELETE')).status).toBe(200);
  });
  it('canonical reparent waits for the lower parent before taking the higher target row', async () => {
    const f = await fixture(), [lowerId, higherId] = [f.parent.id, f.other.id].sort();
    let release!: () => void, ready!: () => void, ownerPid = 0;
    const releasePromise = new Promise<void>(resolve => { release = resolve; }), readyPromise = new Promise<void>(resolve => { ready = resolve; });
    const blocker = db.transaction(async tx => {
      ownerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
      await tx.select().from(issues).where(eq(issues.id, lowerId)).for('update'); ready(); await releasePromise;
    });
    await readyPromise;
    const pending = request(`/issues/${higherId}`, 'PATCH', { parentId: lowerId });
    try {
      let waiter: Record<string, unknown> | undefined;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !waiter) {
        waiter = (await db.execute(sql`select pid, query from pg_stat_activity where ${ownerPid} = any(pg_blocking_pids(pid))`))[0];
        if (!waiter) await new Promise(resolve => setImmediate(resolve));
      }
      expect(waiter).toBeDefined(); expect(Number(waiter!.pid)).not.toBe(ownerPid);
      console.log(JSON.stringify({ label: 'HTTP reparent sorted union', ownerPid, waiter }));
      // A third backend can lock the higher row while the ordered query waits at lower.
      await db.transaction(async tx => { await tx.execute(sql`select id from issues where id = ${higherId} for update nowait`); });
    } finally { release(); await blocker; await pending; }
    expect((await db.select().from(issues).where(eq(issues.id, higherId)))[0].parentId).toBe(lowerId);
  });

});
