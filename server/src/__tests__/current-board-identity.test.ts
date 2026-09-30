import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import express, { type Request } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { authSessions, authUsers, boardApiKeys, companies, companyMemberships, createDb, instanceUserRoles, issues, type Db } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { hashBearerToken } from '../services/board-auth.js';
import { currentBoardIdentity } from '../services/current-board-identity.js';
import { issueTreeCurrentAuthority } from '../services/issue-current-authority.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

describe('current board identity facts from actual native Requests and PostgreSQL', () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase('current-board-facts-');
    db = createDb(temporary.connectionString);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture(expiry: number | null = Date.now() + 60000) {
    const userId = randomUUID(), token = `pcp_board_${randomUUID()}`, cookie = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: 'Human', email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    const [key] = await db.insert(boardApiKeys).values({ userId, name: 'Disposable', keyHash: hashBearerToken(token), expiresAt: expiry === null ? null : new Date(expiry) }).returning();
    const [session] = await db.insert(authSessions).values({ id: randomUUID(), token: cookie, userId, expiresAt: new Date(Date.now() + 60000), createdAt: new Date(), updatedAt: new Date() }).returning();
    const [company] = await db.insert(companies).values({ name: 'Facts', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [member] = await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: userId, membershipRole: null, status: 'active' }).returning();
    return { userId, token, cookie, key, session, company, member };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function authenticated(f: Fixture, source: 'board_key' | 'session' | 'local_implicit' = 'board_key') {
    let captured: Request | undefined;
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: source === 'local_implicit' ? 'local_trusted' : 'authenticated', resolveSession: async req => {
      const token = req.header('cookie')?.replace(/^test-session=/, '');
      if (!token) return null;
      const [session] = await db.select().from(authSessions).where(eq(authSessions.token, token));
      if (!session || session.expiresAt.getTime() <= Date.now()) return null;
      const [user] = await db.select().from(authUsers).where(eq(authUsers.id, session.userId));
      return user ? { session: { id: session.id, userId: session.userId }, user } : null;
    } }));
    app.get('/capture', (req, res) => { captured = req; res.sendStatus(204); });
    app.use(errorHandler);
    let call = request(app).get('/capture');
    if (source === 'board_key') call = call.set('authorization', `Bearer ${f.token}`);
    if (source === 'session') call = call.set('cookie', `test-session=${f.cookie}`);
    expect((await call).status).toBe(204);
    expect(captured?.actor).toMatchObject({ type: 'board', source, userId: source === 'local_implicit' ? 'local-board' : f.userId });
    return captured!;
  }

  // Keep the real SELECT builder/rows; interpose at a chosen awaited table read.
  function afterSelect(table: unknown, callback: () => Promise<void> | void): Pick<Db, 'select'> {
    return { select: ((...args: unknown[]) => {
      const query = (db.select as Function)(...args), from = query.from.bind(query);
      query.from = (selected: unknown) => {
        const builder = from(selected), then = builder.then.bind(builder);
        if (selected === table) builder.then = (resolve: Function, reject: Function) => then(async (rows: unknown) => {
          await callback(); return rows;
        }).then(resolve, reject);
        return builder;
      };
      return query;
    }) as Db['select'] };
  }

  it('returns actual NULL-role membership and admin witnesses on the supplied transaction only', async () => {
    const f = await fixture(), req = await authenticated(f), identity = currentBoardIdentity(req);
    const [admin] = await db.insert(instanceUserRoles).values({ userId: f.userId, role: 'instance_admin' }).returning();
    await db.transaction(async tx => {
      await tx.update(companyMemberships).set({ membershipRole: 'viewer' }).where(eq(companyMemberships.id, f.member.id));
      const reader = { select: tx.select.bind(tx) } as Pick<Db, 'select'>;
      const profile = await identity.read(reader, f.company.id);
      expect(profile.membership).toEqual({ id: f.member.id, role: 'viewer', status: 'active' });
      expect((await db.select().from(companyMemberships).where(eq(companyMemberships.id, f.member.id)))[0].membershipRole).toBeNull();
      expect(profile.actorRefresh).toEqual({ userId: f.userId, memberships: [{ companyId: f.company.id, membershipRole: 'viewer', status: 'active' }], companyIds: [f.company.id], isInstanceAdmin: true });
      expect(profile.witnesses.map(w => w.key).sort()).toEqual([`00:user:${f.userId}`, `08:board_key:${f.key.id}`, `09:membership:${f.member.id}`, `11:admin:${admin.id}`]);
      // Locks are returned, not executed by read; the caller can execute their native SQL.
      for (const witness of [...profile.witnesses].sort((a, b) => a.key.localeCompare(b.key))) await tx.execute(witness.lock);
      expect(inspect(profile, { depth: null })).not.toContain(f.token);
    });
    await db.update(companyMemberships).set({ membershipRole: null }).where(eq(companyMemberships.id, f.member.id));
    expect((await identity.read(db, f.company.id)).membership?.role).toBeNull();
  });

  it.each(['missing', 'inactive'] as const)('returns factual memberless admin with %s selected-company membership', async state => {
    const f = await fixture(), identity = currentBoardIdentity(await authenticated(f));
    const [admin] = await db.insert(instanceUserRoles).values({ userId: f.userId, role: 'instance_admin' }).returning();
    if (state === 'missing') await db.delete(companyMemberships).where(eq(companyMemberships.id, f.member.id));
    else await db.update(companyMemberships).set({ status: 'inactive' }).where(eq(companyMemberships.id, f.member.id));
    const result = await identity.read(db, f.company.id);
    expect(result.membership).toBeNull(); expect(result.adminRoleIds).toEqual([admin.id]);
    expect(result.actorRefresh).toEqual({ userId: f.userId, memberships: [], companyIds: [], isInstanceAdmin: true });
    expect(result.witnesses.map(w => w.key).some(key => key.startsWith('09:'))).toBe(false);
  });

  it.each(['local-board', undefined] as const)('preserves native local identity %s without credential/profile SELECTs', async userId => {
    const f = await fixture(), req = await authenticated(f, 'local_implicit');
    if (userId === undefined) delete req.actor.userId;
    const identity = currentBoardIdentity(req);
    const select = vi.fn(() => { throw new Error('Local identity must not select credential rows'); });
    expect(await identity.read({ select } as unknown as Pick<Db, 'select'>, f.company.id)).toEqual({ source: 'local_implicit', userId: userId ?? null, user: null, credentialDeadline: null, witnesses: [], membership: null, adminRoleIds: [], actorRefresh: null });
    expect(await identity.readPrincipal({ select } as unknown as Pick<Db, 'select'>)).toEqual({ source: 'local_implicit', userId: userId ?? null, user: null, credentialDeadline: null, witnesses: [], adminRoleIds: [] });
    expect(select).not.toHaveBeenCalled(); expect(() => identity.checkTime()).not.toThrow();
    req.actor.userId = 'substituted';
    expect(() => identity.checkTime()).toThrow('Unauthorized');
  });

  it('rechecks local binding across the principal-read await', async () => {
    const f = await fixture(), req = await authenticated(f, 'local_implicit'), identity = currentBoardIdentity(req);
    const pending = identity.read(db, f.company.id);
    req.actor.userId = 'substituted';
    await expect(pending).rejects.toThrow('Unauthorized');
  });

  it('refuses a clone or synthetic board key even with actual header and actor values', async () => {
    const f = await fixture(), req = await authenticated(f);
    expect(() => currentBoardIdentity({ ...req, actor: { ...req.actor } } as Request)).toThrow('Unauthorized');
    expect(() => currentBoardIdentity({ actor: { ...req.actor }, headers: { authorization: `Bearer ${f.token}` } } as Request)).toThrow('Unauthorized');
  });

  it.each(['assistant_grant', 'agent_jwt', 'board_jwt', 'none'])('does not introduce a board identity for %s', async source => {
    const req = await authenticated(await fixture());
    req.actor = { ...req.actor, source } as Request['actor'];
    expect(() => currentBoardIdentity(req)).toThrow('Unauthorized');
  });

  it.each(['revoked', 'expired', 'missing', 'different user'] as const)('refuses a live key that is %s after successful verification', async state => {
    const f = await fixture(), req = await authenticated(f), identity = currentBoardIdentity(req);
    if (state === 'missing') await db.delete(boardApiKeys).where(eq(boardApiKeys.id, f.key.id));
    else if (state === 'different user') {
      const other = await fixture();
      await db.update(boardApiKeys).set({ userId: other.userId }).where(eq(boardApiKeys.id, f.key.id));
    } else await db.update(boardApiKeys).set(state === 'revoked' ? { revokedAt: new Date() } : { expiresAt: new Date(0) }).where(eq(boardApiKeys.id, f.key.id));
    await expect(identity.read(db, f.company.id)).rejects.toThrow('Unauthorized');
  });

  it.each(['board_key', 'session'] as const)('refuses missing auth user after the valid %s row SELECT', async source => {
    const f = await fixture(), identity = currentBoardIdentity(await authenticated(f, source));
    let deleted = false;
    const reader = afterSelect(source === 'board_key' ? boardApiKeys : authSessions, async () => {
      await db.delete(authUsers).where(eq(authUsers.id, f.userId)); deleted = true;
    });
    await expect(identity.read(reader, f.company.id)).rejects.toThrow('Unauthorized');
    expect(deleted).toBe(true); expect(await db.select().from(authUsers).where(eq(authUsers.id, f.userId))).toEqual([]);
  });

  it.each(['board_key', 'session'] as const)('checks %s binding after the last awaited profile query', async source => {
    const f = await fixture(), req = await authenticated(f, source), identity = currentBoardIdentity(req);
    let replaced = false;
    const reader = afterSelect(companyMemberships, () => { req.actor.source = 'local_implicit'; replaced = true; });
    await expect(identity.read(reader, f.company.id)).rejects.toThrow('Unauthorized');
    expect(replaced).toBe(true);
  });

  it.each(['in-place id', 'replacement id', 'user', 'kind'] as const)('captures session primitives independently of %s mutation', async change => {
    const f = await fixture(), req = await authenticated(f, 'session'), identity = currentBoardIdentity(req);
    const profile = await identity.read(db, f.company.id);
    expect(profile.witnesses.map(w => w.key).sort()).toEqual([`00:user:${f.userId}`, `08:session:${f.session.id}`, `09:membership:${f.member.id}`]);
    const other = await fixture();
    if (req.verifiedCredential?.kind !== 'session') throw new Error('Expected authenticated session');
    if (change === 'in-place id') req.verifiedCredential.sessionId = other.session.id;
    if (change === 'replacement id') req.verifiedCredential = { kind: 'session', sessionId: other.session.id, userId: f.userId };
    if (change === 'user') req.verifiedCredential.userId = other.userId;
    if (change === 'kind') req.verifiedCredential = undefined;
    expect(() => identity.checkTime()).toThrow('Unauthorized');
    await expect(identity.read(db, f.company.id)).rejects.toThrow('Unauthorized');
  });

  it.each(['missing', 'expired', 'different user'] as const)('requires the live original session when it is %s', async state => {
    const f = await fixture(), identity = currentBoardIdentity(await authenticated(f, 'session'));
    if (state === 'missing') await db.delete(authSessions).where(eq(authSessions.id, f.session.id));
    else if (state === 'expired') await db.update(authSessions).set({ expiresAt: new Date(0) }).where(eq(authSessions.id, f.session.id));
    else { const other = await fixture(); await db.update(authSessions).set({ userId: other.userId }).where(eq(authSessions.id, f.session.id)); }
    await expect(identity.read(db, f.company.id)).rejects.toThrow('Unauthorized');
  });

  it.each(['board_key', 'session'] as const)('retains the minimum validated %s deadline across rereads and editable returned facts', async source => {
    const f = await fixture(), req = await authenticated(f, source), identity = currentBoardIdentity(req);
    const deadline = Date.now() + 30000, table = source === 'board_key' ? boardApiKeys : authSessions, id = source === 'board_key' ? f.key.id : f.session.id;
    await db.update(table).set({ expiresAt: new Date(deadline) }).where(eq(table.id, id));
    const first = await identity.read(db, f.company.id);
    expect(first.credentialDeadline).toBe(deadline);
    await db.update(table).set({ expiresAt: new Date(deadline + 60000) }).where(eq(table.id, id));
    const second = await identity.read(db, f.company.id);
    expect(second.credentialDeadline).toBe(deadline);
    (first as { credentialDeadline: number | null }).credentialDeadline = null;
    (second as { credentialDeadline: number | null }).credentialDeadline = deadline + 60000;
    vi.spyOn(Date, 'now').mockReturnValue(deadline);
    expect(() => identity.checkTime()).toThrow('Unauthorized');
    await expect(identity.read(db, f.company.id)).rejects.toThrow('Unauthorized');
  });

  it('keeps an original finite key expiry when the live row becomes unbounded', async () => {
    const f = await fixture(), identity = currentBoardIdentity(await authenticated(f));
    await db.update(boardApiKeys).set({ expiresAt: null }).where(eq(boardApiKeys.id, f.key.id));
    expect((await identity.read(db, f.company.id)).credentialDeadline).toBe(f.key.expiresAt!.getTime());
    vi.spyOn(Date, 'now').mockReturnValue(f.key.expiresAt!.getTime());
    expect(() => identity.checkTime()).toThrow('Unauthorized');
  });

  it('adds a finite live bound to an originally unbounded key and never drops it', async () => {
    const f = await fixture(null), identity = currentBoardIdentity(await authenticated(f));
    expect((await identity.read(db, f.company.id)).credentialDeadline).toBeNull();
    const deadline = Date.now() + 30000;
    await db.update(boardApiKeys).set({ expiresAt: new Date(deadline) }).where(eq(boardApiKeys.id, f.key.id));
    expect((await identity.read(db, f.company.id)).credentialDeadline).toBe(deadline);
    await db.update(boardApiKeys).set({ expiresAt: null }).where(eq(boardApiKeys.id, f.key.id));
    expect((await identity.read(db, f.company.id)).credentialDeadline).toBe(deadline);
    vi.spyOn(Date, 'now').mockReturnValue(deadline);
    expect(() => identity.checkTime()).toThrow('Unauthorized');
  });

  it('keeps original expiry through real middleware reauthentication on the same Request', async () => {
    const f = await fixture(), req = await authenticated(f), identity = currentBoardIdentity(req);
    await db.update(boardApiKeys).set({ expiresAt: new Date(f.key.expiresAt!.getTime() + 60000) }).where(eq(boardApiKeys.id, f.key.id));
    await new Promise<void>((resolve, reject) => {
      void actorMiddleware(db, { deploymentMode: 'authenticated' })(req, {} as express.Response, error => error ? reject(error) : resolve());
    });
    expect((await identity.read(db, f.company.id)).credentialDeadline).toBe(f.key.expiresAt!.getTime());
    vi.spyOn(Date, 'now').mockReturnValue(f.key.expiresAt!.getTime());
    expect(() => identity.checkTime()).toThrow('Unauthorized');
  });

  it.each([false, true])('reads a zero-company principal without inventing membership (admin=%s)', async admin => {
    const f = await fixture();
    await db.delete(companyMemberships).where(eq(companyMemberships.id, f.member.id));
    const role = admin ? (await db.insert(instanceUserRoles).values({ userId: f.userId, role: 'instance_admin' }).returning())[0] : null;
    const req = await authenticated(f), identity = currentBoardIdentity(req);
    const principal = await identity.readPrincipal(db);
    expect(principal.user).toEqual({ id: f.userId, name: 'Human', email: `${f.userId}@test.invalid` });
    expect(principal.adminRoleIds).toEqual(role ? [role.id] : []);
    expect(principal.witnesses.map(w => w.key).sort()).toEqual([`00:user:${f.userId}`, `08:board_key:${f.key.id}`, ...(role ? [`11:admin:${role.id}`] : [])]);
    expect(principal).not.toHaveProperty('membership');
    expect(principal).not.toHaveProperty('actorRefresh');
    expect(inspect(principal, { depth: null })).not.toContain(f.token);
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, f.userId))).toEqual([]);
    expect(req.actor.companyIds).toEqual([]);
  });

  it.each(['board_key', 'session'] as const)('checks %s principal binding after the global admin await without company queries', async source => {
    const f = await fixture(), req = await authenticated(f, source), identity = currentBoardIdentity(req);
    let afterAdmin = false;
    const reader = afterSelect(instanceUserRoles, () => { req.actor.userId = 'substituted'; afterAdmin = true; });
    await expect(identity.readPrincipal(reader)).rejects.toThrow('Unauthorized');
    expect(afterAdmin).toBe(true);
  });

  it('retains one board identity across tree reads and the final synchronous guard', async () => {
    const f = await fixture(), req = await authenticated(f), authority = issueTreeCurrentAuthority(req);
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: 'Tree root' }).returning();
    const targets = [{ issue, effectivePatch: {} }];
    const deadline = Date.now() + 30000;
    await db.update(boardApiKeys).set({ expiresAt: new Date(deadline) }).where(eq(boardApiKeys.id, f.key.id));
    await authority.read(db, targets);
    await db.update(boardApiKeys).set({ expiresAt: new Date(deadline + 60000) }).where(eq(boardApiKeys.id, f.key.id));
    await db.transaction(async tx => {
      await tx.execute(sql`select id from ${companies} where id = ${f.company.id} for update`);
      const guard = await authority.stage(tx as unknown as Db, targets);
      await guard.beforeWrite(targets);
      expect(() => guard.checkTime()).not.toThrow();
      req.actor.source = 'local_implicit';
      expect(() => guard.checkTime()).toThrow('Unauthorized');
      req.actor.source = 'board_key';
      vi.spyOn(Date, 'now').mockReturnValue(deadline);
      expect(() => guard.checkTime()).toThrow('Unauthorized');
    });
    await expect(authority.read(db, targets)).rejects.toThrow('Unauthorized');
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].title).toBe('Tree root');
  });

  it('does not run witness locks or start transactions during a SELECT-only read', async () => {
    const f = await fixture(), identity = currentBoardIdentity(await authenticated(f));
    // A concurrent row UPDATE is compatible with plain SELECT; executing FOR SHARE would time out.
    await db.transaction(async writer => {
      await writer.update(boardApiKeys).set({ name: 'Uncommitted' }).where(eq(boardApiKeys.id, f.key.id));
      await db.transaction(async reader => {
        await reader.execute(sql`set local statement_timeout = '1000ms'`);
        expect((await identity.read({ select: reader.select.bind(reader) } as Pick<Db, 'select'>, f.company.id)).userId).toBe(f.userId);
      });
    });
  });
});
