import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { agents, companies, companyMemberships, authUsers, boardApiKeys, assistantConversations, assistantMessages, agentApiKeys, activityLog, workforceEnrollments, cosOnboardingStates, createDb, type Db } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { hashBearerToken } from '../services/board-auth.js';
import { agentCreatorFromProposal } from '../services/agent-creator-from-proposal.js';
import { workforceService } from '../services/workforce.js';
import { agentService } from '../services/agents.js';
import { subscribeCompanyLiveEvents } from '../services/live-events.js';

const boundary = vi.hoisted(() => ({ failSkills: false, materialize: undefined as undefined | ((agent: any, files: Record<string,string>) => Promise<any>) }));
vi.mock('../services/agent-proposer.js', () => ({ agentProposer: () => ({ propose: async () => ({ name: 'New hire', role: 'Marketing', oneLineOkr: 'Publish evidence', rationale: 'Need content', workforceTemplateId: 'marketing-content' }) }) }));
vi.mock('../services/agent-instructions.js', async importOriginal => ({ ...await importOriginal<any>(), agentInstructionsService: () => ({ materializeManagedBundle: async (agent: any, files: Record<string,string>) => boundary.materialize!(agent, files) }) }));
// External skill filesystem is mocked; enrollment/assignment transactions remain real.
vi.mock('../services/company-skills.js', () => ({ companySkillService: () => ({ getByKey: async () => null, createLocalSkill: async (companyId: string, input: any) => { if(boundary.failSkills) throw new Error('Synthetic install failure'); return { key: `company/${companyId}/${input.slug}`, markdown: input.markdown }; } }) }));

describe('onboarding accepted hires and postcommit materialization', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, other: Db;
  let app: express.Express;
  let routes: typeof import('../routes/onboarding-v2.js').onboardingV2Routes;
  function application(connection: Db) { const a = express(); a.use(express.json()); a.use(actorMiddleware(db, { deploymentMode: 'local_trusted' })); a.use('/api/onboarding', routes(connection)); a.use(errorHandler); return a; }
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('accepted-hire-'); db = createDb(temp.connectionString); other = createDb(temp.connectionString);
    const { onboardingV2Routes } = await import('../routes/onboarding-v2.js');
    routes = onboardingV2Routes; app = application(db);
  });
  afterAll(async () => { await temp?.cleanup(); });
  afterEach(() => { vi.unstubAllEnvs(); boundary.materialize = undefined; boundary.failSkills = false; });
  async function fixture(enabled = true) {
    vi.stubEnv('AGENTDASH_BILLING_DISABLED', enabled ? 'false' : 'true'); vi.stubEnv('STRIPE_SECRET_KEY', 'test-capacity-only-no-provider');
    const userId = randomUUID(), token = `pcp_board_${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: 'Owner', email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(boardApiKeys).values({ userId, name: 'Test', keyHash: hashBearerToken(token) });
    const [company] = await db.insert(companies).values({ name: 'Hire test', issuePrefix: randomUUID().slice(0,8), planTier: 'pro_active' }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: userId, membershipRole: 'owner', status: 'active' });
    const [leader] = await db.insert(agents).values({ companyId: company.id, name: 'CoS', role: 'chief_of_staff', adapterType: 'codex_local' }).returning();
    const [conversation] = await db.insert(assistantConversations).values({ companyId: company.id, userId, assistantAgentId: leader.id, metadata: { keep: 'unrelated' } }).returning();
    await db.insert(cosOnboardingStates).values({ conversationId: conversation.id, phase: 'plan' });
    return { company, leader, conversation, token, userId };
  }
  function confirm(f: Awaited<ReturnType<typeof fixture>>, application = app) { return request(application).post('/api/onboarding/agent/confirm').set('authorization', `Bearer ${f.token}`).send({ companyId: f.company.id, conversationId: f.conversation.id, reportsToAgentId: f.leader.id }); }
  async function hires(f: Awaited<ReturnType<typeof fixture>>) { return (await db.select().from(agents).where(eq(agents.companyId,f.company.id))).filter(a => a.id !== f.leader.id); }
  it('preserves selected-template legacy creator dependencies and caller-owned later skill installation', async () => {
    const f = await fixture();
    const result = await agentCreatorFromProposal({ agents: agentService(db), instructions: { materializeManagedBundle: async () => ({ adapterConfig: { nativeBundle: true } }) } as any }).create({
      companyId: f.company.id, reportsToAgentId: f.leader.id, proposal: { name: 'Legacy', role: 'Writer', oneLineOkr: 'Draft', rationale: 'Content', workforceTemplateId: 'marketing-content' }, transcript: [],
    });
    expect(result.apiKey?.token).toBeTruthy();
    expect((await agentService(db).getById(result.agentId))?.status).toBe('idle');
    expect(await workforceService(db).getEnrollment(f.company.id,result.agentId)).toMatchObject({ templateId: 'marketing-content', installedSkillKeys: [] });
    expect((await workforceService(db).getReadiness(f.company.id,result.agentId))?.phase).not.toBe('ready');
  });
  it.each([true,false])('accepts once, frees company lock before files, then announces readiness (billing enabled=%s)', async enabled => {
    const f = await fixture(enabled); const events: string[] = []; const stop = subscribeCompanyLiveEvents(f.company.id, e => { if(e.type === 'activity.logged') events.push(e.payload.action as string); });
    let backend = 0;
    boundary.materialize = async (agent, files) => {
      expect(events).toContain('workforce.enrolled');
      const persisted = (await other.select().from(agents).where(eq(agents.id,agent.id)))[0];
      expect(persisted).toMatchObject({ status: 'paused', pauseReason: 'system' });
      await db.transaction(async primary => { const owner = await primary.execute(sql`select pg_backend_pid() as id`); await other.transaction(async tx => { await tx.execute(sql`set local lock_timeout = '500ms'`); const rows = await tx.execute(sql`select pg_backend_pid() as id`); backend = Number(rows[0].id); expect(backend).not.toBe(Number(owner[0].id)); await tx.select().from(companies).where(eq(companies.id,f.company.id)).for('update'); }); });
      expect(files['AGENTS.md']).toContain('## Execution Contract'); expect(files['AGENTS.md']).toContain('## Hiring context');
      expect(await db.select().from(assistantMessages).where(eq(assistantMessages.conversationId,f.conversation.id))).toEqual([]);
      return { adapterConfig: { nativeBundle: true } };
    };
    try {
      const response = await confirm(f); expect(response.status).toBe(201); expect(backend).toBeGreaterThan(0);
      expect(await hires(f)).toHaveLength(1); expect((await hires(f))[0]).toMatchObject({ status: 'idle', adapterConfig: { nativeBundle: true }, role: 'cmo', title: 'Marketing' });
      expect((await confirm(f)).status).toBe(409); expect(await hires(f)).toHaveLength(1);
      expect((await db.select().from(assistantConversations).where(eq(assistantConversations.id,f.conversation.id)))[0].metadata).toMatchObject({ keep: 'unrelated' });
    } finally { stop(); }
  });
  it('retains paused accepted identity on file failure and refuses rehire without exposing file errors or keys', async () => {
    const f = await fixture(); boundary.materialize = async () => { throw new Error('/private/path SECRET_FILE_FAILURE'); };
    const response = await confirm(f); expect(response.status).toBe(409);
    const accepted = await hires(f); expect(accepted).toHaveLength(1); expect(accepted[0].status).toBe('paused');
    expect(JSON.stringify(response.body)).toContain(accepted[0].id); expect(JSON.stringify(response.body)).not.toMatch(/SECRET_FILE_FAILURE|private\/path|pcp_/);
    expect(await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId,accepted[0].id))).toEqual([]);
    expect(await db.select().from(assistantMessages).where(eq(assistantMessages.conversationId,f.conversation.id))).toEqual([]);
    expect((await confirm(f)).status).toBe(409); expect(await hires(f)).toHaveLength(1);
  });
  it('keeps accepted hire paused and unannounced when skill installation returns an error', async () => {
    const f = await fixture(); boundary.failSkills = true; boundary.materialize = async () => ({ adapterConfig: { nativeBundle: true } });
    const response = await confirm(f); expect(response.status).toBe(409);
    const [accepted] = await hires(f); expect(accepted.status).toBe('paused');
    expect((await db.select().from(workforceEnrollments).where(eq(workforceEnrollments.agentId,accepted.id)))[0].skillInstallError).toBe('Synthetic install failure');
    expect(await db.select().from(assistantMessages).where(eq(assistantMessages.conversationId,f.conversation.id))).toEqual([]);
    expect(await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId,accepted.id))).toEqual([]);
    expect((await confirm(f)).status).toBe(409); expect(await hires(f)).toHaveLength(1);
  });
  it('keeps an accepted hire paused after a committed skill assignment loses its acknowledgement', async () => {
    const f = await fixture();
    boundary.materialize = async () => ({ adapterConfig: { nativeBundle: true } });
    let lostAcknowledgements = 0;
    const uncertainAssignmentDb = new Proxy(db, { get(target, key, receiver) {
      if (key === 'transaction') return async (work: (tx: any) => Promise<any>) => {
        const result = await target.transaction(work);
        if (Array.isArray(result?.installedSkillKeys)) {
          lostAcknowledgements++;
          throw new Error('PRIVATE_SYNTHETIC_SKILL_ACK_LOSS');
        }
        return result;
      };
      return Reflect.get(target, key, receiver);
    } });
    const events: string[] = [];
    const stop = subscribeCompanyLiveEvents(f.company.id, event => {
      if (event.type === 'activity.logged') events.push(event.payload.action as string);
    });
    try {
      const response = await confirm(f, application(uncertainAssignmentDb));
      expect(response.status).toBe(409);
      const [accepted] = await hires(f);
      expect(accepted).toMatchObject({ status: 'paused', pauseReason: 'system', adapterConfig: { nativeBundle: true } });
      const [enrollment] = await db.select().from(workforceEnrollments).where(eq(workforceEnrollments.agentId, accepted.id));
      expect(enrollment.installedSkillKeys).toHaveLength(1);
      expect(enrollment.skillInstallError).toBeNull();
      expect((await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).map(row => row.action)).toEqual(['workforce.enrolled', 'workforce.skills_installed']);
      expect(events).toEqual(['workforce.enrolled']);
      expect(lostAcknowledgements).toBe(1);
      expect(JSON.stringify(response.body)).toContain(accepted.id);
      expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_SYNTHETIC|pcp_/);
      expect(await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, accepted.id))).toEqual([]);
      expect(await db.select().from(assistantMessages).where(eq(assistantMessages.conversationId, f.conversation.id))).toEqual([]);
      expect((await confirm(f)).status).toBe(409);
      expect(await hires(f)).toHaveLength(1);
      expect(events).toEqual(['workforce.enrolled']);
    } finally { stop(); }
  });
  it.each(['paused','patch_paused','terminated'])('completion preserves intervening human %s', async status => {
    const f = await fixture(); let pauseAdvanced = false; boundary.materialize = async agent => { if(status === 'paused') await agentService(other).pause(agent.id); else if (status === 'patch_paused') { const now = vi.spyOn(Date, 'now').mockReturnValue(agent.pausedAt.getTime()); try { const paused = await agentService(other).update(agent.id, { status: 'paused' }); pauseAdvanced = Boolean(paused?.pausedAt && paused.pausedAt.getTime() > agent.pausedAt.getTime()); } finally { now.mockRestore(); } } else await other.update(agents).set({ status: 'terminated' }).where(eq(agents.id,agent.id)); return { adapterConfig: { nativeBundle: true } }; };
    expect((await confirm(f)).status).toBe(409); expect((await hires(f))[0].status).toBe(status === 'patch_paused' ? 'paused' : status); if (status === 'patch_paused') expect(pauseAdvanced).toBe(true);
    expect(await db.select().from(assistantMessages).where(eq(assistantMessages.conversationId,f.conversation.id))).toEqual([]);
  });
  async function plan(f: Awaited<ReturnType<typeof fixture>>) {
    const [row] = await db.insert(assistantMessages).values({ conversationId: f.conversation.id, role: 'assistant', content: 'Plan', cardKind: 'agent_plan_proposal_v1', cardPayload: {
      rationale: 'Growth', alignmentToShortTerm: 'Campaign', alignmentToLongTerm: 'Revenue',
      agents: ['First', 'Second'].map(name => ({ name, role: 'Writer', adapterType: 'codex_local', workforceTemplateId: 'marketing-content', responsibilities: ['Write'], kpis: ['Drafts'] })),
    } }).returning(); return row;
  }
  function confirmPlan(f: Awaited<ReturnType<typeof fixture>>, application = app) { return request(application).post('/api/onboarding/confirm-plan').set('authorization', `Bearer ${f.token}`).send({ conversationId: f.conversation.id }); }
  function faultDatabase(mode: 'rollback' | 'unknown' | 'second') {
    let calls = 0;
    return new Proxy(db, { get(target, key, receiver) {
      if (key === 'transaction') return async (work: (tx: any) => Promise<any>) => {
        calls++;
        if (mode === 'second' && calls === 2) throw new Error('synthetic second creation failure');
        const result = await target.transaction(async tx => { const value = await work(tx); if(mode === 'rollback' && calls === 1) throw new Error('synthetic precommit rollback'); return value; });
        if(mode === 'unknown' && calls === 1) throw new Error('synthetic lost commit acknowledgement');
        return result;
      };
      return Reflect.get(target, key, receiver);
    } });
  }
  it.each([true, false])('atomically rolls back receipt, hire, enrollment and audits before acceptance (billing=%s)', async enabled => {
    const f = await fixture(enabled), events: unknown[] = []; const stop = subscribeCompanyLiveEvents(f.company.id, e => events.push(e));
    boundary.materialize = async () => { throw new Error('must not reach filesystem'); };
    try {
      expect((await confirm(f, application(faultDatabase('rollback')))).status).toBe(500);
      expect(await hires(f)).toEqual([]);
      expect(await db.select().from(workforceEnrollments).where(eq(workforceEnrollments.companyId,f.company.id))).toEqual([]);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).toEqual([]);
      expect((await db.select().from(assistantConversations).where(eq(assistantConversations.id,f.conversation.id)))[0].metadata).toEqual({ keep: 'unrelated' });
      expect(events).toEqual([]);
    } finally { stop(); }
  });
  it('durably looks up accepted IDs after lost commit acknowledgement without publishing or re-entering files', async () => {
    const f = await fixture(), events: unknown[] = []; const stop = subscribeCompanyLiveEvents(f.company.id, e => events.push(e));
    boundary.materialize = async () => { throw new Error('must not reach filesystem'); };
    try {
      const response = await confirm(f, application(faultDatabase('unknown'))); expect(response.status).toBe(409);
      const accepted = await hires(f); expect(accepted).toHaveLength(1); expect(accepted[0].status).toBe('paused');
      expect(JSON.stringify(response.body)).toContain(accepted[0].id); expect(events).toEqual([]);
      expect((await confirm(f)).status).toBe(409); expect(await hires(f)).toHaveLength(1);
    } finally { stop(); }
  });
  it('preserves the first disabled-billing batch acceptance and refuses remaining hires after later failure', async () => {
    const f = await fixture(false); await plan(f); const events: string[] = []; const stop = subscribeCompanyLiveEvents(f.company.id, e => { if(e.type === 'activity.logged') events.push(e.payload.action as string); });
    boundary.materialize = async () => { throw new Error('must not reach filesystem'); };
    try {
      const response = await confirmPlan(f, application(faultDatabase('second'))); expect(response.status).toBe(409);
      expect((await hires(f)).map(a => a.name)).toEqual(['First']);
      expect(events).toEqual(['workforce.enrolled']);
      expect(await db.select().from(workforceEnrollments).where(eq(workforceEnrollments.companyId,f.company.id))).toHaveLength(1);
      expect((await confirmPlan(f)).status).toBe(409); expect(await hires(f)).toHaveLength(1);
      expect((await db.select().from(cosOnboardingStates).where(eq(cosOnboardingStates.conversationId,f.conversation.id)))[0].phase).toBe('materializing');
    } finally { stop(); }
  });
  it.each(['interview', 'plan'])('refuses concurrent and repeated %s confirmations with one accepted set', async kind => {
    const f = await fixture(); if(kind === 'plan') await plan(f);
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>(r => { entered = r; }), barrier = new Promise<void>(r => { release = r; });
    boundary.materialize = async () => { entered(); await barrier; return { adapterConfig: { nativeBundle: true } }; };
    const send = () => kind === 'plan' ? confirmPlan(f) : confirm(f);
    const first = send().then(result => result); await entry;
    try { expect((await send()).status).toBe(409); } finally { release(); }
    expect((await first).status).toBe(201); expect((await send()).status).toBe(409);
    expect(await hires(f)).toHaveLength(kind === 'plan' ? 2 : 1);
    if(kind === 'plan') { await plan(f); expect((await send()).status).toBe(201); expect(await hires(f)).toHaveLength(4); }
  });

});
