import { companyLockQuery, observeExpectedWaiter } from './helpers/observed-lock-wait.js';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Request } from 'express';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activityLog, agents, companies, createDb, heartbeatRuns, agentWakeupRequests, issueComments, issueTreeHolds, issues, type Db } from '@paperclipai/db';
import { actorMiddleware } from '../middleware/auth.js';
import { issueTreeCurrentAuthority } from '../services/issue-current-authority.js';
import { issueTreeControlService } from '../services/issue-tree-control.js';
import { heartbeatService } from '../services/heartbeat.js';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
vi.mock('../services/live-events.js', () => ({ publishLiveEvent: vi.fn() }));
vi.mock('../telemetry.js', () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

function gate(){let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve;});return {promise,open};}
describe('final heartbeat pause admission on actual PostgreSQL',()=>{
  let db:Db,temp:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,server:Server,base:string,actual:Request;
  beforeAll(async()=>{
    temp=await startEmbeddedPostgresTestDatabase('tree-pause-admission-');db=createDb(temp.connectionString);
    const app=express();app.use(actorMiddleware(db,{deploymentMode:'local_trusted'}));app.get('/principal',(req,res)=>{actual=req;res.json({ok:true});});
    server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  });
  afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await db?.$client.end({timeout:0});await temp?.cleanup();});
  async function fixture(interaction:boolean,queued:boolean){
    const [company]=await db.insert(companies).values({name:'Pause admission',issuePrefix:randomUUID().slice(0,8)}).returning();
    const [agent]=await db.insert(agents).values({companyId:company.id,name:'No provider',status:'idle',adapterType:'process',runtimeConfig:{heartbeat:{wakeOnDemand:true,maxConcurrentRuns:1}}}).returning();
    const [issue]=await db.insert(issues).values({companyId:company.id,title:'Admitted issue',status:'todo',assigneeAgentId:agent.id}).returning();
    const comment=interaction?(await db.insert(issueComments).values({companyId:company.id,issueId:issue.id,authorUserId:'local-board',body:'Please answer'}).returning())[0]:null;
    const context=interaction?{issueId:issue.id,wakeReason:'issue_commented',source:'issue.comment',wakeCommentId:comment!.id}:{issueId:issue.id,wakeReason:'issue_assigned',source:'issue.assigned'};
    const request=queued?(await db.insert(agentWakeupRequests).values({companyId:company.id,agentId:agent.id,source:'assignment',reason:context.wakeReason,status:'queued',requestedByActorType:'user',requestedByActorId:'local-board',payload:{issueId:issue.id,...(comment?{commentId:comment.id}:{})}}).returning())[0]:null;
    const run=queued?(await db.insert(heartbeatRuns).values({companyId:company.id,agentId:agent.id,status:'queued',invocationSource:'assignment',wakeupRequestId:request!.id,contextSnapshot:context}).returning())[0]:null;
    if(run)await db.update(agentWakeupRequests).set({runId:run.id}).where(eq(agentWakeupRequests.id,request!.id));
    await fetch(`${base}/principal`);
    const treeContext={companyId:company.id,rootIssueId:issue.id,actor:{actorType:'user' as const,actorId:'local-board',userId:'local-board'},authority:issueTreeCurrentAuthority(actual)};
    return {company,agent,issue,context,request,run,comment,treeContext};
  }
  async function waitFor(ownerPid: number, label: string, contender: Promise<unknown>) {
    const row = await observeExpectedWaiter({
      sample: () => db.execute(sql`select pid, query, pg_blocking_pids(pid) blockers from pg_stat_activity where ${ownerPid} = any(pg_blocking_pids(pid))`),
      ownerPid, label, contender, timeoutMs: 4000, expectedQuery: companyLockQuery,
    });
    console.log(JSON.stringify({ label, ownerPid, waiter: row }));
    return row;
  }

  it.each(['enqueue','claim'] as const)('%s uses final pause facts in both orders and preserves the verified exception',async kind=>{
    for(const interaction of [false,true])for(const order of ['pause-first','admission-first']){
      const f=await fixture(interaction,kind==='claim'),ready=gate(),release=gate();let ownerPid=0,held=false;
      const pausedRoot=(side:string)=>new Proxy(db,{get(target,key,receiver){if(key!=='transaction')return Reflect.get(target,key,receiver);return (work:(tx:unknown)=>Promise<any>)=>target.transaction(async tx=>{
        await tx.execute(sql`set local statement_timeout = '8s'`);const result=await work(tx);
        const selected=side==='pause'?order==='pause-first':order==='admission-first' && (kind==='enqueue'?result?.kind==='queued':result?.run?.status==='running');
        if(selected&&!held){held=true;ownerPid=Number((await tx.execute(sql`select pg_backend_pid() pid`))[0].pid);ready.open();await release.promise;}return result;
      });}});
      const heartbeat=heartbeatService(pausedRoot('heartbeat'),{autoDispatchQueuedRuns:false}),tree=issueTreeControlService(pausedRoot('pause'));
      const pause=()=>tree.acceptAction(f.treeContext,{kind:'create',input:{mode:'pause'}});
      const admission=()=>kind==='claim'?heartbeat.resumeQueuedRuns():heartbeat.wakeup(f.agent.id,{source:'assignment',triggerDetail:'system',reason:f.context.wakeReason,payload:{issueId:f.issue.id,...(f.comment?{commentId:f.comment.id}:{})},contextSnapshot:f.context,requestedByActorType:'user',requestedByActorId:'local-board'});
      const first=order==='pause-first'?pause():admission();await Promise.race([ready.promise,first.then(()=>{throw new Error('Owner escaped barrier');})]);
      const second=order==='pause-first'?admission():pause(),settled=Promise.allSettled([first,second]);
      try{await waitFor(ownerPid,`${kind}/${order}/interaction=${interaction}`,second);}finally{release.open();await settled;}
      const results=await settled;expect(results.map(row=>row.status)).toEqual(['fulfilled','fulfilled']);
      const runs=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,f.company.id));
      const requests=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.company.id));
      expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId,f.company.id))).toHaveLength(1);
      if(order==='pause-first'&&!interaction){
        if(kind==='enqueue'){expect(runs).toEqual([]);expect(requests).toEqual([expect.objectContaining({status:'skipped',reason:'issue_tree_hold_active',runId:null})]);}
        else {expect(runs).toEqual([expect.objectContaining({id:f.run!.id,status:'cancelled'})]);expect((await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id))).some(row=>row.action==='issue.tree_hold_run_interrupted')).toBe(true);}
        expect((await db.select().from(issues).where(eq(issues.id,f.issue.id)))[0].executionRunId).toBeNull();
      }else if(interaction){expect(runs[0].status).toBe('running');if(order==='pause-first')expect(runs[0].contextSnapshot).toMatchObject({treeHoldInteraction:true,activeTreeHold:{interaction:true}});}
      else if(kind==='claim'){expect(runs[0].status).toBe('running');}
      // No provider execution and no hold-effect dispatcher are invoked by this fixture.
      // Clear accepted runs so subsequent resumeQueuedRuns enumerates only its fixture.
      await db.update(heartbeatRuns).set({status:'cancelled'}).where(eq(heartbeatRuns.companyId,f.company.id));
    }
  },45000);
});
