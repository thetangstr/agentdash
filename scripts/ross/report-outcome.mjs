import {createHash} from 'node:crypto';
import {isRossUuid,rossSourceTime} from './commitment-records.mjs';

const tool = 'mcp__ross_agentdash__ross_issue_evidence';
const hash = body => createHash('sha256').update(body).digest('hex');
const matches = (row,expected) => row && Object.entries(expected).every(([key,value])=>row[key]===value);
function decode(content) {
  if(typeof content!=='string'||Buffer.byteLength(content)>1_048_576)return null;
  if(content.startsWith('<untrusted_tool_result ')) {
    if(!content.startsWith(`<untrusted_tool_result source="${tool}">\n`)||!content.endsWith('\n</untrusted_tool_result>'))return null;
    const start=content.indexOf('\n\n');if(start<0)return null;
    content=content.slice(start+2,-'\n</untrusted_tool_result>'.length);
  }
  try {
    let value=JSON.parse(content);
    if(typeof value?.result==='string')value=JSON.parse(value.result);
    return value;
  }catch {return null;}
}
function issuedCall(message,callId,issueId) {
  try {
    return JSON.parse(message.tool_calls).some(call=>{
      if(call.id!==callId||call.function?.name!=='tool_call')return false;
      const args=JSON.parse(call.function.arguments);
      return Array.isArray(args.calls)&&args.calls.length===1&&args.calls[0].name===tool&&matches(args.calls[0].arguments,{issueId})&&Object.keys(args.calls[0].arguments).length===1;
    });
  }catch {return false;}
}

// Owner-side evaluator: caller supplies authenticated API sources and a locked,
// terminal private ledger snapshot. Never invoked with model-provided messages.
export function verifyReportPublicationConsumed({scope,commitment,revision,consumingRun:run,answerComment:comment,messages}) {
  if(!scope||['companyId','projectId','agentId','issueId','leadId'].some(key=>!isRossUuid(scope[key])))throw Error('outcome scope required');
  if(!matches(revision,{companyId:scope.companyId,issueId:scope.issueId,key:'lead-report',createdByAgentId:scope.leadId,createdByUserId:null})||!isRossUuid(revision?.id)||!isRossUuid(revision?.documentId)||typeof revision.body!=='string')throw Error('publication scope/author mismatch');
  if(!matches(run,{companyId:scope.companyId,agentId:scope.agentId,status:'succeeded'})||!isRossUuid(run?.id)||!isRossUuid(run?.issueId)||typeof run.sessionId!=='string'||!run.sessionId||typeof run.answer!=='string')throw Error('succeeded scoped run required');
  if(!matches(comment,{companyId:scope.companyId,issueId:run.issueId,authorAgentId:scope.agentId,authorUserId:null,createdByRunId:run.id})||!isRossUuid(comment?.id))throw Error('comment attribution mismatch');
  if(comment.body!==run.answer)throw Error('attributed answer changed');
  if(!Array.isArray(messages)||messages.length>1000)throw Error('bounded ledger messages required');
  if(messages.some(message=>message.session_id!==run.sessionId))throw Error('private ledger session mismatch');
  const published=rossSourceTime(revision.createdAt),start=rossSourceTime(run.startedAt),end=rossSourceTime(run.finishedAt);
  if(start>end)throw Error('invalid consuming run interval');
  const result={kind:'lead-report-publication-consumed',commitmentId:commitment.id,status:'not-verified',businessOutcomeVerified:false,reportClaimsVerified:false,
    revisionId:revision.id,bodySha256:hash(revision.body),runId:run.id,answerCommentId:comment.id,sessionId:run.sessionId,publicationAt:revision.createdAt,
    scope:{companyId:scope.companyId,projectId:scope.projectId,issueId:scope.issueId,agentId:scope.agentId,leadId:scope.leadId},
    qualification:'Exact historical publication and consumption only; no business completion, current status, permission or artifact approval claim.'};
  if(!matches(commitment.reportedDelivery,{kind:'issue-document-revision',issueId:scope.issueId,key:'lead-report',revisionId:revision.id}))return {...result,reason:'delivery_reference_mismatch'};
  for(const message of messages) {
    if(message.role!=='tool'||message.tool_name!==tool||!Number.isFinite(message.timestamp))continue;
    const time=message.timestamp*1000;
    if(time<start||time>end||time<published)continue;
    const issued=messages.find(candidate=>candidate.role==='assistant'&&candidate.id<message.id&&Number.isFinite(candidate.timestamp)&&candidate.timestamp*1000>=start&&candidate.timestamp<=message.timestamp&&issuedCall(candidate,message.tool_call_id,scope.issueId));
    if(!issued)continue;
    const payload=decode(message.content);if(!payload)continue;
    if(!matches(payload.scope,{companyId:scope.companyId,projectId:scope.projectId,agentId:scope.agentId})||!matches(payload.issue,{id:scope.issueId,companyId:scope.companyId,projectId:scope.projectId}))throw Error('actual tool response scope mismatch');
    let observed;try {observed=rossSourceTime(payload.observedAt);}catch {continue;}
    if(observed<published||observed<start||observed>time||observed-published>3_600_000)continue;
    if(!matches(payload.leadReport,{id:revision.documentId,latestRevisionId:revision.id,latestRevisionNumber:revision.revisionNumber,body:revision.body,updatedByAgentId:scope.leadId,updatedByUserId:null}))continue;
    return {...result,status:'verified',toolMessageId:message.id,toolCallId:message.tool_call_id,consumedAt:new Date(time).toISOString(),sourceObservedAt:payload.observedAt};
  }
  return {...result,reason:'exact_scoped_fresh_tool_read_missing'};
}
