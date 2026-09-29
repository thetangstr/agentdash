import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, companies, createDb, verdicts } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { verdictRoutes } from '../routes/verdicts.js';
import { workforceService } from '../services/workforce.js';
import { verdictsService } from '../services/verdicts.js';
import { documentService } from '../services/documents.js';
import { errorHandler } from '../middleware/index.js';

describe('workforce verdict reviewer identity', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), "workforce-verdict-")); process.env.PAPERCLIP_HOME = home;
    temp = await startEmbeddedPostgresTestDatabase('workforce-verdict-identity-');
    db = createDb(temp.connectionString);
  });
  afterAll(async () => { await temp?.cleanup(); await rm(home, { recursive: true, force: true }); if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome; });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Review identity', issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [worker, reviewer] = await db.insert(agents).values([
      { companyId: company.id, name: 'Worker', adapterType: 'codex_local' },
      { companyId: company.id, name: 'Independent reviewer' },
    ]).returning();
    const svc = workforceService(db);
    const owner = { userId: 'owner' };
    await svc.enroll(company.id, worker.id, { templateId: 'sales-support' }, owner);
    await svc.ensureSkillsInstalled(company.id, worker.id, owner);
    await svc.updateBrief(company.id, {
      expectedRevision: 0, sources: [],
      facts: ['offer', 'pricing', 'idealCustomer', 'qualificationRules'].map(key => ({ key, value: 'Approved input', sourceReference: 'Owner intake' })),
    }, owner);
    await svc.acknowledgeLearning(company.id, worker.id, 1, owner);
    const issue = await svc.startFirstJob(company.id, worker.id, owner);
    await documentService(db).upsertIssueDocument({ issueId: issue.id, key: 'deliverable', format: 'markdown', body: 'Qualification checklist and outreach draft with approved pricing.', createdByAgentId: worker.id });
    const body = { entityType: 'issue', issueId: issue.id, outcome: 'passed' };
    const url = `/api/companies/${company.id}/verdicts`;
    return { company, worker, reviewer, svc, issue, body, url };
  }
  function app(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
    app.use('/api', verdictRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it('refuses the enrolled worker impersonating a human or peer reviewer', async () => {
    const { company, worker, reviewer, svc, issue, body, url } = await fixture();
    const client = app({ type: 'agent', companyId: company.id, agentId: worker.id });
    for (const identity of [{ reviewerUserId: 'someone-else' }, { reviewerAgentId: reviewer.id }]) {
      expect((await request(client).post(url).send({ ...body, ...identity })).status).toBe(403);
    }
    expect(await db.select().from(verdicts).where(and(eq(verdicts.companyId, company.id), eq(verdicts.issueId, issue.id)))).toHaveLength(0);
    expect((await svc.getReadiness(company.id, worker.id))?.phase).not.toBe('ready');
  });

  it('binds an independent authenticated agent and retains assignee neutrality', async () => {
    const { company, worker, reviewer, svc, body, url } = await fixture();
    const self = app({ type: 'agent', companyId: company.id, agentId: worker.id });
    expect((await request(self).post(url).send({ ...body, reviewerAgentId: worker.id })).status).toBe(409);
    const neutral = app({ type: 'agent', companyId: company.id, agentId: reviewer.id });
    const response = await request(neutral).post(url).send(body);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ reviewerAgentId: reviewer.id, reviewerUserId: null });
    expect((await svc.getReadiness(company.id, worker.id))?.phase).toBe('ready');
  });

  it('refuses human impersonation and records the authenticated neutral human', async () => {
    const { company, worker, reviewer, svc, body, url } = await fixture();
    const client = app({ type: 'board', source: 'session', userId: 'human-reviewer', companyIds: [company.id] });
    for (const identity of [{ reviewerUserId: 'other-human' }, { reviewerAgentId: reviewer.id }]) {
      expect((await request(client).post(url).send({ ...body, ...identity })).status).toBe(403);
    }
    const response = await request(client).post(url).send({ ...body, reviewerUserId: 'human-reviewer' });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ reviewerAgentId: null, reviewerUserId: 'human-reviewer' });
    expect((await svc.getReadiness(company.id, worker.id))?.phase).toBe('ready');
  });

  it('uses the local board identity without accepting a supplied human identity', async () => {
    const { body, url } = await fixture();
    const client = app({ type: 'board', source: 'local_implicit' });
    expect((await request(client).post(url).send({ ...body, reviewerUserId: 'someone-else' })).status).toBe(403);
    const response = await request(client).post(url).send(body);
    expect(response.status).toBe(201);
    expect(response.body.reviewerUserId).toBe('board');
  });

  it('preserves explicitly trusted internal service reviewers', async () => {
    const { company, reviewer, issue } = await fixture();
    expect(await verdictsService(db).create({ companyId: company.id, entityType: 'issue', issueId: issue.id, outcome: 'passed', reviewerAgentId: reviewer.id })).toMatchObject({ reviewerAgentId: reviewer.id });
  });
});
