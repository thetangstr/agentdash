import { randomUUID } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authUsers, boardApiKeys, createDb, type Db } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { humanControlRoutes } from '../routes/human-control.js';
import { hashBearerToken } from '../services/board-auth.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

describe('foundation authority on an actual authenticated HTTP request', () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase('foundation-authority-');
    db = createDb(temporary.connectionString);
  });

  afterAll(async () => { await temporary?.cleanup(); });

  async function credential(userId = randomUUID()) {
    await db.insert(authUsers).values({
      id: userId, name: 'Foundation human', email: `${userId}@test.invalid`,
      createdAt: new Date(), updatedAt: new Date(),
    }).onConflictDoNothing();
    const token = `pcp_board_${randomUUID()}`;
    const [key] = await db.insert(boardApiKeys).values({
      userId, name: 'Disposable test key', keyHash: hashBearerToken(token),
    }).returning();
    return { userId, token, key };
  }

  function app(afterAuthentication?: RequestHandler) {
    const application = express();
    application.use(express.json());
    application.use(actorMiddleware(db, { deploymentMode: 'local_trusted' }));
    if (afterAuthentication) application.use(afterAuthentication);
    application.use('/human', humanControlRoutes(db, { heartbeat: { wakeup: async () => null } }));
    application.use(errorHandler);
    return application;
  }

  it.each(['same user, different key', 'different user and key'])('rejects a replaced actor binding: %s', async replacement => {
    const original = await credential();
    const other = await credential(replacement === 'same user, different key' ? original.userId : undefined);
    const application = app((req, _res, next) => {
      // Keep the real Request; a mutable actor is not verified provenance.
      req.actor = { ...req.actor, userId: other.userId, keyId: other.key.id };
      next();
    });
    const response = await request(application).get('/human/identity').set('authorization', `Bearer ${original.token}`);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('user');
    expect(JSON.stringify(response.body)).not.toContain(other.userId);
  });

  it('preserves verified x-agent-key board credentials and Authorization precedence', async () => {
    const first = await credential();
    const second = await credential();
    const application = app();
    const alternateHeader = await request(application).get('/human/identity').set('x-agent-key', first.token);
    expect(alternateHeader.status).toBe(200);
    expect(alternateHeader.body.user.id).toBe(first.userId);
    const preferredHeader = await request(application).get('/human/identity')
      .set('authorization', `Bearer ${first.token}`).set('x-agent-key', second.token);
    expect(preferredHeader.status).toBe(200);
    expect(preferredHeader.body.user.id).toBe(first.userId);
    expect(JSON.stringify(preferredHeader.body)).not.toContain(first.token);
    expect(JSON.stringify(preferredHeader.body)).not.toContain(second.token);
  });

  it('does not turn local implicit or an invalid explicit key into foundation authority', async () => {
    const application = app();
    expect((await request(application).get('/human/identity')).status).toBe(403);
    expect((await request(application).get('/human/identity').set('x-agent-key', 'invalid')).status).toBe(403);
  });

  it('does not extend the original request deadline when the stored key expiry is extended', async () => {
    const original = await credential();
    const expiresAt = new Date(Date.now() + 1500);
    await db.update(boardApiKeys).set({ expiresAt }).where(eq(boardApiKeys.id, original.key.id));
    let extensionExecuted = false;
    const extendedExpiresAt = new Date(Date.now() + 60000);
    const application = app(async (req, _res, next) => {
      expect(req.actor).toMatchObject({ type: 'board', source: 'board_key', userId: original.userId, keyId: original.key.id });
      await db.update(boardApiKeys).set({ expiresAt: extendedExpiresAt }).where(eq(boardApiKeys.id, original.key.id));
      extensionExecuted = true;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 10)));
      next();
    });
    const response = await request(application).get('/human/identity').set('authorization', `Bearer ${original.token}`);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('user');
    expect(extensionExecuted).toBe(true);
    const [persisted] = await db.select().from(boardApiKeys).where(eq(boardApiKeys.id, original.key.id));
    expect(persisted.expiresAt).toEqual(extendedExpiresAt);
    expect(persisted.expiresAt!.getTime()).toBeGreaterThan(expiresAt.getTime());
  });

  it('clears original credential provenance when middleware is re-entered on the same request', async () => {
    const original = await credential();
    const authenticateAgain = actorMiddleware(db, { deploymentMode: 'local_trusted' });
    const application = app((req, res, next) => {
      const originalActor = req.actor;
      req.headers.authorization = 'Bearer invalid';
      void authenticateAgain(req, res, error => {
        if (error) return next(error);
        req.actor = originalActor;
        next();
      });
    });
    const response = await request(application).get('/human/identity').set('authorization', `Bearer ${original.token}`);
    expect(response.status).toBe(403);
  });

});
