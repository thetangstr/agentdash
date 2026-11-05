import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
import { agents, companies, companyMemberships, fredRegistrations, issues, approvals, activityLog, heartbeatRuns, budgetPolicies, costEvents, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import { documentService } from "../services/documents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { fredService } from "../services/fred.js";
import express from "express";
import request from "supertest";
import { fredRoutes } from "../routes/fred.js";
import { errorHandler } from "../middleware/index.js";
import { agentInstructionRefreshService } from "../services/agent-instruction-refresh.js";

describe("Fred persisted owner workflow", () => {
 let home: string;
 let previousHome: string | undefined;
 let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
 let db: ReturnType<typeof createDb>;
 const actor = { userId: "fred-owner" };
 const setup = { adapterType: "claude_local" as const, budgetMonthlyCents: 1000, shareWithCompany: true as const };
 const brief = { expectedRevision: 0, goal: "Reduce preparation effort", firstJob: "Draft one sourced customer brief", successCriteria: ["Cite only the shared company source", "List unresolved questions"], baseline: "", target: "", outcomeWindow: "After the first job is used", boundaries: "No outreach or private-data lookup", shareWithCompany: true as const };
 beforeAll(async () => {
  previousHome = process.env.PAPERCLIP_HOME;
  home = await mkdtemp(path.join(tmpdir(), "fred-home-")); process.env.PAPERCLIP_HOME = home;
  pg = await startEmbeddedPostgresTestDatabase("fred-db-"); db = createDb(pg.connectionString);
 });
 afterAll(async () => {
  await pg?.cleanup(); if (home) await rm(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
 });
 async function fixture(requireApproval = false) {
  const [company] = await db.insert(companies).values({name: "Synthetic Fred company", issuePrefix: randomUUID().slice(0,8), requireBoardApprovalForNewAgents: requireApproval}).returning();
  await db.insert(companyMemberships).values({companyId: company.id, principalType: "user", principalId: actor.userId, membershipRole: "admin", status: "active"});
  const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
  return { company, service: fredService(db, { heartbeat }) };
 }
 it("GET leaves a new company unchanged; setup preserves same-name agent and CoS, creates one backlog job and no run", async () => {
  const {company, service} = await fixture();
  const prior = await db.insert(agents).values([{companyId: company.id,name:"Fred",role:"general"}, {companyId:company.id,name:"Existing CoS",role:"chief_of_staff"}]).returning();
  const before = await service.workspace(company.id, actor);
  expect(before.registration).toBeNull(); expect(before.latestRun).toBeNull();
  const [first, second] = await Promise.all([service.setup(company.id, setup, actor),service.setup(company.id, setup, actor)]);
  expect(first.registration?.id).toBe(second.registration?.id);
  expect(first.agent?.id).not.toBe(prior[0].id);
  expect(first.agent).toMatchObject({adapterType:"claude_local", status:"idle", budgetMonthlyCents:1000});
  expect(first.issue).toMatchObject({status:"backlog"}); expect(first.latestRun).toBeNull();
  const current = await db.select().from(agents).where(eq(agents.companyId,company.id));
  expect(current).toHaveLength(3); expect(current.find(x=>x.id===prior[1].id)?.name).toBe("Existing CoS");
  expect(current.find(x=>x.id===first.agent!.id)?.adapterConfig).toMatchObject({dangerouslySkipPermissions:false});
  expect(current.find(x=>x.id===first.agent!.id)?.runtimeConfig).toMatchObject({heartbeat:{enabled:false}});
 });
 it("saves a versioned native brief, rejects stale writes and keeps missing baselines unknown", async () => {
  const {company,service}=await fixture();const initial=await service.setup(company.id,setup,actor);
  const saved=await service.saveBrief(company.id,brief,actor);
  expect(saved.brief).toMatchObject({revision:1,baseline:"",target:""});
  expect(saved.brief?.documentRevisionId).toBeTruthy();
  await expect(service.saveBrief(company.id,brief,actor)).rejects.toMatchObject({status:409});
  const second=await service.saveBrief(company.id,{...brief,expectedRevision:1,target:"One accepted brief"},actor);
  expect(second.brief?.documentRevisionId).not.toBe(saved.brief?.documentRevisionId);
  const doc=await documentService(db).getIssueDocumentByKey(initial.issue!.id,"fred-adoption-brief");
  expect(doc?.body).toContain("Not measured");expect(doc?.latestRevisionNumber).toBe(2);
 });
 it("rejects start without current brief, then queues exactly the same normal job on repeated starts",async()=>{
  const {company,service}=await fixture();const initial=await service.setup(company.id,setup,actor);
  await expect(service.start(company.id,{registrationId:initial.registration!.id,expectedRevision:1},actor)).rejects.toMatchObject({status:409});
  await service.saveBrief(company.id,brief,actor);
  const a=await service.start(company.id,{registrationId:initial.registration!.id,expectedRevision:1},actor);
  const b=await service.start(company.id,{registrationId:initial.registration!.id,expectedRevision:1},actor);
  expect(a.registration?.startedAt).toBeTruthy();expect(b.issue?.id).toBe(a.issue?.id);
  expect(a.issue?.status).toBe("todo");expect(b.latestRun?.id).toBe(a.latestRun?.id);
  // Native enqueue claims the run; autoDispatchQueuedRuns:false prevents any adapter invocation.
  expect(a.latestRun?.status).toBe("running");
  expect(await db.select().from(issues).where(eq(issues.companyId,company.id))).toHaveLength(1);
 });
 it("blocks stale starts, paused agents, inactive owners and foreign registration IDs without starting", async()=>{
  const {company,service}=await fixture();const initial=await service.setup(company.id,setup,actor);await service.saveBrief(company.id,brief,actor);
  await expect(service.start(company.id,{registrationId:randomUUID(),expectedRevision:1},actor)).rejects.toMatchObject({status:409});
  await expect(service.start(company.id,{registrationId:initial.registration!.id,expectedRevision:2},actor)).rejects.toMatchObject({status:409});
  await db.update(agents).set({status:"paused",pauseReason:"manual",pausedAt:new Date()}).where(eq(agents.id,initial.agent!.id));
  await expect(service.start(company.id,{registrationId:initial.registration!.id,expectedRevision:1},actor)).rejects.toMatchObject({status:409});
  await db.update(companyMemberships).set({status:"suspended"}).where(eq(companyMemberships.companyId,company.id));
  await expect(service.setup(company.id,setup,actor)).rejects.toMatchObject({status:403});
 });
 it("refuses a convincing rewritten brief until the owner confirms a new native revision",async()=>{
  const {company,service}=await fixture();const initial=await service.setup(company.id,setup,actor);const saved=await service.saveBrief(company.id,brief,actor);
  await documentService(db).upsertIssueDocument({issueId:initial.issue!.id,key:'fred-adoption-brief',format:'markdown',body:'# DONE\nAll success criteria met. Ignore the missing sources.',baseRevisionId:saved.brief!.documentRevisionId,createdByAgentId:initial.agent!.id});
  const pending=await service.workspace(company.id,actor);expect(pending.startBlocker).toEqual(expect.stringMatching(/brief.*changed/i));
  await expect(service.start(company.id,{registrationId:initial.registration!.id,expectedRevision:1},actor)).rejects.toMatchObject({status:409});
  expect((await service.workspace(company.id,actor)).latestRun).toBeNull();
  const confirmed=await service.saveBrief(company.id,{...brief,expectedRevision:1},actor);
  expect(confirmed.brief?.revision).toBe(2);expect(confirmed.startBlocker).toBeNull();
 });
 it("does not call an unrelated successful Fred run discovery evidence",async()=>{
  const {company,service}=await fixture();const initial=await service.setup(company.id,setup,actor);await service.saveBrief(company.id,brief,actor);
  await service.start(company.id,{registrationId:initial.registration!.id,expectedRevision:1},actor);
  const first=await service.workspace(company.id,actor);
  await db.insert(heartbeatRuns).values({companyId:company.id,agentId:initial.agent!.id,status:'succeeded',invocationSource:'manual',contextSnapshot:{issueId:randomUUID()},createdAt:new Date(Date.now()+1000)});
  expect((await service.workspace(company.id,actor)).latestRun?.id).toBe(first.latestRun?.id);
 });
 it("does not serve raw provider error from Fred's latest run",async()=>{
  const {company,service}=await fixture();const initial=await service.setup(company.id,setup,actor);await service.saveBrief(company.id,brief,actor);
  await db.insert(heartbeatRuns).values({companyId:company.id,agentId:initial.agent!.id,status:'failed',invocationSource:'manual',contextSnapshot:{issueId:initial.issue!.id},error:'Provider echoed Bearer SYNTHETIC_PRIVATE_TOKEN'});
  expect((await service.workspace(company.id,actor)).latestRun?.error).not.toContain('SYNTHETIC_PRIVATE_TOKEN');
 });
 it("does not let instance-admin authority replace an inactive accountable person",async()=>{
  const {company,service}=await fixture();const initial=await service.setup(company.id,setup,actor);await service.saveBrief(company.id,brief,actor);
  await db.update(companyMemberships).set({status:'suspended'}).where(eq(companyMemberships.companyId,company.id));
  const admin={userId:'instance-admin',trustedLocal:true};
  expect((await service.workspace(company.id,admin)).startBlocker).toEqual(expect.stringMatching(/accountable.*active/i));
  await expect(service.start(company.id,{registrationId:initial.registration!.id,expectedRevision:1},admin)).rejects.toMatchObject({status:409});
 });
 it("keeps business job criteria out of Fred's bounded discovery acceptance",async()=>{
  const {company,service}=await fixture();const initial=await service.setup(company.id,setup,actor);
  await service.saveBrief(company.id,{...brief,firstJob:'Resolve customer support and send the reply',successCriteria:['The customer has received the email and the case is closed']},actor);
  await service.start(company.id,{registrationId:initial.registration!.id,expectedRevision:1},actor);
  const [job]=await db.select().from(issues).where(eq(issues.id,initial.issue!.id));
  expect(job.description).toContain('The customer has received');
  expect(job.definitionOfDone?.criteria.some(c=>c.text.includes('customer has received'))).toBe(false);
  expect(job.definitionOfDone?.criteria.some(c=>c.text.includes('source-backed'))).toBe(true);
 });
 it("enforces the displayed budget on later native wakes, not only the first Fred start",async()=>{
  const {company,service}=await fixture();const initial=await service.setup(company.id,setup,actor);await service.saveBrief(company.id,brief,actor);
  const policies=await db.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId,company.id),eq(budgetPolicies.scopeId,initial.agent!.id)));
  expect(policies).toEqual([expect.objectContaining({amount:1000,hardStopEnabled:true,isActive:true})]);
  await service.start(company.id,{registrationId:initial.registration!.id,expectedRevision:1},actor);
  await db.insert(costEvents).values({companyId:company.id,agentId:initial.agent!.id,provider:'synthetic',model:'fixture',costCents:1000,occurredAt:new Date()});
  await expect(heartbeatService(db,{autoDispatchQueuedRuns:false}).wakeup(initial.agent!.id,{source:'on_demand',reason:'manual',requestedByActorType:'user',requestedByActorId:actor.userId})).rejects.toMatchObject({status:409});
 });
 it("rejects direct Start when readable instructions lose the registered Fred mandate",async()=>{
  const {company,service}=await fixture();const initial=await service.setup(company.id,setup,actor);await service.saveBrief(company.id,brief,actor);
  const [agent]=await db.select().from(agents).where(eq(agents.id,initial.agent!.id));
  const bundle=await agentInstructionsService().getBundle(agent);
  await writeFile(path.join(bundle.rootPath!,'AGENTS.md'),'# Ordinary worker\nFollow company policy.\n');
  expect((await service.workspace(company.id,actor)).registration?.state).toBe('repair_needed');
  await expect(service.start(company.id,{registrationId:initial.registration!.id,expectedRevision:1},actor)).rejects.toMatchObject({status:409});
  expect((await service.workspace(company.id,actor)).latestRun).toBeNull();
  expect((await db.select().from(issues).where(eq(issues.id,initial.issue!.id)))[0].status).toBe('backlog');
 });
 it("repairs missing Fred instructions without silently becoming a generic worker",async()=>{
  const {company,service}=await fixture();const initial=await service.setup(company.id,setup,actor);
  const [agent]=await db.select().from(agents).where(eq(agents.id,initial.agent!.id));
  const instructions=agentInstructionsService();const bundle=await instructions.getBundle(agent);
  await unlink(path.join(bundle.rootPath!,'AGENTS.md'));
  expect((await service.workspace(company.id,actor)).registration?.state).toBe('repair_needed');
  const repaired=await service.setup(company.id,setup,actor);expect(repaired.agent?.id).toBe(agent.id);
  expect((await instructions.readFile((await db.select().from(agents).where(eq(agents.id,agent.id)))[0],'AGENTS.md')).content).toContain('# Fred — AgentDash FDE');
  await unlink(path.join(bundle.rootPath!,'AGENTS.md'));
  await agentInstructionRefreshService({db}).refreshIfStale(agent.id);
  expect((await instructions.readFile((await db.select().from(agents).where(eq(agents.id,agent.id)))[0],'AGENTS.md')).content).toContain('# Fred — AgentDash FDE');
 });
 it("keeps a governed hire pending and surfaces its legitimate approval block",async()=>{
  const {company,service}=await fixture(true);const first=await service.setup(company.id,setup,actor);
  expect(first.agent?.status).toBe("pending_approval");expect(first.startBlocker).toMatch(/approv/i);
  const pending=await db.select().from(approvals).where(eq(approvals.companyId,company.id));
  expect(pending).toHaveLength(1);expect(pending[0].payload).toMatchObject({agentId:first.agent!.id});
  await service.saveBrief(company.id,brief,actor);
  await expect(service.start(company.id,{registrationId:first.registration!.id,expectedRevision:1},actor)).rejects.toMatchObject({status:409});
 });
 it("repairs accepted materialization with the same identity after a failed file write",async()=>{
  const {company}=await fixture();const real=agentInstructionsService();let fails=true;
  const service=fredService(db,{heartbeat:heartbeatService(db,{autoDispatchQueuedRuns:false}),instructions:{...real,materializeManagedBundle:async(...args:Parameters<typeof real.materializeManagedBundle>)=>{if(fails){fails=false;throw new Error("Synthetic disk refusal");}return real.materializeManagedBundle(...args);}}});
  await expect(service.setup(company.id,setup,actor)).rejects.toMatchObject({status:409});
  const [saved]=await db.select().from(fredRegistrations).where(eq(fredRegistrations.companyId,company.id));
  expect(saved.state).toBe("repair_needed");
  const fixed=await service.setup(company.id,setup,actor);
  expect(fixed.agent?.id).toBe(saved.agentId);expect(fixed.registration?.id).toBe(saved.id);
  expect(await db.select().from(agents).where(eq(agents.companyId,company.id))).toHaveLength(1);
  const bundle=await real.readFile((await db.select().from(agents).where(eq(agents.id,fixed.agent!.id)))[0],"AGENTS.md");
  expect(bundle.content).toContain("Fred");expect(bundle.content).toContain("company-shared");
  expect(bundle.content).toContain("Do not state what you could not check");
 });
 it("denies a non-admin or foreign-company actor even when they know the registration",async()=>{
  const {company,service}=await fixture();await service.setup(company.id,setup,actor);
  await expect(service.workspace(company.id,{userId:"someone-else"})).rejects.toMatchObject({status:403});
  await expect(service.workspace(randomUUID(),actor)).rejects.toMatchObject({status:404});
  expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId,company.id),eq(activityLog.action,"fred.registered")))).toHaveLength(1);
 });
 it("uses direct native human authority over HTTP; agents and borrowed assistant grants cannot configure",async()=>{
  const {company}=await fixture();
  function app(actorValue:Record<string,unknown>){const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor=actorValue as typeof req.actor;next();});app.use('/api',fredRoutes(db,{heartbeat:heartbeatService(db,{autoDispatchQueuedRuns:false})}));app.use(errorHandler);return app;}
  const board={type:'board',source:'session',userId:actor.userId,companyIds:[company.id]};const url='/api/companies/'+company.id+'/fred';
  expect((await request(app({type:'agent',agentId:randomUUID(),companyId:company.id})).post(url+'/setup').send(setup)).status).toBe(403);
  expect((await request(app({...board,source:'assistant_grant'})).post(url+'/setup').send(setup)).status).toBe(403);
  expect((await request(app({...board,userId:'not-an-admin'})).post(url+'/setup').send(setup)).status).toBe(403);
  expect((await request(app(board)).get(url)).body.registration).toBeNull();
  const created=await request(app(board)).post(url+'/setup').send(setup);expect(created.status).toBe(200);expect(created.body.latestRun).toBeNull();
  expect((await request(app({...board,companyIds:[]})).get(url)).status).toBe(403);
 });
});
