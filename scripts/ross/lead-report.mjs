import {createHash} from 'node:crypto';
import {lstat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {assertGovernedRun,assertGovernedCheckout,assertGovernedReceipt} from './governed-invocation.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Runtime-owned single mutation. The model never receives a write tool or key.
export async function publishGovernedLeadReport({binding,invocation,receipt,request,workspace}) {
  if(invocation.apiUrl!==binding.apiUrl||['companyId','projectId','agentId'].some(key=>invocation.scope?.[key]!==binding[key])||!uuid.test(invocation.runId??'')||!uuid.test(invocation.issueId??''))throw Error('scoped lead invocation required');
  assertGovernedReceipt(receipt,binding);
  if(receipt.executionMode!=='governed'||receipt.runId!==invocation.runId||!/^\d{8}_\d{6}_[a-z0-9]{6,}(?:_[\w-]+)?$/.test(receipt.sessionId)||Buffer.byteLength(receipt.answer)>20_000)throw Error('scoped governed lead receipt required');
  const stat=await lstat(workspace);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('private publication workspace required');
  const actor=await request('/agents/me');
  const project=await request(`/projects/${binding.projectId}`);
  if(project.id!==binding.projectId||project.companyId!==binding.companyId||project.leadAgentId!==binding.agentId)throw Error('designated project lead required');
  const run=await request(`/heartbeat-runs/${invocation.runId}`);
  const issue=await request(`/issues/${invocation.issueId}`);
  assertGovernedRun(invocation,actor,run,issue);
  assertGovernedCheckout(invocation,issue);
  const path=`/issues/${invocation.issueId}/documents/lead-report`;
  const previous=await request(path);
  if(previous.companyId!==binding.companyId||previous.issueId!==invocation.issueId||previous.key!=='lead-report'||!uuid.test(previous.id??'')||!uuid.test(previous.latestRevisionId??'')||!Number.isSafeInteger(previous.latestRevisionNumber)||previous.latestRevisionNumber<1)throw Error('scoped existing lead report revision required');
  const bodySha256=createHash('sha256').update(receipt.answer).digest('hex');
  const intent={recordedAt:new Date().toISOString(),runId:invocation.runId,scope:invocation.scope,issueId:invocation.issueId,baseRevisionId:previous.latestRevisionId,bodySha256,phase:'reserved-no-repeat'};
  // An ambiguous PUT leaves this reservation in place. Operator inspection,
  // not an automatic retry, determines whether the existing revision changed.
  await writeFile(join(workspace,`lead-report-intent-${invocation.runId}.json`),JSON.stringify(intent,null,2),{flag:'wx',mode:0o600});
  const body={format:'markdown',body:receipt.answer,baseRevisionId:previous.latestRevisionId,...(previous.title!==undefined?{title:previous.title}:{})};
  const published=await request(path,body,'PUT');
  const check=document=>{
    if(document.companyId!==binding.companyId||document.issueId!==invocation.issueId||document.key!=='lead-report'||document.id!==previous.id||!uuid.test(document.latestRevisionId??'')||document.latestRevisionId===previous.latestRevisionId||document.latestRevisionNumber!==previous.latestRevisionNumber+1||document.updatedByAgentId!==binding.agentId||document.updatedByUserId!==null||document.body!==receipt.answer)throw Error('exact lead report body/revision readback required');
  };
  check(published);
  const readback=await request(path);check(readback);
  if(readback.latestRevisionId!==published.latestRevisionId)throw Error('lead report revision changed');
  const publication={issueId:invocation.issueId,documentId:published.id,revisionId:published.latestRevisionId,revisionNumber:published.latestRevisionNumber,bodySha256,runId:invocation.runId,source:binding.apiUrl+path};
  await writeFile(join(workspace,`lead-report-publication-${invocation.runId}.json`),JSON.stringify({recordedAt:new Date().toISOString(),publication,qualification:'Actual governed lead report publication; business claims remain reported, not independently verified.'},null,2),{flag:'wx',mode:0o600});
  return publication;
}
