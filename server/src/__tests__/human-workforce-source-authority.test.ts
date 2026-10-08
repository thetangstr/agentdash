import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agents, agentApiKeys, authUsers, boardApiKeys, companies, companyMemberships, companySkills, workforceEnrollments, activityLog, issueThreadInteractions, issues, humanActionHandles, authSessions, instanceUserRoles, projects, projectAccess, principalPermissionGrants, goals, createDb, type Db } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { humanControlRoutes } from '../routes/human-control.js';
import { issueRoutes } from '../routes/issues.js';
import type { StorageService } from '../storage/types.js';
import { workforceIssueInputs } from '../services/workforce-inputs.js';
import { workforceRoutes } from '../routes/workforce.js';
import { hashBearerToken } from '../services/board-auth.js';
import { workforceService } from '../services/workforce.js';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';
import { subscribeCompanyLiveEvents } from '../services/live-events.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

const effects = vi.hoisted(() => ({ wakeup: vi.fn(async () => null) }));
vi.mock('../services/heartbeat.js', () => ({ heartbeatService: () => effects }));

describe('current authority for actual readiness sources', () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let skillHome: string;
  const priorHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    skillHome = await fs.mkdtemp(path.join(tmpdir(), 'foundation-curated-'));
    process.env.PAPERCLIP_HOME = skillHome;
    temporary = await startEmbeddedPostgresTestDatabase('foundation-authority-');
    db = createDb(temporary.connectionString);
  });

  afterAll(async () => { await temporary?.cleanup(); await fs.rm(skillHome, { recursive: true, force: true }); if (priorHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = priorHome; });

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

  function app(afterAuthentication?: RequestHandler, connection: Db = db, authentication: Parameters<typeof actorMiddleware>[1] = { deploymentMode: 'local_trusted' }) {
    const application = express();
    application.use(express.json());
    application.use(actorMiddleware(db, authentication));
    if (afterAuthentication) application.use(afterAuthentication);
    application.use('/human', humanControlRoutes(connection, { heartbeat: effects }));
    application.use('/api', workforceRoutes(connection, { heartbeat: effects }));
    application.use('/api', issueRoutes(connection, {} as StorageService));
    application.use(errorHandler);
    return application;
  }

  it.each(['pending', 'answered', 'cancelled'] as const)('refuses the whole readiness projection for another owner’s contributing %s question', async state => {
    const owner = await credential();
    const reader = await credential();
    const [company] = await db.insert(companies).values({ name: 'Private readiness', issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values([owner, reader].map(person => ({
      companyId: company.id, principalType: 'user', principalId: person.userId,
      membershipRole: 'member', status: 'active',
    })));
    const [agent] = await db.insert(agents).values({
      companyId: company.id, name: 'Enrolled worker', adapterType: 'codex_local',
      autonomy: 'autonomous', accountableUserId: owner.userId,
    }).returning();
    const agentToken = `pcp_${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId: company.id, agentId: agent.id, name: 'Own worker', keyHash: hashBearerToken(agentToken) });
    const workforce = workforceService(db);
    await workforce.enroll(company.id, agent.id, { templateId: 'marketing-content' }, { userId: owner.userId });
    const issue = await workforce.startFirstJob(company.id, agent.id, { userId: owner.userId });
    const interactions = issueThreadInteractionService(db);
    const question = await interactions.create(issue, {
      kind: 'ask_user_questions', payload: { version: 1, questions: [{
        id: 'offer', prompt: 'Private offer?', companyFactKey: 'offer',
        selectionMode: 'text', options: [], required: true,
      }] },
    }, { agentId: agent.id });
    if (state === 'answered') await interactions.answerQuestions(issue, question.id, {
      answers: [{ questionId: 'offer', optionIds: [], text: 'Private accepted offer' }], shareWithCompany: false,
    }, { userId: owner.userId });
    if (state === 'cancelled') await interactions.cancelQuestions(issue, question.id, {}, { userId: owner.userId });

    const application = app();
    const path = `/api/companies/${company.id}/workforce/agents/${agent.id}`;
    const native = await request(application).get(`${path}/readiness`).set('authorization', `Bearer ${reader.token}`);
    expect(native.status).toBe(404);
    expect(native.body).not.toHaveProperty('phase');
    const foundation = await request(application).post('/human/read').set('authorization', `Bearer ${reader.token}`).send({
      target: { kind: 'company', companyId: company.id }, operationId: 'workforce.readiness.read', version: 1, input: { agentId: agent.id },
    });
    expect(foundation.status).toBe(404);
    expect(foundation.body).not.toHaveProperty('missingFactKeys');
    expect((await request(application).get(`${path}/enrollment`).set('authorization', `Bearer ${reader.token}`)).status).toBe(200);
    const owned = await request(application).get(`${path}/readiness`).set('authorization', `Bearer ${owner.token}`);
    expect(owned.status).toBe(200);
    const worker = await request(application).get(`${path}/readiness`).set('authorization', `Bearer ${agentToken}`);
    expect(worker.status).toBe(200);
    expect(worker.body).toEqual(owned.body);
    // #882 review P2: a company admin still reads readiness (question ids,
    // never the private answer).
    const admin = await credential();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: admin.userId, membershipRole: 'admin', status: 'active' });
    const adminNative = await request(application).get(`${path}/readiness`).set('authorization', `Bearer ${admin.token}`);
    expect(adminNative.status).toBe(200);
    expect(adminNative.body).toEqual(owned.body);
    expect(JSON.stringify(adminNative.body)).not.toContain('Private accepted offer');
    const adminFoundation = await request(application).post('/human/read').set('authorization', `Bearer ${admin.token}`).send({
      target: { kind: 'company', companyId: company.id }, operationId: 'workforce.readiness.read', version: 1, input: { agentId: agent.id },
    });
    expect(adminFoundation.status).toBe(200);
    expect(JSON.stringify(adminFoundation.body)).not.toContain('Private accepted offer');
  });
  it('retains dispatched files but refuses catalog, assignment and failure writes after key revocation', async () => {
    const owner = await credential();
    const [company] = await db.insert(companies).values({ name: 'Curated authority', issuePrefix: randomUUID().slice(0,8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: owner.userId, membershipRole: 'admin', status: 'active' });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Curated worker', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: owner.userId }).returning();
    await workforceService(db).enroll(company.id, agent.id, { templateId: 'marketing-content' }, { userId: owner.userId });
    const write = fs.writeFile.bind(fs), dispatched: string[] = [];
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      await write(...args);
      if (String(args[0]).includes(company.id) && String(args[0]).endsWith('SKILL.md')) {
        dispatched.push(String(args[0]));
        await db.transaction(async tx => {
          await tx.execute(sql`set local lock_timeout = '1000ms'`);
          await tx.update(companies).set({ name: 'Changed while filesystem work is dispatched' }).where(eq(companies.id, company.id));
        });
        await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, owner.key.id));
      }
    });
    let response;
    try { response = await request(app()).post(`/api/companies/${company.id}/workforce/agents/${agent.id}/install-skills`).set('authorization', `Bearer ${owner.token}`).send({}); }
    finally { spy.mockRestore(); }
    expect(dispatched).toHaveLength(1);
    expect(await fs.readFile(dispatched[0], 'utf8')).toContain('name:');
    expect(response.status).toBe(401);
    expect(await db.select().from(companySkills).where(eq(companySkills.companyId, company.id))).toEqual([]);
    const [enrollment] = await db.select().from(workforceEnrollments).where(eq(workforceEnrollments.agentId, agent.id));
    expect(enrollment.installedSkillKeys).toEqual([]);
    expect(enrollment.skillInstallError).toBeNull();
    expect((await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).map(value => value.action)).toEqual(['workforce.enrolled']);
  });

  async function inactiveQuestion() {
    const alice = await credential(), bob = await credential();
    const [company] = await db.insert(companies).values({ name: 'Pinned owner recovery', issuePrefix: randomUUID().slice(0,8) }).returning();
    const members = await db.insert(companyMemberships).values([alice,bob].map(person => ({ companyId: company.id, principalType: 'user', principalId: person.userId, membershipRole: 'member', status: 'active' }))).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Recovery worker', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: alice.userId }).returning();
    const svc = workforceService(db);
    await svc.enroll(company.id, agent.id, { templateId: 'marketing-content' }, { userId: alice.userId });
    const issue = await svc.startFirstJob(company.id, agent.id, { userId: alice.userId });
    const question = await issueThreadInteractionService(db).create(issue, { kind: 'ask_user_questions', payload: { version: 1, questions: [{ id: 'private-required', prompt: 'PRIVATE_ALICE_RECOVERY', required: true, selectionMode: 'text', options: [] }] } }, { agentId: agent.id });
    await db.update(companyMemberships).set({ status: 'inactive' }).where(eq(companyMemberships.id, members.find(value => value.principalId === alice.userId)!.id));
    await db.update(agents).set({ accountableUserId: bob.userId }).where(eq(agents.id, agent.id));
    return { alice, bob, company, members, agent, issue, question };
  }
  it('recovers an inactive pinned owner through safe metadata and confirmed cancellation while required input stays held', async () => {
    const { alice, bob, company, agent, issue, question } = await inactiveQuestion();
    const application = app(), target = { kind: 'company', companyId: company.id };
    expect((await request(application).get(`/api/issues/${issue.id}`).set('authorization', `Bearer ${bob.token}`)).status).toBe(200);
    expect((await request(application).get(`/api/companies/${company.id}/workforce/agents/${agent.id}/readiness`).set('authorization', `Bearer ${bob.token}`)).status).toBe(404);
    const cancel = await request(application).post(`/api/issues/${issue.id}/interactions/${question.id}/cancel`).set('authorization', `Bearer ${bob.token}`).send({});
    expect(cancel.status).toBe(403);
    const replacement = await request(application).post('/human/prepare').set('authorization', `Bearer ${bob.token}`).send({ target, operationId: 'human_questions.replace', version: 1, input: { issueId: issue.id, interactionId: question.id } });
    expect([403,409]).toContain(replacement.status);
    const aliceCancel = await request(application).post(`/api/issues/${issue.id}/interactions/${question.id}/cancel`).set('authorization', `Bearer ${alice.token}`).send({});
    expect(aliceCancel.status).toBe(403);
    const read = await request(application).post('/human/read').set('authorization', `Bearer ${bob.token}`).send({ target, operationId: 'human_questions.read', version: 1, input: { issueId: issue.id, interactionId: question.id } });
    expect(read.status).toBe(403);
    expect(JSON.stringify([cancel.body, replacement.body, read.body])).not.toContain('PRIVATE_ALICE_RECOVERY');
    const [current] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, question.id));
    expect(current.status).toBe('pending');
    expect((await workforceIssueInputs(db, company.id, agent.id, issue.id)).pendingQuestionIds).toContain(question.id);
    const recovery = await request(application).post('/human/read').set('authorization', `Bearer ${bob.token}`).send({ target, operationId: 'human_questions.recovery.list', version: 1, input: { issueId: issue.id } });
    expect(recovery.status).toBe(200);
    expect(recovery.body.questions).toEqual([{ issueId: issue.id, interactionId: question.id, status: 'pending', resolvedByUserId: null, resolvedAt: null }]);
    expect(JSON.stringify(recovery.body)).not.toContain('PRIVATE_ALICE_RECOVERY');
    const prepared = await request(application).post('/human/prepare').set('authorization', `Bearer ${bob.token}`).send({ target, operationId: 'human_questions.recovery.cancel', version: 1, input: { issueId: issue.id, interactionId: question.id } });
    expect(prepared.status).toBe(200);
    expect(JSON.stringify(prepared.body)).not.toContain('PRIVATE_ALICE_RECOVERY');
    effects.wakeup.mockClear();
    const confirmed = await request(application).post('/human/confirm').set('authorization', `Bearer ${bob.token}`).send({ target, handle: prepared.body.handle });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.result).toMatchObject({ issueId: issue.id, interactionId: question.id, status: 'cancelled', resolvedByUserId: bob.userId });
    expect(JSON.stringify(confirmed.body)).not.toContain('PRIVATE_ALICE_RECOVERY');
    expect((await workforceIssueInputs(db, company.id, agent.id, issue.id)).pendingQuestionIds).toContain(question.id);
    expect(effects.wakeup).not.toHaveBeenCalled();
    const replay = await request(application).post('/human/confirm').set('authorization', `Bearer ${bob.token}`).send({ target, handle: prepared.body.handle });
    expect(replay.status).toBe(409);
    const receipt = await issueThreadInteractionService(db).getById(question.id);
    expect(receipt).toMatchObject({ status: 'cancelled', resolvedByUserId: bob.userId, payload: { answerOwnerUserId: alice.userId }, result: { cancelled: true, answers: [] } });
    const cancellationAudit = await db.select().from(activityLog).where(eq(activityLog.companyId, company.id));
    expect(cancellationAudit.filter(row => (row.details as Record<string, unknown>)?.inactiveOwnerRecovery === true)).toHaveLength(1);
    const nextPrepared = await request(application).post('/human/prepare').set('authorization', `Bearer ${bob.token}`).send({ target, operationId: 'human_questions.replace', version: 1, input: { issueId: issue.id, interactionId: question.id } });
    expect(nextPrepared.status).toBe(200);
    const next = await request(application).post('/human/confirm').set('authorization', `Bearer ${bob.token}`).send({ target, handle: nextPrepared.body.handle });
    expect(next.status).toBe(200);
    expect(next.body.result.payload.answerOwnerUserId).toBe(bob.userId);
    const response = await request(application).post('/human/prepare').set('authorization', `Bearer ${bob.token}`).send({ target, operationId: 'human_questions.respond', version: 1, input: { issueId: issue.id, interactionId: next.body.result.interactionId, answers: [{ questionId: 'private-required', optionIds: [], text: 'Genuine replacement answer' }] } });
    expect(response.status).toBe(200);
    expect((await request(application).post('/human/confirm').set('authorization', `Bearer ${bob.token}`).send({ target, handle: response.body.handle })).status).toBe(200);
    expect((await workforceIssueInputs(db, company.id, agent.id, issue.id)).pendingQuestionIds).toEqual([]);
    expect(effects.wakeup).toHaveBeenCalledTimes(1);
    expect(effects.wakeup.mock.calls[0]).toMatchObject([agent.id, { payload: { issueId: issue.id, interactionStatus: 'answered' } }]);
    expect((await request(application).post('/human/confirm').set('authorization', `Bearer ${bob.token}`).send({ target, handle: response.body.handle })).status).toBe(409);
    expect(effects.wakeup).toHaveBeenCalledTimes(1);
  });

  it.each(['owner-reactivated', 'accountability-changed', 'member-revoked', 'key-revoked', 'project-revoked'] as const)('refuses recovery confirmation after %s and preserves the held private question', async change => {
    const f = await inactiveQuestion();
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: 'Recovery project', visibility: 'restricted', createdByUserId: f.alice.userId }).returning();
    await db.insert(projectAccess).values({ projectId: project.id, principalType: 'user', principalId: f.bob.userId, grantedByUserId: f.alice.userId });
    await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issue.id));
    const application = app(), target = { kind: 'company', companyId: f.company.id };
    const prepared = await request(application).post('/human/prepare').set('authorization', `Bearer ${f.bob.token}`).send({ target, operationId: 'human_questions.recovery.cancel', version: 1, input: { issueId: f.issue.id, interactionId: f.question.id } });
    expect(prepared.status).toBe(200);
    if (change === 'owner-reactivated') await db.update(companyMemberships).set({ status: 'active' }).where(eq(companyMemberships.id, f.members.find(m => m.principalId === f.alice.userId)!.id));
    if (change === 'accountability-changed') await db.update(agents).set({ accountableUserId: f.alice.userId }).where(eq(agents.id, f.agent.id));
    if (change === 'member-revoked') await db.update(companyMemberships).set({ status: 'inactive' }).where(eq(companyMemberships.id, f.members.find(m => m.principalId === f.bob.userId)!.id));
    if (change === 'key-revoked') await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, f.bob.key.id));
    if (change === 'project-revoked') await db.delete(projectAccess).where(eq(projectAccess.projectId, project.id));
    const confirmed = await request(application).post('/human/confirm').set('authorization', `Bearer ${f.bob.token}`).send({ target, handle: prepared.body.handle });
    expect([401,403,404,409]).toContain(confirmed.status);
    expect(JSON.stringify(confirmed.body)).not.toContain('PRIVATE_ALICE_RECOVERY');
    expect((await issueThreadInteractionService(db).getById(f.question.id))?.status).toBe('pending');
    expect((await workforceIssueInputs(db, f.company.id, f.agent.id, f.issue.id)).pendingQuestionIds).toContain(f.question.id);
  });

  it('refuses mere administrators and cross-company recovery, and keeps the original owner-only read boundary', async () => {
    const f = await inactiveQuestion(), admin = await credential();
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: 'user', principalId: admin.userId, status: 'active', membershipRole: 'admin' });
    const application = app(), target = { kind: 'company', companyId: f.company.id };
    const body = { target, operationId: 'human_questions.recovery.cancel', version: 1, input: { issueId: f.issue.id, interactionId: f.question.id } };
    expect((await request(application).post('/human/prepare').set('authorization', `Bearer ${admin.token}`).send(body)).status).toBe(403);
    const empty = await request(application).post('/human/read').set('authorization', `Bearer ${admin.token}`).send({ ...body, operationId: 'human_questions.recovery.list', input: { issueId: f.issue.id } });
    expect(empty.body).toEqual({ questions: [] });
    const other = await inactiveQuestion();
    expect((await request(application).post('/human/prepare').set('authorization', `Bearer ${f.bob.token}`).send({ ...body, input: { issueId: other.issue.id, interactionId: other.question.id } })).status).toBe(404);
    expect((await request(application).post('/human/read').set('authorization', `Bearer ${f.bob.token}`).send({ ...body, operationId: 'human_questions.read' })).status).toBe(403);
  });

  it('uses browser session readback and durable receipts; repeating an uncertain confirm cannot cancel or replace twice', async () => {
    const f = await inactiveQuestion(), sessionId = randomUUID();
    await db.insert(authSessions).values({ id: sessionId, token: randomUUID(), userId: f.bob.userId, expiresAt: new Date(Date.now()+60000), createdAt: new Date(), updatedAt: new Date() });
    const application = app(undefined, db, { deploymentMode: 'authenticated', resolveSession: async () => ({ session: { id: sessionId, userId: f.bob.userId }, user: { id: f.bob.userId, name: 'Recovery human', email: 'recovery@test.invalid' } }) });
    const url = `/human/issues/${f.issue.id}/question-recovery`;
    const discovered = await request(application).get(url);
    expect(discovered.status).toBe(200);
    expect(discovered.body.questions).toHaveLength(1);
    expect(JSON.stringify(discovered.body)).not.toContain('PRIVATE_ALICE_RECOVERY');
    for (const action of ['cancel', 'replace']) {
      const input = { interactionId: f.question.id, action };
      const preview = await request(application).post(`${url}/preview`).send(input);
      expect(preview.status).toBe(200);
      const body = { ...input, preconditions: preview.body.preconditions };
      const confirmed = await request(application).post(`${url}/confirm`).send(body);
      expect(confirmed.status).toBe(200);
      expect((await request(application).post(`${url}/confirm`).send(body)).status).toBe(409);
      if (action === 'cancel') {
        const receipt = await request(application).get(url);
        expect(receipt.body.questions[0]).toMatchObject({ status: 'cancelled', resolvedByUserId: f.bob.userId });
        expect((await workforceIssueInputs(db, f.company.id, f.agent.id, f.issue.id)).pendingQuestionIds).toContain(f.question.id);
      }
    }
    const rows = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issue.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.status === 'pending')).toHaveLength(1);
  });

  async function adminWorker() {
    const owner = await credential();
    const [company] = await db.insert(companies).values({ name: 'Guarded leaf', issuePrefix: randomUUID().slice(0,8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: owner.userId, membershipRole: 'admin', status: 'active' });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Leaf worker', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: owner.userId }).returning();
    await workforceService(db).enroll(company.id, agent.id, { templateId: 'marketing-content' }, { userId: owner.userId });
    return { owner, company, agent, target: { kind: 'company', companyId: company.id } };
  }
  function delayRealSelect(matches: (fields: Record<string, unknown> | undefined, table: unknown) => boolean, pause: () => Promise<void>) {
    return new Proxy(db, { get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return (callback: (executor: Db) => Promise<unknown>) => target.transaction(tx => callback(new Proxy(tx, { get(executor, key, receiver) {
        if (key !== 'select') return Reflect.get(executor, key, receiver);
        return (fields?: Record<string, unknown>) => {
          const query = (executor.select as Function)(fields), from = query.from.bind(query);
          query.from = (table: unknown) => {
            const builder = from(table);
            if (matches(fields, table)) {
              const then = builder.then.bind(builder);
              builder.then = (resolve: Function, reject: Function) => then(async (rows: unknown) => { await pause(); return rows; }).then(resolve, reject);
            }
            return builder;
          };
          return query;
        };
      } }) as unknown as Db));
    } });
  }
  it.each(['prepare company read', 'first-job maximum read'] as const)('checks expiry after the actual final awaited %s before any first write', async boundary => {
    const f = await adminWorker(), input = { target: f.target, operationId: 'workforce.first_job.start', version: 1, input: { agentId: f.agent.id } };
    const prepared = boundary === 'first-job maximum read' ? await request(app()).post('/human/prepare').set('authorization', `Bearer ${f.owner.token}`).send(input) : null;
    if (prepared) expect(prepared.status).toBe(200);
    const expiry = new Date(Date.now() + 1500);
    await db.update(boardApiKeys).set({ expiresAt: expiry }).where(eq(boardApiKeys.id, f.owner.key.id));
    let observed = false;
    const routeDb = delayRealSelect((fields, table) => boundary === 'prepare company read' ? table === companies && Boolean(fields?.name) : table === issues && Boolean(fields?.maxNum), async () => {
      observed = true;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry.getTime() - Date.now() + 10)));
    });
    effects.wakeup.mockClear();
    const response = await request(app(undefined, routeDb)).post(prepared ? '/human/confirm' : '/human/prepare').set('authorization', `Bearer ${f.owner.token}`).send(prepared ? { target: f.target, handle: prepared.body.handle } : input);
    expect(observed).toBe(true);
    expect(response.status).toBe(401);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toEqual([]);
    expect((await db.select().from(companies).where(eq(companies.id, f.company.id)))[0].issueCounter).toBe(0);
    expect((await db.select().from(workforceEnrollments).where(eq(workforceEnrollments.agentId, f.agent.id)))[0].firstJobIssueId).toBeNull();
    expect(effects.wakeup).not.toHaveBeenCalled();
    if (!prepared) expect(await db.select().from(humanActionHandles).where(eq(humanActionHandles.actorUserId, f.owner.userId))).toEqual([]);
    else expect((await db.select().from(humanActionHandles).where(eq(humanActionHandles.actorUserId, f.owner.userId)))[0].status).toBe('denied');
    expect((await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).map(value => value.action)).toEqual(['workforce.enrolled']);
  });
  it.each(['key','session','local'] as const)('preserves native ordinary ownerless question create/read/respond/cancel for %s', async source => {
    const f = await adminWorker();
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: 'Ordinary ownerless', status: 'backlog' }).returning();
    const sessionId = randomUUID();
    await db.insert(authSessions).values({ id: sessionId, token: randomUUID(), userId: f.owner.userId, expiresAt: new Date(Date.now()+60000), createdAt: new Date(), updatedAt: new Date() });
    const application = app(undefined, db, source === 'session' ? { deploymentMode: 'authenticated', resolveSession: async () => ({ session: { id: sessionId, userId: f.owner.userId }, user: { id: f.owner.userId, name: 'Session human', email: `${f.owner.userId}@test.invalid` } }) } : { deploymentMode: 'local_trusted' });
    const call = (method: 'get'|'post', url: string, body?: unknown) => {
      const pending = request(application)[method](url);
      if (source === 'key') pending.set('authorization', `Bearer ${f.owner.token}`);
      return body === undefined ? pending : pending.send(body);
    };
    const input = { kind: 'ask_user_questions', payload: { version: 1, questions: [{ id: 'ordinary', prompt: 'Ordinary question', required: true, selectionMode: 'text', options: [] }] } };
    const created = await call('post', `/api/issues/${issue.id}/interactions`, input);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.payload.answerOwnerUserId).toBeUndefined();
    const listed = await call('get', `/api/issues/${issue.id}/interactions`);
    expect(listed.status).toBe(200); expect(listed.body.map((value: {id:string}) => value.id)).toContain(created.body.id);
    const answered = await call('post', `/api/issues/${issue.id}/interactions/${created.body.id}/respond`, { answers: [{ questionId: 'ordinary', optionIds: [], text: 'Ordinary answer' }] });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200); expect(answered.body.status).toBe('answered');
    const second = await call('post', `/api/issues/${issue.id}/interactions`, input);
    const cancelled = await call('post', `/api/issues/${issue.id}/interactions/${second.body.id}/cancel`, {});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200); expect(cancelled.body.status).toBe('cancelled');
    const replacement = await call('post', `/api/issues/${issue.id}/interactions`, { ...input, payload: { ...input.payload, replacesInteractionId: second.body.id } });
    expect(replacement.status).toBe(201); expect(replacement.body.payload.answerOwnerUserId).toBeUndefined();
  });

  function afterCommittedWrite(tableToWatch: unknown, after: () => Promise<void>) {
    return new Proxy(db, { get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return async (callback: (executor: Db) => Promise<unknown>) => {
        let written = false;
        const result = await target.transaction(tx => callback(new Proxy(tx, { get(inner, key, receiver) {
          const value = Reflect.get(inner, key, receiver);
          if (key === 'insert' || key === 'update') return (table: unknown) => { if (table === tableToWatch) written = true; return value.call(inner, table); };
          return typeof value === 'function' ? value.bind(inner) : value;
        } }) as unknown as Db));
        if (written) await after();
        return result;
      };
    } });
  }
  it('retains the committed catalog but refuses the next materialization after revocation', async () => {
    const f = await adminWorker();
    let commits = 0;
    const connection = afterCommittedWrite(companySkills, async () => {
      commits++;
      await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, f.owner.key.id));
    });
    const response = await request(app(undefined, connection)).post(`/api/companies/${f.company.id}/workforce/agents/${f.agent.id}/install-skills`).set('authorization', `Bearer ${f.owner.token}`).send({});
    expect(response.status).toBe(401); expect(commits).toBe(1);
    const catalog = await db.select().from(companySkills).where(eq(companySkills.companyId, f.company.id));
    expect(catalog).toHaveLength(1);
    expect(await fs.readFile(path.join(catalog[0].sourceLocator!, 'SKILL.md'), 'utf8')).toBe(catalog[0].markdown);
    const enrollment = await workforceService(db).getEnrollment(f.company.id, f.agent.id);
    expect(enrollment?.installedSkillKeys).toEqual([]); expect(enrollment?.skillInstallError).toBeNull();
  });
  it.each([false, true])('records a real filesystem failure only while current authority remains (revoke=%s)', async revoke => {
    const f = await adminWorker();
    const write = fs.writeFile.bind(fs);
    let failed = false;
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]).includes(f.company.id) && String(args[0]).endsWith('SKILL.md')) {
        await fs.mkdir(String(args[0]), { recursive: true });
        try { await write(...args); } catch (error) {
          failed = true;
          if (revoke) await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, f.owner.key.id));
          throw error;
        }
      } else await write(...args);
    });
    let response;
    try { response = await request(app()).post(`/api/companies/${f.company.id}/workforce/agents/${f.agent.id}/install-skills`).set('authorization', `Bearer ${f.owner.token}`).send({}); }
    finally { spy.mockRestore(); }
    expect(failed).toBe(true); expect(response.status).toBe(revoke ? 401 : 409);
    const enrollment = await workforceService(db).getEnrollment(f.company.id, f.agent.id);
    expect(enrollment?.installedSkillKeys).toEqual([]);
    if (revoke) expect(enrollment?.skillInstallError).toBeNull(); else expect(enrollment?.skillInstallError).toContain('EISDIR');
    const audits = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
    expect(audits.map(row => row.action)).toEqual(revoke ? ['workforce.enrolled'] : ['workforce.enrolled', 'workforce.skill_install_failed']);
  });
  it('keeps an uncertain committed assignment and never repeats it on the consumed handle', async () => {
    const f = await adminWorker();
    const prepared = await request(app()).post('/human/prepare').set('authorization', `Bearer ${f.owner.token}`).send({ target: f.target, operationId: 'workforce.skills.retry', version: 1, input: { agentId: f.agent.id } });
    expect(prepared.status).toBe(200);
    let assignments = 0;
    const connection = afterCommittedWrite(agents, async () => { assignments++; throw new Error('lost assignment acknowledgement'); });
    const application = app(undefined, connection);
    const confirm = () => request(application).post('/human/confirm').set('authorization', `Bearer ${f.owner.token}`).send({ target: f.target, handle: prepared.body.handle });
    const first = await confirm(); expect(first.status).toBe(409);
    expect(assignments).toBe(1);
    const enrollment = await workforceService(db).getInstalledEnrollment(f.company.id, f.agent.id);
    expect(enrollment.installedSkillKeys.length).toBeGreaterThan(0); expect(enrollment.skillInstallError).toBeNull();
    const second = await confirm(); expect(second.status).toBe(409); expect(assignments).toBe(1);
    const audits = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
    expect(audits.map(row => row.action)).toEqual(['workforce.enrolled', 'workforce.skills_installed']);
    expect((await db.select().from(humanActionHandles).where(eq(humanActionHandles.actorUserId, f.owner.userId)))[0].status).toBe('recovery_required');
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  async function waitForDatabaseLock(...fragments: string[]) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await db.execute(sql`select query from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'`) as unknown as Array<{ query: string }>;
      const result = rows.filter(row => fragments.some(fragment => row.query.includes(fragment)));
      if (result.length) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Expected an actual PostgreSQL lock wait for ${fragments.join(' or ')}`);
  }
  it('lets a protected prepare finish before a later key revocation and refuses a later request', async () => {
    const f = await adminWorker(), reached = deferred(), release = deferred();
    let held = false;
    const connection = delayRealSelect((fields, table) => table === companies && Boolean(fields?.name), async () => {
      if (!held) { held = true; reached.resolve(); await release.promise; }
    });
    const input = { target: f.target, operationId: 'workforce.first_job.start', version: 1, input: { agentId: f.agent.id } };
    const response = request(app(undefined, connection)).post('/human/prepare').set('authorization', `Bearer ${f.owner.token}`).send(input).then(value => value);
    await reached.promise;
    const revoked = db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, f.owner.key.id)).then(value => value);
    try { await waitForDatabaseLock('board_api_keys'); } finally { release.resolve(); }
    expect((await response).status).toBe(200); await revoked;
    expect((await request(app()).post('/human/prepare').set('authorization', `Bearer ${f.owner.token}`).send(input)).status).toBe(403);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toEqual([]);
  });
  it.each(['revoke', 'new admin witness'] as const)('refuses %s observed after waiting for an actual credential lock', async mutation => {
    const f = await adminWorker(), locked = deferred(), release = deferred();
    let blocker!: Promise<void>;
    const application = app(async (_req, _res, next) => {
      blocker = db.transaction(async tx => {
        await tx.select().from(boardApiKeys).where(eq(boardApiKeys.id, f.owner.key.id)).for('update');
        locked.resolve(); await release.promise;
        if (mutation === 'revoke') await tx.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, f.owner.key.id));
      });
      await locked.promise; next();
    });
    const response = request(application).post('/human/prepare').set('authorization', `Bearer ${f.owner.token}`).send({ target: f.target, operationId: 'workforce.first_job.start', version: 1, input: { agentId: f.agent.id } }).then(value => value);
    try {
      await locked.promise;
      await waitForDatabaseLock('board_api_keys');
      if (mutation === 'new admin witness') await db.insert(instanceUserRoles).values({ userId: f.owner.userId, role: 'instance_admin' });
    } finally { release.resolve(); }
    await blocker;
    const result = await response; expect(result.status).toBe(mutation === 'revoke' ? 401 : 409);
    expect(await db.select().from(humanActionHandles).where(eq(humanActionHandles.actorUserId, f.owner.userId))).toEqual([]);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.company.id))).toEqual([]);
  });

  it.each(['restricted', 'foreign'] as const)('refuses %s first-job sources across enrollment, readiness, preparation and reuse', async kind => {
    const f = await adminWorker();
    const job = await workforceService(db).startFirstJob(f.company.id, f.agent.id, { userId: f.owner.userId });
    if (kind === 'restricted') {
      await db.update(companyMemberships).set({ membershipRole: 'member' }).where(eq(companyMemberships.companyId, f.company.id));
      const [project] = await db.insert(projects).values({ companyId: f.company.id, name: 'Private project', visibility: 'restricted', createdByUserId: 'another-person' }).returning();
      await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, job.id));
    } else {
      const [other] = await db.insert(companies).values({ name: 'Other company', issuePrefix: randomUUID().slice(0,8) }).returning();
      const [foreign] = await db.insert(issues).values({ companyId: other.id, title: 'FOREIGN_PRIVATE_JOB' }).returning();
      await db.update(workforceEnrollments).set({ firstJobIssueId: foreign.id }).where(eq(workforceEnrollments.agentId, f.agent.id));
    }
    effects.wakeup.mockClear();
    const application = app(), base = `/api/companies/${f.company.id}/workforce/agents/${f.agent.id}`;
    for (const suffix of ['enrollment','readiness']) expect((await request(application).get(`${base}/${suffix}`).set('authorization', `Bearer ${f.owner.token}`)).status).toBe(404);
    for (const operationId of ['workforce.enrollment.read','workforce.readiness.read']) expect((await request(application).post('/human/read').set('authorization', `Bearer ${f.owner.token}`).send({ target: f.target, operationId, version: 1, input: { agentId: f.agent.id } })).status).toBe(404);
    expect((await request(application).post('/human/prepare').set('authorization', `Bearer ${f.owner.token}`).send({ target: f.target, operationId: 'workforce.first_job.start', version: 1, input: { agentId: f.agent.id } })).status).toBe(404);
    expect((await request(application).post(`${base}/first-job`).set('authorization', `Bearer ${f.owner.token}`).send({})).status).toBe(kind === 'restricted' ? 403 : 404);
    expect(effects.wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(humanActionHandles).where(eq(humanActionHandles.actorUserId, f.owner.userId))).toEqual([]);
  });
  it('uses the actual project grant for a private named question and omits it after grant removal', async () => {
    const f = await adminWorker();
    const job = await workforceService(db).startFirstJob(f.company.id, f.agent.id, { userId: f.owner.userId });
    const q = await issueThreadInteractionService(db).create(job, { kind: 'ask_user_questions', payload: { version: 1, questions: [{ id: 'private', prompt: 'PRIVATE_PROJECT_SOURCE', required: true, selectionMode: 'text', options: [] }] } }, { agentId: f.agent.id });
    await db.update(companyMemberships).set({ membershipRole: 'member' }).where(eq(companyMemberships.companyId, f.company.id));
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: 'Granted private project', visibility: 'restricted', createdByUserId: 'another-person' }).returning();
    await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, job.id));
    await db.insert(projectAccess).values({ projectId: project.id, principalType: 'user', principalId: f.owner.userId, grantedByUserId: 'grantor' });
    const application = app(), body = { target: f.target, operationId: 'human_questions.read', version: 1, input: { issueId: job.id, interactionId: q.id } };
    expect((await request(application).post('/human/read').set('authorization', `Bearer ${f.owner.token}`).send(body)).status).toBe(200);
    await db.delete(projectAccess).where(eq(projectAccess.projectId, project.id));
    const refused = await request(application).post('/human/read').set('authorization', `Bearer ${f.owner.token}`).send(body);
    expect(refused.status).toBe(404); expect(JSON.stringify(refused.body)).not.toContain('PRIVATE_PROJECT_SOURCE');
    const listed = await request(application).get(`/api/issues/${job.id}/interactions`).set('authorization', `Bearer ${f.owner.token}`);
    // #854: an issue in a restricted project the caller is off-list for is 404
    // on every /issues/:id route (the router.param guard), so the native list
    // refuses outright rather than returning an empty list.
    expect(listed.status).toBe(404); expect(JSON.stringify(listed.body)).not.toContain('PRIVATE_PROJECT_SOURCE');
  });
  it('does not return a cached private answer when authority is revoked after its commit', async () => {
    const f = await adminWorker();
    const job = await workforceService(db).startFirstJob(f.company.id, f.agent.id, { userId: f.owner.userId });
    const q = await issueThreadInteractionService(db).create(job, { kind: 'ask_user_questions', payload: { version: 1, questions: [{ id: 'private', prompt: 'Private?', required: true, selectionMode: 'text', options: [] }] } }, { agentId: f.agent.id });
    const connection = afterCommittedWrite(issueThreadInteractions, async () => { await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, f.owner.key.id)); });
    const response = await request(app(undefined, connection)).post(`/api/issues/${job.id}/interactions/${q.id}/respond`).set('authorization', `Bearer ${f.owner.token}`).send({ answers: [{ questionId: 'private', optionIds: [], text: 'PRIVATE_COMMITTED_ANSWER' }] });
    expect(response.status).toBe(401); expect(JSON.stringify(response.body)).not.toContain('PRIVATE_COMMITTED_ANSWER');
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, q.id)))[0].status).toBe('answered');
    expect((await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).map(value => value.action)).toContain('issue.thread_interaction_answered');
  });

  it.each([false, true])('returns the native full public profile and zero-member company choices (admin=%s)', async admin => {
    const person = await credential();
    if (admin) await db.insert(instanceUserRoles).values({ userId: person.userId, role: 'instance_admin' });
    const response = await request(app()).get('/human/identity').set('authorization', `Bearer ${person.token}`);
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: person.userId, name: 'Foundation human', email: `${person.userId}@test.invalid` });
    expect(response.body.memberships).toEqual([]);
    expect(response.body.isInstanceAdmin).toBe(admin);
    const expected = admin ? await db.select({ id: companies.id, name: companies.name }).from(companies) : [];
    expect(response.body.companies).toEqual(expect.arrayContaining(expected)); expect(response.body.companies).toHaveLength(expected.length);
    expect(response.body.targets).toEqual(expect.arrayContaining([{ kind: 'self' }, { kind: 'instance' }, { kind: 'public' }]));
  });
  it('preserves native NULL-role permission truthiness and rechecks explicit grants before confirmation', async () => {
    const f = await adminWorker();
    await db.update(companyMemberships).set({ membershipRole: null }).where(eq(companyMemberships.companyId, f.company.id));
    const incoming = randomUUID();
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: 'user', principalId: incoming, membershipRole: 'member', status: 'active' });
    const body = { target: f.target, operationId: 'human_questions.owner.assign', version: 1, input: { agentId: f.agent.id, accountableUserId: incoming } };
    const application = app();
    expect((await request(application).post('/human/prepare').set('authorization', `Bearer ${f.owner.token}`).send(body)).status).toBe(403);
    const [grant] = await db.insert(principalPermissionGrants).values({ companyId: f.company.id, principalType: 'user', principalId: f.owner.userId, permissionKey: 'agents:create' }).returning();
    const prepared = await request(application).post('/human/prepare').set('authorization', `Bearer ${f.owner.token}`).send(body);
    expect(prepared.status).toBe(200);
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, grant.id));
    expect((await request(application).post('/human/confirm').set('authorization', `Bearer ${f.owner.token}`).send({ target: f.target, handle: prepared.body.handle })).status).toBe(403);
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].accountableUserId).toBe(f.owner.userId);
    expect(await db.select().from(authUsers).where(eq(authUsers.id, incoming))).toEqual([]);
  });

  it('refuses expired known materialization approval before filesystem dispatch without calling it uncertain', async () => {
    const f = await adminWorker(), expiry = new Date(Date.now() + 1500);
    await db.update(boardApiKeys).set({ expiresAt: expiry }).where(eq(boardApiKeys.id, f.owner.key.id));
    let transactions = 0;
    const connection = new Proxy(db, { get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return async (callback: (executor: Db) => Promise<unknown>) => {
        const value = await target.transaction(tx => callback(tx as unknown as Db));
        transactions++;
        if (transactions === 2) await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry.getTime() - Date.now() + 10)));
        return value;
      };
    } });
    const mkdir = fs.mkdir.bind(fs); let dispatched = false;
    const spy = vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      if (String(args[0]).includes(f.company.id)) dispatched = true;
      return mkdir(...args);
    });
    let response;
    try { response = await request(app(undefined, connection)).post(`/api/companies/${f.company.id}/workforce/agents/${f.agent.id}/install-skills`).set('authorization', `Bearer ${f.owner.token}`).send({}); }
    finally { spy.mockRestore(); }
    expect(transactions).toBe(2); expect(dispatched).toBe(false); expect(response.status).toBe(401);
    expect((await workforceService(db).getEnrollment(f.company.id, f.agent.id))?.skillInstallError).toBeNull();
    expect(await db.select().from(companySkills).where(eq(companySkills.companyId, f.company.id))).toEqual([]);
  });

  it('reports uncertain native first-job commit without issuing a wake or replay', async () => {
    const f = await adminWorker(); effects.wakeup.mockClear();
    let commits = 0;
    const connection = afterCommittedWrite(issues, async () => { commits++; throw new Error('lost native job acknowledgement'); });
    const response = await request(app(undefined, connection)).post(`/api/companies/${f.company.id}/workforce/agents/${f.agent.id}/first-job`).set('authorization', `Bearer ${f.owner.token}`).send({});
    expect(response.status).toBe(409); expect(response.body.details).toMatchObject({ persistenceOutcome: 'unknown' });
    expect(commits).toBe(1); expect(effects.wakeup).not.toHaveBeenCalled();
    const jobs = await db.select().from(issues).where(eq(issues.companyId, f.company.id));
    expect(jobs).toHaveLength(1); expect((await workforceService(db).getEnrollment(f.company.id, f.agent.id))?.firstJobIssueId).toBe(jobs[0].id);
  });

  it('fix1 refuses a third human replacement before effects and preserves the current-owner cancelled replacement', async () => {
    const f = await adminWorker(), bob = await credential(), charlie = await credential();
    await db.insert(companyMemberships).values([bob, charlie].map(person => ({ companyId: f.company.id, principalType: 'user', principalId: person.userId, membershipRole: 'member', status: 'active' })));
    const job = await workforceService(db).startFirstJob(f.company.id, f.agent.id, { userId: f.owner.userId });
    const input = { kind: 'ask_user_questions' as const, continuationPolicy: 'wake_assignee' as const, title: 'Private predecessor', summary: 'Keep original summary', payload: { version: 1 as const, questions: [{ id: 'required', prompt: 'Private required input?', required: true, selectionMode: 'text' as const, options: [] }] } };
    const q = await issueThreadInteractionService(db).create(job, input, { agentId: f.agent.id });
    await issueThreadInteractionService(db).cancelQuestions(job, q.id, {}, { userId: f.owner.userId });
    await db.update(agents).set({ accountableUserId: bob.userId }).where(eq(agents.id, f.agent.id));
    await db.update(companyMemberships).set({ status: 'inactive' }).where(eq(companyMemberships.principalId, f.owner.userId));
    const beforeQuestions = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, job.id));
    const beforeAudits = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
    const published: string[] = [], stop = subscribeCompanyLiveEvents(f.company.id, event => { if (event.type === 'activity.logged') published.push(event.payload.action as string); });
    const replacement = { ...input, payload: { ...input.payload, replacesInteractionId: q.id } };
    const application = app(); effects.wakeup.mockClear();
    try {
      const denied = await request(application).post(`/api/issues/${job.id}/interactions`).set('authorization', `Bearer ${charlie.token}`).send(replacement);
      expect(denied.status).toBe(403);
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, job.id))).toEqual(beforeQuestions);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toEqual(beforeAudits);
      expect(published).toEqual([]); expect(effects.wakeup).not.toHaveBeenCalled();
      const accepted = await request(application).post(`/api/issues/${job.id}/interactions`).set('authorization', `Bearer ${bob.token}`).send(replacement);
      expect(accepted.status).toBe(201);
      expect(accepted.body).toMatchObject({ title: input.title, summary: input.summary, continuationPolicy: input.continuationPolicy, status: 'pending', payload: { answerOwnerUserId: bob.userId, replacesInteractionId: q.id, questions: input.payload.questions } });
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, job.id))).toHaveLength(2);
      expect(published).toEqual(['issue.thread_interaction_created']); expect(effects.wakeup).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  type SourceTrace = { transaction: number; sql: string; params: unknown[]; rows?: Array<{ id?: string; objective?: string | null }> };
  function traceSourceTransactions(events: SourceTrace[], afterEnrollmentLock?: () => Promise<void>) {
    let sequence = 0;
    const dialect = new PgDialect();
    return new Proxy(db, { get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return (callback: (executor: Db) => Promise<unknown>) => {
        const transaction = ++sequence;
        return target.transaction(tx => callback(new Proxy(tx, { get(inner, key, receiver) {
          const value = Reflect.get(inner, key, receiver);
          if (key === 'execute') return async (query: SQL) => {
            const result = await inner.execute(query), rendered = dialect.sqlToQuery(query);
            events.push({ transaction, ...rendered });
            if (rendered.sql.includes('"workforce_enrollments"') && rendered.sql.endsWith('for share')) await afterEnrollmentLock?.();
            return result;
          };
          if (key === 'select') return (fields?: Record<string, unknown>) => {
            const query = (inner.select as Function)(fields), from = query.from.bind(query);
            query.from = (table: unknown) => {
              const builder = from(table), then = builder.then.bind(builder);
              builder.then = (resolve: Function, reject: Function) => then((rows: SourceTrace['rows']) => {
                events.push({ transaction, ...builder.toSQL(), rows }); return rows;
              }).then(resolve, reject);
              return builder;
            };
            return query;
          };
          if (key === 'insert' || key === 'update') return (table: unknown) => {
            if (table === issueThreadInteractions) events.push({ transaction, sql: 'question write', params: [] });
            return value.call(inner, table);
          };
          return typeof value === 'function' ? value.bind(inner) : value;
        } }) as unknown as Db));
      };
    } });
  }
  async function sharingQuestion() {
    const f = await adminWorker();
    const job = await workforceService(db).startFirstJob(f.company.id, f.agent.id, { userId: f.owner.userId });
    const q = await issueThreadInteractionService(db).create(job, { kind: 'ask_user_questions', payload: { version: 1, questions: [{ id: 'offer', prompt: 'Which approved offer?', companyFactKey: 'offer', required: true, selectionMode: 'text', options: [] }] } }, { agentId: f.agent.id });
    return { ...f, job, q, enrollment: (await workforceService(db).getEnrollment(f.company.id, f.agent.id))! };
  }
  it.each(['native', 'foundation'] as const)('fix1 stages and seals the actual sharing enrollment before target locks through %s', async transport => {
    const f = await sharingQuestion();
    const [currentAssignee] = await db.insert(agents).values({ companyId: f.company.id, name: 'Reassigned worker', adapterType: 'codex_local' }).returning();
    await db.update(issues).set({ assigneeAgentId: currentAssignee.id }).where(eq(issues.id, f.job.id));
    // Sharing uses the question's persisted workforceAgentId, not the current assignee.
    // These enrollment references are unrelated to this question's native sharing decision.
    const [foreignCompany] = await db.insert(companies).values({ name: 'Unrelated enrollment references', issuePrefix: randomUUID().slice(0,8) }).returning();
    const [foreignJob] = await db.insert(issues).values({ companyId: foreignCompany.id, title: 'Unrelated private job' }).returning();
    const [foreignGoal] = await db.insert(goals).values({ companyId: foreignCompany.id, title: 'Unrelated private goal' }).returning();
    await db.update(workforceEnrollments).set({ firstJobIssueId: foreignJob.id, goalId: foreignGoal.id }).where(eq(workforceEnrollments.id, f.enrollment.id));
    const events: SourceTrace[] = [], application = app(undefined, traceSourceTransactions(events));
    const answers = { shareWithCompany: true, answers: [{ questionId: 'offer', optionIds: [], text: 'Approved public offer' }] };
    let response;
    if (transport === 'native') response = await request(application).post(`/api/issues/${f.job.id}/interactions/${f.q.id}/respond`).set('authorization', `Bearer ${f.owner.token}`).send(answers);
    else {
      const prepared = await request(application).post('/human/prepare').set('authorization', `Bearer ${f.owner.token}`).send({ target: f.target, operationId: 'human_questions.respond', version: 1, input: { issueId: f.job.id, interactionId: f.q.id, ...answers } });
      expect(prepared.status).toBe(200);
      response = await request(application).post('/human/confirm').set('authorization', `Bearer ${f.owner.token}`).send({ target: f.target, handle: prepared.body.handle });
    }
    expect(response.status).toBe(200);
    const mutation = events.find(value => value.sql === 'question write')!;
    expect(mutation).toBeDefined();
    const transaction = events.filter(value => value.transaction === mutation.transaction);
    const enrollmentLock = transaction.findIndex(value => value.sql.includes('"workforce_enrollments"') && value.sql.endsWith('for share') && value.params.includes(f.enrollment.id));
    expect(enrollmentLock, 'actual sharing enrollment must have a positive SHARE receipt').toBeGreaterThanOrEqual(0);
    const issueTargetLock = transaction.findIndex(value => value.sql.includes('from "issues"') && value.sql.endsWith('for update'));
    expect(issueTargetLock).toBeGreaterThan(enrollmentLock);
    const reselections = transaction.slice(enrollmentLock + 1, issueTargetLock).filter(value => value.sql.includes('from "workforce_enrollments"') && value.rows?.some(row => row.id === f.enrollment.id));
    expect(reselections.length, 'actual enrollment must be reread under sealed witnesses').toBeGreaterThan(0);
    expect((await workforceService(db).getBrief(f.company.id)).facts).toMatchObject([{ key: 'offer', value: 'Approved public offer' }]);
  });

  it.each(['share first', 'enrollment update first'] as const)('fix1 serializes a supported enrollment update with sharing (%s)', async order => {
    const f = await sharingQuestion(), reached = deferred(), release = deferred(), events: SourceTrace[] = [];
    let paused = false;
    const connection = traceSourceTransactions(events, async () => {
      if (order === 'share first' && !paused) { paused = true; reached.resolve(); await release.promise; }
    });
    const update = () => workforceService(db).updateEnrollment(f.company.id, f.agent.id, { objective: 'New supported objective' }, { userId: f.owner.userId });
    let writer: Promise<unknown>;
    if (order === 'enrollment update first') {
      writer = db.transaction(async tx => {
        const executor = tx as unknown as Db;
        await workforceService(executor).updateEnrollment(f.company.id, f.agent.id, { objective: 'New supported objective' }, { userId: f.owner.userId }, { executor, publications: [] });
        reached.resolve(); await release.promise;
      });
      await reached.promise;
    }
    const response = request(app(undefined, connection)).post(`/api/issues/${f.job.id}/interactions/${f.q.id}/respond`).set('authorization', `Bearer ${f.owner.token}`).send({ shareWithCompany: true, answers: [{ questionId: 'offer', optionIds: [], text: 'Approved offer across native update' }] }).then(value => value);
    if (order === 'share first') { await reached.promise; writer = update(); }
    // The human authority holds the company row FOR KEY SHARE (review P1), so
    // the competing writer now waits on the company mutex or on the
    // enrollment row the sharing answer pinned FOR SHARE, not necessarily on
    // the company row. Either wait proves the two serialize.
    try { await waitForDatabaseLock('companies', 'workforce_enrollments'); } finally { release.resolve(); }
    expect((await response).status).toBe(200); await writer!;
    const firstEnrollmentRead = events.find(value => value.sql.includes('from "workforce_enrollments"') && value.rows?.some(row => row.id === f.enrollment.id));
    expect(firstEnrollmentRead?.rows?.find(row => row.id === f.enrollment.id)?.objective).toBe(order === 'share first' ? f.enrollment.objective : 'New supported objective');
    expect(events.some(value => value.sql.includes('"workforce_enrollments"') && value.sql.endsWith('for share') && value.params.includes(f.enrollment.id))).toBe(true);
    expect((await workforceService(db).getEnrollment(f.company.id, f.agent.id))?.objective).toBe('New supported objective');
    expect((await workforceService(db).getBrief(f.company.id)).facts).toMatchObject([{ key: 'offer', value: 'Approved offer across native update' }]);
  });
  it.each(['native', 'foundation'] as const)('fix1 does not add sharing enrollment sources to a private %s answer', async transport => {
    const f = await sharingQuestion(), events: SourceTrace[] = [], application = app(undefined, traceSourceTransactions(events));
    const answer = { shareWithCompany: false, answers: [{ questionId: 'offer', optionIds: [], text: 'Keep this offer private' }] };
    let response;
    if (transport === 'native') response = await request(application).post(`/api/issues/${f.job.id}/interactions/${f.q.id}/respond`).set('authorization', `Bearer ${f.owner.token}`).send(answer);
    else {
      const prepared = await request(application).post('/human/prepare').set('authorization', `Bearer ${f.owner.token}`).send({ target: f.target, operationId: 'human_questions.respond', version: 1, input: { issueId: f.job.id, interactionId: f.q.id, ...answer } });
      expect(prepared.status).toBe(200);
      response = await request(application).post('/human/confirm').set('authorization', `Bearer ${f.owner.token}`).send({ target: f.target, handle: prepared.body.handle });
    }
    expect(response.status).toBe(200);
    expect(events.filter(value => value.sql.includes('"workforce_enrollments"'))).toEqual([]);
    expect((await workforceService(db).getBrief(f.company.id)).facts).toEqual([]);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.q.id)))[0].status).toBe('answered');
  });

});
