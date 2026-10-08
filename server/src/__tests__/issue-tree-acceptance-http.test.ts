import { companyLockQuery, observeExpectedWaiter } from './helpers/observed-lock-wait.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyMergePlan, createConfiguredStorageFromPaperclipConfig } from '../../../cli/src/commands/worktree.js';
import { routineService } from '../services/routines.js';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { Db } from '@paperclipai/db';
import { issueTreeCurrentAuthority } from '../services/issue-current-authority.js';
import { issueService } from '../services/issues.js';
import { projectService } from '../services/projects.js';
import { companyService } from '../services/companies.js';
import { executionWorkspaceService } from '../services/execution-workspaces.js';
import type { ActivityPublication } from '../services/activity-log.js';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { activityLog, agents, agentApiKeys, authSessions, authUsers, boardApiKeys, companies, companyMemberships, createDb, issueComments, issues, projects, projectAccess, principalPermissionGrants, instanceUserRoles, assistantAccessTokens, assistantGrants, executionWorkspaces, heartbeatRuns, projectWorkspaces, environments, instanceSettings, routines, agentWakeupRequests, issueTreeHolds, issueTreeHoldMembers } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { issueTreeControlRoutes } from '../routes/issue-tree-control.js';
import { issueTreeControlService } from '../services/issue-tree-control.js';
import { createLocalAgentJwt } from '../agent-auth-jwt.js';
import { agentService } from '../services/agents.js';
import { assistantOAuthService } from '../services/assistant-oauth.js';
import { mintAssistantLoopbackToken, revokeAssistantLoopbackToken, resetAssistantLoopbackTokens } from '../services/assistant-loopback.js';
import { publishLiveEvent } from '../services/live-events.js';
import { hashBearerToken } from '../services/board-auth.js';
import type { StorageService } from '../storage/types.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
const effects = vi.hoisted(() => ({ cancelRun: vi.fn(), wakeup: vi.fn(), reportRunActivity: vi.fn() }));
vi.mock('../services/heartbeat.js', () => ({ heartbeatService: () => effects }));
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));

describe('tree acceptance authority over real middleware, HTTP and PostgreSQL', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, server: Server, base: string;
  let actualRequest: Request, routeExecutor: Db;
  let beforeReadAuthority: (() => Promise<void>) | undefined;
  let readHoldQueries = 0;
  function readProjectionBarrier(builder: any, table: unknown) {
    if (table !== issueTreeHolds || !beforeReadAuthority || ++readHoldQueries !== 2) return builder;
    const barrier = beforeReadAuthority, then = builder.then.bind(builder);
    beforeReadAuthority = undefined;
    builder.then = (resolve: Function, reject: Function) => barrier().then(() => then(resolve, reject));
    return builder;
  }
  let beforeSettingsRead: (() => void) | undefined;
  let acceptancePid: number | undefined;
  let beforeFirstPrepare: (() => Promise<void>) | undefined;
  let beforeIssueLock: (() => Promise<void>) | undefined;
  let afterAuthentication: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('issue-current-authority-');
    db = createDb(temp.connectionString);
    const routeDb = new Proxy(db, { get(target, key, receiver) {
      if (key === 'select') return (...args: unknown[]) => {
        const query = (target.select as Function)(...args), from = query.from.bind(query);
        query.from = (table: unknown) => readProjectionBarrier(from(table), table);
        return query;
      };
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      return (callback: (tx: unknown) => Promise<unknown>, config?: unknown) => target.transaction(async tx => {
        acceptancePid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
        let issueSelectCount = 0;
        return callback(new Proxy(tx, { get(t, k, r) {
        if (k !== 'select') return Reflect.get(t, k, r);
        return (...args: unknown[]) => {
          const query = (t.select as Function)(...args);
          const from = query.from.bind(query);
          query.from = (table: unknown) => {
            const builder = readProjectionBarrier(from(table), table), originalFor = builder.for.bind(builder);
            if (table === issues && ++issueSelectCount === 2 && beforeFirstPrepare) {
              const barrier = beforeFirstPrepare, then = builder.then.bind(builder);
              beforeFirstPrepare = undefined;
              builder.then = (resolve: Function, reject: Function) => barrier().then(() => then(resolve, reject));
            }
            if (table === instanceSettings && beforeSettingsRead) {
              const then = builder.then.bind(builder), barrier = beforeSettingsRead; beforeSettingsRead = undefined;
              builder.then = (resolve: Function, reject: Function) => then((rows: unknown) => { barrier(); return resolve(rows); }, reject);
            }
            builder.for = (mode: string) => {
              const result = originalFor(mode);
              if (table !== issues || mode !== 'update' || !beforeIssueLock) return result;
              const barrier = beforeIssueLock; beforeIssueLock = undefined;
              return { then: (resolve: Function, reject: Function) => barrier().then(() => result).then(resolve, reject) };
            };
            return builder;
          };
          return query;
        };
      } })); }, config as never);
    } });
    routeExecutor = routeDb;
    const app = express(); app.use(express.json());
    const local = express.Router(); local.use(actorMiddleware(db, { deploymentMode: 'local_trusted' }));
    local.use(issueTreeControlRoutes(routeDb)); app.use('/local/api', local);
    app.use(actorMiddleware(db, { deploymentMode: 'authenticated', resolveSession: async req => {
      const token = req.header('cookie')?.replace(/^test-session=/, '');
      if (!token) return null;
      const [session] = await db.select().from(authSessions).where(eq(authSessions.token, token));
      if (!session || session.expiresAt.getTime() <= Date.now()) return null;
      const [user] = await db.select().from(authUsers).where(eq(authUsers.id, session.userId));
      return user ? { session: { id: session.id, userId: session.userId }, user } : null;
    } }));
    app.use(async (_req, _res, next) => { try { actualRequest = _req; await afterAuthentication?.(); next(); } catch (e) { next(e); } });
    app.use('/api', issueTreeControlRoutes(routeDb)); app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  beforeEach(() => { beforeReadAuthority = undefined; readHoldQueries = 0; beforeSettingsRead = undefined; beforeFirstPrepare = undefined; afterAuthentication = undefined; beforeIssueLock = undefined; resetAssistantLoopbackTokens(); vi.restoreAllMocks(); vi.clearAllMocks(); });
  // Close the pool before the embedded server stops — stopping postgres under
  // open sockets is what surfaced as CONNECTION_DESTROYED during cleanup.
  afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await db?.$client.end({ timeout: 5 }); await temp?.cleanup(); });
  async function fixture() {
    const userId = randomUUID(), token = `pcp_board_${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: 'Human', email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    const [key] = await db.insert(boardApiKeys).values({ userId, name: 'Disposable', keyHash: hashBearerToken(token), expiresAt: new Date(Date.now() + 60000) }).returning();
    const [company] = await db.insert(companies).values({ name: 'Authority test', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [membership] = await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: userId, membershipRole: 'member', status: 'active' }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: 'Private', visibility: 'company' }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: 'Original', status: 'backlog' }).returning();
    return { userId, token, key, company, membership, project, issue };
  }
  async function request(f: Awaited<ReturnType<typeof fixture>>, path: string, body?: unknown) {
    return fetch(`${base}/issues/${f.issue.id}/${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  it.each(['tree-control/preview', 'tree-holds'])('refuses mixed-private current subtree at %s without effects', async path => {
    const f = await fixture();
    const [privateProject] = await db.insert(projects).values({ companyId: f.company.id, name: 'Secret', visibility: 'restricted' }).returning();
    await db.insert(issues).values({ companyId: f.company.id, projectId: privateProject.id, parentId: f.issue.id, title: 'Private child' });
    const response = await request(f, path, { mode: 'cancel' });
    expect(response.status).toBe(404); expect(await response.text()).not.toContain('Private child');
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, f.company.id))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]);
    expect(effects.cancelRun).not.toHaveBeenCalled(); expect(publishLiveEvent).not.toHaveBeenCalled();
  });
  it.each(['tree-holds', 'tree-holds?includeMembers=true', 'state', 'detail', 'release', 'resume'])('refuses a moved private historical source for %s', async kind => {
    const f = await fixture();
    const [child] = await db.insert(issues).values({ companyId: f.company.id, parentId: f.issue.id, title: 'Private history' }).returning();
    const held = await issueTreeControlService(db).createHold(f.company.id, f.issue.id, { mode: 'pause', actor: { actorType: 'user', actorId: f.userId } });
    const [privateProject] = await db.insert(projects).values({ companyId: f.company.id, name: 'Secret', visibility: 'restricted' }).returning();
    await db.update(issues).set({ parentId: null, projectId: privateProject.id }).where(eq(issues.id, child.id));
    const path = kind === 'state' ? 'tree-control/state' : kind === 'detail' ? `tree-holds/${held.hold.id}` : kind === 'release' ? `tree-holds/${held.hold.id}/release` : kind === 'resume' ? 'tree-holds' : kind;
    const response = await request(f, path, kind === 'release' ? {} : kind === 'resume' ? { mode: 'resume' } : undefined);
    expect(response.status).toBe(404); expect(await response.text()).not.toContain('Private history');
    expect((await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, held.hold.id)))[0].status).toBe('active');
  });
  it.each(['detail', 'members', 'summary', 'state', 'descendant-summary', 'descendant-state'] as const)('never returns an old private %s projection after its source is deleted', async kind => {
    const f = await fixture(), svc = issueTreeControlService(db);
    const [child] = await db.insert(issues).values({ companyId: f.company.id, parentId: f.issue.id, title: 'Secret retained snapshot', identifier: `SECRET-HISTORY-${randomUUID()}` }).returning();
    const held = await svc.createHold(f.company.id, f.issue.id, { mode: 'pause', actor: { actorType: 'user', actorId: f.userId } });
    const [privateProject] = await db.insert(projects).values({ companyId: f.company.id, name: 'Restricted history', visibility: 'restricted' }).returning();
    await issueService(db).update(child.id, { parentId: kind.startsWith('descendant-') ? f.issue.id : null, projectId: privateProject.id });
    const projected = gate(), continueRead = gate(), deletionStarted = gate();
    let deletionPid = 0;
    const deletionDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      return (work: (tx: unknown) => Promise<unknown>) => target.transaction(async tx => {
        deletionPid = Number((await tx.execute(sql`select pg_backend_pid() pid`))[0].pid);
        deletionStarted.open();
        return work(tx);
      });
    } });
    beforeReadAuthority = async () => { projected.open(); await continueRead.promise; };
    const endpoint = kind === 'detail' ? `tree-holds/${held.hold.id}` : kind === 'members' ? 'tree-holds?includeMembers=true' : kind.endsWith('state') ? 'tree-control/state' : 'tree-holds';
    const pendingRead = request(f, endpoint);
    await projected.promise;
    const deletion = issueService(deletionDb).remove(child.id);
    await deletionStarted.promise;
    // #881 review P2: readback takes no row locks. It projects and authorizes
    // from one REPEATABLE READ snapshot, so the deletion commits without
    // waiting, and the reader still refuses (its snapshot holds the restricted
    // source) instead of returning a projection authorized against a later state.
    await deletion;
    continueRead.open();
    const response = await pendingRead, body = await response.text();
    expect(deletionPid).toBeGreaterThan(0);
    expect(response.status).toBe(404);
    expect(body).not.toContain('Secret retained snapshot');
    expect(body).not.toContain('SECRET-HISTORY');
    expect(body).not.toContain(child.id);
    expect((await request(f, endpoint)).status).toBe(200);
  });
  it('refuses audited preview when credential expires during audit settings read', async () => {
    const f = await fixture();
    beforeSettingsRead = () => { vi.spyOn(Date, 'now').mockReturnValue(f.key.expiresAt!.getTime()); };
    const response = await request(f, 'tree-control/preview', { mode: 'pause' });
    expect(response.status).toBe(401);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]);
    expect(publishLiveEvent).not.toHaveBeenCalled(); expect(effects.cancelRun).not.toHaveBeenCalled();
  });

  async function serviceContext(f: Awaited<ReturnType<typeof fixture>>) {
    expect((await request(f, 'tree-holds')).status).toBe(200);
    return { companyId: f.company.id, rootIssueId: f.issue.id, actor: { actorType: 'user' as const, actorId: f.userId, userId: f.userId }, authority: issueTreeCurrentAuthority(actualRequest) };
  }
  it('plans SELECT-only; updatedAt is not a pin fact; supplied outer rollback keeps the exact collector private', async () => {
    const f = await fixture(), ctx = await serviceContext(f), svc = issueTreeControlService(db), intent = { kind: 'create' as const, input: { mode: 'cancel' as const } };
    const reader = new Proxy(db, { get(target, key, receiver) { if (['transaction','insert','update','delete','execute'].includes(String(key))) return () => { throw new Error('Preparation wrote'); }; return Reflect.get(target,key,receiver); } });
    const before = await svc.planAction(ctx,intent,reader);
    await db.update(issues).set({ updatedAt: new Date(Date.now()+1000) }).where(eq(issues.id,f.issue.id));
    expect((await svc.planAction(ctx,intent,reader)).pin).toEqual(before.pin);
    const publications: ActivityPublication[] = []; vi.mocked(publishLiveEvent).mockClear();
    const forbiddenRoot = new Proxy(db, { get(target,key,receiver) { if (['transaction','select','insert','update','delete','execute'].includes(String(key))) return () => { throw new Error('Root executor escaped'); }; return Reflect.get(target,key,receiver); } });
    await expect(db.transaction(async tx => {
      const result = await issueTreeControlService(forbiddenRoot).acceptAction(ctx,intent,{ expected: before.pin, acceptance: { executor: tx as unknown as Db, publications } });
      expect(result.updatedIssueIds).toEqual([f.issue.id]); expect(publications).toHaveLength(2); expect(publishLiveEvent).not.toHaveBeenCalled();
      expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id))).toEqual([]);
      throw new Error('Outer rollback');
    })).rejects.toThrow('Outer rollback');
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).toEqual([]);
  });
  it.each(['insert','reparent','delete','status','assignment','workspace-metadata','workspace-source'] as const)('rejects a stale %s pin without a hold/audit/runtime effect', async change => {
    const f = await fixture(), svc = issueTreeControlService(db);
    const [agent] = await db.insert(agents).values({ companyId:f.company.id,name:'Agent' }).returning();
    const [child] = await db.insert(issues).values({ companyId:f.company.id,parentId:f.issue.id,title:'Child' }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId:f.company.id,projectId:f.project.id,sourceIssueId:child.id,name:'Source',mode:'shared_workspace',strategyType:'project_primary' }).returning();
    await db.update(issues).set({ executionWorkspaceId:workspace.id }).where(eq(issues.id,f.issue.id));
    const ctx = await serviceContext(f), intent = { kind:'create' as const,input:{mode:'pause' as const} }, prepared = await svc.planAction(ctx,intent);
    if(change==='insert') await issueService(db).create(f.company.id,{ title:'Inserted',parentId:child.id });
    if(change==='reparent') await issueService(db).update(child.id,{parentId:null});
    if(change==='delete') await issueService(db).remove(child.id);
    if(change==='status') await issueService(db).update(child.id,{status:'todo'});
    if(change==='assignment') await issueService(db).update(child.id,{assigneeAgentId:agent.id});
    if(change==='workspace-metadata') await executionWorkspaceService(db).update(workspace.id,{metadata:{changed:true}});
    if(change==='workspace-source') await executionWorkspaceService(db).update(workspace.id,{sourceIssueId:null});
    vi.mocked(publishLiveEvent).mockClear();
    await expect(svc.acceptAction(ctx,intent,{expected:prepared.pin})).rejects.toMatchObject({status:409});
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).toEqual([]);
    expect(effects.cancelRun).not.toHaveBeenCalled(); expect(publishLiveEvent).not.toHaveBeenCalled();
  });
  it.each(['canonical', 'root', 'supplied'] as const)('preserves snapshot, release and exact queue behavior for %s callers', async caller => {
    for (const releasePolicy of [undefined, null]) {
      const f = await fixture(), svc = issueTreeControlService(db), ctx = await serviceContext(f);
      const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'Snapshot assignee' }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, status: 'running', contextSnapshot: { issueId: f.issue.id } }).returning();
      await db.update(issues).set({ status: 'in_progress', assigneeAgentId: agent.id, executionRunId: run.id }).where(eq(issues.id, f.issue.id));
      const [child] = await db.insert(issues).values({ companyId: f.company.id, parentId: f.issue.id, title: 'Terminal snapshot', status: 'done' }).returning();
      const queued = await db.insert(agentWakeupRequests).values(['queued', 'deferred_issue_execution', 'queued', 'claimed'].map((status, index) => ({
        companyId: f.company.id, agentId: agent.id, source: 'assignment', status,
        runId: index === 2 ? run.id : null, payload: { issueId: f.issue.id },
      }))).returning();
      const policy = { strategy: 'manual' as const, note: 'Preserve stored policy' };
      const input = { mode: 'pause' as const, reason: 'Human pause', releasePolicy: policy };
      const releaseInput = { reason: 'Human release', releasePolicy, metadata: { disposition: 'reviewed' } };
      const expectedQueueIds = queued.slice(0, 2).map(row => row.id).sort();
      let holdId = '';
      if (caller === 'canonical') {
        const accepted = await svc.acceptAction(ctx, { kind: 'create', input });
        if (!('hold' in accepted.result)) throw new Error('Expected hold result');
        holdId = accepted.result.hold.id;
        expect(accepted.cancelledWakeupIds.sort()).toEqual(expectedQueueIds);
        await svc.acceptAction(ctx, { kind: 'release', holdId, input: releaseInput });
      } else {
        const work = async (acceptance?: { executor: Db; publications: ActivityPublication[] }) => {
          const created = await svc.createHold(f.company.id, f.issue.id, { ...input, actor: ctx.actor }, acceptance);
          holdId = created.hold.id;
          const changed = await svc.cancelUnclaimedWakeupsForTree(f.company.id, f.issue.id, 'Human pause', acceptance);
          expect(changed.map(row => row.id).sort()).toEqual(expectedQueueIds);
          await svc.releaseHold(f.company.id, f.issue.id, holdId, { ...releaseInput, actor: ctx.actor }, acceptance);
        };
        if (caller === 'supplied') await db.transaction(tx => work({ executor: tx as unknown as Db, publications: [] }));
        else await work();
      }
      const [hold] = await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, holdId));
      expect(hold).toMatchObject({ companyId: f.company.id, rootIssueId: f.issue.id, mode: 'pause', status: 'released', reason: 'Human pause',
        createdByActorType: 'user', createdByUserId: f.userId, createdByAgentId: null, createdByRunId: null,
        releasedByActorType: 'user', releasedByUserId: f.userId, releasedByAgentId: null, releasedByRunId: null,
        releaseReason: 'Human release', releasePolicy: policy, releaseMetadata: { disposition: 'reviewed' } });
      const members = await db.select().from(issueTreeHoldMembers).where(eq(issueTreeHoldMembers.holdId, holdId));
      expect(members).toEqual(expect.arrayContaining([
        expect.objectContaining({ companyId: f.company.id, issueId: f.issue.id, parentIssueId: null, depth: 0, issueTitle: f.issue.title, issueStatus: 'in_progress', assigneeAgentId: agent.id, activeRunId: run.id, activeRunStatus: 'running', skipped: false, skipReason: null }),
        expect.objectContaining({ issueId: child.id, parentIssueId: f.issue.id, depth: 1, issueTitle: child.title, issueStatus: 'done', skipped: true }),
      ]));
      const after = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id));
      expect(after.filter(row => row.status === 'cancelled').map(row => row.id).sort()).toEqual(expectedQueueIds);
      expect(after.find(row => row.id === queued[2].id)?.status).toBe('queued');
      expect(after.find(row => row.id === queued[3].id)?.status).toBe('claimed');
    }
  });
  it('atomically cancels statuses and exact unclaimed queues, retaining linked requests and skipped runs as exact effects', async () => {
    const f = await fixture(), ctx = await serviceContext(f), svc = issueTreeControlService(db);
    const [agent] = await db.insert(agents).values({ companyId:f.company.id,name:'Agent' }).returning();
    const [done] = await db.insert(issues).values({companyId:f.company.id,parentId:f.issue.id,title:'Done',status:'done'}).returning();
    const [run] = await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:agent.id,status:'running',invocationSource:'assignment',contextSnapshot:{issueId:done.id}}).returning();
    const requests = await db.insert(agentWakeupRequests).values(['queued','deferred_issue_execution','claimed','queued','queued'].map((status,index)=>({companyId:f.company.id,agentId:agent.id,source:'assignment',status,runId:index===3?run.id:null,payload:index===4?{}:{issueId:f.issue.id}}))).returning();
    const accepted = await svc.acceptAction(ctx,{kind:'create',input:{mode:'cancel'}});
    expect(accepted.cancelledWakeupIds.sort()).toEqual(requests.slice(0,2).map(row=>row.id).sort()); expect(accepted.updatedIssueIds).toEqual([f.issue.id]);
    expect(accepted.effects).toEqual([{kind:'cancelRun',runId:run.id,issueId:done.id,holdId:('hold' in accepted.result ? accepted.result.hold.id : '')}]);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,requests[3].id)))[0].status).toBe('queued');
    expect((await db.select().from(issues).where(eq(issues.id,done.id)))[0].status).toBe('done');
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).toHaveLength(4);
  });
  it.each(['cancelled','succeeded','failed','null','thrown','pending'] as const)('records truthful %s runtime evidence only after commit', async outcome => {
    const f = await fixture(), ctx = await serviceContext(f), svc = issueTreeControlService(db);
    const [agent] = await db.insert(agents).values({companyId:f.company.id,name:'Agent'}).returning();
    const [run] = await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:agent.id,status:'running',invocationSource:'assignment',contextSnapshot:{issueId:f.issue.id}}).returning();
    const accepted = await svc.acceptAction(ctx,{kind:'create',input:{mode:'pause'}});
    const cancelRun = vi.fn(async (id:string) => {
      expect(id).toBe(run.id);
      await db.transaction(async tx=>{ await tx.execute(sql`set local lock_timeout = '250ms'`); await tx.select().from(companies).where(eq(companies.id,f.company.id)).for('update'); });
      expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id))).toHaveLength(1);
      if(outcome==='thrown') throw new Error('private provider diagnostic');
      if(outcome==='pending') return new Promise<never>(()=>{});
      return outcome==='null'?null:{...run,status:outcome};
    });
    await svc.dispatchTreeEffects(accepted,{cancelRun,wakeup:vi.fn()} as any); expect(cancelRun).toHaveBeenCalledOnce();
    // The hold interrupt names its own reason so the run does not read as an
    // operator stop (cancelled_by_operator belongs to the cancel route only).
    expect(cancelRun).toHaveBeenCalledWith(run.id, "Interrupted: the issue was held by a subtree pause");
    const audits = await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id));
    expect(audits.some(row=>row.action==='issue.tree_hold_run_interrupted')).toBe(outcome==='cancelled');
    expect(audits.at(-1)?.details).toMatchObject({outcome});
  });
  it('rolls back hold, members, statuses and queue when its first audit insert fails',async()=>{
    const f=await fixture();
    const [agent]=await db.insert(agents).values({companyId:f.company.id,name:'Queue owner'}).returning();
    const [queued]=await db.insert(agentWakeupRequests).values({companyId:f.company.id,agentId:agent.id,source:'assignment',status:'queued',payload:{issueId:f.issue.id}}).returning();
    beforeSettingsRead=()=>{throw new Error('Deliberate audit failure');};
    expect((await request(f,'tree-holds',{mode:'cancel'})).status).toBe(500);
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id))).toEqual([]);
    expect(await db.select().from(issueTreeHoldMembers).where(eq(issueTreeHoldMembers.companyId,f.company.id))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).toEqual([]);
    expect((await db.select().from(issues).where(eq(issues.id,f.issue.id)))[0].status).toBe(f.issue.status);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,queued.id)))[0].status).toBe('queued');
    expect(publishLiveEvent).not.toHaveBeenCalled();expect(effects.cancelRun).not.toHaveBeenCalled();
  });
  it('reports accepted state after postcommit publication failure without compensation or runtime',async()=>{
    const f=await fixture();vi.mocked(publishLiveEvent).mockImplementationOnce(()=>{throw new Error('Private publication fault');});
    const response=await request(f,'tree-holds',{mode:'pause'}),body=await response.json();
    expect(response.status).toBe(409);expect(body.details).toMatchObject({persistenceOutcome:'accepted',rootIssueId:f.issue.id});
    expect(JSON.stringify(body)).not.toContain('Private publication fault');
    const holds=await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id));
    expect(holds).toHaveLength(1);expect(holds[0].status).toBe('active');expect(body.details.holdId).toBe(holds[0].id);
    expect(effects.cancelRun).not.toHaveBeenCalled();
  });
  it('dispatches restore wake after commit and records persisted queued evidence without claiming completion',async()=>{
    const f=await fixture(),svc=issueTreeControlService(db);
    const [agent]=await db.insert(agents).values({companyId:f.company.id,name:'Restored assignee'}).returning();
    await db.update(issues).set({status:'in_progress',assigneeAgentId:agent.id}).where(eq(issues.id,f.issue.id));
    const ctx=await serviceContext(f);await svc.acceptAction(ctx,{kind:'create',input:{mode:'cancel'}});
    const accepted=await svc.acceptAction(ctx,{kind:'create',input:{mode:'restore',metadata:{wakeAgents:true}}});
    expect(accepted.updatedIssueIds).toEqual([f.issue.id]);expect(accepted.effects).toHaveLength(1);
    const wakeup=vi.fn(async(agentId:string)=>{
      expect(agentId).toBe(agent.id);
      await db.transaction(async tx=>{await tx.execute(sql`set local lock_timeout = '250ms'`);await tx.select().from(companies).where(eq(companies.id,f.company.id)).for('update');});
      expect((await db.select().from(issues).where(eq(issues.id,f.issue.id)))[0].status).toBe('todo');
      return (await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:agent.id,status:'queued',contextSnapshot:{issueId:f.issue.id}}).returning())[0];
    });
    await svc.dispatchTreeEffects(accepted,{cancelRun:vi.fn(),wakeup} as any);
    expect(wakeup).toHaveBeenCalledOnce();
    const audits=await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id));
    expect(audits.at(-1)).toMatchObject({action:'issue.tree_restore_wakeup_requested',details:{outcome:'wake_queued'}});
  });
  it('unknown root commit keeps accepted data, never publishes or dispatches, and never replays', async () => {
    const f=await fixture(),ctx=await serviceContext(f);let callbacks=0;
    const root=new Proxy(db,{get(target,key,receiver){if(key!=='transaction') return Reflect.get(target,key,receiver); return async(work:(tx:unknown)=>Promise<unknown>)=>{await target.transaction(async tx=>{callbacks++;return work(tx);});throw new Error('private lost ack');};}});
    vi.mocked(publishLiveEvent).mockClear();
    await expect(issueTreeControlService(root).acceptAction(ctx,{kind:'create',input:{mode:'pause'}})).rejects.toMatchObject({status:409,details:{persistenceOutcome:'unknown',rootIssueId:f.issue.id}});
    expect(callbacks).toBe(1);expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id))).toHaveLength(1);
    expect(publishLiveEvent).not.toHaveBeenCalled();expect(effects.cancelRun).not.toHaveBeenCalled();
  });

  function gate() { let open!:()=>void; const promise=new Promise<void>(resolve=>{open=resolve;}); return {open,promise}; }
  async function observedWait(ownerPid: number, label: string, contender: Promise<unknown>, expectedQuery?: RegExp) {
    const row = await observeExpectedWaiter({
      sample: () => db.execute(sql`select pid, query, pg_blocking_pids(pid) blockers from pg_stat_activity where ${ownerPid} = any(pg_blocking_pids(pid))`),
      ownerPid, label, contender, timeoutMs: 4000, expectedQuery,
    });
    console.log(JSON.stringify({ label, ownerPid, waiter: row }));
    return row;
  }

  it.each(['create','child','reparent','remove','project','company','suggestion','routine','cli','workspace-create','workspace-source','workspace-metadata','issue-workspace-metadata'] as const)('%s orders both ways against production exact tree acceptance', async operation=>{
    for(const order of ['writer-first','tree-first']) {
      const f=await fixture(),ctx=await serviceContext(f),ready=gate(),release=gate();let ownerPid=0,paused=false;
      const [otherProject]=await db.insert(projects).values({companyId:f.company.id,name:'Survivor project'}).returning();
      const [child]=await db.insert(issues).values({companyId:f.company.id,projectId:otherProject.id,parentId:f.issue.id,title:'Descendant'}).returning();
      const [workspace]=await db.insert(executionWorkspaces).values({companyId:f.company.id,projectId:f.project.id,sourceIssueId:f.issue.id,name:'Self',mode:'shared_workspace',strategyType:'project_primary'}).returning();
      const [survivingWorkspace]=await db.insert(executionWorkspaces).values({companyId:f.company.id,projectId:otherProject.id,sourceIssueId:f.issue.id,name:'Surviving',mode:'shared_workspace',strategyType:'project_primary'}).returning();
      await db.update(issues).set({executionWorkspaceId:workspace.id}).where(eq(issues.id,f.issue.id));
      await db.update(issues).set({executionWorkspaceId:survivingWorkspace.id}).where(eq(issues.id,child.id));
      const interaction=operation==='suggestion'?await issueThreadInteractionService(db).create(f.issue,{kind:'suggest_tasks',payload:{version:1,tasks:[{clientKey:'task',title:'Suggested'}]}},{userId:f.userId}):null;
      const [agent]=await db.insert(agents).values({companyId:f.company.id,name:'Fake runtime'}).returning();
      const routine=operation==='routine'?(await db.insert(routines).values({companyId:f.company.id,title:'Routine child',parentIssueId:f.issue.id,assigneeAgentId:agent.id,concurrencyPolicy:'always_enqueue'}).returning())[0]:null;
      const storageDir=operation==='cli'?await mkdtemp(path.join(tmpdir(),'tree-cli-')):null;
      const storage=storageDir?createConfiguredStorageFromPaperclipConfig({storage:{provider:'local_disk',localDisk:{baseDir:storageDir}}} as any):null;
      const ownerRoot=(side:string)=>new Proxy(db,{get(target,key,receiver){if(key!=='transaction')return Reflect.get(target,key,receiver);return (work:(tx:unknown)=>Promise<unknown>)=>target.transaction(async tx=>{
        await tx.execute(sql`set local statement_timeout = '8s'`);const result=await work(tx);
        if(!paused&&((order==='writer-first'&&side==='writer')||(order==='tree-first'&&side==='tree'))){paused=true;ownerPid=Number((await tx.execute(sql`select pg_backend_pid() pid`))[0].pid);ready.open();await release.promise;}return result;
      });}});
      const writer=ownerRoot('writer'),tree=issueTreeControlService(ownerRoot('tree'));
      const write=()=>{
        const svc=issueService(writer);
        if(operation==='create')return svc.create(f.company.id,{title:'Inserted',parentId:child.id});
        if(operation==='child')return svc.createChild(child.id,{title:'Inserted child',blockParentUntilDone:true});
        if(operation==='reparent')return svc.update(child.id,{parentId:null});
        if(operation==='remove')return svc.remove(f.issue.id);
        if(operation==='project')return projectService(writer).remove(f.project.id,{withIssues:true});
        if(operation==='company')return companyService(writer).remove(f.company.id);
        if(operation==='suggestion')return issueThreadInteractionService(writer).acceptSuggestedTasks(f.issue,interaction!.id,{}, {userId:f.userId});
        if(operation==='routine')return routineService(writer,{heartbeat:{wakeup:vi.fn(async()=>null)}}).runRoutine(routine!.id,{source:'manual'});
        if(operation==='cli')return applyMergePlan({sourceStorages:[storage!],targetStorage:storage!,targetDb:writer,company:f.company,plan:{projectImports:[],issuePlans:[{action:'insert',source:{...child,id:randomUUID(),title:'Imported child'},targetProjectId:otherProject.id,targetProjectWorkspaceId:null,targetGoalId:null,targetStatus:'backlog',targetAssigneeAgentId:null,targetCreatedByAgentId:null}],commentPlans:[],documentPlans:[],attachmentPlans:[]} as any});
        if(operation==='workspace-create')return executionWorkspaceService(writer).create({companyId:f.company.id,projectId:f.project.id,sourceIssueId:f.issue.id,name:'New workspace',mode:'shared_workspace',strategyType:'project_primary'});
        if(operation==='workspace-source')return executionWorkspaceService(writer).update(workspace.id,{sourceIssueId:null});
        if(operation==='workspace-metadata')return executionWorkspaceService(writer).update(workspace.id,{metadata:{accepted:'writer'}});
        return svc.update(f.issue.id,{executionWorkspaceSettings:{mode:'reuse_existing'}});
      };
      const accept=()=>tree.acceptAction(ctx,{kind:'create',input:{mode:'pause'}});
      const first=order==='writer-first'?write():accept();await Promise.race([ready.promise,first.then(()=>{throw new Error('Owner escaped barrier');})]);
      const second=order==='writer-first'?accept():write(),settled=Promise.allSettled([first,second]);
      try {expect(String((await observedWait(ownerPid,`${operation}/${order}`,second,companyLockQuery)).query)).toMatch(/companies.*for (?:no key )?update/i);}
      finally{release.open();await settled;}
      const results=await settled;expect(results[0].status).toBe('fulfilled');
      const deleted=['remove','project','company'].includes(operation);
      if(order==='writer-first'&&deleted)expect(results[1]).toMatchObject({status:'rejected',reason:{status:404}});
      else {
        expect(results[1].status).toBe('fulfilled');
        const accepted=(results[order==='writer-first'?1:0] as PromiseFulfilledResult<any>).value;
        expect(accepted.acceptedIssueIds).toContain(f.issue.id);
        if(order==='tree-first')expect(accepted.acceptedIssueIds.sort()).toEqual([f.issue.id,child.id].sort());
        else if(operation==='reparent')expect(accepted.acceptedIssueIds).toEqual([f.issue.id]);
        else if(['create','child','suggestion','routine','cli'].includes(operation))expect(accepted.acceptedIssueIds).toHaveLength(3);
        else expect(accepted.acceptedIssueIds).toHaveLength(2);
      }
      if(['remove','project'].includes(operation))expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id,survivingWorkspace.id)))[0].sourceIssueId).toBeNull();
      if(storageDir)await rm(storageDir,{recursive:true,force:true});
    }
  });

  it.each(['credential','membership','project-access'] as const)('locks the complete %s witness union in both revocation orders',async resource=>{
    for(const order of ['tree-first','revocation-first']){
      const f=await fixture(),ready=gate(),release=gate(),writerReady=gate();let writerPid=0,write:Promise<unknown>|undefined;
      await db.update(projects).set({visibility:'restricted'}).where(eq(projects.id,f.project.id));
      await db.insert(projectAccess).values({projectId:f.project.id,principalType:'user',principalId:f.userId,grantedByUserId:f.userId});
      const update=async(tx:any)=>{if(resource==='credential')await tx.update(boardApiKeys).set({revokedAt:new Date()}).where(eq(boardApiKeys.id,f.key.id));else if(resource==='membership')await tx.update(companyMemberships).set({status:'inactive'}).where(eq(companyMemberships.id,f.membership.id));else await tx.delete(projectAccess).where(eq(projectAccess.projectId,f.project.id));};
      if(order==='tree-first')beforeIssueLock=async()=>{ready.open();await release.promise;};
      else afterAuthentication=async()=>{write=db.transaction(async tx=>{writerPid=Number((await tx.execute(sql`select pg_backend_pid() pid`))[0].pid);await update(tx);writerReady.open();await release.promise;});await writerReady.promise;};
      const pending=request(f,'tree-holds',{mode:'pause'});
      if(order==='tree-first'){await ready.promise;write=db.transaction(async tx=>{writerPid=Number((await tx.execute(sql`select pg_backend_pid() pid`))[0].pid);writerReady.open();await update(tx);});}
      await writerReady.promise;
      try{await observedWait(order==='tree-first'?acceptancePid!:writerPid,`${resource}/${order}`,order==='tree-first'?write!:pending);}finally{release.open();await Promise.allSettled([write,pending]);}
      const response=await pending;await write;
      expect(response.status).toBe(order==='tree-first'?201:resource==='credential'?401:resource==='membership'?403:404);
      if(order==='revocation-first'){expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id))).toEqual([]);expect(await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).toEqual([]);}
      afterAuthentication=undefined;beforeIssueLock=undefined;
    }
  });
  it('collects reverse target resource order before locking any higher project',async()=>{
    const f=await fixture();const[other]=await db.insert(projects).values({companyId:f.company.id,name:'Second'}).returning();
    const[lower,higher]=[f.project,other].sort((a,b)=>a.id.localeCompare(b.id));
    await db.update(issues).set({projectId:higher.id}).where(eq(issues.id,f.issue.id));
    await db.insert(issues).values({companyId:f.company.id,projectId:lower.id,parentId:f.issue.id,title:'Lower resource child'});
    const ready=gate(),release=gate();let pid=0;
    const writer=db.transaction(async tx=>{pid=Number((await tx.execute(sql`select pg_backend_pid() pid`))[0].pid);await tx.select().from(projects).where(eq(projects.id,lower.id)).for('update');ready.open();await release.promise;});
    await ready.promise;const pending=request(f,'tree-holds',{mode:'pause'});
    try{await observedWait(pid,'reverse-project-union',pending);await db.transaction(async tx=>{await tx.execute(sql`select id from projects where id = ${higher.id} for update nowait`);});}finally{release.open();await Promise.allSettled([writer,pending]);}
    expect((await pending).status).toBe(201);await writer;
  });
  it.each(['history','run','queue'] as const)('locks reference-only %s agents and refuses a changed reference before any write',async source=>{
    const f=await fixture(),svc=issueTreeControlService(db);
    const [original,replacement]=await db.insert(agents).values([{companyId:f.company.id,name:'Reference only'},{companyId:f.company.id,name:'Changed reference'}]).returning();
    let change!:()=>Promise<unknown>;
    if(source==='history'){
      const held=await svc.createHold(f.company.id,f.issue.id,{mode:'pause',actor:{actorType:'user',actorId:f.userId}});
      await db.update(issueTreeHoldMembers).set({assigneeAgentId:original.id}).where(eq(issueTreeHoldMembers.holdId,held.hold.id));
      change=()=>db.update(issueTreeHoldMembers).set({assigneeAgentId:replacement.id}).where(eq(issueTreeHoldMembers.holdId,held.hold.id));
    }else if(source==='run'){
      const [run]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:original.id,status:'running',invocationSource:'assignment',contextSnapshot:{issueId:f.issue.id}}).returning();
      change=()=>db.update(heartbeatRuns).set({agentId:replacement.id}).where(eq(heartbeatRuns.id,run.id));
    }else{
      const [queued]=await db.insert(agentWakeupRequests).values({companyId:f.company.id,agentId:original.id,source:'assignment',status:'queued',payload:{issueId:f.issue.id}}).returning();
      change=()=>db.update(agentWakeupRequests).set({agentId:replacement.id}).where(eq(agentWakeupRequests.id,queued.id));
    }
    const holdsBefore=await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id));
    const auditsBefore=await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id));
    vi.mocked(publishLiveEvent).mockClear();
    beforeIssueLock=async()=>{
      // A reference is not an assignment. Its row still belongs to the initial
      // positive SHARE union, before any issue/run/history/queue lock.
      await expect(db.transaction(tx=>tx.execute(sql`select id from agents where id = ${original.id} for update nowait`))).rejects.toMatchObject({cause:{code:'55P03'}});
      await change();
    };
    const response=await request(f,'tree-holds',{mode:'cancel'});
    expect(response.status).toBe(409);
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id))).toEqual(holdsBefore);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).toEqual(auditsBefore);
    expect((await db.select().from(issues).where(eq(issues.id,f.issue.id)))[0].assigneeAgentId).toBeNull();
    expect(publishLiveEvent).not.toHaveBeenCalled();expect(effects.cancelRun).not.toHaveBeenCalled();
  });
  it('refuses an earlier-order private rebinding instead of acquiring new witnesses after issue locks',async()=>{
    const f=await fixture();const[hidden]=await db.insert(projects).values({companyId:f.company.id,name:'Private rebound',visibility:'restricted'}).returning();
    beforeIssueLock=async()=>{await db.update(issues).set({projectId:hidden.id}).where(eq(issues.id,f.issue.id));};
    const response=await request(f,'tree-holds',{mode:'cancel'});expect(response.status).toBe(409);expect(await response.text()).not.toContain(hidden.id);
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id))).toEqual([]);
  });
  it.each(['session-delete','session-expiry','key-expiry','loopback-close','loopback-expiry','oauth-revoke'] as const)('reauthorizes actual %s provenance at final acceptance',async kind=>{
    const f=await fixture();let headers:Record<string,string>={authorization:`Bearer ${f.token}`};
    if(kind.startsWith('session')){
      const token=randomUUID(),id=randomUUID(),expiresAt=new Date(Date.now()+60000);
      await db.insert(authSessions).values({id,token,userId:f.userId,expiresAt,createdAt:new Date(),updatedAt:new Date()});headers={cookie:`test-session=${token}`};
      if(kind==='session-delete')afterAuthentication=async()=>{await db.delete(authSessions).where(eq(authSessions.id,id));};else beforeIssueLock=async()=>{vi.spyOn(Date,'now').mockReturnValue(expiresAt.getTime());};
    }else if(kind==='key-expiry')beforeIssueLock=async()=>{vi.spyOn(Date,'now').mockReturnValue(f.key.expiresAt!.getTime());};
    else{
      const[grant]=await db.insert(assistantGrants).values({companyId:f.company.id,userId:f.userId,clientId:randomUUID(),clientName:'Disposable',redirectHost:'test.invalid',scopes:['agentdash:work']}).returning();
      const raw=`pcpa_${randomUUID()}`;const[token]=await db.insert(assistantAccessTokens).values({grantId:grant.id,tokenHash:hashBearerToken(raw),familyId:randomUUID(),resource:'https://test.invalid/api/mcp/assistant',scopes:['agentdash:work'],expiresAt:new Date(Date.now()+60000)}).returning();
      const identity=await assistantOAuthService(db).resolveAccessToken(raw,token.resource);const loopback=mintAssistantLoopbackToken(identity!);headers={authorization:`Bearer ${loopback}`};
      // Middleware intentionally does not authorize this transport's tree POST.
      expect((await fetch(`${base}/issues/${f.issue.id}/tree-holds`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({mode:'pause'})})).status).toBe(403);
      expect((await fetch(`${base}/issues/${f.issue.id}/tree-holds`,{headers})).status).toBe(200);
      const ctx={companyId:f.company.id,rootIssueId:f.issue.id,actor:{actorType:'user' as const,actorId:f.userId,userId:f.userId},authority:issueTreeCurrentAuthority(actualRequest)};
      // The captured real GET Request remains unchanged. This is exclusively
      // service-level origin/lease proof, not HTTP mutation authorization.
      if(kind==='loopback-close')beforeIssueLock=async()=>{revokeAssistantLoopbackToken(loopback);};
      else if(kind==='loopback-expiry')beforeSettingsRead=()=>{vi.spyOn(Date,'now').mockReturnValue(token.expiresAt.getTime());};
      else await db.update(assistantAccessTokens).set({revokedAt:new Date()}).where(eq(assistantAccessTokens.id,token.id));
      await expect(issueTreeControlService(routeExecutor).acceptAction(ctx,{kind:'create',input:{mode:'pause'}},{previewOnly:kind==='loopback-expiry'})).rejects.toMatchObject({status:401});
      expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id))).toEqual([]);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).toEqual([]);expect(publishLiveEvent).not.toHaveBeenCalled();
      if(kind==='oauth-revoke')expect((await fetch(`${base}/issues/${f.issue.id}/tree-holds`,{headers})).status).toBe(401);
      return;
    }
    const response=await fetch(`${base}/issues/${f.issue.id}/${kind==='loopback-expiry'?'tree-control/preview':'tree-holds'}`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({mode:'pause'})});
    expect(response.status).toBe(401);expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id))).toEqual([]);expect(await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).toEqual([]);expect(publishLiveEvent).not.toHaveBeenCalled();
  });
  it('keeps resume root selection narrow while authorizing complete released history and preserves restore statuses',async()=>{
    const f=await fixture(),svc=issueTreeControlService(db);
    const[child,outside]=await db.insert(issues).values([{companyId:f.company.id,parentId:f.issue.id,title:'Child',status:'in_progress'},{companyId:f.company.id,title:'Outside',status:'todo'}]).returning();
    const ancestor=await svc.createHold(f.company.id,outside.id,{mode:'pause',actor:{actorType:'user',actorId:f.userId}});
    await db.insert(issueTreeHoldMembers).values({companyId:f.company.id,holdId:ancestor.hold.id,issueId:child.id,parentIssueId:f.issue.id,depth:1,issueTitle:child.title,issueStatus:'in_progress'});
    const rooted=await svc.createHold(f.company.id,f.issue.id,{mode:'pause',actor:{actorType:'user',actorId:f.userId}});
    await db.update(issues).set({parentId:null}).where(eq(issues.id,child.id));
    const resumed=await request(f,'tree-holds',{mode:'resume'});expect(resumed.status).toBe(200);expect((await resumed.json()).resumedPauseHoldIds).toEqual([rooted.hold.id]);
    expect((await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id,ancestor.hold.id)))[0].status).toBe('active');
    await db.update(issues).set({parentId:f.issue.id}).where(eq(issues.id,child.id));
    expect((await request(f,'tree-holds',{mode:'cancel'})).status).toBe(201);
    const restored=await request(f,'tree-holds',{mode:'restore',metadata:{wakeAgents:true}});expect(restored.status).toBe(200);
    expect((await db.select().from(issues).where(eq(issues.id,child.id)))[0].status).toBe('todo');
    expect((await restored.json()).hold.status).toBe('released');
  });

});
