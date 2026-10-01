import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, companies, companyMemberships, createDb, activityLog, workforceEnrollments, agentStewardships, issueThreadInteractions, type Db } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { agentService } from '../services/agents.js';
import { workforceService } from '../services/workforce.js';
import { agentStewardshipService } from '../services/agent-stewardships.js';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';
import { subscribeCompanyLiveEvents } from '../services/live-events.js';
import { publishActivity, type ActivityPublication } from '../services/activity-log.js';

describe('actual outer commit owns accepted publication', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('outer-publication-'); db = createDb(temp.connectionString); });
  afterAll(async () => { await temp?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Publication boundary', issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: 'owner', status: 'active', membershipRole: 'owner' });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Worker', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: 'owner' }).returning();
    return { company, agent };
  }
  it('keeps root-bound enrolled creation inside the distinct supplied executor and refuses malformed pairs', async () => {
    const { company } = await fixture(); const publications: ActivityPublication[] = [], events: unknown[] = [];
    const stop = subscribeCompanyLiveEvents(company.id, e => events.push(e));
    try {
      await expect(db.transaction(async tx => {
        await agentService(db).create(company.id, { name: 'Accepted hire', adapterType: 'codex_local', workforceTemplateId: 'marketing-content' }, { executor: tx as unknown as Db, publications });
        throw new Error('rollback hired agent');
      })).rejects.toThrow('rollback hired agent');
      expect((await db.select().from(agents).where(eq(agents.companyId, company.id))).map(a => a.name)).toEqual(['Worker']);
      expect(await db.select().from(workforceEnrollments).where(eq(workforceEnrollments.companyId, company.id))).toEqual([]);
      expect(events).toEqual([]);
      await expect((agentService(db).create as any)(company.id, { name: 'Malformed hire' }, { executor: db })).rejects.toThrow(/collector/);
    } finally { stop(); }
  });
  it('discards enrollment and brief notifications on outer rollback, retaining no rows or audits', async () => {
    const { company, agent } = await fixture(); const events: unknown[] = [], publications: ActivityPublication[] = [];
    const stop = subscribeCompanyLiveEvents(company.id, event => events.push(event));
    try {
      await expect(db.transaction(async tx => {
        const executor = tx as unknown as Db, acceptance = { executor, publications };
        await workforceService(db).enroll(company.id, agent.id, { templateId: 'marketing-content' }, { userId: 'owner' }, acceptance);
        await workforceService(db).updateBrief(company.id, { expectedRevision: 0, sources: [], facts: [] }, { userId: 'owner' }, acceptance);
        throw new Error('rollback after accepted work');
      })).rejects.toThrow('rollback after accepted work');
      expect(await db.select().from(workforceEnrollments).where(eq(workforceEnrollments.companyId, company.id))).toEqual([]);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).toEqual([]);
      expect(events).toEqual([]);
    } finally { stop(); }
  });
  it('leaves shared question answer and brief pending/unpublished after outer rollback', async () => {
    const { company, agent } = await fixture(); const svc = workforceService(db);
    await svc.enroll(company.id, agent.id, { templateId: 'marketing-content' }, { userId: 'owner' });
    const issue = await svc.startFirstJob(company.id, agent.id, { userId: 'owner' });
    const q = await issueThreadInteractionService(db).create(issue, { kind: 'ask_user_questions', payload: { version: 1, questions: [{ id: 'offer', prompt: 'Offer?', selectionMode: 'text', required: true, companyFactKey: 'offer', options: [] }] } }, { agentId: agent.id });
    const events: unknown[] = [], publications: ActivityPublication[] = []; const stop = subscribeCompanyLiveEvents(company.id, e => events.push(e));
    try {
      await expect(db.transaction(async tx => {
        const executor = tx as unknown as Db;
        await issueThreadInteractionService(db).answerQuestions(issue, q.id, { shareWithCompany: true, answers: [{ questionId: 'offer', text: 'Approved offer', optionIds: [] }] }, { userId: 'owner' }, { executor, publications });
        throw new Error('rollback shared answer');
      })).rejects.toThrow('rollback shared answer');
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, q.id)))[0].status).toBe('pending');
      expect((await svc.getBrief(company.id)).revision).toBe(0);
      expect(events).toEqual([]);
    } finally { stop(); }
  });
  it('defers supplied stewardship until the caller commits, then publishes each committed audit once', async () => {
    const { company, agent } = await fixture();
    await db.update(agents).set({ autonomy: 'stewarded', accountableUserId: null }).where(eq(agents.id, agent.id));
    const events: unknown[] = [], publications: ActivityPublication[] = []; const stop = subscribeCompanyLiveEvents(company.id, e => events.push(e));
    try {
      await db.transaction(async tx => {
        const executor = tx as unknown as Db;
        await agentStewardshipService(db).assign(company.id, { agentId: agent.id, userId: 'owner', assignedByUserId: 'owner' }, { executor, publications });
        expect(events).toEqual([]);
        expect(await db.select().from(agentStewardships).where(eq(agentStewardships.companyId, company.id))).toEqual([]);
      });
      for (const publication of publications) publishActivity(publication);
      expect(await db.select().from(agentStewardships).where(eq(agentStewardships.companyId, company.id))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).toHaveLength(1);
      expect(events).toHaveLength(1);
    } finally { stop(); }
  });
});
