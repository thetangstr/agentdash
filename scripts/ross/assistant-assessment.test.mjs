import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildAssessmentCommentBody,createAssistantAssessment,ASSESSMENT_REQUEST_MARKER} from './assistant-assessment.mjs';

const companyId='11111111-1111-4111-8111-111111111111';
const projectId='22222222-2222-4222-8222-222222222222';
const issueId='33333333-3333-4333-8333-333333333333';
const otherCompany='99999999-9999-4999-8999-999999999999';
const userId='44444444-4444-4444-8444-444444444444';
const rossAgentId='55555555-5555-4555-8555-555555555555';
const nowMs=Date.parse('2026-09-30T12:00:00Z');
const earlier=new Date(nowMs-5*60*1000).toISOString();
const stale=new Date(nowMs-3*60*60*1000).toISOString();

function issue(over={}) {
  return {id:issueId,companyId,projectId,title:'Scoped source issue',identifier:'TST-1',status:'in_review',assigneeAgentId:rossAgentId,documentSummaries:[{key:'ross-review',latestRevisionId:'rev-1'}],...over};
}
function reviewDoc(over={}) {
  return {id:'doc-review',companyId,issueId,key:'ross-review',body:JSON.stringify({schemaVersion:1,kind:'ross-review',answer:'Prioritize the evidence gap.',runId:'run-1',sessionId:'sess-1',model:'glm-5.3-flash',provider:'zai'}),latestRevisionId:'rev-1',latestRevisionNumber:1,updatedByAgentId:rossAgentId,updatedByUserId:null,updatedAt:earlier,...over};
}
function httpError(status) { const e=new Error('dispatch verification denied');e.statusCode=status;return e; }

function fakeTransport(handler) {
  const calls=[];
  const request=async(path,body)=>{
    calls.push({path,body:body===undefined?null:body,method:body===undefined?'GET':'POST'});
    const value=await handler(path,body);
    if(value&&value.__error)throw value.__error;
    return value;
  };
  return {transport:{request},calls,posts:()=>calls.filter(c=>c.method==='POST')};
}
function bound(handler,over={}) {
  const {transport,calls,posts}=fakeTransport(handler);
  return {service:createAssistantAssessment({transport,actor:{userId},companyId,projectId:null,now:()=>nowMs,...over}),calls,posts};
}
const defaultHandler=(path)=> {
  if(path===`/issues/${issueId}`)return issue();
  if(path===`/issues/${issueId}/documents/ross-review`)return reviewDoc();
  if(path.startsWith(`/issues/${issueId}/comments`))return [];
  return {__error:httpError(500)};
};

test('comment body embeds the request marker and bounded question only',()=>{
  const body=buildAssessmentCommentBody({question:'  What should the lead do next? ',requestKey:'req-000001'});
  assert.equal(body,`[${ASSESSMENT_REQUEST_MARKER}req-000001]\nWhat should the lead do next?`);
  assert.throws(()=>buildAssessmentCommentBody({question:'q',requestKey:'!!'}),/requestKey/);
  assert.throws(()=>buildAssessmentCommentBody({question:'x'.repeat(2001),requestKey:'req-000001'}),/question/);
  assert.throws(()=>buildAssessmentCommentBody({question:'',requestKey:'req-000001'}));
});

test('construction requires a transport, a named person and a bounded company scope',()=>{
  assert.throws(()=>createAssistantAssessment({transport:{},actor:{userId},companyId}),/transport/);
  assert.throws(()=>createAssistantAssessment({transport:{request:async()=>{}},actor:{userId:'board'},companyId}),/userId/);
  assert.throws(()=>createAssistantAssessment({transport:{request:async()=>{}},actor:{userId},companyId:'ross'}),/companyId/);
  assert.throws(()=>createAssistantAssessment({transport:{request:async()=>{}},actor:{userId},companyId,projectId:'x'}),/projectId/);
});

test('a fresh stored review is returned attributed with zero mutation calls',async()=>{
  const {service,calls,posts}=bound(defaultHandler);
  const result=await service.readStoredAssessment({issueId});
  assert.equal(result.status,'fresh');
  assert.equal(result.review.revisionId,'rev-1');
  assert.equal(result.review.authorAgentId,rossAgentId);
  assert.equal(result.review.claims.answer,'Prioritize the evidence gap.');
  assert.equal(result.review.claims.model,'glm-5.3-flash');
  assert.equal(result.freshness.state,'current');
  assert.equal(result.businessOutcomeVerified,false);
  assert.equal(result.independentlyRechecked,false);
  assert.equal(posts().length,0);
  assert.ok(calls.every(c=>c.method==='GET'));
});

test('missing or revoked stored review reports unavailable rather than fabricating',async()=>{
  for(const handler of [
    path=>path===`/issues/${issueId}`?issue({documentSummaries:[]}):{__error:httpError(404)},
    path=>path===`/issues/${issueId}`?issue():(path.endsWith('/documents/ross-review')?{__error:httpError(404)}:{__error:httpError(500)}),
    path=>path===`/issues/${issueId}`?{__error:httpError(403)}:{__error:httpError(500)},
    path=>path===`/issues/${issueId}`?issue({companyId:otherCompany}):{__error:httpError(500)},
  ]) {
    const {service,posts}=bound(handler);
    const result=await service.readStoredAssessment({issueId});
    assert.equal(result.status,'unavailable');
    assert.ok(['no-stored-assessment','source-unavailable'].includes(result.reason));
    assert.equal(result.review,undefined);
    assert.equal(posts().length,0);
  }
});

test('a stale stored review stays qualified instead of reading as current',async()=>{
  const {service}=bound(path=>path.endsWith('/documents/ross-review')?reviewDoc({updatedAt:stale}):defaultHandler(path));
  const result=await service.readStoredAssessment({issueId});
  assert.equal(result.status,'stale');
  assert.match(result.reason,/stored-assessment-stale/);
  assert.equal(result.freshness.state,'stale');
});

test('an explicit request posts one attributed question comment through the native pipeline',async()=>{
  const {service,calls}=bound(path=>{
    if(path===`/issues/${issueId}`)return issue();
    if(path.startsWith(`/issues/${issueId}/comments?`))return [];
    if(path===`/issues/${issueId}/comments`)return {id:'comment-1',authorUserId:userId,body:'[x]'};
    return {__error:httpError(500)};
  });
  const result=await service.requestAssessment({issueId,question:'What is the honest next step?',requestKey:'req-000001'});
  assert.equal(result.status,'requested');
  assert.equal(result.receipt.commentId,'comment-1');
  assert.equal(result.receipt.companyId,companyId);
  assert.equal(result.baselineRevisionId,'rev-1');
  assert.equal(result.attribution.verified,true);
  assert.equal(result.inference.state,'delegated-to-native-run-gates');
  const post=calls.find(c=>c.method==='POST');
  assert.match(post.body.body,/^\[ross-assessment-request:req-000001\]\nWhat is the honest next step\?$/);
});

test('coalescing: an identical re-delivery reuses the recorded request without a new write',async()=>{
  const marked=`[${ASSESSMENT_REQUEST_MARKER}req-000001]\nSame question?`;
  const {service,posts}=bound(path=>{
    if(path===`/issues/${issueId}`)return issue();
    if(path.startsWith(`/issues/${issueId}/comments`))return [{id:'comment-9',body:marked,authorUserId:userId}];
    return {__error:httpError(500)};
  });
  const result=await service.requestAssessment({issueId,question:'Same question?',requestKey:'req-000001'});
  assert.equal(result.status,'coalesced');
  assert.equal(result.receipt.commentId,'comment-9');
  assert.equal(result.receipt.reused,true);
  assert.equal(posts().length,0);
});

test('the same request key carrying a different question refuses without writing',async()=>{
  const marked=`[${ASSESSMENT_REQUEST_MARKER}req-000001]\nOriginal question?`;
  const {service,posts}=bound(path=>{
    if(path===`/issues/${issueId}`)return issue();
    if(path.startsWith(`/issues/${issueId}/comments`))return [{id:'comment-9',body:marked,authorUserId:userId}];
    return {__error:httpError(500)};
  });
  const result=await service.requestAssessment({issueId,question:'Different question?',requestKey:'req-000001'});
  assert.equal(result.status,'conflict');
  assert.equal(result.reason,'request-key-carries-different-question');
  assert.equal(posts().length,0);
});

test('denied, missing and unassigned targets return honest statuses and never start inference',async()=>{
  const cases=[
    [path=>path===`/issues/${issueId}`?{__error:httpError(403)}:{__error:httpError(500)},'denied','actor-not-permitted',0],
    [path=>path===`/issues/${issueId}`?{__error:httpError(404)}:{__error:httpError(500)},'unavailable','target-unavailable',0],
    [path=>path===`/issues/${issueId}`?issue({assigneeAgentId:null}):{__error:httpError(500)},'unavailable','no-assigned-agent',0],
    [path=>path===`/issues/${issueId}`?issue({companyId:otherCompany}):{__error:httpError(500)},'unavailable','target-unavailable',0],
    // A write refused by the API was attempted once and refused; no inference.
    [path=>{
      if(path===`/issues/${issueId}`)return issue();
      if(path.startsWith(`/issues/${issueId}/comments?`))return [];
      return {__error:httpError(403)};
    },'denied','actor-not-permitted',1],
  ];
  for(const [handler,status,reason,expectedPosts] of cases) {
    const {service,posts}=bound(handler);
    const result=await service.requestAssessment({issueId,question:'Assess this?',requestKey:'req-000001'});
    assert.equal(result.status,status,reason);
    assert.equal(result.reason,reason);
    assert.equal(posts().length,expectedPosts,reason);
  }
});

test('an uncertain write is reported once and never reposted',async()=>{
  let attempted=0;
  const {service,posts}=bound(path=>{
    if(path===`/issues/${issueId}`)return issue();
    if(path.startsWith(`/issues/${issueId}/comments?`))return [];
    attempted+=1;return {__error:httpError(500)};
  });
  const result=await service.requestAssessment({issueId,question:'Assess this?',requestKey:'req-000001'});
  assert.equal(result.status,'uncertain');
  assert.equal(result.reason,'acceptance-uncertain-read-before-retry');
  assert.equal(attempted,1);
  assert.equal(posts().length,1);
});

test('request validation rejects malformed identity, scope and question shapes',async()=>{
  const {service,posts}=bound(defaultHandler);
  await assert.rejects(()=>service.requestAssessment({issueId:'AGE-1',question:'q',requestKey:'req-000001'}),/issueId/);
  await assert.rejects(()=>service.requestAssessment({issueId,question:'q',requestKey:'short'}),/requestKey/);
  await assert.rejects(()=>service.requestAssessment({issueId,question:'x'.repeat(2001),requestKey:'req-000001'}),/question/);
  assert.equal(posts().length,0);
});

test('attribution mismatch on the accepted comment is surfaced honestly',async()=>{
  const {service}=bound(path=>{
    if(path===`/issues/${issueId}`)return issue();
    if(path.startsWith(`/issues/${issueId}/comments?`))return [];
    return {id:'comment-2',authorUserId:'66666666-6666-4666-8666-666666666666'};
  });
  const result=await service.requestAssessment({issueId,question:'q',requestKey:'req-000001'});
  assert.equal(result.status,'requested');
  assert.equal(result.attribution.verified,false);
});

test('assessmentStatus answers only from a fresh, newer stored review',async()=>{
  const {service}=bound(path=>path.endsWith('/documents/ross-review')?reviewDoc():defaultHandler(path));
  const answered=await service.assessmentStatus({issueId});
  assert.equal(answered.status,'answered');
  const pending=await service.assessmentStatus({issueId,baselineRevisionId:'rev-1'});
  assert.equal(pending.status,'pending');
  assert.equal(pending.reason,'assessment-not-yet-published');
  const newer=await service.assessmentStatus({issueId,baselineRevisionId:'rev-0'});
  assert.equal(newer.status,'answered');
  const tooEarly=await service.assessmentStatus({issueId,requestedAt:new Date(nowMs).toISOString()});
  assert.equal(tooEarly.status,'pending');
  const answeredByTime=await service.assessmentStatus({issueId,requestedAt:new Date(nowMs-10*60*1000).toISOString()});
  assert.equal(answeredByTime.status,'answered');
});

test('a pending answer surfaces the native run gate honestly when readable',async()=>{
  const {service}=bound(path=>{
    if(path.endsWith('/documents/ross-review'))return reviewDoc();
    if(path===`/issues/${issueId}/runs?limit=3`)return [{status:'failed',resultJson:{stopReason:'budget_exceeded'},livenessReason:null,finishedAt:earlier}];
    return defaultHandler(path);
  });
  const result=await service.assessmentStatus({issueId,baselineRevisionId:'rev-1'});
  assert.equal(result.status,'pending');
  assert.equal(result.gate.state,'last-run-observed');
  assert.equal(result.gate.lastRun.stopReason,'budget_exceeded');
  const noRuns=await bound(defaultHandler).service.assessmentStatus({issueId,baselineRevisionId:'rev-1'});
  assert.equal(noRuns.status,'pending');
  assert.equal(noRuns.gate.state,'no-run-visible');
});

test('assessmentStatus keeps unavailable and stale answers truthful',async()=>{
  const missing=bound(path=>path===`/issues/${issueId}`?issue({documentSummaries:[]}):{__error:httpError(404)});
  const gone=await missing.service.assessmentStatus({issueId,baselineRevisionId:'rev-1'});
  assert.equal(gone.status,'unavailable');
  const staleBound=bound(path=>path.endsWith('/documents/ross-review')?reviewDoc({updatedAt:stale}):defaultHandler(path));
  const staleResult=await staleBound.service.assessmentStatus({issueId,baselineRevisionId:'rev-0'});
  assert.equal(staleResult.status,'stale');
});
