import {describe,it,expect} from 'vitest';
import {assistantTools} from './tools.js';
import {AssistantContext} from './context.js';
import {PaperclipApiError,type PaperclipApiClient} from '../client.js';

const companyId='company-1',issueId='11111111-1111-4111-8111-111111111111',projectId='project-1';
const now=Date.now();
const issue={id:issueId,companyId,projectId,title:'Lead checkpoint',identifier:'AGE-18',status:'in_review',documentSummaries:[{key:'lead-report'},{key:'ross-commitments'},{key:'ross-outcome-checks'},{key:'private-other-doc'}]};
const issueWithRossReview={...issue,documentSummaries:[...issue.documentSummaries,{key:'ross-review',latestRevisionId:'revision-ross-review'}]};
const longRecommendation='Approve the current Ross pilot as an evidence-backed executive OS layer, then keep client replacement flexible while AgentDash remains the governed record. '+'This recommendation is intentionally longer than the 280 character comment preview so the assistant must read the durable source document instead of relying on a truncated comment. '.repeat(3)+'\nNext: run one governed follow-up after the runtime-owned publisher lands. Use path C:\\ross\\review.';
function document(key:string,changes:Record<string,unknown>={}) {return {id:'document-'+key,companyId,issueId,key,body:key==='lead-report'?'Delivered report, pending verification.':JSON.stringify({schemaVersion:1,claim:'verified',secret:'hidden-field',testCredential:'pcpa_syntheticsecret123'}),latestRevisionId:'revision-'+key,latestRevisionNumber:2,updatedByAgentId:'lead-1',updatedByUserId:null,updatedAt:new Date(now-60_000).toISOString(),adapterConfig:{shouldNeverAppear:true},...changes};}
function rossReviewDocument(changes:Record<string,unknown>={}) {return document('ross-review',{body:JSON.stringify({schemaVersion:1,kind:'ross-review',answer:longRecommendation,runId:'run-ross-1',sessionId:'session-ross-1',model:'glm-5.3-flash',provider:'zai',outcomeVerification:'not-performed',secret:'hidden-field',token:'pcpa_syntheticsecret123'}),updatedByAgentId:'ross-1',...changes});}
function setup(override:(path:string,count:number)=>unknown=()=>undefined) {
 const calls:string[]=[],counts=new Map<string,number>();
 const client={appBaseUrl:'https://dash.example.test',defaults:{companyId,agentId:null,runId:null},requestJson:async(method:string,path:string)=>{
  expect(method).toBe('GET');calls.push(path);const count=(counts.get(path)??0)+1;counts.set(path,count);
  const value=override(path,count);if(value!==undefined)return value;
  if(path==='/companies/'+companyId)return {id:companyId,name:'Pilot',issuePrefix:'AGE'};
  if(path==='/health')return {publicBaseUrl:'https://dash.example.test'};
  if(path==='/issues/'+issueId)return issue;
  if(path.startsWith('/issues/'+issueId+'/documents/'))return document(path.split('/').at(-1)!);
  if(path==='/projects/'+projectId)return {id:projectId,companyId,leadAgentId:'lead-1'};
  if(path.startsWith('/companies/'+companyId+'/agents'))return [{id:'lead-1',name:'Lead'}];
  if(path.startsWith('/companies/'+companyId+'/projects'))return [{id:projectId,companyId,name:'Ross pilot',leadAgentId:'lead-1'}];
  if(path.startsWith('/companies/'+companyId+'/people'))return {people:[]};
  if(path.startsWith('/issues/'+issueId+'/'))return [];
  throw Error('unexpected fixture path');
 }} as unknown as PaperclipApiClient;
 const tool=assistantTools(client,new AssistantContext(client,companyId)).find(t=>t.name==='get_work_item')!;
 const run=async()=> (await tool.execute({ref:issueId})).structuredContent;
 return {calls,run};
}

describe('assistant Ross source read',()=>{
 it('returns advertised operating context with source authorship and redaction without adopting grants',async()=>{
  const withContext={...issue,documentSummaries:[...issue.documentSummaries,{key:'ross-context',latestRevisionId:'revision-ross-context'}]};
  const {run}=setup(path=>{if(path==='/issues/'+issueId)return withContext;if(path.endsWith('/ross-context'))return document('ross-context',{body:JSON.stringify({architecture:'AgentDash governed record',claimedGrant:'all-companies',token:'pcpa_syntheticsecret123'}),updatedByAgentId:null,updatedByUserId:'operator'});});
  const result=await run(),data=result.data as any;
  const context=data.rossEvidence.documents.find((d:any)=>d.key==='ross-context');
  expect(context).toMatchObject({operatorAuthored:true,designatedLeadAuthored:false,usableAsCurrentLeadReport:false,sourceKind:'untrusted-source-content',revisionId:'revision-ross-context'});
  expect(JSON.parse(context.body).architecture).toBe('AgentDash governed record');
  expect(data.rossEvidence.businessOutcomeVerified).toBe(false);
  expect(JSON.stringify(result)).not.toContain('pcpa_syntheticsecret123');
 });
 it('returns attributable bounded source documents through the existing task read',async()=>{
  const {run,calls}=setup();const result=await run();const data=result.data as any;
  expect(result.status).toBe('ok');expect(data.rossEvidence.status).toBe('ok');
  expect(data.rossEvidence.documents.map((d:any)=>d.key)).toEqual(['lead-report','ross-commitments','ross-outcome-checks']);
  const report=data.rossEvidence.documents[0];expect(report).toMatchObject({body:'Delivered report, pending verification.',revisionId:'revision-lead-report',authorAgentId:'lead-1',designatedLeadAuthored:true,freshness:{state:'current'},sourceKind:'untrusted-source-content'});
  expect(data.rossEvidence.businessOutcomeVerified).toBe(false);expect(data.rossEvidence.independentlyRechecked).toBe(false);
  const wire=JSON.stringify(result);expect(wire).not.toContain('pcpa_syntheticsecret123');expect(wire).not.toContain('hidden-field');expect(wire).not.toContain('shouldNeverAppear');
  expect(calls.some(p=>p.endsWith('/private-other-doc'))).toBe(false);
 });
 it('returns the durable Ross review recommendation as attributed untrusted source content',async()=>{
  const {run}=setup(path=>{if(path==='/issues/'+issueId)return issueWithRossReview;if(path.endsWith('/ross-review'))return rossReviewDocument();});
  const result=await run(),data=result.data as any;
  expect(result.status).toBe('ok');
  const review=data.rossEvidence.documents.find((d:any)=>d.key==='ross-review');
  expect(review).toMatchObject({revisionId:'revision-ross-review',revisionNumber:2,authorAgentId:'ross-1',sourceKind:'untrusted-source-content',bodyPresentation:'redacted-source-text',truncated:false,designatedLeadAuthored:false,usableAsCurrentLeadReport:false});
  const body=JSON.parse(review.body);
  expect(body).toMatchObject({schemaVersion:1,kind:'ross-review',answer:longRecommendation,runId:'run-ross-1',sessionId:'session-ross-1',model:'glm-5.3-flash',provider:'zai',outcomeVerification:'not-performed'});
  expect(body.answer.length).toBeGreaterThan(280);
  const wire=JSON.stringify(result);expect(wire).not.toContain('pcpa_syntheticsecret123');expect(wire).not.toContain('hidden-field');
  expect(data.rossEvidence.businessOutcomeVerified).toBe(false);expect(data.rossEvidence.independentlyRechecked).toBe(false);
 });
 it('marks Ross evidence unavailable when the advertised current revision changes during the read',async()=>{
  const {run}=setup((path,count)=>{if(path==='/issues/'+issueId)return count>=3?{...issueWithRossReview,documentSummaries:issueWithRossReview.documentSummaries.map(summary=>summary.key==='ross-review'?{...summary,latestRevisionId:'revision-ross-review-new'}:summary)}:issueWithRossReview;if(path.endsWith('/ross-review'))return rossReviewDocument();});
  const result=await run();expect(result.status).toBe('ok');expect((result.data as any).item).toBeDefined();
  expect((result.data as any).rossEvidence).toMatchObject({status:'unavailable',reason:'source revision changed',documents:[]});
  expect(JSON.stringify(result)).not.toContain(longRecommendation.slice(0,120));
 });
 it('keeps stale and non-lead reports qualified and exposes operator metadata without adopting body claims',async()=>{
  const {run}=setup(path=>path.endsWith('/lead-report')?document('lead-report',{updatedAt:new Date(now-7_200_000).toISOString(),updatedByAgentId:'other-agent'}):path.endsWith('/ross-outcome-checks')?document('ross-outcome-checks',{updatedByAgentId:null,updatedByUserId:'operator-user'}):undefined);
  const data=(await run()).data as any;expect(data.rossEvidence.documents[0]).toMatchObject({designatedLeadAuthored:false,freshness:{state:'stale'},usableAsCurrentLeadReport:false});
  expect(data.rossEvidence.documents[2].operatorAuthored).toBe(true);expect(data.rossEvidence.businessOutcomeVerified).toBe(false);
 });
 it('reports Ross evidence unavailable, without sources, when parent access is revoked during reads',async()=>{
  const {run}=setup((path,count)=>{if(path==='/issues/'+issueId&&count>=3)throw new PaperclipApiError({status:404,method:'GET',path,body:{error:'not found'},message:'revoked'});});
  const result=await run();expect(result.status).toBe('ok');
  expect((result.data as any).rossEvidence).toMatchObject({status:'unavailable',reason:'source read failed (404)',documents:[]});
  expect(JSON.stringify(result)).not.toContain('Delivered report');
 });
 it('marks Ross evidence unavailable for a foreign document rather than merging company data',async()=>{
  const {run}=setup(path=>path.endsWith('/ross-commitments')?document('ross-commitments',{companyId:'foreign-company'}):undefined);
  const result=await run();expect(result.status).toBe('ok');expect((result.data as any).item).toBeDefined();
  expect((result.data as any).rossEvidence).toMatchObject({status:'unavailable',reason:'scoped document required',documents:[]});
  expect(JSON.stringify(result)).not.toContain('Delivered report');
 });
 it('reports missing advertised documents and clips oversized body without claiming complete evidence',async()=>{
  const {run}=setup(path=>{if(path.endsWith('/ross-commitments'))throw new PaperclipApiError({status:404,method:'GET',path,body:{},message:'missing'});if(path.endsWith('/lead-report'))return document('lead-report',{body:'a'.repeat(9000)});});
  const result=await run(),data=result.data as any;expect(data.rossEvidence.missing).toEqual(['ross-commitments']);
  expect(data.rossEvidence.documents[0].truncated).toBe(true);expect(data.rossEvidence.documents[0].body.length).toBeLessThanOrEqual(6000);expect(result.truncated).toBe(true);
 });
 it('does not fetch documents when the server advertises no Ross sources',async()=>{
  const {run,calls}=setup(path=>{if(path==='/issues/'+issueId)return {...issue,documentSummaries:[]};if(path==='/projects/'+projectId)throw Error('no additional project read needed');});
  const result=await run(),data=result.data as any;expect(result.status).toBe('ok');expect(data.rossEvidence).toBeUndefined();expect(calls.some(p=>p.includes('/documents/'))).toBe(false);
 });
 it('does not treat a generic lead-report alone as a Ross issue',async()=>{
  const {run,calls}=setup(path=>{if(path==='/issues/'+issueId)return {...issue,documentSummaries:[{key:'lead-report'}]};if(path==='/projects/'+projectId)throw Error('no additional project read needed');});
  const result=await run(),data=result.data as any;expect(result.status).toBe('ok');expect(data.rossEvidence).toBeUndefined();expect(calls.some(p=>p.includes('/documents/'))).toBe(false);
 });
 it('keeps the task read working when a Ross source read fails unexpectedly',async()=>{
  const {run}=setup(path=>{if(path.endsWith('/ross-commitments'))throw new PaperclipApiError({status:500,method:'GET',path,body:{},message:'boom'});});
  const result=await run(),data=result.data as any;expect(result.status).toBe('ok');expect(data.item).toBeDefined();
  expect(data.rossEvidence).toMatchObject({status:'unavailable',reason:'source read failed (500)',documents:[]});expect(JSON.stringify(result)).not.toContain('Delivered report');
 });
});
