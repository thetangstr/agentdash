import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { workforceRoutes } from '../routes/workforce.js';
import { issueRoutes } from '../routes/issues.js';
import type { StorageService } from '../storage/types.js';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/index.js';
import { eq, and } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { agents, companies, companyMemberships, authUsers, authSessions, createDb, agentRuns, issueComments, issues } from '@paperclipai/db';
import type { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { workforceService } from '../services/workforce.js';
import { heartbeatService } from '../services/heartbeat.js';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';

const execute = vi.hoisted(() => vi.fn());
vi.mock('../adapters/index.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js');
  return { ...actual, getServerAdapter: (type: string) => ({ ...actual.getServerAdapter(type), execute, supportsLocalAgentJwt: false }) };
});
vi.mock('../telemetry.js', () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

describe('inactive owner recovery with real heartbeat', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const priorHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'owner-recovery-runtime-'));
    process.env.PAPERCLIP_HOME = home;
    temp = await startEmbeddedPostgresTestDatabase('owner-recovery-runtime-'); db = createDb(temp.connectionString);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); if (priorHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = priorHome; await rm(home, { recursive: true, force: true }); });
  it('holds the stranded KEYLESS job across recovery, then resumes it exactly once after Bob answers and keeps unrelated work usable', async () => {
    const [company] = await db.insert(companies).values({ name: 'Runtime company', issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: 'owner', membershipRole: 'owner', status: 'active' });
    await db.insert(authUsers).values({ id: 'owner', name: 'Owner', email: 'owner@runtime.test.invalid', createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: 'bob', membershipRole: 'admin', status: 'active' });
    await db.insert(authUsers).values({ id: 'bob', name: 'Bob', email: 'bob@recovery.test.invalid', createdAt: new Date(), updatedAt: new Date() });
    const sessionId = randomUUID();
    await db.insert(authSessions).values({ id: sessionId, token: randomUUID(), userId: 'bob', expiresAt: new Date(Date.now() + 600000), createdAt: new Date(), updatedAt: new Date() });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Worker', adapterType: 'codex_local', adapterConfig: { cwd: home, command: '/bin/true' }, autonomy: 'autonomous', accountableUserId: 'owner' }).returning();
    const svc = workforceService(db), questions = issueThreadInteractionService(db), heartbeat = heartbeatService(db);
    await svc.enroll(company.id, agent.id, { templateId: 'marketing-content' }, { userId: 'owner' });
    const job = await svc.startFirstJob(company.id, agent.id, { userId: 'owner' });
    let interactionId = '';
    const captured: AdapterExecutionContext[] = [];
    execute.mockImplementation(async (ctx: AdapterExecutionContext) => {
      captured.push(ctx);
      if (captured.length === 1) {
        const q = await questions.create(job, { kind: 'ask_user_questions', continuationPolicy: 'wake_assignee', sourceRunId: ctx.runId, payload: { version: 1, questions: [{ id: 'offer', prompt: 'What offer?', selectionMode: 'text', options: [], required: true }] } }, { agentId: agent.id });
        interactionId = q.id;
      }
      if (typeof ctx.context.issueId === 'string') await db.insert(issueComments).values({ companyId: company.id, issueId: ctx.context.issueId, authorAgentId: agent.id, createdByRunId: ctx.runId, body: captured.length === 1 ? 'Waiting for required input.' : 'Used approved and issue-scoped input.' });
      return { exitCode: 0, signal: null, timedOut: false, summary: 'Updated the issue with current status.', sessionId: 'resume-session', sessionParams: { sessionId: 'resume-session', cwd: home }, provider: 'test', model: 'fake', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
    });
    async function run(issueId: string, extra: Record<string, unknown> = {}) {
      const queued = await heartbeat.invoke(agent.id, 'on_demand', { issueId, ...extra });
      expect(queued).not.toBeNull();
      await vi.waitFor(async () => {
        expect((await heartbeat.getRun(queued!.id))?.status).toBe('succeeded');
        expect(await db.select().from(agentRuns).where(eq(agentRuns.heartbeatRunId, queued!.id))).toHaveLength(1);
      }, { timeout: 15000, interval: 50 });
      return queued!;
    }
    await run(job.id, { paperclipWorkforce: { invented: 'forged' } });
    expect(captured[0].context.paperclipWorkforce).toMatchObject({ brief: { revision: 0, facts: [] }, taskFacts: [] });
    expect(interactionId).not.toBe('');
    const before = captured.length;
    for (let i = 0; i < 3; i++) expect(await heartbeat.invoke(agent.id, 'on_demand', { issueId: job.id, interactionStatus: 'answered' })).toBeNull();
    expect(captured).toHaveLength(before);
    expect(await db.select().from(agentRuns).where(eq(agentRuns.agentId, agent.id))).toHaveLength(1);
    await db.update(companyMemberships).set({status:'inactive'}).where(and(eq(companyMemberships.companyId,company.id),eq(companyMemberships.principalId,'owner')));
    await db.update(agents).set({accountableUserId:'bob'}).where(eq(agents.id,agent.id));
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: 'authenticated', resolveSession: async () => ({ session: { id: sessionId, userId: 'bob' }, user: { id: 'bob', name: 'Bob', email: 'bob@recovery.test.invalid' } }) }));
    app.use('/api', workforceRoutes(db));
    app.use('/api', issueRoutes(db, {} as StorageService));
    app.use(errorHandler);
    const readinessPath = `/api/companies/${company.id}/workforce/agents/${agent.id}/readiness`;
    expect((await request(app).get(readinessPath)).status).toBe(404);
    const recoveryPath = `/api/issues/${job.id}/question-recovery`;
    const metadata = await request(app).get(recoveryPath);
    expect(metadata.status).toBe(200);
    expect((await request(app).post(`${recoveryPath}/${interactionId}/cancel`).send({expectedUpdatedAt:metadata.body.items[0].updatedAt})).status).toBe(200);
    expect(await heartbeat.invoke(agent.id,'on_demand',{issueId:job.id})).toBeNull();
    expect(captured).toHaveLength(1);
    const replacement = await request(app).post(`${recoveryPath}/${interactionId}/replace`).send({});
    expect(replacement.status).toBe(201);
    expect(replacement.body.payload.answerOwnerUserId).toBe('bob');
    expect(await heartbeat.invoke(agent.id,'on_demand',{issueId:job.id})).toBeNull();
    const responsePath = `/api/issues/${job.id}/interactions/${replacement.body.id}/respond`;
    const responseBody = { answers: [{ questionId: 'offer', optionIds: [], text: 'Job-private trial offer' }] };
    expect((await request(app).post(responsePath).send(responseBody)).status).toBe(200);
    await vi.waitFor(async () => {
      expect(captured).toHaveLength(2);
      expect((await heartbeat.getRun(captured[1].runId))?.status).toBe('succeeded');
      expect(await db.select().from(agentRuns).where(eq(agentRuns.agentId, agent.id))).toHaveLength(2);
    }, { timeout: 15000, interval: 50 });
    expect((await request(app).post(responsePath).send(responseBody)).status).toBe(409);
    expect(captured).toHaveLength(2);
    expect(captured[1].context.issueId).toBe(job.id);
    expect((await request(app).get(readinessPath)).status).toBe(200);
    expect(captured[1].runtime.sessionParams).toMatchObject({ sessionId: 'resume-session' });
    expect(captured[1].context.paperclipWorkforce).toMatchObject({ taskFacts: [{ value: 'Job-private trial offer', issueId: job.id }], brief: { facts: [] } });
    const [other] = await db.insert(issues).values({ companyId: company.id, title: 'Second job', assigneeAgentId: agent.id, status: 'todo' }).returning();
    await run(other.id);
    expect(captured[2].context.paperclipWorkforce).toMatchObject({ taskFacts: [], brief: { facts: [] } });
    expect((await svc.getBrief(company.id)).facts).toEqual([]);
  }, 45000);
});
