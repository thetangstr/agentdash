import {createHash} from 'node:crypto';
import {lstat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {assertGovernedRun,assertGovernedCheckout,assertGovernedReceipt} from './governed-invocation.mjs';
import {encodeLeadJsonForApi} from './lead-acknowledgment.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exactSession=/^\d{8}_\d{6}_[a-z0-9]{6,}(?:_[\w-]+)?$/;
const matches=(row,expected)=>row&&Object.entries(expected).every(([key,value])=>row[key]===value);

// Runtime-owned durable review. The model supplies only answer text; the
// harness fixes key, identity, model/provider, and source references.
export async function publishGovernedRossReview({binding,invocation,receipt,request,workspace}) {
  if((binding.role??'ross')!=='ross'||invocation.apiUrl!==binding.apiUrl||['companyId','projectId','agentId'].some(key=>invocation.scope?.[key]!==binding[key])||!uuid.test(invocation.runId??'')||!uuid.test(invocation.issueId??''))throw Error('scoped ross review binding required');
  assertGovernedReceipt(receipt,binding);
  if(receipt.executionMode!=='governed'||receipt.runId!==invocation.runId||!exactSession.test(receipt.sessionId)||Buffer.byteLength(receipt.answer)>20_000)throw Error('actual governed ross review receipt required');
  const stat=await lstat(workspace);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('private ross review workspace required');
  const actor=await request('/agents/me'),project=await request(`/projects/${binding.projectId}`);
  if(!matches(project,{id:binding.projectId,companyId:binding.companyId}))throw Error('current ross project visibility required');
  const run=await request(`/heartbeat-runs/${invocation.runId}`),issue=await request(`/issues/${invocation.issueId}`);
  assertGovernedRun(invocation,actor,run,issue);
  assertGovernedCheckout(invocation,issue);

  const path=`/issues/${invocation.issueId}/documents/ross-review`;
  let previous,missing=false;
  try {previous=await request(path);}
  catch(error) {
    if(error.statusCode!==404)throw Error('ross review document read denied');
    missing=true;
  }
  if(!missing&&(!matches(previous,{companyId:binding.companyId,issueId:invocation.issueId,key:'ross-review',updatedByAgentId:binding.agentId,updatedByUserId:null})||!uuid.test(previous.id??'')||!uuid.test(previous.latestRevisionId??'')||!Number.isSafeInteger(previous.latestRevisionNumber)||previous.latestRevisionNumber<1))throw Error('existing scoped ross review revision required');

  const body=encodeLeadJsonForApi({schemaVersion:1,kind:'ross-review',answer:receipt.answer,runId:invocation.runId,sessionId:receipt.sessionId,model:'glm-5.3-flash',provider:'zai',outcomeVerification:'not-performed'});
  const decoded=JSON.parse(body);
  if(decoded.answer!==receipt.answer||decoded.runId!==invocation.runId||decoded.sessionId!==receipt.sessionId||decoded.model!=='glm-5.3-flash'||decoded.provider!=='zai'||decoded.outcomeVerification!=='not-performed')throw Error('exact ross review source JSON required');
  const bodySha256=createHash('sha256').update(body).digest('hex');
  const intent={recordedAt:new Date().toISOString(),runId:invocation.runId,scope:invocation.scope,issueId:invocation.issueId,baseRevisionId:missing?null:previous.latestRevisionId,bodySha256,phase:'reserved-no-repeat'};
  await writeFile(join(workspace,`ross-review-intent-${invocation.runId}.json`),JSON.stringify(intent,null,2),{flag:'wx',mode:0o600});
  const published=await request(path,{format:'markdown',body,baseRevisionId:missing?null:previous.latestRevisionId,...(!missing&&previous.title!==undefined?{title:previous.title}:{})},'PUT');
  const check=document=>{
    if(!matches(document,{...(!missing?{id:previous.id}:{}),companyId:binding.companyId,issueId:invocation.issueId,key:'ross-review',updatedByAgentId:binding.agentId,updatedByUserId:null,latestRevisionNumber:(missing?0:previous.latestRevisionNumber)+1,body})||!uuid.test(document?.id??'')||!uuid.test(document.latestRevisionId??'')||(!missing&&document.latestRevisionId===previous.latestRevisionId))throw Error('exact ross review body/revision readback required');
  };
  check(published);
  const readback=await request(path);
  check(readback);
  if(readback.id!==published.id||readback.latestRevisionId!==published.latestRevisionId)throw Error('ross review revision changed');
  const publication={issueId:invocation.issueId,documentId:published.id,revisionId:published.latestRevisionId,revisionNumber:published.latestRevisionNumber,bodySha256,runId:invocation.runId,source:binding.apiUrl+path};
  await writeFile(join(workspace,`ross-review-publication-${invocation.runId}.json`),JSON.stringify({recordedAt:new Date().toISOString(),publication,qualification:'Actual governed Ross review publication; outcome verification not performed.'},null,2),{flag:'wx',mode:0o600});
  return publication;
}
