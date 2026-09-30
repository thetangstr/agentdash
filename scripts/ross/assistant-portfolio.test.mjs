import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantPortfolioReader} from './assistant-portfolio.mjs';

const userId='user-portfolio-1';
const companyA='11111111-1111-4111-8111-111111111111';
const companyB='22222222-2222-4222-8222-222222222222';
const companyC='33333333-3333-4333-8333-333333333333';

function whoami(companyId,user=userId,extra={}) {
  return {
    isError:false,
    structuredContent:{
      status:'ok',
      data:{user:{userId:user},company:{id:companyId},scopes:['read'],...extra},
    },
  };
}

function item(companyId,ref,extra={}) {
  return {
    isError:false,
    structuredContent:{
      status:'ok',
      asOf:'2026-09-30T09:00:00.000Z',
      summary:'Work item '+ref,
      data:{
        ref,
        companyId,
        title:'Review '+ref,
        rossEvidence:{
          documents:[{key:'ross-review',body:'untrusted source '+ref,sourceKind:'untrusted-source-content',freshness:{state:'current'},authorAgentId:'agent-'+companyId.slice(0,4)}],
          businessOutcomeVerified:false,
          qualification:'Attributed source content; not independently verified.',
        },
        ...extra,
      },
      truncated:false,
    },
  };
}

function client(script) {
  const calls=[];
  return {
    calls,
    async callTool(input) {
      calls.push(input);
      const next=script.shift();
      if(next instanceof Error)throw next;
      if(typeof next==='function')return next(input,calls);
      return next;
    },
  };
}

function wedgedClient(firstName='whoami') {
  const calls=[];
  const signals=[];
  return {
    calls,
    signals,
    async callTool(input,_unused,options={}) {
      calls.push(input);
      signals.push(options.signal);
      assert.equal(options.timeout,10_000);
      if(input.name!==firstName)throw new Error('unexpected call after timeout');
      return new Promise((_resolve,reject)=>{
        options.signal?.addEventListener('abort',()=>reject(Object.assign(new Error('aborted with hidden body'),{name:'AbortError'})),{once:true});
      });
    },
  };
}

function names(client) {
  return client.calls.map(call=>call.name);
}

test('reads selected companies with fixed whoami rechecks and preserves source envelopes without synthesis',async()=>{
  const a=client([whoami(companyA),item(companyA,'A-1'),whoami(companyA)]);
  const b=client([whoami(companyB),item(companyB,'B-7'),whoami(companyB)]);
  const reader=createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:a},{companyId:companyB,client:b}]});
  const result=await reader.read([{companyId:companyA,refs:['A-1']},{companyId:companyB,refs:['B-7']}]);
  assert.deepEqual(names(a),['whoami','get_work_item','whoami']);
  assert.deepEqual(names(b),['whoami','get_work_item','whoami']);
  assert.equal(a.calls[1].arguments.ref,'A-1');
  assert.equal(result.status,'ok');
  assert.equal(result.businessOutcomeVerified,false);
  assert.equal(result.coverage,'selected permitted companies/work-items only');
  assert.equal(result.consistency,'sequential rechecks; not atomic');
  assert.deepEqual(result.companies.map(row=>row.companyId),[companyA,companyB]);
  assert.equal(result.companies[0].status,'available');
  assert.equal(result.companies[0].sources[0].data.rossEvidence.businessOutcomeVerified,false);
  assert.equal(result.companies[0].sources[0].data.rossEvidence.documents[0].sourceKind,'untrusted-source-content');
  assert.equal(Object.hasOwn(result.companies[0].sources[0],'structuredContent'),false);
  assert.equal(a.calls.every(call=>call.arguments&&Object.keys(call).length===2),true);
});

test('validates config and selection before I/O, including unknown companies and scope overrides',async()=>{
  const a=client([whoami(companyA)]);
  assert.throws(()=>createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:a}],provider:'zai'}),/exact|config|shape/i);
  assert.throws(()=>createAssistantPortfolioReader({userId:'',connections:[{companyId:companyA,client:a}]}),/userId/i);
  assert.throws(()=>createAssistantPortfolioReader({userId,connections:[]}),/connections/i);
  assert.throws(()=>createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:a},{companyId:companyA,client:a}]}),/duplicate|unique/i);
  assert.throws(()=>createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:{}}]}),/callTool/i);
  const reader=createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:a}]});
  await assert.rejects(()=>reader.read([{companyId:companyB,refs:['B-1']}]),/unknown|scope|company/i);
  await assert.rejects(()=>reader.read([{companyId:companyA,refs:['A-1'],companyIds:[companyB]}]),/exact|shape|scope/i);
  await assert.rejects(()=>reader.read([{companyId:companyA,refs:[]}]),/refs/i);
  await assert.rejects(()=>reader.read([{companyId:companyA,refs:['A-1','A-1']}]),/duplicate|unique/i);
  await assert.rejects(()=>reader.read([{companyId:companyA,refs:['x'.repeat(201)]}]),/ref/i);
  assert.equal(a.calls.length,0);
});

test('drops a company when identity mismatches before read or during postcheck',async()=>{
  const pre=client([whoami(companyA,'other-user')]);
  const revoked=client([whoami(companyB),item(companyB,'B-1'),whoami(companyB,'other-user')]);
  const companyMismatch=client([whoami(companyC,userId,{company:{id:companyA}})]);
  const reader=createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:pre},{companyId:companyB,client:revoked},{companyId:companyC,client:companyMismatch}]});
  const result=await reader.read([{companyId:companyA,refs:['A-1']},{companyId:companyB,refs:['B-1']},{companyId:companyC,refs:['C-1']}]);
  assert.deepEqual(result.companies,[
    {companyId:companyA,status:'unavailable',reason:'company-source-unavailable'},
    {companyId:companyB,status:'unavailable',reason:'company-source-unavailable'},
    {companyId:companyC,status:'unavailable',reason:'company-source-unavailable'},
  ]);
  assert.deepEqual(names(pre),['whoami']);
  assert.deepEqual(names(revoked),['whoami','get_work_item','whoami']);
  assert.equal(JSON.stringify(result).includes('B-1'),false);
});

test('keeps available companies when another company transport fails and exposes no error body',async()=>{
  const a=client([whoami(companyA),item(companyA,'A-1'),whoami(companyA)]);
  const b=client([new Error('secret bearer token exploded')]);
  const reader=createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:a},{companyId:companyB,client:b}]});
  const result=await reader.read([{companyId:companyA,refs:['A-1']},{companyId:companyB,refs:['B-1']}]);
  assert.equal(result.companies[0].status,'available');
  assert.deepEqual(result.companies[1],{companyId:companyB,status:'unavailable',reason:'company-source-unavailable'});
  assert.equal(JSON.stringify(result).includes('secret bearer'),false);
});

test('preserves refused and not_found work-item envelopes as available scoped outcomes',async()=>{
  const refused={status:'refused',asOf:'2026-09-30T09:00:00.000Z',summary:'Refused',data:{reason:'not visible'},freshness:{state:'current'},attribution:{source:'mcp'},qualification:'scoped refusal',truncated:false};
  const missing={status:'not_found',asOf:'2026-09-30T09:00:00.000Z',summary:'Missing',data:{},qualification:'scoped miss',truncated:false};
  const wrapped=value=>({isError:false,structuredContent:value});
  const clarify={status:'needs_clarification',asOf:'2026-09-30T09:00:00.000Z',summary:'Choose one',data:{},candidates:[{ref:'A-1'}],truncated:false};
  const a=client([whoami(companyA),wrapped(refused),wrapped(missing),wrapped(clarify),whoami(companyA)]);
  const reader=createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:a}]});
  const result=await reader.read([{companyId:companyA,refs:['A-403','A-404','A-?']}]);
  assert.equal(result.companies[0].status,'available');
  assert.deepEqual(result.companies[0].sources,[refused,missing,clarify]);
  assert.equal(result.businessOutcomeVerified,false);
});

test('rejects malformed MCP responses, source envelopes, missing read scope, write tools, and oversized output safely',async()=>{
  for(const bad of [
    {},
    {isError:true,structuredContent:{status:'ok',data:{}}},
    {isError:false,structuredContent:{status:'refused',data:{}}},
    {isError:false,structuredContent:{status:'ok',data:{user:{userId},company:{id:companyA},scopes:[]}}},
  ]) {
    const c=client([bad]);
    const reader=createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:c}]});
    const result=await reader.read([{companyId:companyA,refs:['A-1']}]);
    assert.deepEqual(result.companies,[{companyId:companyA,status:'unavailable',reason:'company-source-unavailable'}]);
  }

  for(const badSource of [
    {status:'done',asOf:'2026-09-30T09:00:00.000Z',summary:'Bad',data:{},truncated:false},
    {status:'ok',asOf:'not-a-date',summary:'Bad',data:{},truncated:false},
    {status:'ok',asOf:'1',summary:'Bad',data:{},truncated:false},
    {status:'ok',asOf:'2026-09-30T09:00:00.000Z',summary:'x'.repeat(1001),data:{},truncated:false},
    {status:'ok',asOf:'2026-09-30T09:00:00.000Z',summary:'Bad',data:{},truncated:'no'},
  ]) {
    const c=client([whoami(companyA),{isError:false,structuredContent:badSource},whoami(companyA)]);
    const reader=createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:c}]});
    const result=await reader.read([{companyId:companyA,refs:['A-1']}]);
    assert.deepEqual(result.companies,[{companyId:companyA,status:'unavailable',reason:'company-source-unavailable'}]);
  }

  const writey=client([whoami(companyA)]);
  const reader=createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:writey}]});
  await assert.rejects(()=>reader.read([{companyId:companyA,refs:['A-1'],tool:'create_work_item'}]),/exact|shape|tool/i);
  assert.equal(writey.calls.length,0);

  const large=client([whoami(companyC),item(companyC,'C-1',{blob:'x'.repeat(1_100_000)}),whoami(companyC)]);
  const tooBig=createAssistantPortfolioReader({userId,connections:[{companyId:companyC,client:large}]});
  await assert.rejects(()=>tooBig.read([{companyId:companyC,refs:['C-1']}]),/portfolio|output|too large/i);
});

test('snapshots config and selection before async I/O so mutations cannot widen identity, clients, or refs',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const original=client([
    async()=>{await gate;return whoami(companyA);},
    item(companyA,'A-1'),
    whoami(companyA),
  ]);
  const replacement=client([whoami(companyB,'mutated-user'),item(companyB,'B-1'),whoami(companyB,'mutated-user')]);
  const connections=[{companyId:companyA,client:original}];
  const config={userId,connections};
  const reader=createAssistantPortfolioReader(config);
  config.userId='mutated-user';
  connections[0]={companyId:companyB,client:replacement};
  const selection=[{companyId:companyA,refs:['A-1']}];
  const pending=reader.read(selection);
  selection[0].refs.push('A-2');
  release();
  const result=await pending;
  assert.equal(result.companies[0].status,'available');
  assert.deepEqual(original.calls.map(call=>call.arguments),[{}, {ref:'A-1'}, {}]);
  assert.equal(replacement.calls.length,0);
});

test('timeouts abort one wedged company, skip its remaining reads, and keep other companies independent',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const stuck=wedgedClient('whoami');
  const ok=client([whoami(companyB),item(companyB,'B-1'),whoami(companyB)]);
  const reader=createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:stuck},{companyId:companyB,client:ok}]});
  const pending=reader.read([{companyId:companyA,refs:['A-1']},{companyId:companyB,refs:['B-1']}]);
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  const result=await pending;
  assert.equal(stuck.signals[0].aborted,true);
  assert.deepEqual(names(stuck),['whoami']);
  assert.deepEqual(names(ok),['whoami','get_work_item','whoami']);
  assert.deepEqual(result.companies[0],{companyId:companyA,status:'unavailable',reason:'company-source-unavailable'});
  assert.equal(result.companies[1].status,'available');
  assert.equal(JSON.stringify(result).includes('hidden body'),false);
});

test('post-read timeout aborts recheck and drops already collected company sources',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const calls=[];
  const signals=[];
  const delayed={
    calls,
    signals,
    async callTool(input,_unused,options={}) {
      calls.push(input);
      signals.push(options.signal);
      assert.equal(options.timeout,10_000);
      if(input.name==='whoami'&&calls.length===1)return whoami(companyA);
      if(input.name==='get_work_item')return item(companyA,'A-1');
      return new Promise((_resolve,reject)=>{
        options.signal?.addEventListener('abort',()=>reject(Object.assign(new Error('postcheck secret'),{name:'AbortError'})),{once:true});
      });
    },
  };
  const reader=createAssistantPortfolioReader({userId,connections:[{companyId:companyA,client:delayed}]});
  const pending=reader.read([{companyId:companyA,refs:['A-1']}]);
  for(let i=0;i<10&&calls.length<3;i++)await Promise.resolve();
  assert.equal(calls.length,3);
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  const result=await pending;
  assert.deepEqual(names(delayed),['whoami','get_work_item','whoami']);
  assert.equal(signals[2].aborted,true);
  assert.deepEqual(result.companies,[{companyId:companyA,status:'unavailable',reason:'company-source-unavailable'}]);
  assert.equal(JSON.stringify(result).includes('A-1'),false);
});
