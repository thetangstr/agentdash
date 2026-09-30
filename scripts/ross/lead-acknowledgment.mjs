import {createHash} from 'node:crypto';
import {lstat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {assertGovernedRun,assertGovernedCheckout,assertGovernedReceipt} from './governed-invocation.mjs';
import {isRossUuid,rossSourceTime,parseCommitmentDocument} from './commitment-records.mjs';

const matches=(row,expected)=>row&&Object.entries(expected).every(([key,value])=>row[key]===value);
function exactKeys(value,fields) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(key=>!Object.hasOwn(value,key)))throw Error('exact acknowledgment schema required');
}
function bounded(value,limit) {if(typeof value!=='string'||!value.trim()||value.length>limit)throw Error('bounded acknowledgment decision required');}

// The API's multiline text normalizer rewrites literal \\n/\\r sequences,
// even inside JSON strings. Tokenize escapes so both line breaks and literal
// backslashes retain their decoded values across that normalizer.
export function encodeLeadJsonForApi(value) {
  const replacements={'\\n':'\\u000a','\\r':'\\u000d','\\\\':'\\u005c'};
  return JSON.stringify(value,null,2).replace(/\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/g,token=>replacements[token]??token);
}

// One fixed recommendation, selected by the pilot operator. Model text can
// accept/challenge it, but cannot select a different identity, source or action.
export async function publishGovernedLeadAcknowledgment({binding,invocation,receipt,request,workspace}) {
  const config=binding.acknowledgment;
  exactKeys(config,['commitmentId','rossAgentId','recommendation']);
  exactKeys(config.recommendation,['issueId','commentId','runId']);
  if(binding.role!=='lead'||!isRossUuid(config.rossAgentId)||config.rossAgentId===binding.agentId||!Object.values(config.recommendation).every(isRossUuid)||typeof config.commitmentId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(config.commitmentId)||invocation.apiUrl!==binding.apiUrl||['companyId','projectId','agentId'].some(key=>invocation.scope?.[key]!==binding[key])||!isRossUuid(invocation.runId)||!isRossUuid(invocation.issueId))throw Error('scoped lead acknowledgment binding required');
  assertGovernedReceipt(receipt,binding);
  if(receipt.executionMode!=='governed'||receipt.runId!==invocation.runId||!/^\d{8}_\d{6}_[a-z0-9]{6,}(?:_[\w-]+)?$/.test(receipt.sessionId)||Buffer.byteLength(receipt.answer)>8192)throw Error('actual governed acknowledgment receipt required');
  let decision;try {decision=JSON.parse(receipt.answer);}catch {throw Error('JSON acknowledgment decision required');}
  exactKeys(decision,['schemaVersion','decision','title','reason','checkpoint','checkpointAt']);
  if(decision.schemaVersion!==1||!['accepted','challenged'].includes(decision.decision))throw Error('explicit acknowledgment decision required');
  bounded(decision.title,500);bounded(decision.reason,1000);bounded(decision.checkpoint,500);
  const checkpoint=rossSourceTime(decision.checkpointAt),now=Date.now();
  if(checkpoint<=now||checkpoint>now+48*60*60*1000)throw Error('future bounded decision checkpoint required');
  const stat=await lstat(workspace);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('private acknowledgment workspace required');
  const currentAuthority=async()=>{
    const actor=await request('/agents/me'),project=await request(`/projects/${binding.projectId}`);
    if(!matches(project,{id:binding.projectId,companyId:binding.companyId,leadAgentId:binding.agentId}))throw Error('designated project lead required');
    const run=await request(`/heartbeat-runs/${invocation.runId}`),issue=await request(`/issues/${invocation.issueId}`);
    assertGovernedRun(invocation,actor,run,issue);assertGovernedCheckout(invocation,issue);
  };
  const adviceAuthority=async()=>{
    const ref=config.recommendation;
    const parent=await request(`/issues/${ref.issueId}`),ross=await request(`/agents/${config.rossAgentId}`);
    if(!matches(parent,{id:ref.issueId,companyId:binding.companyId,projectId:binding.projectId})||!matches(ross,{id:config.rossAgentId,companyId:binding.companyId}))throw Error('same-project recommendation scope required');
    const run=await request(`/heartbeat-runs/${ref.runId}`),comment=await request(`/issues/${ref.issueId}/comments/${ref.commentId}`);
    if(!matches(run,{id:ref.runId,companyId:binding.companyId,agentId:config.rossAgentId,status:'succeeded'})||run.contextSnapshot?.issueId!==ref.issueId||!matches(comment,{id:ref.commentId,companyId:binding.companyId,issueId:ref.issueId,authorAgentId:config.rossAgentId,authorUserId:null,createdByRunId:ref.runId})||typeof comment.body!=='string'||!comment.body.trim()||run.resultJson?.result!==comment.body)throw Error('exact succeeded recommendation run/answer required');
  };
  await currentAuthority();await adviceAuthority();
  const path=`/issues/${invocation.issueId}/documents/ross-commitments`;let previous,missing=false;
  try {previous=await request(path);}catch(error){if(error.statusCode!==404)throw error;previous=null;missing=true;}
  if(!missing&&(!matches(previous,{companyId:binding.companyId,issueId:invocation.issueId,key:'ross-commitments',updatedByAgentId:binding.agentId,updatedByUserId:null})||!isRossUuid(previous.id)||!isRossUuid(previous.latestRevisionId)||!Number.isSafeInteger(previous.latestRevisionNumber)||previous.latestRevisionNumber<1))throw Error('existing scoped lead commitment revision required');
  const decoded=previous?parseCommitmentDocument(previous.body):{schemaVersion:1,provenance:'Run-owned lead acknowledgment commitments; no outcome verification.',commitments:[]};
  if(decoded.commitments.some(c=>c.id===config.commitmentId))throw Error('duplicate commitment already exists');
  const nextBody=commentId=>encodeLeadJsonForApi({schemaVersion:1,provenance:decoded.provenance+`\nActual lead run ${invocation.runId} appended ${config.commitmentId}; prior records retained, outcome verification not performed.`,commitments:[...decoded.commitments,{id:config.commitmentId,title:decision.title,decision:decision.decision,checkpoint:decision.checkpoint,checkpointAt:decision.checkpointAt,recommendation:config.recommendation,acknowledgment:{issueId:invocation.issueId,commentId},reportedDelivery:null,verification:{status:'not-performed'}}]});
  // Check limits/schema before either mutation; only the actual API comment ID
  // is substituted after the first write. Partial success is inspectable.
  parseCommitmentDocument(nextBody(invocation.runId));
  const wireAnswer=/\\[nr]/.test(receipt.answer)?encodeLeadJsonForApi(decision):receipt.answer;
  const answerEncoding=wireAnswer===receipt.answer?'exact-model-bytes':'JSON-equivalent-API-safe-encoding';
  const intent={recordedAt:new Date().toISOString(),runId:invocation.runId,commitmentId:config.commitmentId,scope:invocation.scope,issueId:invocation.issueId,baseRevisionId:previous?.latestRevisionId??null,answerSha256:createHash('sha256').update(receipt.answer).digest('hex'),answerEncoding,phase:'reserved-no-repeat'};
  await writeFile(join(workspace,`lead-acknowledgment-intent-${invocation.runId}.json`),JSON.stringify(intent,null,2),{flag:'wx',mode:0o600});
  const posted=await request(`/issues/${invocation.issueId}/comments`,{body:wireAnswer});
  const checkComment=comment=>{if(!isRossUuid(comment?.id)||!matches(comment,{companyId:binding.companyId,issueId:invocation.issueId,authorAgentId:binding.agentId,authorUserId:null,createdByRunId:invocation.runId,body:wireAnswer}))throw Error('exact actual lead acknowledgment comment required');};
  checkComment(posted);
  const ack=await request(`/issues/${invocation.issueId}/comments/${posted.id}`);checkComment(ack);
  await writeFile(join(workspace,`lead-acknowledgment-source-${invocation.runId}.json`),JSON.stringify({recordedAt:new Date().toISOString(),answerEncoding,comment:ack},null,2),{flag:'wx',mode:0o600});
  await currentAuthority();await adviceAuthority();
  const body=nextBody(ack.id);parseCommitmentDocument(body);
  const published=await request(path,{format:'markdown',body,baseRevisionId:previous?.latestRevisionId??null,...(previous?.title!==undefined?{title:previous.title}:{})},'PUT');
  const checkDocument=document=>{if(!matches(document,{...(previous?{id:previous.id}:{}),companyId:binding.companyId,issueId:invocation.issueId,key:'ross-commitments',updatedByAgentId:binding.agentId,updatedByUserId:null,latestRevisionNumber:(previous?.latestRevisionNumber??0)+1,body})||!isRossUuid(document.id)||!isRossUuid(document.latestRevisionId)||document.latestRevisionId===previous?.latestRevisionId)throw Error('exact acknowledgment revision/body readback required');};
  checkDocument(published);const readback=await request(path);checkDocument(readback);
  if(readback.id!==published.id||readback.latestRevisionId!==published.latestRevisionId)throw Error('acknowledgment revision changed');
  const publication={commitmentId:config.commitmentId,decision:decision.decision,acknowledgmentCommentId:ack.id,revisionId:published.latestRevisionId,revisionNumber:published.latestRevisionNumber,runId:invocation.runId};
  await writeFile(join(workspace,`lead-acknowledgment-publication-${invocation.runId}.json`),JSON.stringify({...publication,recordedAt:new Date().toISOString(),qualification:'Actual model acknowledgment and typed commitment publication; no business completion or independent outcome verification.'},null,2),{flag:'wx',mode:0o600});
  return publication;
}
