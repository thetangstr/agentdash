import { issueTreeControlService } from '../services/issue-tree-control.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activityLog, agents, heartbeatRuns, companies, createDb, issueComments, issueTreeHolds, issueTreeHoldMembers, issues, projects, type Db } from '@paperclipai/db';
import { issueService } from '../services/issues.js';
import { projectService } from '../services/projects.js';
import { companyService } from '../services/companies.js';
import { publishLiveEvent } from '../services/live-events.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));

describe('exact issue history deletion closure', () => {
  let db: Db, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('tree-history-delete-'); db = createDb(temp.connectionString); });
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); });
  it.each(['issue', 'project', 'company'] as const)('%s privately refuses every incoming foreign history edge before cleanup', async owner => {
    for (const edge of ['root', 'member', 'parent', 'cascading-member-company', 'owning-hold', 'cascading-member-source']) {
      const [local, foreign] = await db.insert(companies).values(['Local', 'Private'].map(name => ({ name, issuePrefix: randomUUID().slice(0, 8) }))).returning();
      const [project] = await db.insert(projects).values({ companyId: local.id, name: 'Target' }).returning();
      const [target, survivor, foreignIssue] = await db.insert(issues).values([{ companyId: local.id, projectId: project.id, title: 'Target' }, { companyId: local.id, title: 'Survivor' }, { companyId: foreign.id, title: 'Private' }]).returning();
      await db.insert(issueComments).values({ companyId: local.id, issueId: target.id, body: 'Must survive' });
      const foreignHold = ['root', 'member', 'parent', 'owning-hold'].includes(edge);
      const [hold] = await db.insert(issueTreeHolds).values({ companyId: foreignHold ? foreign.id : local.id, rootIssueId: ['root', 'cascading-member-company', 'cascading-member-source'].includes(edge) ? target.id : foreignIssue.id, mode: 'pause', createdByActorType: 'system' }).returning();
      await db.insert(issueTreeHoldMembers).values({ companyId: ['root', 'member', 'parent', 'cascading-member-company'].includes(edge) ? foreign.id : local.id, holdId: hold.id, issueId: ['member', 'owning-hold'].includes(edge) ? target.id : edge === 'cascading-member-source' ? foreignIssue.id : survivor.id, parentIssueId: edge === 'parent' ? target.id : null, depth: 0, issueTitle: 'Private snapshot', issueStatus: 'todo' });
      const snapshot = async () => ({ issues: await db.select().from(issues), holds: await db.select().from(issueTreeHolds), members: await db.select().from(issueTreeHoldMembers), comments: await db.select().from(issueComments), audits: await db.select().from(activityLog) });
      const before = await snapshot(); vi.mocked(publishLiveEvent).mockClear();
      const result = owner === 'issue' ? issueService(db).remove(target.id) : owner === 'project' ? projectService(db).remove(project.id, { withIssues: true }) : companyService(db).remove(local.id);
      await expect(result).rejects.toMatchObject({ status: 409, message: 'Issue topology is unavailable for deletion' });
      expect(await snapshot()).toEqual(before); expect(publishLiveEvent).not.toHaveBeenCalled();
    }
  });
  it('preserves valid same-company root cascades and snapshot-parent SET NULL', async () => {
    const [company] = await db.insert(companies).values({ name: 'Valid', issuePrefix: randomUUID().slice(0,8) }).returning();
    const [target, survivor] = await db.insert(issues).values(['Target','Survivor'].map(title => ({ companyId: company.id, title }))).returning();
    const holds = await db.insert(issueTreeHolds).values([target,survivor].map(root => ({ companyId: company.id, rootIssueId: root.id, mode: 'pause', createdByActorType: 'system' }))).returning();
    await db.insert(issueTreeHoldMembers).values(holds.map(hold => ({ companyId: company.id, holdId: hold.id, issueId: survivor.id, parentIssueId: target.id, depth: 1, issueTitle: 'Snapshot', issueStatus: 'todo' })));
    await issueService(db).remove(target.id);
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, holds[0].id))).toEqual([]);
    expect((await db.select().from(issueTreeHoldMembers).where(eq(issueTreeHoldMembers.holdId, holds[1].id)))[0].parentIssueId).toBeNull();
  });
  it.each(['parent','assignee','execution-run','context-run'] as const)('low-level root and supplied hold creation refuse legacy foreign %s references',async kind=>{
    for(const supplied of [false,true]){
      const [local,foreign]=await db.insert(companies).values(['Local','Foreign'].map(name=>({name,issuePrefix:randomUUID().slice(0,8)}))).returning();
      const [root,other]=await db.insert(issues).values([{companyId:local.id,title:'Root'},{companyId:foreign.id,title:'Private'}]).returning();
      const [agent]=await db.insert(agents).values({companyId:kind==='context-run'?local.id:foreign.id,name:'Legacy'}).returning();
      const [run]=await db.insert(heartbeatRuns).values({companyId:kind==='context-run'?local.id:foreign.id,agentId:agent.id,status:'running',contextSnapshot:{issueId:other.id}}).returning();
      await db.update(issues).set(kind==='parent'?{parentId:other.id}:kind==='assignee'?{assigneeAgentId:agent.id}:{executionRunId:run.id}).where(eq(issues.id,root.id));
      const svc=issueTreeControlService(db),input={mode:'pause' as const,actor:{actorType:'system' as const,actorId:'system'}};
      const result=supplied?db.transaction(tx=>svc.createHold(local.id,root.id,input,{executor:tx as unknown as Db,publications:[]})):svc.createHold(local.id,root.id,input);
      await expect(result).rejects.toMatchObject({status:404});
      expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,local.id))).toEqual([]);
    }
  });
  it.each(['agent','run'] as const)('low-level root and supplied restore refuse foreign actor %s references before writes',async kind=>{
    for(const supplied of [false,true]){
      const [local,foreign]=await db.insert(companies).values(['Local','Foreign'].map(name=>({name,issuePrefix:randomUUID().slice(0,8)}))).returning();
      const [root]=await db.insert(issues).values({companyId:local.id,title:'Root',status:'todo'}).returning();
      const [agent]=await db.insert(agents).values({companyId:foreign.id,name:'Foreign actor'}).returning();
      const [run]=await db.insert(heartbeatRuns).values({companyId:foreign.id,agentId:agent.id,status:'running'}).returning();
      const svc=issueTreeControlService(db),actor={actorType:'system' as const,actorId:'system'};
      const cancelled=await svc.createHold(local.id,root.id,{mode:'cancel',actor});
      await svc.cancelIssueStatusesForHold(local.id,root.id,cancelled.hold.id);
      const restore=await svc.createHold(local.id,root.id,{mode:'restore',actor});
      const input={actor:{...actor,...(kind==='agent'?{agentId:agent.id}:{runId:run.id})}};
      let writes=0;
      const observed=(tx:Db)=>new Proxy(tx,{get(target,key,receiver){if(key==='update')return(...args:unknown[])=>{writes++;return (target.update as Function)(...args);};return Reflect.get(target,key,receiver);}});
      const observedRoot=new Proxy(db,{get(target,key,receiver){if(key==='transaction')return(work:(tx:Db)=>Promise<unknown>)=>target.transaction(tx=>work(observed(tx as unknown as Db)));return Reflect.get(target,key,receiver);}});
      const result=supplied?db.transaction(tx=>svc.restoreIssueStatusesForHold(local.id,root.id,restore.hold.id,input,{executor:observed(tx as unknown as Db),publications:[]})):issueTreeControlService(observedRoot).restoreIssueStatusesForHold(local.id,root.id,restore.hold.id,input);
      await expect(result).rejects.toMatchObject({status:404});
      expect(writes).toBe(0);
      expect((await db.select().from(issues).where(eq(issues.id,root.id)))[0].status).toBe('cancelled');
      expect((await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id,restore.hold.id)))[0].status).toBe('active');
    }
  });
  it.each(['root','member'] as const)('selected history with moved foreign %s privately refuses read and release',async moved=>{
    const [local,foreign]=await db.insert(companies).values(['Local','Foreign'].map(name=>({name,issuePrefix:randomUUID().slice(0,8)}))).returning();
    const [root,child]=await db.insert(issues).values([{companyId:local.id,title:'Root'},{companyId:local.id,title:'Child'}]).returning();
    await db.update(issues).set({parentId:root.id}).where(eq(issues.id,child.id));
    const svc=issueTreeControlService(db),held=await svc.createHold(local.id,root.id,{mode:'pause',actor:{actorType:'system',actorId:'system'}});
    await db.update(issues).set({companyId:foreign.id}).where(eq(issues.id,moved==='root'?root.id:child.id));
    await expect(svc.getHold(local.id,held.hold.id)).rejects.toMatchObject({status:404});
    if(moved==='root')await expect(svc.getActivePauseHoldGate(local.id,root.id)).rejects.toMatchObject({status:404});
    await expect(svc.releaseHold(local.id,root.id,held.hold.id,{actor:{actorType:'system',actorId:'system'}})).rejects.toMatchObject({status:404});
    expect((await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id,held.hold.id)))[0].status).toBe('active');
  });

});
