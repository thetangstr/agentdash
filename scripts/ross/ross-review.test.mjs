import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildGovernedInvocation} from './governed-invocation.mjs';
import {publishGovernedRossReview} from './ross-review.mjs';

const companyId='11111111-1111-4111-8111-111111111111';
const projectId='22222222-2222-4222-8222-222222222222';
const rossAgentId='33333333-3333-4333-8333-333333333333';
const runId='44444444-4444-4444-8444-444444444444';
const issueId='55555555-5555-4555-8555-555555555555';
const documentId='66666666-6666-4666-8666-666666666666';
const baseRevisionId='77777777-7777-4777-8777-777777777777';
const nextRevisionId='88888888-8888-4888-8888-888888888888';
const apiUrl='http://127.0.0.1:3100/api';
const answer='Ross recommendation line 1\nline 2 with literal slash \\ and encoded-looking \\n text.';
const path=`/issues/${issueId}/documents/ross-review`;

const token=claims=>[
  Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),
  Buffer.from(JSON.stringify({sub:rossAgentId,company_id:companyId,run_id:runId,adapter_type:'hermes_local',exp:Math.floor(Date.now()/1000)+600,...claims})).toString('base64url'),
  'synthetic_signature',
].join('.');

const binding={apiUrl,companyId,projectId,agentId:rossAgentId,role:'ross'};
const args=['chat','-q','Publish the governed Ross review.','-Q','-m','glm-5.3-flash','--provider','zai','-t','ross_agentdash','--max-turns','4','--source','tool'];
const env={PAPERCLIP_API_URL:apiUrl,PAPERCLIP_COMPANY_ID:companyId,PAPERCLIP_AGENT_ID:rossAgentId,PAPERCLIP_RUN_ID:runId,PAPERCLIP_TASK_ID:issueId,PAPERCLIP_API_KEY:token({})};
const invocation=buildGovernedInvocation(binding,args,env);

function receipt(overrides={}) {
  const sessionId=overrides.sessionId??'20260930_081500_abcd12_full';
  return {
    scope:{companyId,projectId,agentId:rossAgentId},
    executionMode:'governed',
    runId,
    requestedModel:'glm-5.3-flash',
    endpoint:'https://api.z.ai/api/paas/v4',
    sessionId,
    answer,
    failure:null,
    usage:{modelRows:[{session_id:sessionId,model:'glm-5.3-flash',billing_provider:'zai',billing_base_url:'https://api.z.ai/api/paas/v4',api_call_count:2}]},
    ...overrides,
  };
}

function sourceJson(overrides={}) {
  return {
    schemaVersion:1,
    kind:'ross-review',
    answer,
    runId,
    sessionId:receipt().sessionId,
    model:'glm-5.3-flash',
    provider:'zai',
    outcomeVerification:'not-performed',
    ...overrides,
  };
}

function rows(overrides={}) {
  const body=JSON.stringify(sourceJson(),null,2);
  return {
    actor:{id:rossAgentId,companyId},
    project:{id:projectId,companyId},
    run:{id:runId,agentId:rossAgentId,companyId,status:'running',contextSnapshot:{issueId}},
    issue:{id:issueId,companyId,projectId,assigneeAgentId:rossAgentId,status:'in_progress',checkoutRunId:runId,executionRunId:runId},
    currentDocument:{id:documentId,companyId,issueId,key:'ross-review',body:'prior review',latestRevisionId:baseRevisionId,latestRevisionNumber:2,updatedByAgentId:rossAgentId,updatedByUserId:null},
    nextDocument:{id:documentId,companyId,issueId,key:'ross-review',body,latestRevisionId:nextRevisionId,latestRevisionNumber:3,updatedByAgentId:rossAgentId,updatedByUserId:null},
    ...overrides,
  };
}

function fakeRequest(data=rows(),options={}) {
  const calls=[];
  let missing=Boolean(options.missingDocument);
  const request=async(requestPath,body,method)=>{
    calls.push({path:requestPath,body:body??null,method:method??(body?'POST':'GET')});
    if(requestPath==='/agents/me')return data.actor;
    if(requestPath===`/projects/${projectId}`)return data.project;
    if(requestPath===`/heartbeat-runs/${runId}`)return data.run;
    if(requestPath===`/issues/${issueId}`)return data.issue;
    if(requestPath===path&&(method??'GET')==='GET') {
      if(options.readStatus&&!calls.some(call=>call.method==='PUT')) {
        const error=new Error('dispatch verification denied');
        error.statusCode=options.readStatus;
        throw error;
      }
      if(missing&&!calls.some(call=>call.method==='PUT')) {
        const error=new Error('dispatch verification denied');
        error.statusCode=404;
        throw error;
      }
      if(options.successfulBaseline!==undefined&&!calls.some(call=>call.method==='PUT'))return options.successfulBaseline;
      if(options.editedReadback&&calls.some(call=>call.method==='PUT'))return {...data.nextDocument,body:'edited'};
      return calls.some(call=>call.method==='PUT')?data.nextDocument:data.currentDocument;
    }
    if(requestPath===path&&method==='PUT') {
      if(options.failCAS)throw new Error('document CAS refused');
      if(body.baseRevisionId!==(missing?null:data.currentDocument.latestRevisionId))throw new Error('bad base revision');
      const decoded=JSON.parse(body.body);
      assert.deepEqual(decoded,sourceJson());
      assert.equal(body.format,'markdown');
      missing=false;
      data.nextDocument={...data.nextDocument,body:body.body,latestRevisionNumber:options.missingDocument?1:data.currentDocument.latestRevisionNumber+1};
      return data.nextDocument;
    }
    throw new Error(`unexpected request ${method??'GET'} ${requestPath}`);
  };
  return {request,calls,data};
}

async function workspace(t) {
  const dir=await mkdtemp(join(tmpdir(),'ross-review-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir;
}

test('creates the first ross-review document from exact decoded governed answer source',async t=>{
  const dir=await workspace(t);
  const fx=fakeRequest(rows({nextDocument:{...rows().nextDocument,latestRevisionNumber:1}}),{missingDocument:true});
  const publication=await publishGovernedRossReview({binding,invocation,receipt:receipt(),request:fx.request,workspace:dir});
  const put=fx.calls.find(call=>call.method==='PUT');
  assert.equal(put.body.baseRevisionId,null);
  assert.equal(put.body.body.includes('\\\\n'),false);
  assert.deepEqual(JSON.parse(put.body.body),sourceJson());
  assert.deepEqual(publication,{
    issueId,
    documentId,
    revisionId:nextRevisionId,
    revisionNumber:1,
    bodySha256:createHash('sha256').update(put.body.body).digest('hex'),
    runId,
    source:apiUrl+path,
  });
  const intent=JSON.parse(await readFile(join(dir,'ross-review-intent-'+runId+'.json'),'utf8'));
  assert.equal(intent.baseRevisionId,null);
  assert.equal(intent.bodySha256,publication.bodySha256);
  const stored=JSON.parse(await readFile(join(dir,'ross-review-publication-'+runId+'.json'),'utf8'));
  assert.deepEqual(stored.publication,publication);
});

test('updates an existing ross-review document with CAS and exact readback',async t=>{
  const dir=await workspace(t);
  const fx=fakeRequest();
  const publication=await publishGovernedRossReview({binding,invocation,receipt:receipt(),request:fx.request,workspace:dir});
  assert.deepEqual(fx.calls.map(call=>[call.method,call.path]),[
    ['GET','/agents/me'],
    ['GET',`/projects/${projectId}`],
    ['GET',`/heartbeat-runs/${runId}`],
    ['GET',`/issues/${issueId}`],
    ['GET',path],
    ['PUT',path],
    ['GET',path],
  ]);
  assert.equal(fx.calls.find(call=>call.method==='PUT').body.baseRevisionId,baseRevisionId);
  assert.equal(publication.revisionNumber,3);
});

test('publishes for legacy Ross bindings without a role but still rejects lead bindings',async t=>{
  const dir=await workspace(t);
  const legacyBinding={apiUrl,companyId,projectId,agentId:rossAgentId};
  const legacyInvocation=buildGovernedInvocation(legacyBinding,args,env);
  const fx=fakeRequest();
  const publication=await publishGovernedRossReview({binding:legacyBinding,invocation:legacyInvocation,receipt:receipt(),request:fx.request,workspace:dir});
  assert.equal(publication.documentId,documentId);
  assert.equal(fx.calls.some(call=>call.method==='PUT'),true);

  const lead=fakeRequest();
  const leadDir=await workspace(t);
  await assert.rejects(
    ()=>publishGovernedRossReview({binding:{...binding,role:'lead'},invocation,receipt:receipt(),request:lead.request,workspace:leadDir}),
    /scoped ross review binding|required|role/i,
  );
  assert.equal(lead.calls.some(call=>call.method==='PUT'),false);
});

test('refuses duplicate reservation before another publish attempt can write',async t=>{
  const dir=await workspace(t);
  await publishGovernedRossReview({binding,invocation,receipt:receipt(),request:fakeRequest().request,workspace:dir});
  const second=fakeRequest();
  await assert.rejects(
    ()=>publishGovernedRossReview({binding,invocation,receipt:receipt(),request:second.request,workspace:dir}),
    /duplicate|intent|run|exists/i,
  );
  assert.equal(second.calls.some(call=>call.method==='PUT'),false);
});

test('rejects manual receipts, wrong actor, bad model route and lost checkout before mutation',async t=>{
  for(const [badReceipt,mutate] of [
    [{...receipt(),executionMode:'manual'},data=>data],
    [{...receipt(),requestedModel:'glm-4'},data=>data],
    [{...receipt(),endpoint:'https://api.z.ai/api/coding/paas/v4'},data=>data],
    [receipt(),data=>{data.actor.id=documentId;}],
    [receipt(),data=>{data.issue.checkoutRunId=documentId;}],
    [receipt(),data=>{data.project.companyId=projectId;}],
  ]) {
    const dir=await workspace(t);
    const data=rows();
    mutate(data);
    const fx=fakeRequest(data);
    await assert.rejects(
      ()=>publishGovernedRossReview({binding,invocation,receipt:badReceipt,request:fx.request,workspace:dir}),
      /ross|governed|route|model|receipt|actor|checkout|project|scope|dispatch/i,
    );
    assert.equal(fx.calls.some(call=>call.method==='PUT'),false);
  }
});

test('denies non-404 document reads, CAS failures and altered readback without retrying ambiguous writes',async t=>{
  const denied=fakeRequest(rows(),{readStatus:403});
  const deniedDir=await workspace(t);
  await assert.rejects(
    ()=>publishGovernedRossReview({binding,invocation,receipt:receipt(),request:denied.request,workspace:deniedDir}),
    /document|read|denied|verification/i,
  );
  assert.equal(denied.calls.some(call=>call.method==='PUT'),false);

  for(const [fx,pattern] of [
    [fakeRequest(rows(),{failCAS:true}),/CAS|revision|refused/i],
    [fakeRequest(rows(),{editedReadback:true}),/readback|body|revision|scope/i],
  ]) {
    const dir=await workspace(t);
    await assert.rejects(
      ()=>publishGovernedRossReview({binding,invocation,receipt:receipt(),request:fx.request,workspace:dir}),
      pattern,
    );
    assert.equal(fx.calls.filter(call=>call.method==='PUT').length,1);
  }
});

test('rejects successful malformed baseline reads instead of treating them as missing documents',async t=>{
  for(const baseline of [null,false]) {
    const fx=fakeRequest(rows(),{successfulBaseline:baseline});
    const dir=await workspace(t);
    await assert.rejects(
      ()=>publishGovernedRossReview({binding,invocation,receipt:receipt(),request:fx.request,workspace:dir}),
      /existing|scoped|revision|baseline|document/i,
    );
    assert.equal(fx.calls.some(call=>call.method==='PUT'),false);
  }
});
