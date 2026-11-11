// AgentDash: built-in FDE. Identity is a protected registration, never a name or title.
import { and, desc, eq, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, companyMemberships, fredRegistrations, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { FRED_MANDATE_VERSION, fredBriefSchema, fredSetupSchema, fredStartSchema, type FredBriefInput, type FredSetupInput, type FredStartInput, type FredWorkspace } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { agentService } from "./agents.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { loadFredInstructionsBundle, hasFredMandate } from "./fred-instructions.js";
import { budgetService } from "./budgets.js";
import { onboardingMaterializationPause } from "./agent-creator-from-proposal.js";
import { issueService } from "./issues.js";
import { documentService } from "./documents.js";
import { approvalService } from "./approvals.js";
import { heartbeatService } from "./heartbeat.js";
import { lockCompanyTierCapacity } from "./tier-policy.js";
import { insertActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { normalizeHumanRole } from "./company-member-roles.js";
import { logger } from "../middleware/logger.js";

export interface FredActor { userId: string; trustedLocal?: boolean; syntheticLocalOwner?: boolean }
interface Options {
 instructions?: Pick<ReturnType<typeof agentInstructionsService>, "materializeManagedBundle">;
 heartbeat?: Pick<ReturnType<typeof heartbeatService>, "wakeup">;
}
import { hasCurrentFredBrief, renderFredBrief, renderFredDiscoveryDescription } from "./fred-brief.js";

const BRIEF_KEY = "fred-adoption-brief";


export function fredService(db: Db, options: Options = {}) {
 const instructions = options.instructions ?? agentInstructionsService();
 async function authorize(tx: Db, companyId: string, actor: FredActor) {
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
  if (!company) throw notFound("Company not found");
  if (!actor.userId) throw forbidden("A signed-in company administrator is required");
  if (!actor.trustedLocal) {
   const [member] = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId,companyId),eq(companyMemberships.principalType,"user"),eq(companyMemberships.principalId,actor.userId))).for("share");
   if (!member || member.status !== "active" || normalizeHumanRole(member.membershipRole) !== "admin") throw forbidden("An active company owner or administrator is required");
  }
  return company;
 }
 async function locked<T>(companyId: string, actor: FredActor, work: (tx: Db, company: typeof companies.$inferSelect, publications: ActivityPublication[]) => Promise<T>) {
  const publications: ActivityPublication[] = [];
  const result = await db.transaction(async t => {
   const tx=t as unknown as Db;
   await lockCompanyTierCapacity(tx, companyId);
   const company=await authorize(tx,companyId,actor);
   return work(tx, company, publications);
  });
  for (const publication of publications) publishActivity(publication);
  return result;
 }
 async function rowFor(tx: Db, companyId: string, lock = false) {
  const query=tx.select().from(fredRegistrations).where(eq(fredRegistrations.companyId,companyId));
  return (await (lock ? query.for("update") : query))[0] ?? null;
 }
 async function bindings(tx: Db, registration: typeof fredRegistrations.$inferSelect) {
  const agent=registration.agentId ? (await tx.select().from(agents).where(and(eq(agents.id,registration.agentId),eq(agents.companyId,registration.companyId))))[0] ?? null : null;
  const issue=registration.mainIssueId ? (await tx.select().from(issues).where(and(eq(issues.id,registration.mainIssueId),eq(issues.companyId,registration.companyId))))[0] ?? null : null;
  if (registration.agentId && !agent || registration.mainIssueId && !issue) throw conflict("Fred's saved identity or work thread needs administrator repair");
  if (issue && agent && issue.assigneeAgentId !== agent.id) throw conflict("Fred's work thread was reassigned; inspect it before continuing");
  return {agent,issue};
 }
 async function workspace(companyId: string, actor: FredActor): Promise<FredWorkspace> {
  return db.transaction(async t => {
   const tx=t as unknown as Db;const company=await authorize(tx,companyId,actor);const registration=await rowFor(tx,companyId);
   const {agent,issue}=registration ? await bindings(tx,registration) : {agent:null,issue:null};
   const document=issue ? await documentService(tx).getIssueDocumentByKey(issue.id,BRIEF_KEY) : null;
   const latest=agent && issue ? (await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,companyId),eq(heartbeatRuns.agentId,agent.id),sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`)).orderBy(desc(heartbeatRuns.createdAt),desc(heartbeatRuns.id)).limit(1))[0] : null;
   const mandatePresent=agent ? await hasFredMandate(agent) : false;
   let blocker: string|null=null;
   if (company.status !== "active") blocker="This company is paused or archived.";
   else if (!registration) blocker="Set up Fred before starting discovery.";
   else if (registration.state !== "ready" || !agent || !issue || !mandatePresent) blocker="Fred's setup needs repair before starting work.";
   else if (agent.status === "pending_approval") blocker="Fred is awaiting the native hiring approval.";
   else if (!["idle","running","active"].includes(agent.status)) blocker="Fred is paused, stopped or unavailable. Review the agent before starting.";
   else if (!registration.brief || registration.briefRevision < 1) blocker="Save the company-shared adoption brief first.";
   else if (!hasCurrentFredBrief(document, registration.briefDocumentRevisionId, registration.brief, registration.briefRevision)) blocker="The adoption brief changed or its proof is unavailable. Review the current document and save the agreed criteria again.";
   else if (agent.budgetMonthlyCents <= 0 || agent.spentMonthlyCents >= agent.budgetMonthlyCents) blocker="Fred needs an available explicit budget.";
   else if (["done","cancelled"].includes(issue.status)) blocker="This discovery job is closed. Open its evidence and next steps.";
   else if (registration.startedAt && !latest && issue.description !== renderFredDiscoveryDescription(registration.brief, registration.briefRevision, registration.briefDocumentRevisionId)) blocker="The brief changed after the discovery request. Inspect the pinned work before retrying.";
   else if (registration.startedAt && latest) blocker="Discovery has already been requested. Continue in the work thread.";
   if (agent?.accountableUserId && !(actor.syntheticLocalOwner && agent.accountableUserId === "local-board")) {
    const [owner]=await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId,companyId),eq(companyMemberships.principalType,"user"),eq(companyMemberships.principalId,agent.accountableUserId),eq(companyMemberships.status,"active")));
    if (!owner) blocker="Fred's accountable person is no longer active. An administrator must reassign accountability.";
   }
   return {companyId,registration:registration ? {id:registration.id,agentId:registration.agentId,mainIssueId:registration.mainIssueId,ownerUserId:registration.ownerUserId,state:registration.state === "ready" && !mandatePresent ? "repair_needed" : registration.state,mandateVersion:registration.mandateVersion,startedAt:registration.startedAt?.toISOString()??null}:null,
    agent:agent ? {id:agent.id,name:agent.name,status:agent.status,adapterType:agent.adapterType,budgetMonthlyCents:agent.budgetMonthlyCents,spentMonthlyCents:agent.spentMonthlyCents}:null,
    issue:issue ? {id:issue.id,identifier:issue.identifier,title:issue.title,status:issue.status}:null,
    brief:registration?.brief ? {...registration.brief,revision:registration.briefRevision,documentRevisionId:registration.briefDocumentRevisionId}:null,
    canConfigure:true,startBlocker:blocker,latestRun:latest ? {id:latest.id,status:latest.status,error:latest.error ? "Open the native work receipt for the recorded reason." : null}:null};
  });
 }
 async function setup(companyId: string, raw: FredSetupInput, actor: FredActor) {
  const input=fredSetupSchema.parse(raw);
  const accepted=await locked(companyId,actor,async(tx,company,publications)=>{
   if (company.status!=="active") throw conflict("Cannot set up Fred in a paused or archived company");
   let registration=await rowFor(tx,companyId,true);
   if (registration) {
    const {agent}=await bindings(tx,registration);
    if (agent?.status==="terminated") throw conflict("Fred was terminated. An administrator must review recovery; setup will not recreate it.");
    if (agent && (agent.adapterType!==input.adapterType || agent.budgetMonthlyCents!==input.budgetMonthlyCents)) throw conflict("Fred already exists with different settings. Use the agent's native configuration controls.");
    if (registration.state === "ready" && agent && !await hasFredMandate(agent)) {
     if (!['idle','error'].includes(agent.status)) throw conflict("Fred's instructions need repair; preserve its current pause or active work and inspect the agent first.");
     const [active]=await tx.select({id:heartbeatRuns.id}).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,companyId),eq(heartbeatRuns.agentId,agent.id),sql`${heartbeatRuns.status} in ('queued','running')`)).limit(1);
     if(active) throw conflict("Fred still has active work. Repair after it is safely idle.");
     if ((await agentInstructionsService().getBundle(agent)).mode === 'external') throw conflict("Fred's instructions are externally managed. Repair them through the native configuration controls.");
     await agentService(tx).update(agent.id,{...onboardingMaterializationPause(),metadata:{...agent.metadata,onboardingMaterialization:'pending'}});
     [registration]=await tx.update(fredRegistrations).set({state:'materializing',updatedAt:new Date()}).where(eq(fredRegistrations.id,registration.id)).returning();
    }
    return registration;
   }
   [registration]=await tx.insert(fredRegistrations).values({companyId,ownerUserId:actor.userId,state:"materializing",mandateVersion:FRED_MANDATE_VERSION}).returning();
   const agent=await agentService(tx).create(companyId,{name:"Fred",role:"general",title:"AgentDash FDE",autonomy:"autonomous",accountableUserId:actor.userId,createdByUserId:actor.userId,visibility:"company",
    adapterType:input.adapterType,adapterConfig:{dangerouslySkipPermissions:false,dangerouslyBypassApprovalsAndSandbox:false},
    runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:false,maxConcurrentRuns:1}},budgetMonthlyCents:input.budgetMonthlyCents,permissions:{canCreateAgents:false},...onboardingMaterializationPause()});
   await budgetService(tx).upsertPolicy(companyId,{scopeType:"agent",scopeId:agent.id,amount:agent.budgetMonthlyCents,windowKind:"calendar_month_utc",hardStopEnabled:true},actor.userId);
   const issue=await issueService(tx).create(companyId,{title:"Discover one useful first job with Fred",description:"Company-shared onboarding. No job starts until the owner saves a brief and explicitly selects Start discovery. The resulting report is a proposal, not owner acceptance or a proven business outcome.",status:"backlog",priority:"medium",assigneeAgentId:agent.id,createdByUserId:actor.userId});
   [registration]=await tx.update(fredRegistrations).set({agentId:agent.id,mainIssueId:issue.id,updatedAt:new Date()}).where(eq(fredRegistrations.id,registration.id)).returning();
   publications.push(await insertActivity(tx,{companyId,actorType:"user",actorId:actor.userId,action:"fred.registered",entityType:"agent",entityId:agent.id,details:{registrationId:registration.id,mainIssueId:issue.id,mandateVersion:FRED_MANDATE_VERSION}}));
   return registration;
  });
  if (accepted.state==="ready") return workspace(companyId,actor);
  try {
   await locked(companyId,actor,async(tx,company,publications)=>{
    const registration=await rowFor(tx,companyId,true);
    if (!registration || registration.id!==accepted.id) throw conflict("Fred registration changed before setup completed");
    if (registration.state==="ready") return;
    if (company.status!=="active") throw conflict("Company is no longer active");
    const {agent}=await bindings(tx,registration);
    if (!agent || !agent.pausedAt || agent.status!=="paused" || agent.pauseReason!=="system") throw conflict("Fred's original setup pause changed; inspect the existing agent");
    const materialized=await instructions.materializeManagedBundle(agent,await loadFredInstructionsBundle(),{entryFile:"AGENTS.md",replaceExisting:false});
    await agentService(tx).completeMaterialization(agent.id,agent.pausedAt,materialized.adapterConfig,company.requireBoardApprovalForNewAgents?"pending_approval":"idle");
    if (company.requireBoardApprovalForNewAgents) {
     await approvalService(tx).create(companyId,{type:"hire_agent",status:"pending",requestedByUserId:actor.userId,payload:{agentId:agent.id,name:agent.name,role:"general",title:"AgentDash FDE",adapterType:agent.adapterType,budgetMonthlyCents:agent.budgetMonthlyCents}});
    }
    await tx.update(fredRegistrations).set({state:"ready",updatedAt:new Date()}).where(eq(fredRegistrations.id,registration.id));
    publications.push(await insertActivity(tx,{companyId,actorType:"user",actorId:actor.userId,action:"fred.setup_completed",entityType:"agent",entityId:agent.id,details:{registrationId:registration.id,requiresApproval:company.requireBoardApprovalForNewAgents}}));
   });
  } catch (error) {
   const code=error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
   const errorCode=["EACCES","EPERM","ENOENT","ENOSPC","EROFS","EIO","23505","40001","40P01"].includes(code) ? code : "unknown";
   logger.warn({companyId,agentId:accepted.agentId,registrationId:accepted.id,errorCode},"Fred setup needs inspection; retry the accepted identity");
   await locked(companyId,actor,async tx=>{
    const current=await rowFor(tx,companyId,true);
    if(current && current.id===accepted.id && current.state!=="ready") await tx.update(fredRegistrations).set({state:"repair_needed",updatedAt:new Date()}).where(eq(fredRegistrations.id,current.id));
   });
   throw conflict("Fred's identity was accepted but setup needs repair. Retry setup for the same Fred; do not create another agent.",{accepted:true,agentId:accepted.agentId,registrationId:accepted.id});
  }
  return workspace(companyId,actor);
 }
 async function saveBrief(companyId: string, raw: FredBriefInput, actor: FredActor) {
  const input=fredBriefSchema.parse(raw);
  await locked(companyId,actor,async(tx,company,publications)=>{
   if(company.status!=="active") throw conflict("Company is not active");
   const r=await rowFor(tx,companyId,true);if(!r || r.state!=="ready" || !r.mainIssueId) throw conflict("Set up Fred before saving its brief");
   await bindings(tx,r);
   if(r.briefRevision!==input.expectedRevision) throw conflict("The adoption brief changed. Reload before saving.");
   const {expectedRevision,shareWithCompany,...content}=input;
   const revision=expectedRevision+1;
   // Only this explicit human save can re-confirm criteria after an intervening
   // native edit. Bind the actual current revision; concurrent native edits still 409.
   const current=await documentService(tx).getIssueDocumentByKey(r.mainIssueId,BRIEF_KEY);
   const written=await documentService(tx).upsertIssueDocument({issueId:r.mainIssueId,key:BRIEF_KEY,title:"Company-shared adoption brief",format:"markdown",body:renderFredBrief(content,revision),baseRevisionId:current?.latestRevisionId??null,createdByUserId:actor.userId,changeSummary:"Owner updated the shared adoption criteria"});
   await tx.update(fredRegistrations).set({brief:content,briefRevision:revision,briefDocumentRevisionId:written.document.latestRevisionId,updatedAt:new Date()}).where(eq(fredRegistrations.id,r.id));
   publications.push(await insertActivity(tx,{companyId,actorType:"user",actorId:actor.userId,action:"fred.brief_saved",entityType:"issue",entityId:r.mainIssueId,details:{revision,documentRevisionId:written.document.latestRevisionId}}));
  });
  return workspace(companyId,actor);
 }
 async function start(companyId: string, raw: FredStartInput, actor: FredActor) {
  const input=fredStartSchema.parse(raw);
  const accepted=await locked(companyId,actor,async(tx,company,publications)=>{
   const r=await rowFor(tx,companyId,true);
   if(!r || r.id!==input.registrationId || r.state!=="ready" || !r.agentId || !r.mainIssueId || !r.brief) throw conflict("Fred's saved setup is not ready");
   if(r.briefRevision!==input.expectedRevision) throw conflict("The adoption brief changed. Review it before starting.");
   const {agent,issue}=await bindings(tx,r);
   const document=issue ? await documentService(tx).getIssueDocumentByKey(issue.id,BRIEF_KEY) : null;
   if(!hasCurrentFredBrief(document, r.briefDocumentRevisionId, r.brief, r.briefRevision)) throw conflict("The adoption brief changed or is unavailable. Review and save the agreed criteria before starting.");
   if(company.status!=="active" || !agent || !issue || !["idle","active","running"].includes(agent.status)) throw conflict("Fred is blocked, paused or awaiting approval; inspect the agent before starting.");
   if(!await hasFredMandate(agent)) throw conflict("Fred’s instructions need repair before starting work.");
   if(agent.budgetMonthlyCents<=0 || agent.spentMonthlyCents>=agent.budgetMonthlyCents) throw conflict("Fred's explicit budget is exhausted");
   if(agent.accountableUserId && !(actor.syntheticLocalOwner && agent.accountableUserId === "local-board")) {
    const [owner]=await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId,companyId),eq(companyMemberships.principalType,"user"),eq(companyMemberships.principalId,agent.accountableUserId),eq(companyMemberships.status,"active"))).for("share");
    if(!owner) throw conflict("Fred's accountable person is inactive");
   }
   if(r.startedAt && issue.description !== renderFredDiscoveryDescription(r.brief, r.briefRevision, r.briefDocumentRevisionId)) throw conflict("The brief changed after the discovery request. Inspect the pinned work before retrying.");
   if(["done","cancelled"].includes(issue.status)) throw conflict("Discovery is already closed. Inspect its evidence rather than restarting setup.");
   if(!r.startedAt) {
    await issueService(tx).update(issue.id,{status:"todo",description:renderFredDiscoveryDescription(r.brief,r.briefRevision,r.briefDocumentRevisionId),definitionOfDone:{summary:"A sourced adoption recommendation and the next real decision",criteria:[{id:"sources",text:"A source-backed adoption recommendation using only permitted company context",done:false},{id:"unknowns",text:"Unresolved questions and missing proof are explicit",done:false},{id:"setup",text:"A proposed specialist job, criteria and native approval handoff; no unapproved business action",done:false}]}});
    const runtime=agent.runtimeConfig as Record<string,unknown>;
    const heartbeat=runtime.heartbeat && typeof runtime.heartbeat==="object" ? runtime.heartbeat as Record<string,unknown> : {};
    await tx.update(agents).set({runtimeConfig:{...runtime,heartbeat:{...heartbeat,enabled:false,wakeOnDemand:true}},updatedAt:new Date()}).where(eq(agents.id,agent.id));
    await tx.update(fredRegistrations).set({startedAt:new Date(),updatedAt:new Date()}).where(eq(fredRegistrations.id,r.id));
    publications.push(await insertActivity(tx,{companyId,actorType:"user",actorId:actor.userId,action:"fred.discovery_requested",entityType:"issue",entityId:issue.id,details:{registrationId:r.id,briefRevision:r.briefRevision}}));
   }
   return {registrationId:r.id,agentId:agent.id,issueId:issue.id};
  });
  // Serialize post-commit dispatch independently of the issue/domain locks. A lost
  // response reads the durable native wake request before considering a retry.
  await db.transaction(async t=>{
   const tx=t as unknown as Db;
   await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"fred-dispatch:"+accepted.registrationId}))`);
   await authorize(tx,companyId,actor);
   const key="fred-discovery:"+accepted.registrationId;
   const [prior]=await tx.select({id:agentWakeupRequests.id}).from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,companyId),eq(agentWakeupRequests.agentId,accepted.agentId),eq(agentWakeupRequests.idempotencyKey,key),sql`${agentWakeupRequests.status} <> 'skipped'`)).limit(1);
   if(prior) return;
   await (options.heartbeat ?? heartbeatService(db)).wakeup(accepted.agentId,{source:"on_demand",triggerDetail:"manual",reason:"fred_discovery",idempotencyKey:key,requestedByActorType:"user",requestedByActorId:actor.userId,contextSnapshot:{issueId:accepted.issueId,source:"fred_discovery",forceFreshSession:true}});
  });
  return workspace(companyId,actor);
 }
 return {workspace,setup,saveBrief,start};
}
