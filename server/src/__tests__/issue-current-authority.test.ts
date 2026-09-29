import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { activityLog, agents, agentApiKeys, authSessions, authUsers, boardApiKeys, companies, companyMemberships, createDb, issueComments, issues, projects, projectAccess, principalPermissionGrants, instanceUserRoles, assistantAccessTokens, assistantGrants, executionWorkspaces, heartbeatRuns, projectWorkspaces, environments, instanceSettings } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { issueRoutes } from '../routes/issues.js';
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

describe('exact current issue authority over real middleware, HTTP and PostgreSQL', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, server: Server, base: string;
  let acceptancePid: number | undefined;
  let beforeFirstPrepare: (() => Promise<void>) | undefined;
  let beforeIssueLock: (() => Promise<void>) | undefined;
  let afterAuthentication: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('issue-current-authority-');
    db = createDb(temp.connectionString);
    const routeDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      return (callback: (tx: unknown) => Promise<unknown>) => target.transaction(async tx => {
        acceptancePid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
        let issueSelectCount = 0;
        return callback(new Proxy(tx, { get(t, k, r) {
        if (k !== 'select') return Reflect.get(t, k, r);
        return (...args: unknown[]) => {
          const query = (t.select as Function)(...args);
          const from = query.from.bind(query);
          query.from = (table: unknown) => {
            const builder = from(table), originalFor = builder.for.bind(builder);
            if (table === issues && ++issueSelectCount === 2 && beforeFirstPrepare) {
              const barrier = beforeFirstPrepare, then = builder.then.bind(builder);
              beforeFirstPrepare = undefined;
              builder.then = (resolve: Function, reject: Function) => barrier().then(() => then(resolve, reject));
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
      } })); });
    } });
    const app = express(); app.use(express.json());
    const local = express.Router(); local.use(actorMiddleware(db, { deploymentMode: 'local_trusted' }));
    local.use(issueRoutes(routeDb, {} as StorageService)); app.use('/local/api', local);
    app.use(actorMiddleware(db, { deploymentMode: 'authenticated', resolveSession: async req => {
      const token = req.header('cookie')?.replace(/^test-session=/, '');
      if (!token) return null;
      const [session] = await db.select().from(authSessions).where(eq(authSessions.token, token));
      if (!session || session.expiresAt.getTime() <= Date.now()) return null;
      const [user] = await db.select().from(authUsers).where(eq(authUsers.id, session.userId));
      return user ? { session: { id: session.id, userId: session.userId }, user } : null;
    } }));
    app.use(async (_req, _res, next) => { try { await afterAuthentication?.(); next(); } catch (e) { next(e); } });
    app.use('/api', issueRoutes(routeDb, {} as StorageService)); app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  beforeEach(() => { beforeFirstPrepare = undefined; afterAuthentication = undefined; beforeIssueLock = undefined; resetAssistantLoopbackTokens(); vi.restoreAllMocks(); vi.clearAllMocks(); });
  afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await temp?.cleanup(); });
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
  async function mutate(f: Awaited<ReturnType<typeof fixture>>, kind: 'patch' | 'comment', options: { token?: string; cookie?: string; body?: Record<string, unknown>; runId?: string } = {}) {
    return fetch(`${base}/issues/${f.issue.id}${kind === 'comment' ? '/comments' : ''}`, {
      method: kind === 'comment' ? 'POST' : 'PATCH', headers: { ...(options.cookie ? { cookie: `test-session=${options.cookie}` } : { authorization: `Bearer ${options.token ?? f.token}` }), 'content-type': 'application/json', ...(options.runId ? { 'x-paperclip-run-id': options.runId } : {}) },
      body: JSON.stringify(options.body ?? (kind === 'comment' ? { body: 'Refuse' } : { title: 'Changed', comment: 'Refuse' })),
    });
  }
  it.each(['patch', 'comment'] as const)('refuses %s after original board key revocation at middleware barrier', async kind => {
    const f = await fixture();
    afterAuthentication = async () => { await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, f.key.id)); };
    const response = await mutate(f, kind);
    expect(response.status).toBe(401);
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].title).toBe('Original');
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]);
    expect(effects.wakeup).not.toHaveBeenCalled();
  });
  it.each(['patch', 'comment'] as const)('refuses %s on a private source project', async kind => {
    const f = await fixture(); await db.update(projects).set({ visibility: 'restricted' }).where(eq(projects.id, f.project.id));
    expect((await mutate(f, kind)).status).toBe(404);
  });

  async function noWrites(f: Awaited<ReturnType<typeof fixture>>) {
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].title).toBe('Original');
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]);
    expect(effects.wakeup).not.toHaveBeenCalled(); expect(effects.cancelRun).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  }
  it.each(['patch', 'comment'] as const)('refuses %s when exact named session is deleted after verification', async kind => {
    const f = await fixture(), cookie = randomUUID(), id = randomUUID();
    await db.insert(authSessions).values({ id, token: cookie, userId: f.userId, expiresAt: new Date(Date.now() + 60000), createdAt: new Date(), updatedAt: new Date() });
    afterAuthentication = async () => { await db.delete(authSessions).where(eq(authSessions.id, id)); };
    expect((await mutate(f, kind, { cookie })).status).toBe(401); await noWrites(f);
  });
  it.each(['patch', 'comment'] as const)('accepts %s with an exact named session and original user', async kind => {
    const f = await fixture(), cookie = randomUUID(), id = randomUUID();
    await db.insert(authSessions).values({ id, token: cookie, userId: f.userId, expiresAt: new Date(Date.now() + 60000), createdAt: new Date(), updatedAt: new Date() });
    expect((await mutate(f, kind, { cookie })).status).toBe(kind === 'patch' ? 200 : 201);
  });
  it.each(['patch', 'comment'] as const)('rechecks %s board deadline at the final prewrite boundary', async kind => {
    const f = await fixture(), expires = f.key.expiresAt!.getTime();
    beforeIssueLock = async () => { vi.spyOn(Date, 'now').mockReturnValue(expires); };
    expect((await mutate(f, kind)).status).toBe(401); await noWrites(f);
  });
  it.each(['patch', 'comment'] as const)('keeps named instance-admin %s entry membership mandatory', async kind => {
    const f = await fixture(); await db.insert(instanceUserRoles).values({ userId: f.userId, role: 'instance_admin' });
    afterAuthentication = async () => { await db.delete(companyMemberships).where(eq(companyMemberships.id, f.membership.id)); };
    expect((await mutate(f, kind)).status).toBe(403); await noWrites(f);
  });
  it.each(['patch', 'comment'] as const)('preserves legitimate worker %s on a restricted project', async kind => {
    const f = await fixture(), token = randomUUID();
    const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'Worker' }).returning();
    await db.insert(agentApiKeys).values({ agentId: agent.id, companyId: f.company.id, keyHash: hashBearerToken(token), name: 'Disposable' });
    await db.update(projects).set({ visibility: 'restricted' }).where(eq(projects.id, f.project.id));
    await db.update(issues).set({ assigneeAgentId: agent.id }).where(eq(issues.id, f.issue.id));
    expect((await mutate(f, kind, { token })).status).toBe(kind === 'patch' ? 200 : 201);
  });
  it.each(['patch', 'comment'] as const)('refuses %s with an agent-key company mismatch', async kind => {
    const f = await fixture(), token = randomUUID();
    const [foreign] = await db.insert(companies).values({ name: 'Other company', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: foreign.id, name: 'Foreign' }).returning();
    await db.insert(agentApiKeys).values({ agentId: agent.id, companyId: f.company.id, keyHash: hashBearerToken(token), name: 'Mismatched' });
    expect((await mutate(f, kind, { token })).status).toBe(401); await noWrites(f);
  });
  it.each([null, '', 'member', 'legacy-role'])('preserves assignment grant semantics for role %s', async role => {
    const f = await fixture(); await db.update(companyMemberships).set({ membershipRole: role }).where(eq(companyMemberships.id, f.membership.id));
    const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'Requested' }).returning();
    const body = { assigneeAgentId: agent.id };
    expect((await mutate(f, 'patch', { body })).status).toBe(role ? 200 : 403);
    if (!role) {
      await db.insert(principalPermissionGrants).values({ companyId: f.company.id, principalType: 'user', principalId: f.userId, permissionKey: 'tasks:assign', scope: { uninterpreted: true } });
      expect((await mutate(f, 'patch', { body })).status).toBe(200);
    }
  });
  it('guards a requested destination project and retains creator/listed/admin exceptions', async () => {
    const f = await fixture(); const [destination] = await db.insert(projects).values({ companyId: f.company.id, name: 'Destination', visibility: 'restricted' }).returning();
    expect((await mutate(f, 'patch', { body: { projectId: destination.id } })).status).toBe(404);
    await db.insert(projectAccess).values({ projectId: destination.id, principalType: 'user', principalId: f.userId, grantedByUserId: f.userId });
    expect((await mutate(f, 'patch', { body: { projectId: destination.id } })).status).toBe(200);
    await db.delete(projectAccess).where(eq(projectAccess.projectId, destination.id));
    await db.update(projects).set({ createdByUserId: f.userId }).where(eq(projects.id, destination.id));
    expect((await mutate(f, 'comment')).status).toBe(201);
    await db.update(projects).set({ createdByUserId: null }).where(eq(projects.id, destination.id));
    await db.update(companyMemberships).set({ membershipRole: 'owner' }).where(eq(companyMemberships.id, f.membership.id));
    expect((await mutate(f, 'comment')).status).toBe(201);
  });
  async function assistant(f: Awaited<ReturnType<typeof fixture>>, internal = false) {
    const [grant] = await db.insert(assistantGrants).values({ companyId: f.company.id, userId: f.userId, clientId: randomUUID(), clientName: 'Disposable', redirectHost: 'test.invalid', scopes: ['agentdash:work'] }).returning();
    const raw = `pcpa_${randomUUID()}`;
    const [token] = await db.insert(assistantAccessTokens).values({ grantId: grant.id, tokenHash: hashBearerToken(raw), familyId: randomUUID(), resource: 'https://test.invalid/api/mcp/assistant', scopes: ['agentdash:work'], expiresAt: new Date(Date.now() + 60000) }).returning();
    const identity = await assistantOAuthService(db).resolveAccessToken(raw, token.resource);
    expect(identity).not.toBeNull();
    const loopback = mintAssistantLoopbackToken({ ...identity!, origin: internal ? { kind: 'internal' } : identity!.origin });
    return { grant, token, loopback };
  }
  it.each(['patch', 'comment'] as const)('preserves explicit internal assistant %s compatibility', async kind => {
    const f = await fixture(), a = await assistant(f, true);
    expect((await mutate(f, kind, { token: a.loopback, body: kind === 'patch' ? { title: 'Allowed' } : { body: 'Allowed' } })).status).toBe(kind === 'patch' ? 200 : 201);
  });
  it.each(['patch', 'comment'] as const)('checks original assistant authority and exact loopback liveness for %s', async kind => {
    for (const change of ['token', 'grant', 'scope', 'expiry', 'close'] as const) {
      const f = await fixture(), a = await assistant(f);
      if (change === 'close' || change === 'expiry') beforeIssueLock = async () => {
        if (change === 'close') revokeAssistantLoopbackToken(a.loopback);
        else vi.spyOn(Date, 'now').mockReturnValue(a.token.expiresAt.getTime());
      };
      else afterAuthentication = async () => {
        if (change === 'token') {
          await db.update(assistantAccessTokens).set({ revokedAt: new Date() }).where(eq(assistantAccessTokens.id, a.token.id));
          await db.insert(assistantAccessTokens).values({ grantId: a.grant.id, tokenHash: hashBearerToken(randomUUID()), familyId: randomUUID(), resource: a.token.resource, scopes: ['agentdash:work'], expiresAt: new Date(Date.now() + 60000) });
        } else {
          await db.update(assistantGrants).set(change === 'grant' ? { revokedAt: new Date() } : { scopes: [] }).where(eq(assistantGrants.id, a.grant.id));
          if (change === 'grant') await db.insert(assistantGrants).values({ companyId: a.grant.companyId, userId: a.grant.userId,
            clientId: a.grant.clientId, clientName: a.grant.clientName, redirectHost: a.grant.redirectHost, scopes: ['agentdash:work'] });
        }
      };
      expect((await mutate(f, kind, { token: a.loopback, body: kind === 'patch' ? { title: 'Refused' } : { body: 'Refused' } })).status, change).toBe(401);
      await noWrites(f); afterAuthentication = undefined; vi.restoreAllMocks();
    }
  });
  it.each(['patch', 'comment'] as const)('preserves strict-less JWT expiry and signed/effective run distinction for %s', async kind => {
    vi.stubEnv('PAPERCLIP_AGENT_JWT_SECRET', 'disposable-test-secret');
    const f = await fixture(), [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'JWT worker' }).returning();
    const signedRun = randomUUID(), effectiveRun = randomUUID();
    await db.insert(heartbeatRuns).values([signedRun, effectiveRun].map(id => ({ id, companyId: f.company.id, agentId: agent.id, status: 'running' })));
    const token = createLocalAgentJwt(agent.id, f.company.id, 'process', signedRun)!;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    beforeIssueLock = async () => { vi.spyOn(Date, 'now').mockReturnValue(claims.exp * 1000); };
    expect((await mutate(f, kind, { token, runId: effectiveRun })).status).toBe(kind === 'patch' ? 200 : 201);
    const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
    expect(audit.every(row => row.runId === effectiveRun)).toBe(true);
    vi.restoreAllMocks();
    beforeIssueLock = async () => { vi.spyOn(Date, 'now').mockReturnValue((claims.exp + 1) * 1000); };
    expect((await mutate(f, kind, { token, runId: effectiveRun })).status).toBe(401);
    vi.unstubAllEnvs();
  });

  function barrier() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  }
  async function blockingPid(blocker: number) {
    for (let tries = 0; tries < 1000; tries++) {
      const rows = await db.execute(sql`select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
        where datname = current_database() and ${blocker} = any(pg_blocking_pids(pid))`);
      if (rows.length) return rows;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Expected explicit PostgreSQL blocking relationship did not occur');
  }
  it.each(['patch', 'comment'] as const)('orders %s positive credential/membership/project revocation on distinct PostgreSQL backends', async kind => {
    for (const resource of ['credential', 'membership', 'project'] as const) for (const order of ['acceptance-first', 'revocation-first'] as const) {
      const f = await fixture(), entered = barrier(), proceed = barrier(), writerReady = barrier();
      let writerPid = 0;
      const update = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        if (resource === 'credential') await tx.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, f.key.id));
        else if (resource === 'membership') await tx.update(companyMemberships).set({ status: 'inactive' }).where(eq(companyMemberships.id, f.membership.id));
        else await tx.update(projects).set({ visibility: 'restricted' }).where(eq(projects.id, f.project.id));
      };
      let write: Promise<unknown> | undefined;
      if (order === 'acceptance-first') beforeIssueLock = async () => { entered.release(); await proceed.promise; };
      else afterAuthentication = async () => {
        write = db.transaction(async tx => {
          writerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
          await update(tx); writerReady.release(); await proceed.promise;
        });
        await writerReady.promise;
      };
      const request = mutate(f, kind);
      if (order === 'acceptance-first') {
        await entered.promise;
        write = db.transaction(async tx => {
          writerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
          writerReady.release(); await update(tx);
        });
        await writerReady.promise;
      } else await writerReady.promise;
      try {
        const observed = await blockingPid(order === 'acceptance-first' ? acceptancePid! : writerPid);
        expect(writerPid).not.toBe(acceptancePid);
        console.info(JSON.stringify({ kind, resource, order, acceptancePid, writerPid, observed }));
      } finally { proceed.release(); }
      const response = await request; await write;
      expect(response.status).toBe(order === 'acceptance-first' ? (kind === 'patch' ? 200 : 201) : resource === 'credential' ? 401 : resource === 'membership' ? 403 : 404);
      if (order === 'revocation-first') await noWrites(f);
      afterAuthentication = undefined; vi.clearAllMocks();
    }
  });

  it.each(['patch', 'comment'] as const)('keeps implicit-local %s compatible and explicit invalid credentials unauthenticated', async kind => {
    const f = await fixture(); await db.update(projects).set({ visibility: 'restricted' }).where(eq(projects.id, f.project.id));
    const url = `${base.replace('/api', '/local/api')}/issues/${f.issue.id}${kind === 'comment' ? '/comments' : ''}`;
    for (const header of [undefined, 'Bearer invalid', 'Bearer ']) {
      const response = await fetch(url, { method: kind === 'patch' ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json', ...(header ? { authorization: header } : {}) },
        body: JSON.stringify(kind === 'patch' ? { title: 'Local' } : { body: 'Local' }) });
      expect(response.status).toBe(header ? 401 : kind === 'patch' ? 200 : 201);
    }
  });
  it.each(['patch', 'comment'] as const)('checks %s source company binding before closed workspace projection', async kind => {
    const f = await fixture(), other = await fixture();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: other.company.id, projectId: other.project.id,
      mode: 'isolated_workspace', strategyType: 'git_worktree', name: 'Private foreign workspace', status: 'archived', closedAt: new Date() }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, f.issue.id));
    const response = await mutate(f, kind); expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('Private foreign workspace'); await noWrites(f);
  });
  it.each(['patch', 'comment'] as const)('checks %s source project company binding before visibility exceptions', async kind => {
    const f = await fixture(), other = await fixture();
    await db.update(issues).set({ projectId: other.project.id }).where(eq(issues.id, f.issue.id));
    expect((await mutate(f, kind)).status).toBe(404); await noWrites(f);
  });
  it('refuses missing/foreign destination projects and missing/foreign selected workspaces', async () => {
    const f = await fixture(), other = await fixture();
    await db.insert(instanceSettings).values({ experimental: { enableIsolatedWorkspaces: true } }).onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableIsolatedWorkspaces: true } } });
    const [workspace] = await db.insert(projectWorkspaces).values({ companyId: other.company.id, projectId: other.project.id, name: 'Foreign' }).returning();
    for (const body of [{ projectId: randomUUID() }, { projectId: other.project.id }]) expect((await mutate(f, 'patch', { body })).status).toBe(404);
    for (const [body, status] of [[{ projectWorkspaceId: randomUUID() }, 404], [{ projectWorkspaceId: workspace.id }, 422], [{ executionWorkspaceId: randomUUID() }, 404]] as const) expect((await mutate(f, 'patch', { body })).status).toBe(status);
    await noWrites(f);
  });
  it('retains archived/foreign/missing/disallowed-driver environment refusals', async () => {
    const f = await fixture(), other = await fixture();
    for (const caseName of ['archived', 'foreign', 'missing', 'driver', 'fake'] as const) {
      const [environment] = await db.insert(environments).values({ companyId: caseName === 'foreign' ? other.company.id : f.company.id,
        name: randomUUID(), driver: caseName === 'driver' ? 'plugin' : caseName === 'fake' ? 'sandbox' : 'ssh',
        status: caseName === 'archived' ? 'archived' : 'active', config: caseName === 'fake' ? { provider: 'fake' } : {} }).returning();
      const response = await mutate(f, 'patch', { body: { executionWorkspaceSettings: { environmentId: caseName === 'missing' ? randomUUID() : environment.id } } });
      expect(response.status, caseName).toBe(422);
    }
    await noWrites(f);
  });
  it('rechecks live host-command authority after verified instance-admin revocation', async () => {
    const f = await fixture(); const [admin] = await db.insert(instanceUserRoles).values({ userId: f.userId, role: 'instance_admin' }).returning();
    afterAuthentication = async () => { await db.delete(instanceUserRoles).where(eq(instanceUserRoles.id, admin.id)); };
    expect((await mutate(f, 'patch', { body: { executionWorkspaceSettings: { workspaceStrategy: { provisionCommand: 'never execute' } } } })).status).toBe(403);
    await noWrites(f);
  });
  it.each(['patch', 'comment'] as const)('preserves %s manager hierarchy override on restricted projects', async kind => {
    const f = await fixture(), token = randomUUID();
    const [manager] = await db.insert(agents).values({ companyId: f.company.id, name: 'Manager' }).returning();
    const [worker] = await db.insert(agents).values({ companyId: f.company.id, name: 'Worker', reportsTo: manager.id }).returning();
    await db.insert(agentApiKeys).values({ agentId: manager.id, companyId: f.company.id, keyHash: hashBearerToken(token), name: 'Manager key' });
    await db.update(issues).set({ assigneeAgentId: worker.id }).where(eq(issues.id, f.issue.id));
    await db.update(projects).set({ visibility: 'restricted' }).where(eq(projects.id, f.project.id));
    expect((await mutate(f, kind, { token })).status).toBe(kind === 'patch' ? 200 : 201);
  });
  it.each(['patch', 'comment'] as const)('expires %s internal loopback independently of OAuth', async kind => {
    const f = await fixture(), a = await assistant(f, true), minted = Date.now();
    beforeIssueLock = async () => { vi.spyOn(Date, 'now').mockReturnValue(minted + 10 * 60 * 1000); };
    expect((await mutate(f, kind, { token: a.loopback, body: kind === 'patch' ? { title: 'Refused' } : { body: 'Refused' } })).status).toBe(401);
    await noWrites(f);
  });

  it.each(['patch', 'comment'] as const)('rejects changed %s source bindings before private closed-workspace projection', async kind => {
    const f = await fixture(); const [hidden] = await db.insert(projects).values({ companyId: f.company.id, name: 'Private changed project', visibility: 'restricted' }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.company.id, projectId: hidden.id,
      mode: 'isolated_workspace', strategyType: 'git_worktree', name: 'Private changed workspace', status: 'archived', closedAt: new Date() }).returning();
    beforeIssueLock = async () => { await db.update(issues).set({ projectId: hidden.id, executionWorkspaceId: workspace.id }).where(eq(issues.id, f.issue.id)); };
    const response = await mutate(f, kind); expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain('Private changed workspace'); await noWrites(f);
  });

  it.each(['patch', 'comment'] as const)('refuses a private source rebound before first %s preparation without projecting it', async kind => {
    const f = await fixture();
    const [hidden] = await db.insert(projects).values({ companyId: f.company.id, name: 'Hidden first-prepare project', visibility: 'restricted' }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.company.id, projectId: hidden.id,
      mode: 'isolated_workspace', strategyType: 'git_worktree', name: 'Hidden first-prepare workspace', status: 'archived',
      cwd: '/private/first-prepare-workspace', closedAt: new Date() }).returning();
    let reached = false;
    beforeFirstPrepare = async () => {
      reached = true;
      await db.transaction(async tx => {
        const writerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
        expect(writerPid).not.toBe(acceptancePid);
        await tx.update(issues).set({ projectId: hidden.id, executionWorkspaceId: workspace.id }).where(eq(issues.id, f.issue.id));
        console.info(JSON.stringify({ kind, case: 'before-first-prepare-rebind', acceptancePid, writerPid, projectId: hidden.id, workspaceId: workspace.id }));
      });
    };
    const response = await mutate(f, kind), body = await response.json();
    expect(reached).toBe(true);
    expect(response.status).toBe(409);
    await noWrites(f);
    expect(body).not.toHaveProperty('executionWorkspace');
    for (const hiddenValue of [hidden.id, workspace.id, workspace.name, workspace.cwd]) expect(JSON.stringify(body)).not.toContain(hiddenValue);
  });

  it.each(['patch', 'comment'] as const)('samples the exact named session expiry at final %s guard', async kind => {
    const f = await fixture(), cookie = randomUUID(), expiresAt = new Date(Date.now() + 60000);
    await db.insert(authSessions).values({ id: randomUUID(), token: cookie, userId: f.userId, expiresAt, createdAt: new Date(), updatedAt: new Date() });
    beforeIssueLock = async () => { vi.spyOn(Date, 'now').mockReturnValue(expiresAt.getTime()); };
    expect((await mutate(f, kind, { cookie })).status).toBe(401); await noWrites(f);
  });
  it.each(['patch', 'comment'] as const)('retains %s original board-key user binding', async kind => {
    const f = await fixture(), other = await fixture();
    afterAuthentication = async () => { await db.update(boardApiKeys).set({ userId: other.userId }).where(eq(boardApiKeys.id, f.key.id)); };
    expect((await mutate(f, kind)).status).toBe(401); await noWrites(f);
  });
  it.each(['patch', 'comment'] as const)('rechecks %s agent-key revocation/status/evaluator predicates while permitting paused agents', async kind => {
    for (const state of ['revoked', 'terminated', 'pending_approval', 'evaluator', 'paused'] as const) {
      const f = await fixture(), token = randomUUID();
      const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'Worker' }).returning();
      const [key] = await db.insert(agentApiKeys).values({ agentId: agent.id, companyId: f.company.id, keyHash: hashBearerToken(token), name: 'Disposable' }).returning();
      afterAuthentication = async () => {
        if (state === 'revoked') await db.update(agentApiKeys).set({ revokedAt: new Date() }).where(eq(agentApiKeys.id, key.id));
        else await db.update(agents).set(state === 'evaluator' ? { role: 'evaluator' } : { status: state }).where(eq(agents.id, agent.id));
      };
      expect((await mutate(f, kind, { token })).status, state).toBe(state === 'paused' ? (kind === 'patch' ? 200 : 201) : state === 'evaluator' ? 403 : 401);
      if (state !== 'paused') await noWrites(f);
      vi.clearAllMocks();
    }
  });

  it.each(['patch', 'comment'] as const)('takes %s parent witnesses before credential children during deletion', async kind => {
    for (const principal of ['board-key', 'session', 'agent-key'] as const) {
      const f = await fixture(), held = barrier(), proceed = barrier();
      let parentId = f.userId, childId = f.key.id, token = f.token, cookie: string | undefined;
      if (principal === 'session') {
        cookie = randomUUID(); childId = randomUUID();
        await db.insert(authSessions).values({ id: childId, token: cookie, userId: f.userId, expiresAt: new Date(Date.now() + 60000), createdAt: new Date(), updatedAt: new Date() });
      } else if (principal === 'agent-key') {
        const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'Disposable parent' }).returning();
        parentId = agent.id; token = randomUUID();
        const [key] = await db.insert(agentApiKeys).values({ agentId: agent.id, companyId: f.company.id, keyHash: hashBearerToken(token), name: 'Disposable child' }).returning();
        childId = key.id;
      }
      const parentTable = principal === 'agent-key' ? agents : authUsers;
      const childTable = principal === 'agent-key' ? agentApiKeys : principal === 'session' ? authSessions : boardApiKeys;
      let writerPid = 0, childAvailable = false, write: Promise<unknown> | undefined;
      afterAuthentication = async () => {
        write = db.transaction(async tx => {
          writerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
          await tx.execute(sql`select id from ${parentTable} where id = ${parentId} for update`);
          held.release(); await proceed.promise;
          try {
            await tx.execute(sql`select id from ${childTable} where id = ${childId} for update nowait`);
            childAvailable = true;
          } catch (error) {
            const failure = error as { code?: string; cause?: { code?: string } };
            if ((failure.code ?? failure.cause?.code) === '55P03') return;
            throw error;
          }
          if (principal === 'agent-key') await tx.delete(agentApiKeys).where(eq(agentApiKeys.id, childId));
          await tx.execute(sql`delete from ${parentTable} where id = ${parentId}`);
        }).catch(error => {
          // postgres-js also rejects the outer transaction after NOWAIT has
          // aborted it; retain the lock observation without an unhandled promise.
          const failure = error as { code?: string; cause?: { code?: string } };
          if ((failure.code ?? failure.cause?.code) !== '55P03') throw error;
        });
        await held.promise;
      };
      const request = mutate(f, kind, { token, cookie });
      await held.promise;
      try {
        const observed = await blockingPid(writerPid);
        expect(acceptancePid).not.toBe(writerPid);
        console.info(JSON.stringify({ kind, principal, case: 'parent-delete', acceptancePid, writerPid, observed }));
      } finally { proceed.release(); }
      const response = await request; await write;
      expect(childAvailable, `${principal}: waiting acceptance must not hold the credential child`).toBe(true);
      expect(response.status).toBe(401); await noWrites(f);
      afterAuthentication = undefined; vi.clearAllMocks();
    }
  });
  it.each(['patch', 'comment'] as const)('serializes canonical agent removal with authenticated %s in both orders', async kind => {
    for (const order of ['acceptance-first', 'removal-first'] as const) {
      const f = await fixture(), token = randomUUID(), accepted = barrier(), detached = barrier(), proceed = barrier();
      const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: 'Removed worker' }).returning();
      await db.insert(agentApiKeys).values({ agentId: agent.id, companyId: f.company.id, keyHash: hashBearerToken(token), name: 'Disposable' });
      await db.update(issues).set({ assigneeAgentId: agent.id }).where(eq(issues.id, f.issue.id));
      let removerPid = 0;
      // Root-bound real service, distinct actual transaction; only pause after
      // the existing issue-detach SQL has executed, without replacing any SQL.
      const removalDb = new Proxy(db, { get(target, key, receiver) {
        if (key !== 'transaction') return Reflect.get(target, key, receiver);
        return (callback: (tx: unknown) => Promise<unknown>) => target.transaction(async tx => {
          removerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
          return callback(new Proxy(tx, { get(t, k, r) {
            if (k !== 'update') return Reflect.get(t, k, r);
            return (table: unknown) => {
              const query = (t.update as Function)(table), set = query.set.bind(query);
              query.set = (...args: unknown[]) => {
                const builder = set(...args), where = builder.where.bind(builder);
                builder.where = (...predicates: unknown[]) => {
                  const result = where(...predicates);
                  return table === issues ? Promise.resolve(result).then(async rows => {
                    detached.release(); if (order === 'removal-first') await proceed.promise; return rows;
                  }) : result;
                };
                return builder;
              };
              return query;
            };
          } }));
        });
      } });
      let removal: Promise<{ value?: unknown; error?: unknown }> | undefined;
      const remove = () => agentService(removalDb).remove(agent.id).then(value => ({ value }), error => ({ error }));
      if (order === 'acceptance-first') beforeIssueLock = async () => { accepted.release(); await proceed.promise; };
      else afterAuthentication = async () => { removal = remove(); await detached.promise; };
      const request = mutate(f, kind, { token });
      if (order === 'acceptance-first') { await accepted.promise; removal = remove(); }
      else await detached.promise;
      try {
        const observed = await blockingPid(order === 'acceptance-first' ? acceptancePid! : removerPid);
        expect(removerPid).not.toBe(acceptancePid);
        console.info(JSON.stringify({ kind, case: 'canonical-agent-remove', order, acceptancePid, removerPid, observed }));
      } finally { proceed.release(); }
      const response = await request, removed = await removal;
      expect(removed?.error).toBeUndefined();
      expect(response.status).toBe(order === 'acceptance-first' ? (kind === 'patch' ? 200 : 201) : 401);
      expect(await db.select().from(agents).where(eq(agents.id, agent.id))).toEqual([]);
      expect(await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agent.id))).toEqual([]);
      expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].assigneeAgentId).toBeNull();
      // The existing remover intentionally deletes agent comments/activity.
      // Acceptance-first success is observable in its HTTP response and title.
      if (order === 'removal-first') await noWrites(f);
      else if (kind === 'patch') expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].title).toBe('Changed');
      afterAuthentication = undefined; vi.clearAllMocks();
    }
  });

});
