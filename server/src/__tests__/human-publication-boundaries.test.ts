import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, companies, companyMemberships, authUsers, boardApiKeys, activityLog, issueThreadInteractions, humanActionHandles, humanChannelBindings, bridgeEndpoints, agentStewardships, createDb, type Db } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { hashBearerToken } from '../services/board-auth.js';
import { workforceService } from '../services/workforce.js';
import { agentStewardshipService } from '../services/agent-stewardships.js';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';
import { humanControlRoutes } from '../routes/human-control.js';
import { subscribeCompanyLiveEvents } from '../services/live-events.js';
import { setPluginEventBus } from '../services/activity-log.js';
vi.mock('../services/company-skills.js', () => ({ companySkillService: () => ({ getByKey: async () => null, createLocalSkill: async (companyId: string, input: any) => ({ key: `company/${companyId}/${input.slug}`, markdown: input.markdown }) }) }));

describe('human HTTP acceptance publication and continuation', () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  const plugins: any[] = [];
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('human-publications-'); db = createDb(temp.connectionString); setPluginEventBus({ emit: async (event: unknown) => { plugins.push(event); return { errors: [] }; } } as any); });
  afterAll(async () => { await temp?.cleanup(); });
  async function fixture() {
    const userId = randomUUID(), token = `pcp_board_${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: 'Owner', email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(boardApiKeys).values({ userId, name: 'Test', keyHash: hashBearerToken(token) });
    const [company] = await db.insert(companies).values({ name: 'Human acceptance', issuePrefix: randomUUID().slice(0,8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: 'user', principalId: userId, membershipRole: 'owner', status: 'active' });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Worker', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: userId }).returning();
    return { userId, token, company, agent, target: { kind: 'company', companyId: company.id } };
  }
  function app(mode: 'normal' | 'rollback' | 'unknown', wake: () => Promise<any> = async () => null) {
    const connection = new Proxy(db, { get(target, key, receiver) {
      if(key === 'transaction') return async (work: (tx: any) => Promise<any>) => {
        const result = await target.transaction(async tx => { const value = await work(tx); if(mode === 'rollback') throw new Error('synthetic acceptance rollback'); return value; });
        if(mode === 'unknown') throw new Error('synthetic unknown commit acknowledgement');
        return result;
      };
      return Reflect.get(target,key,receiver);
    } });
    const a = express(); a.use(express.json()); a.use(actorMiddleware(db, { deploymentMode: 'local_trusted' })); a.use('/human', humanControlRoutes(connection, { heartbeat: { wakeup: wake } })); a.use(errorHandler); return a;
  }
  async function execute(f: Awaited<ReturnType<typeof fixture>>, application: express.Express, operationId: string, input: unknown) {
    const prepared = await request(application).post('/human/prepare').set('authorization', `Bearer ${f.token}`).send({ target: f.target, operationId, version: 1, input });
    expect(prepared.status).toBe(200);
    const confirm = () => request(application).post('/human/confirm').set('authorization', `Bearer ${f.token}`).send({ target: f.target, handle: prepared.body.handle });
    return { response: await confirm(), confirm };
  }
  it.each(['rollback','unknown','normal'] as const)('shared answer audits follow actual %s outcome before continuation', async mode => {
    const f = await fixture(), svc = workforceService(db);
    await svc.enroll(f.company.id,f.agent.id,{templateId:'marketing-content'},{userId:f.userId});
    const issue = await svc.startFirstJob(f.company.id,f.agent.id,{userId:f.userId});
    const q = await issueThreadInteractionService(db).create(issue,{kind:'ask_user_questions',continuationPolicy:'wake_assignee',payload:{version:1,questions:[{id:'offer',prompt:'Offer?',companyFactKey:'offer',selectionMode:'text',options:[],required:true}]}},{agentId:f.agent.id});
    const order: string[] = []; const stop = subscribeCompanyLiveEvents(f.company.id,e => { if(e.type==='activity.logged') order.push(e.payload.action as string); });
    const application = app(mode, async () => { expect((await svc.getBrief(f.company.id)).revision).toBe(1); order.push('continuation'); return null; });
    try {
      const result = await execute(f, application,'human_questions.respond',{issueId:issue.id,interactionId:q.id,shareWithCompany:true,answers:[{questionId:'offer',optionIds:[],text:'Approved offer'}]});
      expect(result.response.status).toBe(mode==='normal'?200:409);
      const rows = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id,q.id));
      expect(rows[0].status).toBe(mode==='rollback'?'pending':'answered');
      expect((await svc.getBrief(f.company.id)).revision).toBe(mode==='rollback'?0:1);
      expect(order).toEqual(mode==='normal'?['workforce.brief_updated','issue.thread_interaction_answered','continuation']:[]);
      const before = order.slice(); expect((await result.confirm()).status).toBe(409); expect(order).toEqual(before);
    } finally { stop(); }
  });
  it('publishes no-hook replacement after acceptance and never during preparation', async () => {
    const f=await fixture(); await workforceService(db).enroll(f.company.id,f.agent.id,{templateId:'marketing-content'},{userId:f.userId});
    const issue=await workforceService(db).startFirstJob(f.company.id,f.agent.id,{userId:f.userId});
    const svc=issueThreadInteractionService(db); const q=await svc.create(issue,{kind:'ask_user_questions',payload:{version:1,questions:[{id:'offer',prompt:'Offer?',selectionMode:'text',options:[],required:true}]}},{agentId:f.agent.id}); await svc.cancelQuestions(issue,q.id,{}, {userId:f.userId});
    const events: string[]=[]; const stop=subscribeCompanyLiveEvents(f.company.id,e=>{if(e.type==='activity.logged')events.push(e.payload.action as string);});
    try { const result=await execute(f,app('normal'),'human_questions.replace',{issueId:issue.id,interactionId:q.id}); expect(result.response.status).toBe(200); expect(events).toEqual(['issue.thread_interaction_created']); expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId,issue.id))).toHaveLength(2); } finally {stop();}
  });
  it.each(['rollback','normal'] as const)('ownership transfer %s keeps revocations, history and all audit publications together',async mode=>{
    const f=await fixture(); await db.update(agents).set({autonomy:'stewarded',accountableUserId:null}).where(eq(agents.id,f.agent.id));
    const incoming=randomUUID(); await db.insert(companyMemberships).values({companyId:f.company.id,principalType:'user',principalId:incoming,membershipRole:'member',status:'active'});
    await agentStewardshipService(db).assign(f.company.id,{agentId:f.agent.id,userId:f.userId,assignedByUserId:f.userId});
    const [binding]=await db.insert(humanChannelBindings).values({companyId:f.company.id,userId:f.userId,agentId:f.agent.id,provider:'telegram',externalUserId:randomUUID()}).returning();
    const [endpoint]=await db.insert(bridgeEndpoints).values({companyId:f.company.id,userId:f.userId,label:'Test',tokenHash:randomUUID()}).returning();
    const events:string[]=[];const stop=subscribeCompanyLiveEvents(f.company.id,e=>{if(e.type==='activity.logged')events.push(e.payload.action as string);});
    try{
      const {response}=await execute(f,app(mode),'human_questions.stewardship.transfer',{agentId:f.agent.id,userId:incoming,transferReason:'Handoff'});expect(response.status).toBe(mode==='normal'?200:409);
      const channel=(await db.select().from(humanChannelBindings).where(eq(humanChannelBindings.id,binding.id)))[0]; const bridge=(await db.select().from(bridgeEndpoints).where(eq(bridgeEndpoints.id,endpoint.id)))[0];
      expect(Boolean(channel.revokedAt)).toBe(mode==='normal');expect(Boolean(bridge.revokedAt)).toBe(mode==='normal');
      expect(await db.select().from(agentStewardships).where(eq(agentStewardships.companyId,f.company.id))).toHaveLength(mode==='normal'?2:1);
      expect(events).toEqual(mode==='normal'?['human_channel.binding_revoked','bridge.endpoint_revoked','agent.stewardship_transferred']:[]);
    }finally{stop();}
  });
  it.each(['rollback','normal'] as const)('accountability %s keeps both ownership audits and plugin publication with accepted state',async mode=>{
    const f=await fixture(), incoming=randomUUID();await db.insert(companyMemberships).values({companyId:f.company.id,principalType:'user',principalId:incoming,membershipRole:'member',status:'active'});
    const events:string[]=[];const stop=subscribeCompanyLiveEvents(f.company.id,e=>{if(e.type==='activity.logged')events.push(e.payload.action as string);});
    try{const {response}=await execute(f,app(mode),'human_questions.owner.assign',{agentId:f.agent.id,accountableUserId:incoming});expect(response.status).toBe(mode==='normal'?200:409);
      expect((await db.select().from(agents).where(eq(agents.id,f.agent.id)))[0].accountableUserId).toBe(mode==='normal'?incoming:f.userId);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).toHaveLength(mode==='normal'?2:0);
      expect(events).toEqual(mode==='normal'?['agent.updated','agent.accountability_changed']:[]);
      expect(plugins.filter(e=>e.companyId===f.company.id).map(e=>e.eventType)).toEqual(mode==='normal'?['agent.updated']:[]);
    }finally{stop();}
  });
});
