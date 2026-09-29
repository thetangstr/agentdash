import { randomUUID } from 'node:crypto';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authUsers, boardApiKeys, createDb } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { hashBearerToken } from '../services/board-auth.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import type { Server } from 'node:http';

describe('explicit credentials never inherit local board authority', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('human-control-auth-');
    db = createDb(temp.connectionString);
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: 'local_trusted' }));
    app.get('/identity', (req, res) => res.json(req.actor));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); await temp?.cleanup(); });
  async function identity(headers: Record<string, string> = {}) {
    return (await fetch(`${base}/identity`, { headers })).json();
  }
  it('keeps no-credential local use, but denies invalid and explicitly empty headers', async () => {
    expect(await identity()).toMatchObject({ type: 'board', source: 'local_implicit' });
    for (const headers of [{ authorization: 'Bearer invalid' }, { authorization: 'Bearer ' }, { 'x-agent-key': 'invalid' }, { 'x-agent-key': '' }]) {
      expect(await identity(headers)).toMatchObject({ type: 'none', source: 'none' });
    }
  });
  it('resolves the named user only for a current live key', async () => {
    const userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: 'Human', email: `${userId}@test.invalid`, createdAt: now, updatedAt: now });
    for (const state of ['live', 'revoked', 'expired'] as const) {
      const token = `pcp_board_${randomUUID()}`;
      await db.insert(boardApiKeys).values({ userId, name: state, keyHash: hashBearerToken(token), revokedAt: state === 'revoked' ? now : null, expiresAt: new Date(Date.now() + (state === 'expired' ? -60000 : 60000)) });
      expect(await identity({ authorization: `Bearer ${token}` })).toMatchObject(state === 'live' ? { type: 'board', source: 'board_key', userId } : { type: 'none', source: 'none' });
    }
  });
});
