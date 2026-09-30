import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { actorMiddleware } from '../middleware/auth.js';
import { agents, companies, companyMemberships, authUsers, authSessions, createDb } from '@paperclipai/db';
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
  const sessionId = randomUUID();
  beforeAll(async () => {
    skillHome = await mkdtemp(path.join(tmpdir(), 'workforce-skills-'));
    process.env.PAPERCLIP_HOME = skillHome;
    temp = await startEmbeddedPostgresTestDatabase('agentdash-workforce-routes-'); db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: 'owner', name: 'Owner', email: 'owner@routes.test.invalid', createdAt: new Date(), updatedAt: new Date() });
    await db.insert(authSessions).values({ id: sessionId, token: randomUUID(), userId: 'owner', expiresAt: new Date(Date.now() + 600000), createdAt: new Date(), updatedAt: new Date() });
    [companyId] = (await db.insert(companies).values({ name: 'Route test', issuePrefix: randomUUID().slice(0, 8) }).returning()).map(x => x.id);
    await db.insert(companyMemberships).values({ companyId, principalType: 'user', principalId: 'owner', status: 'active', membershipRole: 'admin' });
    [agentId, peerId] = (await db.insert(agents).values([{ companyId, name: 'Self', adapterType: 'codex_local' }, { companyId, name: 'Peer' }]).returning()).map(x => x.id);
  });
  afterAll(async () => { await temp?.cleanup(); await rm(skillHome, { recursive: true, force: true }); if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome; });
  function app(actor: Record<string, unknown>) {
    const app = express(); app.use(express.json());
    if (actor.type === 'board') {
      app.use(async (_req, _res, next) => {
        await db.update(companyMemberships).set({ membershipRole: (actor.memberships as { membershipRole: string }[])[0].membershipRole }).where(eq(companyMemberships.companyId, companyId));
        next();
      });
      app.use(actorMiddleware(db, { deploymentMode: 'authenticated', resolveSession: async () => ({ session: { id: sessionId, userId: 'owner' }, user: { id: 'owner', name: 'Owner', email: 'owner@routes.test.invalid' } }) }));
    } else app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
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
  it('restricts proposal review and target changes to company direction authority', async () => {
    for (const actor of [worker(), board('member')]) {
      expect((await request(app(actor)).get(`${base()}/proposals`)).status).toBe(403);
      expect((await request(app(actor)).post(`${base()}/proposals/${randomUUID()}/review`).send({ decision: 'approve', expectedRevision: 1 })).status).toBe(403);
      expect((await request(app(actor)).patch(`${base()}/agents/${agentId}/enrollment`).send({ objective: 'Private update' })).status).toBe(403);
    }
    expect((await request(app(board())).patch(`${base()}/agents/${agentId}/enrollment`).send({ templateId: 'marketing-content' })).status).toBe(400);
    const updated = await request(app(board())).patch(`${base()}/agents/${agentId}/enrollment`).send({ objective: 'Qualify leads', metrics: ['10 qualified leads'], goalId: null });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ templateId: 'sales-support', objective: 'Qualify leads', metrics: ['10 qualified leads'], goalId: null });
    expect((await request(app({ ...worker(), companyId: randomUUID() })).get(`${base()}/proposals`)).status).toBe(403);
  });
  it('returns inspectable source provenance and reviews through HTTP', async () => {
    const brief = await request(app(board())).get(`${base()}/brief`);
    const published = await request(app(board())).put(`${base()}/brief`).send({ expectedRevision: brief.body.revision, sources: [{ id: 'source', label: 'Owner source', content: 'Approved audience' }], facts: [] });
    const proposal = await request(app(worker())).post(`${base()}/proposals`).send({ facts: [{ key: 'audience', value: 'Businesses', sourceReference: 'source' }], sourceReferences: ['source'] });
    expect(proposal.status).toBe(201);
    const list = await request(app(board())).get(`${base()}/proposals`);
    expect(list.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: proposal.body.id, status: 'proposed', sources: [{ id: 'source', label: 'Owner source', content: 'Approved audience' }] })]));
    const reviewed = await request(app(board())).post(`${base()}/proposals/${proposal.body.id}/review`).send({ decision: 'approve', expectedRevision: published.body.revision });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toMatchObject({ status: 'approved', reviewedByUserId: 'owner' });
  });

});
