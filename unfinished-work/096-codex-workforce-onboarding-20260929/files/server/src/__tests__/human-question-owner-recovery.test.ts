import { agentService } from '../services/agents.js';
import { agentStewardshipService } from '../services/agent-stewardships.js';
import { boardAuthService } from '../services/board-auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentDashServer } from '../../../packages/mcp-server/src/index.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, companies, companyMemberships, authUsers, boardApiKeys, agents, issueThreadInteractions, activityLog, authSessions, agentApiKeys, humanActionHandles, instanceUserRoles, issues, projects, projectAccess, workforceEnrollments, goals, type Db } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { issueRoutes } from '../routes/issues.js';
import { humanControlRoutes } from '../routes/human-control.js';
import { workforceRoutes } from '../routes/workforce.js';
import { hashBearerToken } from '../services/board-auth.js';
import { accessService } from '../services/access.js';
import { workforceService } from '../services/workforce.js';
import { issueThreadInteractionService } from '../services/issue-thread-interactions.js';
import { workforceIssueInputs } from '../services/workforce-inputs.js';
import type { StorageService } from '../storage/types.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
const effects = vi.hoisted(() => ({ wakeup: vi.fn(async () => null) }));
vi.mock('../services/heartbeat.js', () => ({ heartbeatService: () => effects }));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe('inactive question owner recovery', () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase('question-owner-recovery-'); db = createDb(temporary.connectionString); });
  afterAll(async () => { await temporary?.cleanup(); });
  async function human() {
    const userId = randomUUID(), token = `pcp_board_${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: 'Test human', email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
    const [key] = await db.insert(boardApiKeys).values({ userId, name: 'Test key', keyHash: hashBearerToken(token) }).returning();
    return { userId, token, key };
  }
  async function fixture() {
    const alice = await human(), bob = await human();
    const [company] = await db.insert(companies).values({ name: 'Recovery fixture', issuePrefix: randomUUID().slice(0,8) }).returning();
    const members = await db.insert(companyMemberships).values([alice,bob].map(person => ({ companyId: company.id, principalType: 'user', principalId: person.userId, membershipRole: 'admin', status: 'active' }))).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: 'Worker', adapterType: 'codex_local', autonomy: 'autonomous', accountableUserId: alice.userId }).returning();
    const svc = workforceService(db);
    await svc.enroll(company.id, agent.id, { templateId: 'marketing-content' }, { userId: alice.userId });
    const issue = await svc.startFirstJob(company.id, agent.id, { userId: alice.userId });
    const q = await issueThreadInteractionService(db).create(issue, { kind: 'ask_user_questions', payload: { version: 1, questions: [{ id: 'SECRET_KEYLESS_ID', prompt: 'SECRET_ALICE_PROMPT', required: true, selectionMode: 'text', options: [] }] } }, { agentId: agent.id });
    const aliceMember = members.find(m => m.principalId === alice.userId)!;
    await db.update(companyMemberships).set({ status: 'inactive' }).where(eq(companyMemberships.id, aliceMember.id));
    await db.update(agents).set({ accountableUserId: bob.userId }).where(eq(agents.id, agent.id));
    return { alice, bob, company, agent, issue, q, aliceMember };
  }
  function app(connection = db, afterAuthentication?: express.RequestHandler, authentication: Parameters<typeof actorMiddleware>[1] = { deploymentMode: 'local_trusted' }) {
    const a = express(); a.use(express.json()); a.use(actorMiddleware(db, authentication)); if (afterAuthentication) a.use(afterAuthentication);
    a.use('/api/human-control', humanControlRoutes(connection, { heartbeat: effects }));
    a.use('/human', humanControlRoutes(connection, { heartbeat: effects }));
    a.use('/api', workforceRoutes(connection, { heartbeat: effects }));
    a.use('/api', issueRoutes(connection, {} as StorageService)); a.use(errorHandler); return a;
  }
  async function waitForLock(fragment: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await db.execute(sql`select query from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query like ${`%${fragment}%`}`);
      if (rows.length) return;
      await new Promise(done => setTimeout(done, 10));
    }
    throw new Error(`Expected actual PostgreSQL lock wait: ${fragment}`);
  }
  it('has an immediate enforced parent FK and the exact membership uniqueness needed for absence stabilization', async () => {
    const constraints = await db.execute(sql`select convalidated, condeferrable, condeferred, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='company_memberships'::regclass and contype='f'`);
    expect(constraints).toContainEqual(expect.objectContaining({ convalidated: true, condeferrable: false, condeferred: false, definition: 'FOREIGN KEY (company_id) REFERENCES companies(id)' }));
    const indexes = await db.execute(sql`select indexdef from pg_indexes where tablename='company_memberships'`);
    expect(indexes.some(row => String(row.indexdef).includes('UNIQUE INDEX company_memberships_company_principal_unique_idx') && String(row.indexdef).includes('(company_id, principal_type, principal_id)'))).toBe(true);
  });
  it.each(['inactive','missing'] as const)('blocks real ensureMembership activation when the recovery %s lock wins', async kind => {
    const f = await fixture();
    if (kind === 'missing') await db.delete(companyMemberships).where(eq(companyMemberships.id, f.aliceMember.id));
    const reached = deferred(), release = deferred();
    const hold = db.transaction(async tx => {
      await tx.select().from(companies).where(eq(companies.id, f.company.id)).for('update');
      await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, f.company.id), eq(companyMemberships.principalId, f.alice.userId))).for('share');
      reached.resolve(); await release.promise;
      const members = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, f.company.id), eq(companyMemberships.principalId, f.alice.userId)));
      expect(members.some(m => m.status === 'active')).toBe(false);
    });
    await reached.promise;
    const activation = accessService(db).ensureMembership(f.company.id, 'user', f.alice.userId, 'member', 'active');
    try { await waitForLock(kind === 'missing' ? 'insert into "company_memberships"' : 'update "company_memberships"'); } finally { release.resolve(); }
    await hold; expect((await activation).status).toBe('active');
  });
  it.each(['inactive','missing'] as const)('sees committed native activation when the %s writer wins', async kind => {
    const f = await fixture();
    if (kind === 'missing') await db.delete(companyMemberships).where(eq(companyMemberships.id, f.aliceMember.id));
    const reached = deferred(), release = deferred();
    const activation = db.transaction(async tx => {
      await accessService(tx as unknown as Db).ensureMembership(f.company.id, 'user', f.alice.userId, 'member', 'active');
      reached.resolve(); await release.promise;
    });
    await reached.promise;
    const observe = db.transaction(async tx => {
      await tx.select().from(companies).where(eq(companies.id, f.company.id)).for('update');
      const members = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, f.company.id), eq(companyMemberships.principalId, f.alice.userId))).for('share');
      expect(members[0].status).toBe('active');
    });
    try { await waitForLock(kind === 'missing' ? '"companies"' : '"company_memberships"'); } finally { release.resolve(); }
    await activation; await observe;
  });
  it('recovers a KEYLESS pending question through safe metadata while readiness remains private', async () => {
    const f = await fixture(), a = app(), auth = `Bearer ${f.bob.token}`;
    const base = `/api/issues/${f.issue.id}/question-recovery`;
    expect((await request(a).get(`/api/companies/${f.company.id}/workforce/agents/${f.agent.id}/readiness`).set('Connection', 'close').set('authorization', auth)).status).toBe(404);
    const list = await request(a).get(base).set('Connection', 'close').set('authorization', auth);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([{ issueId: f.issue.id, interactionId: f.q.id, status: 'pending', updatedAt: expect.stringMatching(/\.\d{6}Z$/), reason: 'original_owner_unavailable' }]);
    expect(JSON.stringify(list.body)).not.toContain('SECRET');
    effects.wakeup.mockClear();
    const cancelled = await request(a).post(`${base}/${f.q.id}/cancel`).set('Connection', 'close').set('authorization', auth).send({ expectedUpdatedAt: list.body.items[0].updatedAt });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ issueId: f.issue.id, interactionId: f.q.id, status: 'cancelled', replacementRequired: true });
    expect((await workforceIssueInputs(db, f.company.id, f.agent.id, f.issue.id)).pendingQuestionIds).toContain(f.q.id);
    expect(effects.wakeup).not.toHaveBeenCalled();
    const replacement = await request(a).post(`${base}/${f.q.id}/replace`).set('Connection', 'close').set('authorization', auth).send({});
    expect(replacement.status).toBe(201);
    expect(replacement.body.payload.answerOwnerUserId).toBe(f.bob.userId);
    expect(replacement.body.payload.replacesInteractionId).toBe(f.q.id);
    // Reload/unknown-replacement inspection uses the unchanged native authorized list.
    const visible = await request(a).get(`/api/issues/${f.issue.id}/interactions`).set('Connection', 'close').set('authorization', auth);
    expect(visible.status).toBe(200);
    expect(visible.body.map((value: { id: string }) => value.id)).toEqual([replacement.body.id]);
    const answered = await request(a).post(`/api/issues/${f.issue.id}/interactions/${replacement.body.id}/respond`).set('Connection', 'close').set('authorization', auth).send({ answers: [{ questionId: 'SECRET_KEYLESS_ID', optionIds: [], text: 'A genuine current-owner answer' }] });
    expect(answered.status).toBe(200);
    let sources: import('../services/workforce-inputs.js').WorkforceInputObservation | undefined;
    const inputs = await workforceIssueInputs(db, f.company.id, f.agent.id, f.issue.id, { observeSources(value) { sources = value; } });
    expect(inputs.pendingQuestionIds).toEqual([]);
    expect(sources!.pendingSources.find(value => value.interactionId === f.q.id)?.roles).toEqual(['replacement_target']);
    expect(sources!.pendingSources.find(value => value.interactionId === replacement.body.id)?.roles).toEqual(['sufficient_answer']);
    const readiness = await request(a).get(`/api/companies/${f.company.id}/workforce/agents/${f.agent.id}/readiness`).set('Connection', 'close').set('authorization', auth);
    expect(readiness.status).toBe(200);

    const audits = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
    expect(audits.filter(row => row.action === 'issue.thread_interaction_cancelled')).toHaveLength(1);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.q.id)))[0].status).toBe('cancelled');
  });  async function metadata(f: Awaited<ReturnType<typeof fixture>>) {
    const result = await request(app()).get(`/api/issues/${f.issue.id}/question-recovery`).set('Connection', 'close').set('authorization', `Bearer ${f.bob.token}`);
    expect(result.status).toBe(200); return result.body.items[0];
  }
  async function cancel(f: Awaited<ReturnType<typeof fixture>>, updatedAt: string, application = app()) {
    return request(application).post(`/api/issues/${f.issue.id}/question-recovery/${f.q.id}/cancel`).set('Connection', 'close').set('authorization', `Bearer ${f.bob.token}`).send({ expectedUpdatedAt: updatedAt });
  }
  async function noCancellation(f: Awaited<ReturnType<typeof fixture>>) {
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.q.id)))[0].status).toBe('pending');
    expect((await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).filter(row => row.action === 'issue.thread_interaction_cancelled')).toEqual([]);
  }
  it.each(['active old member', 'absent old profile', 'missing pinned owner', 'unrelated human', 'instance admin', 'worker', 'unnamed local'] as const)('does not grant metadata or cancellation for %s', async scenario => {
    const f = await fixture(); let token = f.bob.token;
    if (scenario === 'active old member' || scenario === 'absent old profile') {
      await accessService(db).ensureMembership(f.company.id, 'user', f.alice.userId);
      if (scenario === 'absent old profile') await db.delete(authUsers).where(eq(authUsers.id, f.alice.userId));
    }
    if (scenario === 'missing pinned owner') { const payload = { ...f.q.payload }; delete (payload as any).answerOwnerUserId; await db.update(issueThreadInteractions).set({ payload }).where(eq(issueThreadInteractions.id, f.q.id)); }
    if (scenario === 'unrelated human' || scenario === 'instance admin') {
      const stranger = await human(); token = stranger.token;
      await accessService(db).ensureMembership(f.company.id, 'user', stranger.userId);
      if (scenario === 'instance admin') await db.insert(instanceUserRoles).values({ userId:stranger.userId, role:'instance_admin' });
    }
    if (scenario === 'worker') { token = `pcp_${randomUUID()}`; await db.insert(agentApiKeys).values({ companyId:f.company.id,agentId:f.agent.id,name:'Worker',keyHash:hashBearerToken(token) }); }
    if (scenario === 'unnamed local') token = '';
    const a = app(), auth = `Bearer ${token}`;
    const list = await request(a).get(`/api/issues/${f.issue.id}/question-recovery`).set('Connection', 'close').set('authorization', auth);
    if (['worker','unnamed local'].includes(scenario)) expect(list.status).toBeGreaterThanOrEqual(400);
    else { expect(list.status).toBe(200); expect(list.body.items).toEqual([]); }
    const mutation = await request(a).post(`/api/issues/${f.issue.id}/question-recovery/${f.q.id}/cancel`).set('Connection', 'close').set('authorization',auth).send({expectedUpdatedAt:new Date(f.q.updatedAt).toISOString()});
    expect(mutation.status).toBeGreaterThanOrEqual(400); expect(JSON.stringify([list.body,mutation.body])).not.toContain('SECRET'); await noCancellation(f);
  });
  it.each(['session','local'] as const)('uses actual named native %s identity without issuing a board key', async source => {
    const f = await fixture();
    if (source === 'local') {
      await db.insert(authUsers).values({id:'local-board',name:'Local',email:'recovery-local@test.invalid',createdAt:new Date(),updatedAt:new Date()}).onConflictDoNothing();
      await accessService(db).ensureMembership(f.company.id,'user','local-board');
      await db.update(agents).set({accountableUserId:'local-board'}).where(eq(agents.id,f.agent.id));
    }
    const token = randomUUID(), sessionId = randomUUID();
    if (source === 'session') await db.insert(authSessions).values({id:sessionId,userId:f.bob.userId,token,expiresAt:new Date(Date.now()+60000),createdAt:new Date(),updatedAt:new Date()});
    const application = app(db,undefined,source === 'session' ? {deploymentMode:'authenticated',resolveSession:async()=>({user:{id:f.bob.userId,name:'Bob',email:`${f.bob.userId}@test.invalid`},session:{id:sessionId,userId:f.bob.userId}})} : {deploymentMode:'local_trusted'});
    const list = await request(application).get(`/api/issues/${f.issue.id}/question-recovery`);
    expect(list.status,JSON.stringify(list.body)).toBe(200); expect(list.body.items).toHaveLength(1);
    const result = await request(application).post(`/api/issues/${f.issue.id}/question-recovery/${f.q.id}/cancel`).send({expectedUpdatedAt:list.body.items[0].updatedAt});
    expect(result.status).toBe(200);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id,f.q.id)))[0].resolvedByUserId).toBe(source === 'local' ? 'local-board' : f.bob.userId);
  });
  it('uses subsequent issue binding and exact timestamp CAS, without enrollment goal/first-job visibility', async () => {
    const f = await fixture();
    const [later] = await db.insert(issues).values({companyId:f.company.id,title:'Subsequent workforce work',assigneeAgentId:f.agent.id}).returning();
    await db.update(issueThreadInteractions).set({issueId:later.id}).where(eq(issueThreadInteractions.id,f.q.id));
    await db.execute(sql`update ${issueThreadInteractions} set updated_at='2026-09-29T01:02:03.123456Z' where id=${f.q.id}`);
    f.issue = later as typeof f.issue;
    const [foreign] = await db.insert(companies).values({name:'Unrelated',issuePrefix:randomUUID().slice(0,8)}).returning();
    const [foreignJob] = await db.insert(issues).values({companyId:foreign.id,title:'Private unrelated first job'}).returning();
    const [foreignGoal] = await db.insert(goals).values({companyId:foreign.id,title:'Private unrelated goal'}).returning();
    await db.update(workforceEnrollments).set({firstJobIssueId:foreignJob.id,goalId:foreignGoal.id}).where(eq(workforceEnrollments.agentId,f.agent.id));
    const row = await metadata(f); expect(row.updatedAt).toBe('2026-09-29T01:02:03.123456Z');
    expect((await cancel(f,'2026-09-29T01:02:03.123Z')).status).toBe(409); await noCancellation(f);
    expect((await cancel(f,row.updatedAt)).status).toBe(200);
  });
  it('paginates only fully authorized metadata and rejects a private or mismatched cursor', async () => {
    const f = await fixture();
    // Independent pending questions pinned to the now unavailable original owner.
    for (let index=0;index<3;index++) await db.insert(issueThreadInteractions).values({companyId:f.company.id,issueId:f.issue.id,kind:'ask_user_questions',status:'pending',payload:f.q.payload});
    const auth = `Bearer ${f.bob.token}`, route = `/api/issues/${f.issue.id}/question-recovery`;
    const first = await request(app()).get(`${route}?limit=2`).set('Connection', 'close').set('authorization',auth);
    expect(first.body.items).toHaveLength(2); expect(first.body.nextCursor).toBe(first.body.items[1].interactionId);
    const second = await request(app()).get(`${route}?limit=2&cursor=${first.body.nextCursor}`).set('Connection', 'close').set('authorization',auth);
    expect(second.body.items).toHaveLength(2); expect(second.body.nextCursor).toBeNull();
    expect(new Set([...first.body.items,...second.body.items].map((q:any)=>q.interactionId)).size).toBe(4);
    expect((await request(app()).get(`${route}?cursor=${randomUUID()}`).set('Connection', 'close').set('authorization',auth)).status).toBe(400);
    expect((await request(app()).get(`${route}?cursor=${first.body.nextCursor}&interactionId=${f.q.id}`).set('Connection', 'close').set('authorization',auth)).status).toBe(400);
    expect((await request(app()).get(`${route}?limit=51`).set('Connection', 'close').set('authorization',auth)).status).toBe(400);
    expect(JSON.stringify([first.body,second.body])).not.toContain('SECRET');
  });
  it('uses six actual registered MCP tools over real HTTP for metadata, one confirmed cancellation, replacement and genuine answer', async () => {
    const f = await fixture(), target = {kind:'company',companyId:f.company.id};
    const http = app().listen(0,'127.0.0.1'); await new Promise<void>(done=>http.once('listening',done));
    const mcp = createAgentDashServer({apiUrl:`http://127.0.0.1:${(http.address() as {port:number}).port}/api`,apiKey:f.bob.token,companyId:null,agentId:null,runId:null},{toolset:'human'});
    const client = new Client({name:'owner-recovery',version:'1'}), [a,b] = InMemoryTransport.createLinkedPair(); await mcp.connect(a); await client.connect(b);
    async function invoke(name:string,args:Record<string,unknown>) {const response=await client.callTool({name,arguments:args});return {error:response.isError,body:JSON.parse((response.content as {text:string}[])[0].text)};}
    try {
      expect((await client.listTools()).tools.map(t=>t.name)).toEqual(['human_identity','human_select_target','human_discover','human_read','human_prepare','human_confirm']);
      expect((await invoke('human_select_target',{target})).error).not.toBe(true);
      const discovery = await invoke('human_discover',{target}); expect(discovery.body.operations).toHaveLength(22);
      const listed = await invoke('human_read',{target,operationId:'human_questions.recovery.list',version:1,input:{issueId:f.issue.id}});
      const prepared = await invoke('human_prepare',{target,operationId:'human_questions.recovery.cancel',version:1,input:{issueId:f.issue.id,interactionId:f.q.id,expectedUpdatedAt:listed.body.items[0].updatedAt}});
      expect(prepared.error,JSON.stringify(prepared.body)).not.toBe(true); expect(JSON.stringify(prepared.body)).not.toContain('SECRET'); await noCancellation(f);
      const confirmed = await invoke('human_confirm',{target,handle:prepared.body.handle}); expect(confirmed.error,JSON.stringify(confirmed.body)).not.toBe(true);
      expect(confirmed.body.result).toEqual({issueId:f.issue.id,interactionId:f.q.id,status:'cancelled',replacementRequired:true});
      await accessService(db).ensureMembership(f.company.id,'user',f.alice.userId);
      const terminal = await invoke('human_confirm',{target,handle:prepared.body.handle}); expect(terminal.error).toBe(true); expect(terminal.body.status).toBe('completed');
      expect(JSON.stringify(terminal.body)).not.toContain('SECRET');
      const inspected = await invoke('human_read',{target,operationId:'human_questions.recovery.list',version:1,input:{issueId:f.issue.id,interactionId:f.q.id}}); expect(inspected.body.items[0]).toEqual(confirmed.body.result);
      const replacement = await invoke('human_prepare',{target,operationId:'human_questions.replace',version:1,input:{issueId:f.issue.id,interactionId:f.q.id}}); expect(replacement.error).not.toBe(true);
      const created = await invoke('human_confirm',{target,handle:replacement.body.handle}); expect(created.error,JSON.stringify(created.body)).not.toBe(true); expect(created.body.result.payload.answerOwnerUserId).toBe(f.bob.userId);
      const answer = await invoke('human_prepare',{target,operationId:'human_questions.respond',version:1,input:{issueId:f.issue.id,interactionId:created.body.result.interactionId,answers:[{questionId:'SECRET_KEYLESS_ID',optionIds:[],text:'Genuine Bob input'}]}}); expect(answer.error).not.toBe(true);
      expect((await invoke('human_confirm',{target,handle:answer.body.handle})).error).not.toBe(true);
      const readiness = await invoke('human_read',{target,operationId:'workforce.readiness.read',version:1,input:{agentId:f.agent.id}}); expect(readiness.error).not.toBe(true); expect(readiness.body.pendingQuestionIds).toEqual([]);
      const audits = await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id)); expect(audits.filter(row=>row.action==='issue.thread_interaction_cancelled')).toHaveLength(1);
    } finally {await client.close();await mcp.close();await new Promise<void>(done=>http.close(()=>done()));}
  });
  it.each(['old owner activated','current owner changed','project revoked'] as const)('refuses stale bridge preparation when %s',async scenario=>{
    const f=await fixture(),row=await metadata(f),target={kind:'company',companyId:f.company.id};
    const prepared=await request(app()).post('/human/prepare').set('Connection', 'close').set('authorization',`Bearer ${f.bob.token}`).send({target,operationId:'human_questions.recovery.cancel',version:1,input:{issueId:f.issue.id,interactionId:f.q.id,expectedUpdatedAt:row.updatedAt}});
    expect(prepared.status).toBe(200);
    if(scenario==='old owner activated') await accessService(db).ensureMembership(f.company.id,'user',f.alice.userId);
    if(scenario==='current owner changed') await db.update(agents).set({accountableUserId:f.alice.userId}).where(eq(agents.id,f.agent.id));
    if(scenario==='project revoked') {await db.update(companyMemberships).set({membershipRole:'member'}).where(eq(companyMemberships.companyId,f.company.id));const[p]=await db.insert(projects).values({companyId:f.company.id,name:'Private',visibility:'restricted',createdByUserId:'someone-else'}).returning();await db.update(issues).set({projectId:p.id}).where(eq(issues.id,f.issue.id));}
    const confirmed=await request(app()).post('/human/confirm').set('Connection', 'close').set('authorization',`Bearer ${f.bob.token}`).send({target,handle:prepared.body.handle}); expect(confirmed.status).toBeGreaterThanOrEqual(400); expect(JSON.stringify(confirmed.body)).not.toContain('SECRET');await noCancellation(f);
  });
  type Trace = { sql:string; params:unknown[]; transaction:number };
  function traced(events:Trace[], hook?: (entry:Trace)=>Promise<void>, afterCommit?:()=>Promise<void>) {
    const dialect=new PgDialect();let count=0;
    return new Proxy(db,{get(target,key,receiver){if(key!=='transaction')return Reflect.get(target,key,receiver);return async(callback:(connection:Db)=>Promise<unknown>)=>{
      const transaction=++count;let questionWritten=false;
      const value=await target.transaction(tx=>callback(new Proxy(tx,{get(inner,prop,receiver){
        const value=Reflect.get(inner,prop,receiver);
        if(prop==='execute')return async(query:SQL)=>{const rows=await inner.execute(query), entry={transaction,...dialect.sqlToQuery(query)};events.push(entry);await hook?.(entry);return rows;};
        if(prop==='select')return(fields?:Record<string,unknown>)=>{const query=(inner.select as Function)(fields),from=query.from.bind(query);query.from=(table:unknown)=>{const builder=from(table),then=builder.then.bind(builder);builder.then=(resolve:Function,reject:Function)=>then(async(rows:unknown)=>{const entry={transaction,...builder.toSQL()};events.push(entry);await hook?.(entry);return rows;}).then(resolve,reject);return builder;};return query;};
        if(prop==='update'||prop==='insert')return(table:unknown)=>{if(table===issueThreadInteractions){questionWritten=true;events.push({transaction,sql:'question write',params:[]});}return value.call(inner,table);};
        return typeof value==='function'?value.bind(inner):value;
      }}) as unknown as Db));
      if(questionWritten)await afterCommit?.();return value;
    };}});
  }
  it.each(['inactive update','missing insert','delete reinsert'] as const)('native cancellation wins before %s and source locks share its actual executor',async kind=>{
    const f=await fixture();if(kind==='missing insert')await db.delete(companyMemberships).where(eq(companyMemberships.id,f.aliceMember.id));
    const row=await metadata(f),reached=deferred(),release=deferred(),events:Trace[]=[];let paused=false;
    const connection=traced(events,async entry=>{if(!paused&&entry.sql.includes('"issue_thread_interactions"')&&entry.sql.endsWith('for share')){paused=true;reached.resolve();await release.promise;}});
    const response=cancel(f,row.updatedAt,app(connection));
    const running=response.then(value=>value);await reached.promise;
    const writer=kind==='delete reinsert'?db.transaction(async tx=>{await tx.delete(companyMemberships).where(eq(companyMemberships.id,f.aliceMember.id));await accessService(tx as unknown as Db).ensureMembership(f.company.id,'user',f.alice.userId);}):accessService(db).ensureMembership(f.company.id,'user',f.alice.userId);
    try{await waitForLock('company_memberships');}finally{release.resolve();}
    expect((await running).status).toBe(200);await writer;
    const mutation=events.find(entry=>entry.sql==='question write')!;expect(mutation).toBeDefined();
    const sequence=events.filter(entry=>entry.transaction===mutation.transaction),company=sequence.findIndex(entry=>entry.sql.includes('"companies"')&&entry.sql.endsWith('for update'));
    const member=sequence.findIndex(entry=>entry.sql.includes('"company_memberships"')&&entry.sql.endsWith('for share')&&entry.params.includes(f.aliceMember.id));
    expect(company).toBe(0);if(kind!=='missing insert')expect(member).toBeGreaterThan(company);
    expect(sequence.filter(entry=>entry.sql.endsWith('for share')).length).toBeGreaterThan(4);
    const lastPredicate=sequence.findLastIndex(entry=>entry.sql.includes('::timestamptz'));expect(lastPredicate).toBeLessThan(sequence.findIndex(entry=>entry.sql==='question write'));expect(lastPredicate).toBeGreaterThan(member);
    const inspection=await request(app()).get(`/api/issues/${f.issue.id}/question-recovery?interactionId=${f.q.id}`).set('Connection', 'close').set('authorization',`Bearer ${f.bob.token}`);expect(inspection.body.items[0].status).toBe('cancelled');
  });
  it.each(['inactive update','missing insert','delete reinsert'] as const)('refuses with no effects when native %s commits before source acceptance',async kind=>{
    const f=await fixture();if(kind==='missing insert')await db.delete(companyMemberships).where(eq(companyMemberships.id,f.aliceMember.id));
    const row=await metadata(f),reached=deferred(),release=deferred();
    const writer=Promise.allSettled([db.transaction(async tx=>{if(kind==='delete reinsert')await tx.delete(companyMemberships).where(eq(companyMemberships.id,f.aliceMember.id));await accessService(tx as unknown as Db).ensureMembership(f.company.id,'user',f.alice.userId);reached.resolve();await release.promise;})]);
    await reached.promise;
    const running=cancel(f,row.updatedAt).then(value=>value);
    try{await waitForLock(kind==='inactive update'?'company_memberships':'companies');}finally{release.resolve();}
    expect((await writer)[0]).toMatchObject({status:'fulfilled'});expect((await running).status).toBe(404);await noCancellation(f);
  });
  it.each(['accountability','stewardship','project','credential'] as const)('refuses %s changed while actual source acceptance waits',async kind=>{
    const f=await fixture(),other=await human();await accessService(db).ensureMembership(f.company.id,'user',other.userId);
    if(kind==='stewardship'){await agentService(db).update(f.agent.id,{autonomy:'stewarded'});await agentStewardshipService(db).assign(f.company.id,{agentId:f.agent.id,userId:f.bob.userId,assignedByUserId:f.bob.userId});}
    let projectId:string|undefined;
    if(kind==='project'){await db.update(companyMemberships).set({membershipRole:'member'}).where(eq(companyMemberships.companyId,f.company.id));const[p]=await db.insert(projects).values({companyId:f.company.id,name:'Restricted',visibility:'restricted',createdByUserId:'other'}).returning();projectId=p.id;await db.update(issues).set({projectId:p.id}).where(eq(issues.id,f.issue.id));await db.insert(projectAccess).values({projectId:p.id,principalType:'user',principalId:f.bob.userId,grantedByUserId:'other'});}
    const row=await metadata(f),reached=deferred(),release=deferred();let writer:Promise<PromiseSettledResult<unknown>[]>|undefined;
    // Start after middleware has authenticated and updated lastUsedAt. Its wait is not our proof.
    const application=app(db,async(_req,_res,next)=>{writer=Promise.allSettled([db.transaction(async tx=>{
      const executor=tx as unknown as Db;
      if(kind==='accountability')await agentService(executor).update(f.agent.id,{accountableUserId:other.userId});
      if(kind==='stewardship')await agentStewardshipService(executor).transfer(f.company.id,f.agent.id,{userId:other.userId,transferredByUserId:f.bob.userId},{executor,publications:[]});
      if(kind==='project')await tx.delete(projectAccess).where(eq(projectAccess.projectId,projectId!));
      if(kind==='credential')await boardAuthService(executor).revokeBoardApiKey(f.bob.key.id);
      reached.resolve();await release.promise;
    })]);await reached.promise;next();});
    const running=cancel(f,row.updatedAt,application).then(value=>value);await reached.promise;
    try{await waitForLock(kind==='credential'?'board_api_keys':kind==='project'?'project_access':kind==='stewardship'?'companies':'agents');}finally{release.resolve();}
    expect((await writer)![0]).toMatchObject({status:'fulfilled'});expect((await running).status).toBeGreaterThanOrEqual(400);await noCancellation(f);
  });
  it('checks the original credential deadline after the final actual timestamp SELECT immediately before native cancellation write',async()=>{
    const f=await fixture(),row=await metadata(f),expiry=new Date(Date.now()+1000),events:Trace[]=[];await db.update(boardApiKeys).set({expiresAt:expiry}).where(eq(boardApiKeys.id,f.bob.key.id));let observed=false;
    const connection=traced(events,async entry=>{if(entry.sql.includes('::timestamptz')){observed=true;await new Promise(done=>setTimeout(done,Math.max(0,expiry.getTime()-Date.now()+10)));}});
    expect((await cancel(f,row.updatedAt,app(connection))).status).toBe(401);expect(observed).toBe(true);expect(events.some(entry=>entry.sql==='question write')).toBe(false);await noCancellation(f);
  });
  it.each(['native','foundation'] as const)('keeps committed %s cancellation unknown after lost transaction acknowledgement, with safe current inspection and no replay',async transport=>{
    const f=await fixture(),row=await metadata(f),target={kind:'company',companyId:f.company.id},events:Trace[]=[];
    const connection=traced(events,undefined,async()=>{throw new Error('lost cancellation acknowledgement');});
    const prepared=transport==='foundation'?await request(app()).post('/human/prepare').set('Connection', 'close').set('authorization',`Bearer ${f.bob.token}`).send({target,operationId:'human_questions.recovery.cancel',version:1,input:{issueId:f.issue.id,interactionId:f.q.id,expectedUpdatedAt:row.updatedAt}}):null;
    const result=prepared?await request(app(connection)).post('/human/confirm').set('Connection', 'close').set('authorization',`Bearer ${f.bob.token}`).send({target,handle:prepared.body.handle}):await cancel(f,row.updatedAt,app(connection));
    expect(result.status,JSON.stringify(result.body)).toBe(409);expect(JSON.stringify(result.body)).not.toContain('SECRET');
    if(prepared){expect(result.body.details.status).toBe('recovery_required');const replay=await request(app()).post('/human/confirm').set('Connection', 'close').set('authorization',`Bearer ${f.bob.token}`).send({target,handle:prepared.body.handle});expect(replay.status).toBe(409);}
    else expect(result.body.details.persistenceOutcome).toBe('unknown');
    const inspect=await request(app()).get(`/api/issues/${f.issue.id}/question-recovery?interactionId=${f.q.id}`).set('Connection', 'close').set('authorization',`Bearer ${f.bob.token}`);expect(inspect.body.items[0]).toEqual({issueId:f.issue.id,interactionId:f.q.id,status:'cancelled',replacementRequired:true});
    expect(events.filter(entry=>entry.sql==='question write')).toHaveLength(1);expect((await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).filter(row=>row.action==='issue.thread_interaction_cancelled')).toHaveLength(1);
  });
  it('keeps a known cancellation applied when current metadata authority disappears before output, exposing action state only',async()=>{
    const f=await fixture(),row=await metadata(f),target={kind:'company',companyId:f.company.id},other=await human();await accessService(db).ensureMembership(f.company.id,'user',other.userId);
    const prepared=await request(app()).post('/human/prepare').set('Connection', 'close').set('authorization',`Bearer ${f.bob.token}`).send({target,operationId:'human_questions.recovery.cancel',version:1,input:{issueId:f.issue.id,interactionId:f.q.id,expectedUpdatedAt:row.updatedAt}});expect(prepared.status).toBe(200);
    const connection=traced([],undefined,async()=>{await agentService(db).update(f.agent.id,{accountableUserId:other.userId});});
    const result=await request(app(connection)).post('/human/confirm').set('Connection', 'close').set('authorization',`Bearer ${f.bob.token}`).send({target,handle:prepared.body.handle});expect(result.status).toBe(409);expect(result.body.details).not.toHaveProperty('result');expect(JSON.stringify(result.body)).not.toContain('SECRET');
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id,f.q.id)))[0].status).toBe('cancelled');
    const repeated=await request(app()).post('/human/confirm').set('Connection', 'close').set('authorization',`Bearer ${f.bob.token}`).send({target,handle:prepared.body.handle});expect(repeated.status).toBe(409);expect(repeated.body.details).not.toHaveProperty('result');
  });

  it.each(['unenrolled','unassigned'] as const)('retains Branch B for a later %s issue, using the same prior workforce owner selection', async kind => {
    const f = await fixture();
    const [next] = await db.insert(agents).values({companyId:f.company.id,name:'Unenrolled reassignment',adapterType:'codex_local'}).returning();
    await db.update(issues).set({assigneeAgentId:kind==='unassigned'?null:next.id}).where(eq(issues.id,f.issue.id));
    const row = await metadata(f); expect((await cancel(f,row.updatedAt)).status).toBe(200);
    const replacement=await request(app()).post(`/api/issues/${f.issue.id}/question-recovery/${f.q.id}/replace`).set('Connection','close').set('authorization',`Bearer ${f.bob.token}`).send({});
    expect(replacement.status).toBe(201);expect(replacement.body.payload).toMatchObject({answerOwnerUserId:f.bob.userId,workforceAgentId:f.agent.id});
  });
  it('lets a restored former owner inspect a cancelled receipt only after becoming current canonical owner again', async () => {
    const f=await fixture(),row=await metadata(f);expect((await cancel(f,row.updatedAt)).status).toBe(200);
    await accessService(db).ensureMembership(f.company.id,'user',f.alice.userId);
    await agentService(db).update(f.agent.id,{accountableUserId:f.alice.userId});
    const result=await request(app()).get(`/api/issues/${f.issue.id}/question-recovery?interactionId=${f.q.id}`).set('Connection','close').set('authorization',`Bearer ${f.alice.token}`);
    expect(result.status).toBe(200);expect(result.body.items).toEqual([{issueId:f.issue.id,interactionId:f.q.id,status:'cancelled',replacementRequired:true}]);
  });
  it('refuses the ID-only replacement adapter for ordinary ownerless cards', async () => {
    const f=await fixture();const[job]=await db.insert(issues).values({companyId:f.company.id,title:'Ordinary job'}).returning();
    const svc=issueThreadInteractionService(db),q=await svc.create(job,{kind:'ask_user_questions',payload:{version:1,questions:[{id:'ordinary',prompt:'Ordinary?',selectionMode:'text',options:[],required:true}]}},{userId:f.bob.userId});
    await svc.cancelQuestions(job,q.id,{}, {userId:f.bob.userId});
    const count=(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId,job.id))).length;
    const result=await request(app()).post(`/api/issues/${job.id}/question-recovery/${q.id}/replace`).set('Connection','close').set('authorization',`Bearer ${f.bob.token}`).send({});
    expect(result.status).toBe(403);expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId,job.id))).toHaveLength(count);
  });
  it.each(['accountability','stewardship','project','credential'] as const)('commits cancellation before a later %s writer without retaining private output authority',async kind=>{
    const f=await fixture(),other=await human();await accessService(db).ensureMembership(f.company.id,'user',other.userId);
    if(kind==='stewardship'){await agentService(db).update(f.agent.id,{autonomy:'stewarded'});await agentStewardshipService(db).assign(f.company.id,{agentId:f.agent.id,userId:f.bob.userId,assignedByUserId:f.bob.userId});}
    let projectId:string|undefined;
    if(kind==='project'){await db.update(companyMemberships).set({membershipRole:'member'}).where(eq(companyMemberships.companyId,f.company.id));const[p]=await db.insert(projects).values({companyId:f.company.id,name:'Restricted',visibility:'restricted',createdByUserId:'other'}).returning();projectId=p.id;await db.update(issues).set({projectId:p.id}).where(eq(issues.id,f.issue.id));await db.insert(projectAccess).values({projectId:p.id,principalType:'user',principalId:f.bob.userId,grantedByUserId:'other'});}
    const row=await metadata(f),reached=deferred(),release=deferred();let paused=false;
    const connection=traced([],async entry=>{if(!paused&&entry.sql.includes('"issue_thread_interactions"')&&entry.sql.endsWith('for share')){paused=true;reached.resolve();await release.promise;}});
    const running=cancel(f,row.updatedAt,app(connection)).then(value=>value);await reached.promise;
    const writer=Promise.allSettled([kind==='accountability'?agentService(db).update(f.agent.id,{accountableUserId:other.userId}):kind==='stewardship'?agentStewardshipService(db).transfer(f.company.id,f.agent.id,{userId:other.userId,transferredByUserId:f.bob.userId}):kind==='credential'?boardAuthService(db).revokeBoardApiKey(f.bob.key.id):db.delete(projectAccess).where(eq(projectAccess.projectId,projectId!)).then(value=>value)]);
    try{await waitForLock(kind==='credential'?'board_api_keys':kind==='project'?'project_access':kind==='stewardship'?'companies':'agents');}finally{release.resolve();}
    const result=await running;const [outcome]=await writer;expect(outcome, JSON.stringify(outcome)).toMatchObject({status:'fulfilled'});expect([200,401,403,404,409]).toContain(result.status);expect(JSON.stringify(result.body)).not.toContain('SECRET');
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id,f.q.id)))[0].status).toBe('cancelled');
    expect((await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).filter(row=>row.action==='issue.thread_interaction_cancelled')).toHaveLength(1);
    const inspect=await request(app()).get(`/api/issues/${f.issue.id}/question-recovery?interactionId=${f.q.id}`).set('Connection','close').set('authorization',`Bearer ${f.bob.token}`);expect(inspect.status).toBeGreaterThanOrEqual(400);expect(JSON.stringify(inspect.body)).not.toContain('SECRET');
  });
  it('seals the prepared owner source identities even if a changed membership remains unavailable',async()=>{
    const f=await fixture(),row=await metadata(f),target={kind:'company',companyId:f.company.id};
    const prepare=await request(app()).post('/human/prepare').set('Connection','close').set('authorization',`Bearer ${f.bob.token}`).send({target,operationId:'human_questions.recovery.cancel',version:1,input:{issueId:f.issue.id,interactionId:f.q.id,expectedUpdatedAt:row.updatedAt}});expect(prepare.status).toBe(200);
    await db.update(companyMemberships).set({status:'suspended'}).where(eq(companyMemberships.id,f.aliceMember.id));
    const confirmed=await request(app()).post('/human/confirm').set('Connection','close').set('authorization',`Bearer ${f.bob.token}`).send({target,handle:prepare.body.handle});expect(confirmed.status).toBe(409);await noCancellation(f);
  });

  it('refuses unavailable current template binding even when prior enrollment identifiers match',async()=>{
    const f=await fixture();
    await db.update(workforceEnrollments).set({templateId:'unavailable-template'}).where(eq(workforceEnrollments.agentId,f.agent.id));
    await db.update(issueThreadInteractions).set({payload:{...f.q.payload,workforceTemplateId:'unavailable-template'}}).where(eq(issueThreadInteractions.id,f.q.id));
    const result=await request(app()).get(`/api/issues/${f.issue.id}/question-recovery?interactionId=${f.q.id}`).set('Connection','close').set('authorization',`Bearer ${f.bob.token}`);
    expect(result.status).toBe(404);await noCancellation(f);
  });

  it('does not serialize malformed private persisted values through recovery errors',async()=>{
    const f=await fixture();const payload=JSON.parse(JSON.stringify(f.q.payload));payload.questions[0].selectionMode='SECRET_PRIVATE_INVALID';await db.update(issueThreadInteractions).set({payload}).where(eq(issueThreadInteractions.id,f.q.id));
    const targeted=await request(app()).get(`/api/issues/${f.issue.id}/question-recovery?interactionId=${f.q.id}`).set('Connection','close').set('authorization',`Bearer ${f.bob.token}`);
    expect(JSON.stringify(targeted.body)).not.toContain('SECRET_PRIVATE_INVALID');expect(targeted.status).toBe(404);
  });

});
