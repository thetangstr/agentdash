import { randomUUID } from 'node:crypto';
import express, { type Request } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { activityLog, authUsers, boardApiKeys, companies, companyMemberships, createDb, issueComments, issues, type Db } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { issueRoutes } from '../routes/issues.js';
import { hashBearerToken } from '../services/board-auth.js';
import { publishLiveEvent } from '../services/live-events.js';
import type { StorageService } from '../storage/types.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

const effects = vi.hoisted(() => ({ cancelRun: vi.fn(), wakeup: vi.fn(), reportRunActivity: vi.fn() }));
vi.mock('../services/heartbeat.js', () => ({ heartbeatService: () => effects }));
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));

describe('original board identity on canonical issue HTTP acceptance', () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase('current-board-http-');
    db = createDb(temporary.connectionString);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const userId = randomUUID(), token = `pcp_board_${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: 'Human', email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    const [key] = await db.insert(boardApiKeys).values({ userId, name: 'Disposable', keyHash: hashBearerToken(token), expiresAt: new Date(Date.now() + 60000) }).returning();
    const [company] = await db.insert(companies).values({ name: 'Identity', issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: userId, membershipRole: 'member', status: 'active' });
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: 'Original', status: 'backlog' }).returning();
    return { userId, token, key, company, issue };
  }

  function app(afterAuthentication: (req: Request) => Promise<void> | void, afterCollection?: (req: Request) => Promise<void> | void) {
    let actualRequest: Request;
    // Interpose only the real issue UPDATE lock await, after initial identity collection.
    const routeDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      return (callback: (tx: Db) => Promise<unknown>) => target.transaction(async tx => callback(new Proxy(tx, { get(t, k, r) {
        if (k !== 'select') return Reflect.get(t, k, r);
        return (...args: unknown[]) => {
          const query = (t.select as Function)(...args), from = query.from.bind(query);
          query.from = (table: unknown) => {
            const builder = from(table), originalFor = builder.for.bind(builder);
            builder.for = (mode: string) => {
              const result = originalFor(mode);
              if (table !== issues || mode !== 'update' || !afterCollection) return result;
              const run = afterCollection; afterCollection = undefined;
              return { then: (resolve: Function, reject: Function) => Promise.resolve(run(actualRequest)).then(() => result).then(resolve, reject) };
            };
            return builder;
          };
          return query;
        };
      } }) as unknown as Db));
    } });
    const application = express(); application.use(express.json());
    application.use(actorMiddleware(db, { deploymentMode: 'authenticated' }));
    application.use(async (req, _res, next) => {
      actualRequest = req;
      try { await afterAuthentication(req); next(); } catch (e) { next(e); }
    });
    application.use('/api', issueRoutes(routeDb, {} as StorageService));
    application.use(errorHandler);
    return application;
  }

  async function noWrites(f: Awaited<ReturnType<typeof fixture>>) {
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].title).toBe('Original');
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual([]);
    expect(effects.wakeup).not.toHaveBeenCalled(); expect(effects.cancelRun).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  }

  it('refuses the expired original key even when its live expiry was extended after authentication', async () => {
    const f = await fixture(), originalDeadline = f.key.expiresAt!.getTime(), extended = new Date(originalDeadline + 60000);
    let postAuth = false;
    const application = app(async req => {
      expect(req.actor).toMatchObject({ type: 'board', source: 'board_key', userId: f.userId, keyId: f.key.id });
      await db.update(boardApiKeys).set({ expiresAt: extended }).where(eq(boardApiKeys.id, f.key.id));
      postAuth = true;
      vi.spyOn(Date, 'now').mockReturnValue(originalDeadline);
    });
    const response = await request(application).patch(`/api/issues/${f.issue.id}`).set('authorization', `Bearer ${f.token}`).send({ title: 'Changed', comment: 'Refuse' });
    expect(postAuth).toBe(true);
    expect((await db.select().from(boardApiKeys).where(eq(boardApiKeys.id, f.key.id)))[0].expiresAt).toEqual(extended);
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain(f.token);
    await noWrites(f);
  });

  it.each(['same user key before collection', 'different user before collection', 'key after collection', 'source after collection'] as const)('refuses %s substitution on the actual Request', async change => {
    const f = await fixture(), other = await fixture();
    const [secondKey] = await db.insert(boardApiKeys).values({ userId: f.userId, name: 'Other key', keyHash: hashBearerToken(randomUUID()) }).returning();
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: 'user', principalId: other.userId, membershipRole: 'member', status: 'active' });
    let authenticated = false, substituted = false;
    const substitute = (req: Request) => {
      substituted = true;
      if (change === 'source after collection') req.actor.source = 'local_implicit';
      else if (change === 'different user before collection') req.actor = { ...req.actor, userId: other.userId, keyId: other.key.id };
      else req.actor.keyId = secondKey.id;
    };
    const application = app(req => {
      expect(req.actor).toMatchObject({ type: 'board', source: 'board_key', userId: f.userId, keyId: f.key.id });
      authenticated = true;
      if (change.endsWith('before collection')) substitute(req);
    }, change.endsWith('after collection') ? substitute : undefined);
    const response = await request(application).patch(`/api/issues/${f.issue.id}`).set('authorization', `Bearer ${f.token}`).send({ title: 'Changed', comment: 'Refuse' });
    expect(authenticated).toBe(true); expect(substituted).toBe(true);
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain(f.token);
    await noWrites(f);
  });
});
