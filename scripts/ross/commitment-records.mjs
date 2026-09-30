// Typed source content is never authorization or independent outcome proof.
export const isRossUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const select = (row, fields) => Object.fromEntries(fields.map(key => [key, row[key] ?? null]));
function keys(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('structured object required');
  if (Object.keys(value).some(key => !allowed.includes(key))) throw Error('unknown record field');
  if (required.some(key => !(key in value))) throw Error('missing record field');
}
function text(value, limit) { if(typeof value !== 'string' || !value.trim() || value.length > limit) throw Error('bounded text required'); }
function ids(value, fields) { keys(value, fields); if(fields.some(key => !isRossUuid(value[key]))) throw Error('source UUID required'); }
export function rossSourceTime(value) {
  if(typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw Error('valid ISO source time required');
  return Date.parse(value);
}
export function parseCommitmentDocument(body) {
  if(typeof body !== 'string' || Buffer.byteLength(body) > 65_536) throw Error('commitment document size limit');
  let data;try { data=JSON.parse(body); } catch { throw Error('invalid commitment JSON'); }
  keys(data,['schemaVersion','provenance','commitments']);
  if(data.schemaVersion!==1) throw Error('unsupported commitment schema');
  text(data.provenance,4000);
  if(!Array.isArray(data.commitments) || data.commitments.length>20) throw Error('commitment count limit');
  const seen=new Set();
  for(const c of data.commitments) {
    const fields=['id','title','decision','checkpoint','recommendation','acknowledgment','reportedDelivery','verification'];
    keys(c,[...fields,'checkpointAt'],fields);
    if(typeof c.id!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(c.id)) throw Error('bounded commitment ID required');
    if(seen.has(c.id)) throw Error('duplicate commitment ID');seen.add(c.id);
    text(c.title,500);text(c.checkpoint,500);
    if(!['accepted','challenged'].includes(c.decision)) throw Error('explicit lead decision required');
    if(c.checkpointAt!==undefined) { try { rossSourceTime(c.checkpointAt); } catch { throw Error('invalid checkpoint time'); } }
    ids(c.recommendation,['issueId','commentId','runId']);ids(c.acknowledgment,['issueId','commentId']);
    if(c.reportedDelivery!==null) {
      keys(c.reportedDelivery,['kind','issueId','key','revisionId']);
      if(c.reportedDelivery.kind!=='issue-document-revision' || c.reportedDelivery.key!=='lead-report') throw Error('unsupported delivery reference');
      if(!isRossUuid(c.reportedDelivery.issueId) || !isRossUuid(c.reportedDelivery.revisionId)) throw Error('delivery UUID required');
    }
    keys(c.verification,['status']);if(c.verification.status!=='not-performed') throw Error('verification cannot be asserted by a lead record');
  }
  return data;
}

// Only createRossBridge calls this after authenticating actor/project/parent.
export async function collectCommitmentSources({get,check,rows,root,scope,project,issue}) {
  const leadId=project.leadAgentId;
  if(!isRossUuid(leadId)) throw Error('current project lead required');
  const binding={apiUrl:root,...scope,issueId:issue.id,leadId};
  const path=`/issues/${issue.id}/documents/ross-commitments`;
  const doc=await get(path,true);const sources=[];const records=[];
  const add=(key,payload)=>sources.push({key,payload});
  const parent=async id=> { if(!isRossUuid(id))throw Error('source issue UUID required');return check(await get(`/issues/${id}`),{id,companyId:scope.companyId,projectId:scope.projectId}); };
  const revision=async (issueId,key,revisionId,documentId=null)=>{
    await parent(issueId);
    const history=rows(await get(`/issues/${issueId}/documents/${key}/revisions`,true)??[]);
    if(history.length>100)throw Error('revision history pilot limit');
    for(const r of history)check(r,{companyId:scope.companyId,issueId,key});
    const r=history.find(r=>r.id===revisionId);
    if(!r)return null;
    if(!isRossUuid(r.id)||!isRossUuid(r.documentId)||!Number.isInteger(r.revisionNumber)||r.revisionNumber<1)throw Error('invalid revision metadata');
    if(documentId&&r.documentId!==documentId)throw Error('revision document mismatch');
    if(r.createdByAgentId!==leadId||r.createdByUserId)throw Error('lead revision author mismatch');
    const payload={...select(r,['id','companyId','documentId','issueId','key','revisionNumber','body','createdByAgentId','createdByUserId','createdAt']),creatingRunId:null,source:root+`/issues/${issueId}/documents/${key}/revisions`};
    add('revision:'+r.documentId+':'+r.id,payload);return payload;
  };
  let document=null;
  if(doc) {
    check(doc,{companyId:scope.companyId,issueId:issue.id,key:'ross-commitments'});
    if(!isRossUuid(doc.id)||!isRossUuid(doc.latestRevisionId)||doc.updatedByAgentId!==leadId||doc.updatedByUserId)throw Error('lead document author/revision mismatch');
    const decoded=parseCommitmentDocument(doc.body);
    const current=await revision(issue.id,'ross-commitments',doc.latestRevisionId,doc.id);
    if(!current||current.body!==doc.body||current.revisionNumber!==doc.latestRevisionNumber)throw Error('latest document revision mismatch');
    document={...select(doc,['id','companyId','issueId','key','body','latestRevisionId','latestRevisionNumber','updatedByAgentId','updatedByUserId','updatedAt']),source:root+path};
    add('document:'+doc.id+':'+doc.latestRevisionId,document);
    for(const c of decoded.commitments) {
      const problems=[];
      const comment=async(ref,author)=>{
        await parent(ref.issueId);
        const row=await get(`/issues/${ref.issueId}/comments/${ref.commentId}`,true);
        if(!row)return null;
        check(row,{id:ref.commentId,companyId:scope.companyId,issueId:ref.issueId});
        if(row.authorAgentId!==author||row.authorUserId)throw Error('linked comment author mismatch');
        const payload={...select(row,['id','companyId','issueId','body','authorAgentId','authorUserId','createdByRunId','createdAt','updatedAt']),source:root+`/issues/${ref.issueId}/comments/${ref.commentId}`};
        add('comment:'+row.id+':'+(row.updatedAt??row.createdAt),payload);return row;
      };
      const advice=await comment(c.recommendation,scope.agentId);
      if(!advice)problems.push('missing_advice');
      else {
        if(advice.createdByRunId!==c.recommendation.runId)throw Error('advice run attribution mismatch');
        const run=await get(`/heartbeat-runs/${c.recommendation.runId}`,true);
        if(!run)problems.push('missing_run');
        else {
          check(run,{id:c.recommendation.runId,companyId:scope.companyId,agentId:scope.agentId});
          if(run.contextSnapshot?.issueId!==c.recommendation.issueId||run.status!=='succeeded')throw Error('historical run issue/status mismatch');
          if(typeof run.resultJson?.result!=='string')throw Error('historical run answer missing');
          if(run.resultJson.result!==advice.body)problems.push('advice_content_changed');
          add('run:'+run.id,{...select(run,['id','companyId','agentId','status','startedAt','finishedAt']),issueId:run.contextSnapshot.issueId,answer:run.resultJson.result,source:root+`/heartbeat-runs/${run.id}`});
        }
      }
      const ack=await comment(c.acknowledgment,leadId);
      if(!ack)problems.push('acknowledgment_source_missing');
      if(c.reportedDelivery) {
        const d=c.reportedDelivery;
        const delivery=await revision(d.issueId,d.key,d.revisionId);
        if(!delivery)problems.push('missing_reported_delivery');
      }
      records.push({commitment:c,issues:problems});
    }
  }
  const again=await get(path,true);
  if(Boolean(again)!==Boolean(doc)||(doc&&(again.latestRevisionId!==doc.latestRevisionId||again.body!==doc.body||again.updatedByAgentId!==doc.updatedByAgentId||again.updatedByUserId!==doc.updatedByUserId)))throw Error('commitment document changed during collection');
  const observedAt=new Date().toISOString();
  for(const source of sources)for(const field of ['createdAt','updatedAt','startedAt','finishedAt'])if(source.payload[field]!==undefined&&source.payload[field]!==null&&rossSourceTime(source.payload[field])>Date.parse(observedAt))throw Error('future source timestamp');
  if(document&&rossSourceTime(document.updatedAt)>Date.parse(observedAt))throw Error('future document timestamp');
  return {scope:binding,document,records,sources,observedAt,consistency:'sequential-reads-not-atomic',outcomeVerification:'not-performed'};
}
