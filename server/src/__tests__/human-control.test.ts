import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentDashServer } from '../../../packages/mcp-server/src/index.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, goals, issues, projects, agentWakeupRequests, heartbeatRuns, issueThreadInteractions, activityLog, authUsers, boardApiKeys, companies, companyMemberships, createDb, humanActionHandles, instanceUserRoles } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { hashBearerToken } from '../services/board-auth.js';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';
import { heartbeatService } from '../services/heartbeat.js';
import { workforceService } from '../services/workforce.js';
import * as workforceModule from '../services/workforce.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';


describe('human control HTTP contract with current named authority', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: Server | undefined;
  let base: string;
  let bridgeAvailable = false;
  let failAfterWake = false;
  let skillHome: string;
  const priorHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    skillHome = await mkdtemp(path.join(tmpdir(), 'human-control-skills-'));
    process.env.PAPERCLIP_HOME = skillHome;
    temp = await startEmbeddedPostgresTestDatabase('human-control-'); db = createDb(temp.connectionString);
    const bridge = await import('../routes/human-control.js').catch(() => null);
    bridgeAvailable = Boolean(bridge?.humanControlRoutes);
    const app = express(); app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: 'local_trusted' }));
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    if (bridge) app.use('/api/human-control', bridge.humanControlRoutes(db, { heartbeat: { ...heartbeat, wakeup: async (...args) => { const result = await heartbeat.wakeup(...args); if (failAfterWake) throw new Error('SYNTHETIC_PRIVATE_TRANSPORT_FAILURE'); return result; } } }));
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server!.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api/human-control`;
  });
  afterAll(async () => { if (server) await new Promise<void>(r => server!.close(() => r())); await temp?.cleanup(); await rm(skillHome, { recursive: true, force: true }); if (priorHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = priorHome; });
  async function human(role = 'admin') {
    const userId = randomUUID(), token = `pcp_board_${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: 'Named human', email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    const [key] = await db.insert(boardApiKeys).values({ userId, name: 'Human harness', keyHash: hashBearerToken(token), expiresAt: new Date(Date.now() + 60000) }).returning();
    const [company] = await db.insert(companies).values({ name: 'Explicit company', issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: userId, membershipRole: role, status: 'active' });
    return { userId, token, key, company, target: { kind: 'company', companyId: company.id } };
  }
  async function call(token: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  async function sdk(h: Awaited<ReturnType<typeof human>>) {
    const mcp = createAgentDashServer({ apiUrl: base.replace('/human-control', ''), apiKey: h.token, companyId: h.company.id, agentId: null, runId: null }, { toolset: 'human' });
    const client = new Client({ name: 'recovery-access-regression', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(a);
    await client.connect(b);
    return {
      async confirm(handle: string) {
        const result = await client.callTool({ name: 'human_confirm', arguments: { target: h.target, handle } });
        return { error: result.isError, body: JSON.parse((result.content as Array<{ text: string }>)[0].text) };
      },
      async close() { await client.close(); await mcp.close(); },
    };
  }
  const action = (target: unknown) => ({ target, operationId: 'workforce.brief.publish', version: 1, input: { expectedRevision: 0, sources: [{ id: 's', label: 'Approved source', content: 'Full useful source '.repeat(200).trim() }], facts: [{ key: 'offer', value: 'Known company offer', sourceReference: 's' }] } });
  it('exposes an actual distinct board-key bridge with no implicit human identity', async () => {
    expect(bridgeAvailable, 'human bridge route must be implemented').toBe(true);
    const h = await human();
    expect(await call(h.token, '/identity')).toMatchObject({ status: 200, body: { user: { id: h.userId }, targets: expect.arrayContaining([h.target]) } });
    for (const token of ['', 'pcp_bad', 'pcpa_invalid', 'pcin_invalid', 'endpoint-invalid']) expect((await call(token, '/identity')).status).toBeGreaterThanOrEqual(400);
    const noKey = await fetch(`${base}/identity`); expect(noKey.status).toBe(403);
  });
  it('refuses a foreign company prepare before taking that company\'s write lock (#883 review)', async () => {
    const h = await human(), other = await human();
    let release!: () => void;
    const holding = new Promise<void>(resolve => { release = resolve; });
    // A writer holds the foreign company's mutex. If prepare took the write
    // lock before the access check it would queue behind this transaction.
    let locked!: () => void;
    const lockTaken = new Promise<void>(resolve => { locked = resolve; });
    const writer = db.transaction(async tx => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, other.company.id)).for('no key update');
      locked();
      await holding;
    });
    await lockTaken;
    try {
      const started = Date.now();
      const refused = await call(h.token, '/prepare', action({ kind: 'company', companyId: other.company.id }));
      expect([403, 404]).toContain(refused.status);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await db.select().from(humanActionHandles).where(eq(humanActionHandles.actorUserId, h.userId))).toEqual([]);
    } finally { release(); await writer; }
  });
  it('prepares without mutation, shows full readback and confirms only once on the pinned target', async () => {
    expect(bridgeAvailable).toBe(true);
    const h = await human(), other = await human();
    const prepared = await call(h.token, '/prepare', action(h.target));
    expect(prepared.status).toBe(200);
    expect(prepared.body.readback.input).toEqual(action(h.target).input);
    expect((await workforceService(db).getBrief(h.company.id)).revision).toBe(0);
    expect((await call(other.token, '/confirm', { target: h.target, handle: prepared.body.handle })).status).toBe(404);
    expect((await call(h.token, '/confirm', { target: other.target, handle: prepared.body.handle })).status).toBe(404);
    const confirmations = await Promise.all([call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle }), call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle })]);
    expect(confirmations.filter(r => r.status === 200)).toHaveLength(1);
    expect((await workforceService(db).getBrief(h.company.id)).revision).toBe(1);
    expect((await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle })).status).toBe(409);
    const read = await call(h.token, '/read', { target: h.target, operationId: 'workforce.brief.read', version: 1, input: {} });
    expect(read.body.sources[0].content).toBe(action(h.target).input.sources[0].content);
  });
  it('rechecks downgraded membership and stale revisions, terminally refuses each handle', async () => {
    expect(bridgeAvailable).toBe(true);
    const h = await human();
    const first = await call(h.token, '/prepare', action(h.target));
    await db.update(companyMemberships).set({ membershipRole: 'member' }).where(and(eq(companyMemberships.companyId, h.company.id), eq(companyMemberships.principalId, h.userId)));
    expect((await call(h.token, '/confirm', { target: h.target, handle: first.body.handle })).status).toBe(403);
    await db.update(companyMemberships).set({ membershipRole: 'admin' }).where(eq(companyMemberships.companyId, h.company.id));
    expect((await call(h.token, '/confirm', { target: h.target, handle: first.body.handle })).status).toBe(409);
    const second = await call(h.token, '/prepare', action(h.target));
    await workforceService(db).updateBrief(h.company.id, { expectedRevision: 0, sources: [], facts: [] }, { userId: h.userId });
    expect((await call(h.token, '/confirm', { target: h.target, handle: second.body.handle })).status).toBe(409);
    expect((await db.select().from(humanActionHandles).where(eq(humanActionHandles.actorUserId, h.userId))).map(r => r.status).sort()).toEqual(['denied', 'stale']);
  });
  it('strictly validates inputs and discovers only supported authorized descriptors', async () => {
    expect(bridgeAvailable).toBe(true);
    const h = await human('member');
    const found = await call(h.token, '/discover', { target: h.target });
    expect(found.status).toBe(200);
    expect(found.body.operations.some((d: {operationId:string}) => d.operationId === 'workforce.brief.read')).toBe(true);
    expect(found.body.operations.some((d: {operationId:string}) => d.operationId === 'workforce.brief.publish')).toBe(false);
    const a = action(h.target);
    for (const invalid of [{ ...a, version: 2 }, { ...a, operationId: 'raw.http' }, { ...a, input: { ...a.input, userId: h.userId } }, { ...a, target: { kind: 'self', userId: h.userId } }]) expect((await call(h.token, '/prepare', invalid)).status).toBe(400);
    expect((await workforceService(db).getBrief(h.company.id)).revision).toBe(0);
  });
  it('covers workforce catalog, enrollment, targets, learning, proposals, skills and repeat first-job dispatch', async () => {
    const h = await human();
    const op = (operationId: string, input: unknown = {}) => ({ target: h.target, operationId, version: 1, input });
    const read = (id: string, input: unknown = {}) => call(h.token, '/read', op(id, input));
    const mutate = async (id: string, input: unknown = {}) => {
      const prepared = await call(h.token, '/prepare', op(id, input));
      expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
      expect(prepared.body.readback.company).toMatchObject({ id: h.company.id, name: 'Explicit company' });
      if (id === 'workforce.proposals.review') expect(prepared.body.readback.context.proposal).toMatchObject({ status: 'proposed', facts: [{ value: 'Known offer' }] });
      if (id === 'workforce.first_job.start') expect(prepared.body.readback.context.effects).toContain('Create or recover the ordinary first-job issue and durably wake its assigned worker; normal budgets, capacity, approvals and run quotas still apply.');
      const result = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return result.body.result;
    };
    const catalog = await read('workforce.templates.list');
    expect(catalog.status).toBe(200);
    expect(catalog.body[0].skills[0].content.length).toBeGreaterThan(500);
    const [worker] = await db.insert(agents).values({ companyId: h.company.id, name: 'Worker', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: h.userId }).returning();
    const [goal] = await db.insert(goals).values({ companyId: h.company.id, title: 'Pipeline' }).returning();
    const enrolled = await mutate('workforce.enrollment.create', { agentId: worker.id, templateId: 'marketing-content', objective: 'Draft campaign', goalId: goal.id });
    expect(enrolled).toMatchObject({ templateId: 'marketing-content', templateVersion: 1, skillInstallError: null });
    expect((await read('workforce.enrollment.read', { agentId: worker.id })).body).toMatchObject({ id: enrolled.id });
    expect((await read('workforce.readiness.read', { agentId: worker.id })).body.phase).toBe('needs_input');
    await mutate('workforce.enrollment.update', { agentId: worker.id, objective: 'Better campaign', metrics: ['Qualified replies'] });
    await mutate('workforce.learning.acknowledge', { agentId: worker.id, revision: 0 });
    await mutate('workforce.skills.retry', { agentId: worker.id });
    const first = await mutate('workforce.first_job.start', { agentId: worker.id });
    const repeated = await mutate('workforce.first_job.start', { agentId: worker.id });
    expect(repeated.issueId).toBe(first.issueId);
    expect(await db.select().from(issues).where(eq(issues.companyId, h.company.id))).toHaveLength(1);
    expect((await db.select().from(activityLog).where(and(eq(activityLog.companyId, h.company.id), eq(activityLog.action, 'issue.created'))))).toHaveLength(1);
    await mutate('workforce.brief.publish', { expectedRevision: 0, sources: [{ id: 'shared', label: 'Source', content: 'Approved company source' }], facts: [] });
    const proposal = await workforceService(db).proposeFacts(h.company.id, worker.id, { facts: [{ key: 'offer', value: 'Known offer', sourceReference: 'shared' }], sourceReferences: ['shared'] });
    expect((await read('workforce.proposals.list')).body).toHaveLength(1);
    expect(await mutate('workforce.proposals.review', { proposalId: proposal.id, decision: 'approve', expectedRevision: 1 })).toMatchObject({ status: 'approved', reviewedByUserId: h.userId });
    const other = await human();
    const [foreign] = await db.insert(goals).values({ companyId: other.company.id, title: 'Other' }).returning();
    expect((await call(h.token, '/prepare', op('workforce.enrollment.update', { agentId: worker.id, goalId: foreign.id }))).status).toBe(404);
    const [foreignWorker] = await db.insert(agents).values({ companyId: other.company.id, name: 'Foreign worker', adapterType: 'codex_local' }).returning();
    await workforceService(db).enroll(other.company.id, foreignWorker.id, { templateId: 'marketing-content' }, { userId: other.userId });
    await workforceService(db).updateBrief(other.company.id, { expectedRevision: 0, sources: [{ id: 'foreign-source', label: 'Foreign private source', content: 'Foreign private content' }], facts: [] }, { userId: other.userId });
    const foreignProposal = await workforceService(db).proposeFacts(other.company.id, foreignWorker.id, { facts: [{ key: 'offer', value: 'Foreign fact', sourceReference: 'foreign-source' }], sourceReferences: ['foreign-source'] });
    const priorHandles = await db.select().from(humanActionHandles).where(eq(humanActionHandles.actorUserId, h.userId));
    expect((await call(h.token, '/prepare', op('workforce.enrollment.create', { agentId: foreignWorker.id, templateId: 'marketing-content' }))).status).toBe(404);
    expect((await call(h.token, '/prepare', op('workforce.proposals.review', { proposalId: foreignProposal.id, decision: 'approve', expectedRevision: 2 }))).status).toBe(404);
    expect((await read('workforce.enrollment.read', { agentId: foreignWorker.id })).status).toBe(404);
    expect(await db.select().from(humanActionHandles).where(eq(humanActionHandles.actorUserId, h.userId))).toHaveLength(priorHandles.length);
    expect((await workforceService(db).getBrief(h.company.id)).sources.some(source => source.id === 'foreign-source')).toBe(false);
    const rejected = await workforceService(db).proposeFacts(h.company.id, worker.id, { facts: [{ key: 'offer', value: 'Known offer', sourceReference: 'shared' }], sourceReferences: ['shared'] });
    expect(await mutate('workforce.proposals.review', { proposalId: rejected.id, decision: 'reject', expectedRevision: 2 })).toMatchObject({ status: 'rejected' });
    const stale = await call(h.token, '/prepare', op('workforce.enrollment.update', { agentId: worker.id, objective: 'Stale edit' }));
    await workforceService(db).updateEnrollment(h.company.id, worker.id, { objective: 'Concurrent canonical edit' }, { userId: h.userId });
    expect((await call(h.token, '/confirm', { target: h.target, handle: stale.body.handle })).status).toBe(409);
    expect((await read('workforce.enrollment.read', { agentId: worker.id })).body.objective).toBe('Concurrent canonical edit');
  });

  it('lists only exact-owner questions, supports private responses, explicit sharing, cancellation and replacement', async () => {
    const h = await human('member'), peer = await human();
    await db.insert(companyMemberships).values({ companyId: h.company.id, principalType: 'user', principalId: peer.userId, membershipRole: 'admin', status: 'active' });
    const [worker] = await db.insert(agents).values({ companyId: h.company.id, name: 'Question worker', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: h.userId }).returning();
    const svc = workforceService(db); await svc.enroll(h.company.id, worker.id, { templateId: 'marketing-content' }, { userId: h.userId });
    const issue = await svc.startFirstJob(h.company.id, worker.id, { userId: h.userId });
    const questions = issueThreadInteractionService(db);
    const createQuestion = () => questions.create(issue, { kind: 'ask_user_questions', continuationPolicy: 'wake_assignee', payload: { version: 1, questions: [{ id: 'offer', prompt: 'Offer?', selectionMode: 'text', required: true, companyFactKey: 'offer', options: [] }] } }, { agentId: worker.id });
    const q = await createQuestion();
    const op = (operationId: string, input: unknown = {}) => ({ target: h.target, operationId, version: 1, input });
    const pending = await call(h.token, '/read', op('human_questions.pending.list'));
    expect(pending.status).toBe(200);
    expect(pending.body.questions.map((x: {interactionId:string}) => x.interactionId)).toContain(q.id);
    expect((await call(peer.token, '/read', op('human_questions.pending.list'))).body.questions).toEqual([]);
    const answer = { issueId: issue.id, interactionId: q.id, answers: [{ questionId: 'offer', optionIds: [], text: 'Private named answer' }] };
    expect((await call(peer.token, '/prepare', op('human_questions.respond', answer))).status).toBe(403);
    const prepared = await call(h.token, '/prepare', op('human_questions.respond', answer));
    expect(prepared.status).toBe(200);
    expect(prepared.body.readback.context?.question?.payload?.questions[0]?.prompt).toBe('Offer?');
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, q.id)))[0].status).toBe('pending');
    const answered = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect((await svc.getBrief(h.company.id)).facts).toEqual([]);
    const q2 = await createQuestion();
    const share = await call(h.token, '/prepare', op('human_questions.respond', { ...answer, interactionId: q2.id, shareWithCompany: true }));
    expect(share.status).toBe(200);
    expect(share.body.readback.input.shareWithCompany).toBe(true);
    expect((await call(h.token, '/confirm', { target: h.target, handle: share.body.handle })).status).toBe(200);
    expect((await svc.getBrief(h.company.id)).facts[0].value).toBe('Private named answer');
    const q3 = await questions.create(issue, { kind: 'ask_user_questions', continuationPolicy: 'wake_assignee', payload: { version: 1, questions: [{ id: 'date', prompt: 'Launch date?', selectionMode: 'text', required: true, options: [] }] } }, { agentId: worker.id });
    const cancel = await call(h.token, '/prepare', op('human_questions.cancel', { issueId: issue.id, interactionId: q3.id }));
    expect((await call(h.token, '/confirm', { target: h.target, handle: cancel.body.handle })).status).toBe(200);
    expect((await svc.getReadiness(h.company.id, worker.id))?.pendingQuestionIds).toContain(q3.id);
    const replace = await call(h.token, '/prepare', op('human_questions.replace', { issueId: issue.id, interactionId: q3.id }));
    expect(replace.status, JSON.stringify(replace.body)).toBe(200);
    const replaced = await call(h.token, '/confirm', { target: h.target, handle: replace.body.handle });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body.result.payload).toMatchObject({ answerOwnerUserId: h.userId, replacesInteractionId: q3.id, questions: [{ id: 'date', required: true }] });
    const audits = await db.select().from(activityLog).where(eq(activityLog.companyId, h.company.id));
    expect(JSON.stringify(audits)).not.toContain('Private named answer');
  });

  it('uses canonical administrator ownership recovery without impersonating another question owner', async () => {
    const h = await human(), member = await human('member');
    await db.insert(companyMemberships).values({ companyId: h.company.id, principalType: 'user', principalId: member.userId, membershipRole: 'member', status: 'active' });
    const [worker] = await db.insert(agents).values({ companyId: h.company.id, name: 'Autonomous', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: h.userId }).returning();
    const op = (operationId: string, input: unknown) => ({ target: h.target, operationId, version: 1, input });
    const input = { agentId: worker.id, accountableUserId: member.userId };
    expect((await call(member.token, '/prepare', op('human_questions.owner.assign', input))).status).toBe(403);
    const prepared = await call(h.token, '/prepare', op('human_questions.owner.assign', input));
    expect(prepared.status).toBe(200);
    expect((await db.select().from(agents).where(eq(agents.id, worker.id)))[0].accountableUserId).toBe(h.userId);
    expect((await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle })).status).toBe(200);
    expect((await db.select().from(agents).where(eq(agents.id, worker.id)))[0].accountableUserId).toBe(member.userId);
    const [paired] = await db.insert(agents).values({ companyId: h.company.id, name: 'Stewarded', adapterType: 'codex_local', autonomy: 'stewarded' }).returning();
    for (const [operationId, fields] of [['human_questions.stewardship.assign', { userId: h.userId }], ['human_questions.stewardship.transfer', { userId: member.userId, transferReason: 'New accountable owner' }]] as const) {
      const p = await call(h.token, '/prepare', op(operationId, { agentId: paired.id, ...fields }));
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const result = await call(h.token, '/confirm', { target: h.target, handle: p.body.handle });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.result.userId).toBe(fields.userId);
    }
  });

  it('recovers inactive owner input over the real MCP bridge and queues the same task once despite lost answer acknowledgment', async () => {
    const old = await human('member'), current = await human('member');
    await db.insert(companyMemberships).values({ companyId: old.company.id, principalType: 'user', principalId: current.userId, membershipRole: 'member', status: 'active' });
    const target = old.target;
    const [worker] = await db.insert(agents).values({ companyId: old.company.id, name: 'Inactive-owner SDK worker', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: old.userId }).returning();
    const workforce = workforceService(db);
    await workforce.enroll(old.company.id, worker.id, { templateId: 'marketing-content' }, { userId: old.userId });
    const issue = await workforce.startFirstJob(old.company.id, worker.id, { userId: old.userId });
    const question = await issueThreadInteractionService(db).create(issue, { kind: 'ask_user_questions', continuationPolicy: 'wake_assignee', payload: { version: 1, questions: [{ id: 'needed', prompt: 'Original private question', selectionMode: 'text', options: [], required: true }] } }, { agentId: worker.id });
    await db.update(companyMemberships).set({ status: 'inactive' }).where(and(eq(companyMemberships.companyId, old.company.id), eq(companyMemberships.principalId, old.userId)));
    await db.update(agents).set({ accountableUserId: current.userId }).where(eq(agents.id, worker.id));
    const mcp = createAgentDashServer({ apiUrl: base.replace('/human-control', ''), apiKey: current.token, companyId: old.company.id, agentId: null, runId: null }, { toolset: 'human' });
    const client = new Client({ name: 'inactive-owner-recovery', version: '1' });
    const [a,b] = InMemoryTransport.createLinkedPair(); await mcp.connect(a); await client.connect(b);
    async function invoke(name: string, args: Record<string, unknown>) {
      const response = await client.callTool({ name, arguments: { target, ...args } });
      return { error: response.isError, body: JSON.parse((response.content as Array<{ text: string }>)[0].text) };
    }
    async function prepare(operationId: string, input: Record<string, unknown>) {
      const result = await invoke('human_prepare', { operationId, version: 1, input });
      expect(result.error, JSON.stringify(result.body)).not.toBe(true);
      return result.body;
    }
    try {
      const found = await invoke('human_read', { operationId: 'human_questions.recovery.list', version: 1, input: { issueId: issue.id } });
      expect(found.body.questions).toHaveLength(1);
      expect(JSON.stringify(found.body)).not.toContain('Original private question');
      const cancellation = await prepare('human_questions.recovery.cancel', { issueId: issue.id, interactionId: question.id });
      expect((await invoke('human_confirm', { handle: cancellation.handle })).body.result.status).toBe('cancelled');
      expect((await workforce.getReadiness(old.company.id, worker.id))?.pendingQuestionIds).toContain(question.id);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, worker.id))).toHaveLength(0);
      const replacement = await prepare('human_questions.replace', { issueId: issue.id, interactionId: question.id });
      const replaced = await invoke('human_confirm', { handle: replacement.handle });
      expect(replaced.error).not.toBe(true);
      const answer = await prepare('human_questions.respond', { issueId: issue.id, interactionId: replaced.body.result.interactionId, answers: [{ questionId: 'needed', optionIds: [], text: 'Genuine scoped answer' }] });
      failAfterWake = true;
      const uncertain = await invoke('human_confirm', { handle: answer.handle });
      failAfterWake = false;
      expect(uncertain.body.status).toBe('recovery_required');
      expect((await invoke('human_confirm', { handle: answer.handle })).body.status).toBe('recovery_required');
      const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, worker.id));
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, worker.id));
      expect(wakeups).toHaveLength(1); expect(runs).toHaveLength(1);
      expect(wakeups[0].payload).toMatchObject({ issueId: issue.id, interactionStatus: 'answered' });
      expect(runs[0].contextSnapshot).toMatchObject({ issueId: issue.id, taskId: issue.id });
      expect((await workforce.getReadiness(old.company.id, worker.id))?.pendingQuestionIds).toEqual([]);
      expect((await issueThreadInteractionService(db).getById(question.id))?.payload.answerOwnerUserId).toBe(old.userId);
    } finally { failAfterWake = false; await client.close(); await mcp.close(); }
  });

  it('executes real SDK tools/list and tools/call through HTTP, and exposes durable recovery after a committed wake failure', async () => {
    const h = await human();
    const [worker] = await db.insert(agents).values({ companyId: h.company.id, name: 'Recovery worker', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: h.userId }).returning();
    await workforceService(db).enroll(h.company.id, worker.id, { templateId: 'marketing-content' }, { userId: h.userId });
    const mcp = createAgentDashServer({ apiUrl: base.replace('/human-control', ''), apiKey: h.token, companyId: null, agentId: null, runId: null }, { toolset: 'human' });
    const client = new Client({ name: 'real-human-integration', version: '1' });
    const [a,b] = InMemoryTransport.createLinkedPair(); await mcp.connect(a); await client.connect(b);
    async function invoke(name: string, args: Record<string, unknown>) {
      const response = await client.callTool({ name, arguments: args });
      const content = response.content as Array<{text:string}>;
      return { error: response.isError, body: content[0].text.startsWith('{') ? JSON.parse(content[0].text) : { message: content[0].text } };
    }
    try {
      expect((await client.listTools()).tools).toHaveLength(6);
      expect((await invoke('human_select_target', { target: h.target })).error).not.toBe(true);
      const found = await invoke('human_discover', { target: h.target });
      expect(found.body.operations).toHaveLength(24);
      const p = await invoke('human_prepare', { target: h.target, operationId: 'workforce.first_job.start', version: 1, input: { agentId: worker.id } });
      expect(await db.select().from(issues).where(eq(issues.companyId, h.company.id))).toHaveLength(0);
      failAfterWake = true;
      const failed = await invoke('human_confirm', { target: h.target, handle: p.body.handle });
      failAfterWake = false;
      expect(failed.error).toBe(true);
      expect(failed.body).toMatchObject({ status: 'recovery_required', actionId: p.body.id });
      expect(JSON.stringify(failed.body)).not.toContain('SYNTHETIC_PRIVATE');
      const [handle] = await db.select().from(humanActionHandles).where(eq(humanActionHandles.id, p.body.id));
      const [job] = await db.select().from(issues).where(eq(issues.companyId, h.company.id));
      expect(handle.status).toBe('recovery_required');
      expect(handle.result).toMatchObject({ reference: { issueId: job.id } });
      const assertOneWake = async () => {
        expect(await db.select().from(issues).where(eq(issues.companyId, h.company.id))).toHaveLength(1);
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, worker.id))).toHaveLength(1);
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, worker.id))).toHaveLength(1);
      };
      await assertOneWake();
      const replay = await invoke('human_confirm', { target: h.target, handle: p.body.handle });
      expect(replay.body.status).toBe('recovery_required');
      const second = await invoke('human_prepare', { target: h.target, operationId: 'workforce.first_job.start', version: 1, input: { agentId: worker.id } });
      expect((await invoke('human_confirm', { target: h.target, handle: second.body.handle })).body.result.issueId).toBe(job.id);
      await assertOneWake();
      await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, h.key.id));
      await expect(client.listTools()).rejects.toThrow();
    } finally { failAfterWake = false; await client.close(); await mcp.close(); }
  });

  it('paginates discovery and owned questions without losing total counts or accepting unknown cursors', async () => {
    const h = await human();
    const first = await call(h.token, '/discover', { target: h.target, limit: 1 });
    expect(first.body.operations).toHaveLength(1);
    expect(first.body.nextCursor).toBeTypeOf('string');
    const next = await call(h.token, '/discover', { target: h.target, limit: 1, cursor: first.body.nextCursor });
    expect(next.body.operations[0].operationId).not.toBe(first.body.operations[0].operationId);
    expect((await call(h.token, '/discover', { target: h.target, cursor: 'forged-cursor' })).status).toBe(400);
    const [worker] = await db.insert(agents).values({ companyId: h.company.id, name: 'Pagination', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: h.userId }).returning();
    const svc = workforceService(db); await svc.enroll(h.company.id, worker.id, { templateId: 'marketing-content' }, { userId: h.userId });
    const issue = await svc.startFirstJob(h.company.id, worker.id, { userId: h.userId });
    const questions = issueThreadInteractionService(db);
    for (let i = 0; i < 3; i++) await questions.create(issue, { kind: 'ask_user_questions', payload: { version: 1, questions: [{ id: `q${i}`, prompt: 'Choose', selectionMode: 'single', options: [{ id: 'a', label: 'A' }] }] } }, { agentId: worker.id });
    const page = async (offset: number) => call(h.token, '/read', { target: h.target, operationId: 'human_questions.pending.list', version: 1, input: { offset, limit: 2 } });
    expect((await page(0)).body).toMatchObject({ total: 3, nextOffset: 2, questions: expect.any(Array) });
    expect((await page(2)).body.questions).toHaveLength(1);
    expect((await page(3)).body).toMatchObject({ total: 3, nextOffset: null, questions: [] });
  });
  it('refuses membership removal and current instance-role downgrade without mutating at confirm', async () => {
    const h = await human('member');
    const [role] = await db.insert(instanceUserRoles).values({ userId: h.userId, role: 'instance_admin' }).returning();
    const p = await call(h.token, '/prepare', action(h.target)); expect(p.status).toBe(200);
    await db.delete(instanceUserRoles).where(eq(instanceUserRoles.id, role.id));
    expect((await call(h.token, '/confirm', { target: h.target, handle: p.body.handle })).status).toBe(403);
    expect((await workforceService(db).getBrief(h.company.id)).revision).toBe(0);
    await db.update(companyMemberships).set({ membershipRole: 'admin' }).where(eq(companyMemberships.companyId, h.company.id));
    const removed = await call(h.token, '/prepare', action(h.target));
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, h.company.id));
    expect((await call(h.token, '/confirm', { target: h.target, handle: removed.body.handle })).status).toBe(403);
    expect((await workforceService(db).getBrief(h.company.id)).revision).toBe(0);
    expect((await call(h.token, '/discover', { target: { kind: 'instance' } })).status).toBe(200);
    expect((await call(h.token, '/discover', { target: { kind: 'self' } })).status).toBe(200);
    expect((await call(h.token, '/read', { target: { kind: 'public' }, operationId: 'workforce.brief.read', version: 1, input: {} })).status).toBe(400);
  });

  it('rechecks pinned owner, accepts single/multi/text answers and resumes the same question once', async () => {
    const h = await human('member'), next = await human('member');
    await db.insert(companyMemberships).values({ companyId: h.company.id, principalType: 'user', principalId: next.userId, membershipRole: 'member', status: 'active' });
    const [worker] = await db.insert(agents).values({ companyId: h.company.id, name: 'Selections', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: h.userId }).returning();
    const svc = workforceService(db); await svc.enroll(h.company.id, worker.id, { templateId: 'marketing-content' }, { userId: h.userId });
    const issue = await svc.startFirstJob(h.company.id, worker.id, { userId: h.userId });
    const q = await issueThreadInteractionService(db).create(issue, { kind: 'ask_user_questions', continuationPolicy: 'wake_assignee', payload: { version: 1, questions: [
      { id: 'single', prompt: 'Choose one', selectionMode: 'single', required: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'multi', prompt: 'Choose several', selectionMode: 'multi', required: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'text', prompt: 'Explain', selectionMode: 'text', required: true, options: [] },
    ] } }, { agentId: worker.id });
    const body = { target: h.target, operationId: 'human_questions.respond', version: 1, input: { issueId: issue.id, interactionId: q.id, answers: [{ questionId: 'single', optionIds: ['a'] }, { questionId: 'multi', optionIds: ['a', 'b'] }, { questionId: 'text', optionIds: [], text: 'Known private input' }] } };
    expect((await call(h.token, '/prepare', { ...body, input: { ...body.input, answers: [{ questionId: 'single', optionIds: ['a'], answerOwnerUserId: next.userId }] } })).status).toBe(400);
    expect(await db.select().from(humanActionHandles).where(eq(humanActionHandles.actorUserId, h.userId))).toHaveLength(0);
    const stale = await call(h.token, '/prepare', body); expect(stale.status).toBe(200);
    await db.update(issueThreadInteractions).set({ payload: { ...q.payload, answerOwnerUserId: next.userId }, updatedAt: new Date() }).where(eq(issueThreadInteractions.id, q.id));
    expect((await call(h.token, '/confirm', { target: h.target, handle: stale.body.handle })).status).toBe(403);
    const fresh = await call(next.token, '/prepare', body); expect(fresh.status).toBe(200);
    const response = await call(next.token, '/confirm', { target: h.target, handle: fresh.body.handle });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.result).toMatchObject({ issueId: issue.id, interactionId: q.id, status: 'answered', result: { shareWithCompany: false, answers: body.input.answers } });
    expect((await call(next.token, '/confirm', { target: h.target, handle: fresh.body.handle })).status).toBe(409);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, worker.id))).toHaveLength(1);
  });

  it('preserves only the canonical stewardship exception for a current instance admin without membership', async () => {
    const h = await human(), member = await human('member');
    await db.insert(companyMemberships).values({ companyId: h.company.id, principalType: 'user', principalId: member.userId, membershipRole: 'member', status: 'active' });
    await db.delete(companyMemberships).where(and(eq(companyMemberships.companyId, h.company.id), eq(companyMemberships.principalId, h.userId)));
    await db.insert(instanceUserRoles).values({ userId: h.userId, role: 'instance_admin' });
    const [worker] = await db.insert(agents).values({ companyId: h.company.id, name: 'Unpaired', adapterType: 'codex_local', autonomy: 'stewarded' }).returning();
    const identity = await call(h.token, '/identity'); expect(identity.body.targets).toContainEqual(h.target);
    expect(identity.body.memberships).not.toContainEqual(expect.objectContaining({ companyId: h.company.id }));
    const found = await call(h.token, '/discover', { target: h.target });
    expect(found.status).toBe(200);
    expect(found.body.operations.map((x: {operationId:string}) => x.operationId).sort()).toEqual(['human_questions.stewardship.assign', 'human_questions.stewardship.transfer']);
    for (const operationId of ['workforce.brief.read', 'human_questions.pending.list']) expect((await call(h.token, '/read', { target: h.target, operationId, version: 1, input: {} })).status).toBe(403);
    expect((await call(h.token, '/prepare', { target: h.target, operationId: 'human_questions.owner.assign', version: 1, input: { agentId: worker.id, accountableUserId: member.userId } })).status).toBe(403);
    const p = await call(h.token, '/prepare', { target: h.target, operationId: 'human_questions.stewardship.assign', version: 1, input: { agentId: worker.id, userId: member.userId } });
    expect(p.status).toBe(200);
    expect((await call(h.token, '/confirm', { target: h.target, handle: p.body.handle })).status).toBe(200);
  });

  it('I1 never discloses cached terminal values over HTTP or SDK after membership loss', async () => {
    const h = await human(), other = await human();
    const prepared = await call(h.token, '/prepare', action(h.target));
    expect((await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle })).status).toBe(200);
    const bridge = await sdk(h);
    try {
      await db.delete(companyMemberships).where(eq(companyMemberships.companyId, h.company.id));
      const [original] = await db.select().from(humanActionHandles).where(eq(humanActionHandles.id, prepared.body.id));
      expect(JSON.stringify(original.result)).toContain('Full useful source');
      for (const status of ['completed', 'denied', 'stale', 'expired', 'recovery_required']) {
        await db.update(humanActionHandles).set({ status }).where(eq(humanActionHandles.id, original.id));
        const raw = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
        expect(raw.status).toBe(409);
        expect(raw.body.details).toEqual({ status, actionId: original.id });
        expect(JSON.stringify(raw.body)).not.toContain('Full useful source');
        const mcp = await bridge.confirm(prepared.body.handle);
        expect(mcp.error).toBe(true);
        expect(mcp.body).not.toHaveProperty('result');
        const [after] = await db.select().from(humanActionHandles).where(eq(humanActionHandles.id, original.id));
        expect(after).toEqual({ ...original, status });
      }
      expect((await call(other.token, '/confirm', { target: h.target, handle: prepared.body.handle })).status).toBe(404);
      expect((await call(h.token, '/confirm', { target: other.target, handle: prepared.body.handle })).status).toBe(404);
      const secondKey = `pcp_board_${randomUUID()}`;
      await db.insert(boardApiKeys).values({ userId: h.userId, name: 'Different same-human key', keyHash: hashBearerToken(secondKey) });
      expect((await call(secondKey, '/confirm', { target: h.target, handle: prepared.body.handle })).status).toBe(404);
      expect((await workforceService(db).getBrief(h.company.id)).revision).toBe(1);
    } finally { await bridge.close(); }
  });

  it('I1 rechecks completed question visibility and owner before safe recovery references without pending-only preconditions', async () => {
    const h = await human('member');
    const [worker] = await db.insert(agents).values({ companyId: h.company.id, name: 'Private recovery worker', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: h.userId }).returning();
    const workforce = workforceService(db);
    await workforce.enroll(h.company.id, worker.id, { templateId: 'marketing-content' }, { userId: h.userId });
    const issue = await workforce.startFirstJob(h.company.id, worker.id, { userId: h.userId });
    const questions = issueThreadInteractionService(db);
    async function answerQuestion(fail: boolean) {
      const q = await questions.create(issue, { kind: 'ask_user_questions', continuationPolicy: 'wake_assignee', payload: { version: 1, questions: [{ id: 'private', prompt: 'PRIVATE_QUESTION_SENTINEL', selectionMode: 'text', required: true, options: [] }] } }, { agentId: worker.id });
      const prepared = await call(h.token, '/prepare', { target: h.target, operationId: 'human_questions.respond', version: 1, input: { issueId: issue.id, interactionId: q.id, answers: [{ questionId: 'private', optionIds: [], text: 'PRIVATE_ANSWER_SENTINEL' }] } });
      expect(prepared.status).toBe(200);
      failAfterWake = fail;
      const result = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
      failAfterWake = false;
      expect(result.status).toBe(fail ? 409 : 200);
      return { q, prepared };
    }
    const completed = await answerQuestion(false);
    const recovery = await answerQuestion(true);
    const bridge = await sdk(h);
    async function check(handle: string, reference?: Record<string, string>) {
      const raw = await call(h.token, '/confirm', { target: h.target, handle });
      expect(raw.status).toBe(409);
      expect(JSON.stringify(raw.body)).not.toContain('PRIVATE_');
      expect(raw.body.details.result).toEqual(reference ? { reference } : undefined);
      const mcp = await bridge.confirm(handle);
      expect(mcp.error).toBe(true);
      expect(JSON.stringify(mcp.body)).not.toContain('PRIVATE_');
      expect(mcp.body.result).toEqual(reference ? { reference } : undefined);
    }
    try {
      await check(completed.prepared.body.handle);
      await check(recovery.prepared.body.handle, { issueId: issue.id, interactionId: recovery.q.id });
      const before = await db.select().from(humanActionHandles).where(eq(humanActionHandles.actorUserId, h.userId));
      const [project] = await db.insert(projects).values({ companyId: h.company.id, name: 'Hidden recovery project', visibility: 'restricted', createdByUserId: 'another-person' }).returning();
      await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, issue.id));
      await check(completed.prepared.body.handle);
      await check(recovery.prepared.body.handle);
      await db.update(projects).set({ visibility: 'company' }).where(eq(projects.id, project.id));
      await check(recovery.prepared.body.handle, { issueId: issue.id, interactionId: recovery.q.id });
      await db.update(issueThreadInteractions).set({ payload: { ...recovery.q.payload, answerOwnerUserId: 'different-current-owner' } }).where(eq(issueThreadInteractions.id, recovery.q.id));
      await check(recovery.prepared.body.handle);
      expect(await db.select().from(humanActionHandles).where(eq(humanActionHandles.actorUserId, h.userId))).toEqual(before);
      expect((await questions.getById(recovery.q.id))?.status).toBe('answered');
    } finally { failAfterWake = false; await bridge.close(); }
  });

  it('marks the handle stale, not recovery_required, when a database error rolls the confirm back (#883 review)', async () => {
    const h = await human();
    const prepared = await call(h.token, '/prepare', action(h.target));
    expect(prepared.status).toBe(200);
    const realFactory = workforceModule.workforceService;
    const spy = vi.spyOn(workforceModule, 'workforceService').mockImplementation(connection => {
      const service = realFactory(connection);
      return { ...service, updateBrief: async () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); } };
    });
    try {
      const confirmed = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
      expect(confirmed.status).toBe(409);
      expect(confirmed.body.details).toMatchObject({ status: 'stale', actionId: prepared.body.id });
      expect((await db.select().from(humanActionHandles).where(eq(humanActionHandles.id, prepared.body.id)))[0].status).toBe('stale');
      expect((await realFactory(db).getBrief(h.company.id)).revision).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it('I3 persists the scoped enrollment before skill installation and exposes only an authorized SDK recovery reference', async () => {
    const h = await human();
    const [worker] = await db.insert(agents).values({ companyId: h.company.id, name: 'Skill recovery worker', adapterType: 'codex_local' }).returning();
    const enrollment = await workforceService(db).enroll(h.company.id, worker.id, { templateId: 'marketing-content' }, { userId: h.userId });
    const prepared = await call(h.token, '/prepare', { target: h.target, operationId: 'workforce.skills.retry', version: 1, input: { agentId: worker.id } });
    expect(prepared.status).toBe(200);
    const realFactory = workforceModule.workforceService;
    let attempts = 0;
    let persistedBeforeInstall: typeof humanActionHandles.$inferSelect | undefined;
    const spy = vi.spyOn(workforceModule, 'workforceService').mockImplementation(connection => {
      const service = realFactory(connection);
      return { ...service, ensureSkillsInstalled: async (...args) => {
        attempts += 1;
        [persistedBeforeInstall] = await db.select().from(humanActionHandles).where(eq(humanActionHandles.id, prepared.body.id));
        await service.ensureSkillsInstalled(...args);
        throw new Error('PRIVATE_POST_INSTALL_FAILURE');
      } };
    });
    const bridge = await sdk(h);
    try {
      const result = await bridge.confirm(prepared.body.handle);
      expect(result.error).toBe(true);
      expect(result.body).toMatchObject({ status: 'recovery_required', result: { reference: { enrollmentId: enrollment.id } } });
      expect(JSON.stringify(result.body)).not.toContain('PRIVATE_');
      expect(persistedBeforeInstall).toMatchObject({ status: 'recovery_required', result: { reference: { enrollmentId: enrollment.id } } });
      expect(persistedBeforeInstall?.consumedAt).not.toBeNull();
      expect((await realFactory(db).getEnrollment(h.company.id, worker.id))?.installedSkillKeys.length).toBeGreaterThan(0);
      const replay = await bridge.confirm(prepared.body.handle);
      expect(replay.body).toMatchObject({ status: 'recovery_required', result: { reference: { enrollmentId: enrollment.id } } });
      expect(attempts).toBe(1);
      await db.delete(companyMemberships).where(eq(companyMemberships.companyId, h.company.id));
      expect((await bridge.confirm(prepared.body.handle)).body).not.toHaveProperty('result');
      const raw = await call(h.token, '/confirm', { target: h.target, handle: prepared.body.handle });
      expect(raw.body.details).toEqual({ status: 'recovery_required', actionId: prepared.body.id });
      expect(attempts).toBe(1);
    } finally { spy.mockRestore(); await bridge.close(); }
  });

});
