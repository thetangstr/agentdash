import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agents, companies, createDb } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { heartbeatService } from '../services/heartbeat.js';
import * as routes from '../routes/workforce.js';
import { errorHandler } from '../middleware/index.js';

describe('workforce HTTP authority', () => {
  let skillHome: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string, agentId: string, peerId: string;
  beforeAll(async () => {
    skillHome = await mkdtemp(path.join(tmpdir(), 'workforce-skills-'));
    process.env.PAPERCLIP_HOME = skillHome;
    temp = await startEmbeddedPostgresTestDatabase('agentdash-workforce-routes-'); db = createDb(temp.connectionString);
    [companyId] = (await db.insert(companies).values({ name: 'Route test', issuePrefix: randomUUID().slice(0, 8) }).returning()).map(x => x.id);
    [agentId, peerId] = (await db.insert(agents).values([{ companyId, name: 'Self', adapterType: 'codex_local' }, { companyId, name: 'Peer' }]).returning()).map(x => x.id);
  });
  afterAll(async () => { await temp?.cleanup(); await rm(skillHome, { recursive: true, force: true }); if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome; });
  function app(actor: Record<string, unknown>) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
    app.use('/api', routes.workforceRoutes(db, { heartbeat: heartbeatService(db, { autoDispatchQueuedRuns: false }) })); app.use(errorHandler); return app;
  }
  const worker = () => ({ type: 'agent', companyId, agentId });
  const board = (membershipRole = 'admin') => ({ type: 'board', source: 'session', userId: 'owner', companyIds: [companyId], memberships: [{ companyId, status: 'active', membershipRole }] });
  const base = () => `/api/companies/${companyId}/workforce`;
  it('requires human direction authority to publish a brief', async () => {
    const body = { expectedRevision: 0, sources: [], facts: [] };
    expect((await request(app(worker())).put(`${base()}/brief`).send(body)).status).toBe(403);
    expect((await request(app(board('member'))).put(`${base()}/brief`).send(body)).status).toBe(403);
    expect((await request(app(board())).put(`${base()}/brief`).send(body)).status).toBe(200);
  });
  it('allows company reads but rejects cross-company and peer-agent lookups', async () => {
    expect((await request(app(worker())).get(`${base()}/brief`)).status).toBe(200);
    expect((await request(app(worker())).get(`${base()}/agents/${peerId}/enrollment`)).status).toBe(403);
    expect((await request(app({ ...worker(), companyId: randomUUID() })).get(`${base()}/templates`)).status).toBe(403);
  });
  it('only authorized humans can select a role and start work', async () => {
    expect((await request(app(worker())).post(`${base()}/agents/${agentId}/enrollment`).send({ templateId: 'sales-support' })).status).toBe(403);
    expect((await request(app(board())).post(`${base()}/agents/${agentId}/enrollment`).send({ templateId: 'sales-support' })).status).toBe(200);
    expect((await request(app(worker())).post(`${base()}/agents/${agentId}/first-job`).send({})).status).toBe(403);
    expect((await request(app(board())).post(`${base()}/agents/${agentId}/first-job`).send({})).status).toBe(200);
  });
});
