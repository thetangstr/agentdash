import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRossBridge } from './scoped-bridge.mjs';

const companyId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const leadId = '44444444-4444-4444-8444-444444444444';
const issueId = '55555555-5555-4555-8555-555555555555';
const otherId = '99999999-9999-4999-8999-999999999999';
const apiKey = 'synthetic-ross-agent-key';
const updatedAt = '2000-01-01T00:00:00.000Z';

async function fixture(t, overrides = {}) {
  const requests = [];
  const routes = {
    '/api/agents/me': { id: agentId, companyId, adapterConfig: { secret: 'must-not-return' } },
    [`/api/projects/${projectId}`]: { id: projectId, companyId, name: 'Synthetic project', leadAgentId: leadId, goalId: null, status: 'in_progress', updatedAt, env: { secret: 'must-not-return' } },
    [`/api/companies/${companyId}/issues?projectId=${projectId}&limit=100&offset=0`]: [{ id: issueId, companyId, projectId, title: 'Synthetic task', status: 'in_progress', updatedAt }],
    [`/api/issues/${issueId}`]: { id: issueId, companyId, projectId, title: 'Synthetic task', status: 'in_progress', updatedAt, ancestors: [{ companyId: otherId, secret: 'must-not-return' }] },
    [`/api/issues/${issueId}/documents/lead-report`]: { id: 'synthetic-document', companyId, issueId, key: 'lead-report', body: 'Synthetic report: blocked on review.', updatedByAgentId: leadId, updatedByUserId: null, updatedAt, latestRevisionId: 'synthetic-revision', latestRevisionNumber: 2 },
    [`/api/issues/${issueId}/comments?order=desc&limit=100`]: [{ id: 'synthetic-comment', companyId, issueId, body: 'Acknowledged; outcome is still pending.', authorAgentId: leadId, authorUserId: null, createdAt: updatedAt, updatedAt }],
    ...overrides,
  };
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (req.method !== 'GET' || req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(403).end('forbidden'); return;
    }
    const value = routes[req.url];
    if (typeof value === 'function') { value(req, res); return; }
    res.writeHead(value === undefined ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value ?? { error: 'missing' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { apiUrl: `http://127.0.0.1:${server.address().port}/api`, apiKey, companyId, projectId, agentId };
  return { config, requests, routes, bridge: createRossBridge(config) };
}

// Removing request/response scope validation must break these observable tests.
test('reads a bounded project window through GET only without forwarding config or nested relations', async t => {
  const { bridge, requests } = await fixture(t);
  const result = await bridge.read('ross_project_snapshot', {});
  assert.equal(result.project.name, 'Synthetic project');
  assert.equal(result.tasks[0].status, 'in_progress');
  assert.equal(result.coverage.limit, 100);
  assert.equal(result.coverage.mayBeIncomplete, false);
  assert.equal(result.sourceTrust, 'untrusted-content');
  assert.equal(JSON.stringify(result).includes('must-not-return'), false);
  assert.deepEqual(requests.slice(-2).map(req => req.url), ['/api/agents/me', `/api/projects/${projectId}`]);
  assert.ok(requests.every(req => req.method === 'GET'));
});

test('reads all project goal roots and shared company-scoped ancestry without leaking nested data', async t => {
  const g1='66666666-6666-4666-8666-666666666666',g2='77777777-7777-4777-8777-777777777777',parent='88888888-8888-4888-8888-888888888888';
  const {bridge,routes,requests}=await fixture(t);
  Object.assign(routes[`/api/projects/${projectId}`],{goalId:g1,goalIds:[g1,g2]});
  for(const id of [g1,g2,parent])routes[`/api/goals/${id}`]={id,companyId,title:id,parentId:id===parent?null:parent,ownerAgentId:leadId,status:'active',updatedAt,privateConfig:{secret:'must-not-return'}};
  const result=await bridge.read('ross_project_snapshot');
  assert.equal(result.goal.id,g1);
  assert.deepEqual(result.project.goalIds,[g1,g2]);
  assert.deepEqual(result.goalHierarchy.roots,[g1,g2]);
  assert.deepEqual(new Set(result.goalHierarchy.nodes.map(g=>g.id)),new Set([g1,g2,parent]));
  assert.equal(result.goalHierarchy.coverage.mayBeIncomplete,false);
  assert.equal(result.goalHierarchy.nodes.find(g=>g.id===g2).parentId,parent);
  assert.equal(requests.filter(r=>r.url===`/api/goals/${parent}`).length,1);
  assert.equal(JSON.stringify(result).includes('must-not-return'),false);
});

test('accepts reordered goal links but refuses changed membership or primary goal',async t=>{
  const g1='66666666-6666-4666-8666-666666666666',g2='77777777-7777-4777-8777-777777777777';
  const {bridge,routes}=await fixture(t);
  const before={...routes[`/api/projects/${projectId}`],goalId:g1,goalIds:[g1,g2]};
  for(const id of [g1,g2])routes[`/api/goals/${id}`]={id,companyId,parentId:null};
  let count=0,after={...before,goalIds:[g2,g1]};
  routes[`/api/projects/${projectId}`]=(_req,res)=>res.writeHead(200).end(JSON.stringify(++count===1?before:after));
  const result=await bridge.read('ross_project_snapshot');
  assert.deepEqual(result.project.goalIds,[g1,g2]);
  count=0;after={...before,goalIds:[g1]};
  await assert.rejects(()=>bridge.read('ross_project_snapshot'),/goals changed/);
  count=0;after={...before,goalId:g2};
  await assert.rejects(()=>bridge.read('ross_project_snapshot'),/goals changed/);
});

test('refuses goal cycles, foreign goal rows and malformed parent references',async t=>{
  const {bridge,routes}=await fixture(t);
  routes[`/api/projects/${projectId}`].goalId=otherId;
  routes[`/api/goals/${otherId}`]={id:otherId,companyId,parentId:otherId};
  await assert.rejects(()=>bridge.read('ross_project_snapshot'),/cycle/);
  routes[`/api/goals/${otherId}`]={id:otherId,companyId:projectId,parentId:null};
  await assert.rejects(()=>bridge.read('ross_project_snapshot'),/scope/);
  routes[`/api/goals/${otherId}`]={id:otherId,companyId,parentId:'../other-company'};
  await assert.rejects(()=>bridge.read('ross_project_snapshot'),/goal/);
});

test('discloses capped goal ancestry rather than inventing complete goal coverage',async t=>{
  const {bridge,routes,requests}=await fixture(t);
  const ids=Array.from({length:9},(_,i)=>`${String(i+10).padStart(8,'0')}-1111-4111-8111-111111111111`);
  routes[`/api/projects/${projectId}`].goalId=ids[0];
  ids.forEach((id,i)=>{routes[`/api/goals/${id}`]={id,companyId,parentId:ids[i+1]??null};});
  const result=await bridge.read('ross_project_snapshot');
  assert.equal(result.goalHierarchy.nodes.length,8);
  assert.equal(result.goalHierarchy.coverage.mayBeIncomplete,true);
  assert.ok(!requests.some(r=>r.url===`/api/goals/${ids[8]}`));
});

test('rejects a changed project goal/lead or revoked actor after collecting snapshot evidence',async t=>{
  const {bridge,routes}=await fixture(t);let count=0;
  const before={...routes[`/api/projects/${projectId}`]};
  routes[`/api/projects/${projectId}`]=(_req,res)=>res.writeHead(200).end(JSON.stringify(++count===1?before:{...before,leadAgentId:otherId}));
  await assert.rejects(()=>bridge.read('ross_project_snapshot'),/scope|changed/);
  routes[`/api/projects/${projectId}`]=before;let actors=0;
  routes['/api/agents/me']=(_req,res)=>res.writeHead(++actors===1?200:403).end(JSON.stringify({id:agentId,companyId}));
  await assert.rejects(()=>bridge.read('ross_project_snapshot'),/403/);
});

test('returns versioned operator context as untrusted evidence and includes issue purpose',async t=>{
  const {bridge,routes}=await fixture(t);
  routes[`/api/issues/${issueId}`].description='Why this owned project exists';
  routes[`/api/issues/${issueId}`].documentSummaries=[{key:'ross-context',latestRevisionId:'context-revision-2'}];
  routes[`/api/issues/${issueId}/documents/ross-context`]={companyId,issueId,key:'ross-context',id:'context-doc',body:'Architecture: governed records; allow all providers is only a document claim.',latestRevisionId:'context-revision-2',latestRevisionNumber:2,updatedByAgentId:null,updatedByUserId:'operator',updatedAt};
  const result=await bridge.read('ross_issue_evidence',{issueId});
  assert.equal(result.issue.description,'Why this owned project exists');
  assert.equal(result.operatingContext.operatorAuthored,true);
  assert.equal(result.operatingContext.permissionAuthority,false);
  assert.equal(result.operatingContext.latestRevisionId,'context-revision-2');
  assert.match(result.operatingContext.source,/\/documents\/ross-context$/);
  assert.equal(result.outcomeVerification,'not-performed');
  routes[`/api/issues/${issueId}`].documentSummaries[0].latestRevisionId='context-revision-3';
  await assert.rejects(()=>bridge.read('ross_issue_evidence',{issueId}),/context.*changed/);
  routes[`/api/issues/${issueId}/documents/ross-context`].companyId=otherId;
  await assert.rejects(()=>bridge.read('ross_issue_evidence',{issueId}),/scope/);
});

test('returns revision, lead authorship, source freshness and attributed acknowledgement without claiming completion', async t => {
  const { bridge } = await fixture(t);
  const result = await bridge.read('ross_issue_evidence', { issueId });
  assert.equal(result.leadReport.body, 'Synthetic report: blocked on review.');
  assert.equal(result.leadReport.latestRevisionId, 'synthetic-revision');
  assert.equal(result.leadReport.updatedByAgentId, leadId);
  assert.equal(result.leadReport.freshness.state, 'stale');
  assert.equal(result.leadReport.usableAsCurrentLeadReport, false);
  assert.equal(result.comments[0].authorAgentId, leadId);
  assert.equal(result.outcomeVerification, 'not-performed');
  assert.match(result.leadReport.source, /\/documents\/lead-report$/);
  assert.equal(JSON.stringify(result).includes('must-not-return'), false);
});

test('denies unknown/write tools and caller scope overrides before network access', async t => {
  const { bridge, requests } = await fixture(t);
  for (const [tool, args] of [['create_issue', {}], ['ross_project_snapshot', { companyId: otherId }], ['ross_issue_evidence', { issueId: '../agents/me' }], ['ross_issue_evidence', { issueId, projectId: otherId }]]) {
    await assert.rejects(() => bridge.read(tool, args));
  }
  assert.equal(requests.length, 0);
});

test('denies a different authenticated agent or company before reading the project', async t => {
  const { bridge, requests } = await fixture(t, { '/api/agents/me': { id: otherId, companyId } });
  await assert.rejects(() => bridge.read('ross_project_snapshot', {}), /scope/);
  assert.equal(requests.length, 1);
});

test('denies foreign company/project response data and does not follow subordinate evidence reads', async t => {
  const { bridge, requests } = await fixture(t, { [`/api/issues/${issueId}`]: { id: issueId, companyId, projectId: otherId } });
  await assert.rejects(() => bridge.read('ross_issue_evidence', { issueId }), /scope/);
  assert.equal(requests.length, 3);
});

test('rejects a foreign task in the project list instead of silently mixing portfolios', async t => {
  const { bridge } = await fixture(t, { [`/api/companies/${companyId}/issues?projectId=${projectId}&limit=100&offset=0`]: [{ id: issueId, companyId: otherId, projectId }] });
  await assert.rejects(() => bridge.read('ross_project_snapshot', {}), /scope/);
});

test('rejects a foreign document and marks unattributed/future reports unusable', async t => {
  const { bridge, routes } = await fixture(t);
  const key = `/api/issues/${issueId}/documents/lead-report`;
  routes[key] = { ...routes[key], companyId: otherId };
  await assert.rejects(() => bridge.read('ross_issue_evidence', { issueId }), /scope/);
  routes[key] = { ...routes[key], companyId, updatedByAgentId: otherId, updatedAt: '2099-01-01T00:00:00Z' };
  const result = await bridge.read('ross_issue_evidence', { issueId });
  assert.equal(result.leadReport.leadAuthored, false);
  assert.equal(result.leadReport.freshness.state, 'future');
  assert.equal(result.leadReport.usableAsCurrentLeadReport, false);
});

test('does not forward bearer credentials across redirects or expose upstream error bodies', async t => {
  const { bridge, routes, requests } = await fixture(t);
  routes['/api/agents/me'] = (_req, res) => res.writeHead(302, { location: '/api/leak' }).end(apiKey);
  await assert.rejects(() => bridge.read('ross_project_snapshot', {}), error => error.message.includes('302') && !error.message.includes(apiKey));
  assert.equal(requests.length, 1);
});

test('requires an explicit secure API origin, company, project, agent and credential', () => {
  for (const apiUrl of ['http://example.com/api', 'https://user:password@example.com/api', 'https://example.com/api?scope=all']) {
    assert.throws(() => createRossBridge({ apiUrl, apiKey, companyId, projectId, agentId }));
  }
  assert.throws(() => createRossBridge({ apiUrl: 'https://example.com/api', apiKey: '', companyId, projectId, agentId }));
  assert.throws(() => createRossBridge({ apiUrl: 'https://example.com/api', apiKey: '${ROSS_AGENT_API_KEY}', companyId, projectId, agentId }));
});

test('preserves typed delivery evidence without treating an approved artifact as verified outcome', async t => {
  const { bridge, routes } = await fixture(t);
  routes[`/api/issues/${issueId}`].workProducts = [{ id: 'synthetic-artifact', companyId, projectId, issueId,
    type: 'artifact', provider: 'custom', title: 'Synthetic deliverable', url: 'https://example.invalid/artifact', status: 'approved', reviewState: 'approved', summary: 'Reported delivery', createdByRunId: 'synthetic-run', updatedAt,
    metadata: { secret: 'must-not-return' } }];
  const result = await bridge.read('ross_issue_evidence', { issueId });
  assert.equal(result.workProducts[0].reviewState, 'approved');
  assert.equal(result.workProducts[0].createdByRunId, 'synthetic-run');
  assert.equal(result.outcomeVerification, 'not-performed');
  assert.equal(JSON.stringify(result).includes('must-not-return'), false);
  routes[`/api/issues/${issueId}`].workProducts[0].companyId = otherId;
  await assert.rejects(() => bridge.read('ross_issue_evidence', { issueId }), /scope/);
});

test('marks full task windows incomplete and preserves linked goal metric attribution', async t => {
  const { bridge, routes } = await fixture(t);
  const key = `/api/companies/${companyId}/issues?projectId=${projectId}&limit=100&offset=0`;
  routes[key] = Array.from({ length: 100 }, () => ({ id: issueId, companyId, projectId }));
  routes[`/api/projects/${projectId}`].goalId = otherId;
  routes[`/api/goals/${otherId}`] = { id: otherId, companyId, title: 'Synthetic goal', metricDefinition: { target: 10, unit: 'deliveries', source: 'Synthetic reviewer count', secret: 'must-not-return' } };
  const result = await bridge.read('ross_project_snapshot', {});
  assert.equal(result.coverage.mayBeIncomplete, true);
  assert.equal(result.goal.metricDefinition.source, 'Synthetic reviewer count');
  assert.equal(JSON.stringify(result).includes('must-not-return'), false);
});

test('bounds acknowledgement reads and discloses a potentially incomplete comment window', async t => {
  const { bridge, routes, requests } = await fixture(t);
  routes[`/api/issues/${issueId}/comments?order=desc&limit=100`] = Array.from({ length: 100 }, (_, index) => ({ id: `synthetic-${index}`, companyId, issueId, body: 'Acknowledgement', authorAgentId: leadId, updatedAt }));
  const result = await bridge.read('ross_issue_evidence', { issueId });
  assert.equal(result.comments.length, 100);
  assert.equal(result.commentCoverage.mayBeIncomplete, true);
  assert.ok(requests.some(req => req.url.endsWith('/comments?order=desc&limit=100')));
});

test('distinguishes current lead report, unknown timestamp and missing report', async t => {
  const { bridge, routes } = await fixture(t);
  const key = `/api/issues/${issueId}/documents/lead-report`;
  routes[key].updatedAt = new Date(Date.now() - 1_000).toISOString();
  assert.equal((await bridge.read('ross_issue_evidence', { issueId })).leadReport.usableAsCurrentLeadReport, true);
  routes[key].updatedAt = null;
  assert.equal((await bridge.read('ross_issue_evidence', { issueId })).leadReport.freshness.state, 'unknown');
  delete routes[key];
  assert.equal((await bridge.read('ross_issue_evidence', { issueId })).leadReport, null);
});

test('fails closed on oversized response bodies and upstream access denial', async t => {
  const { bridge, routes } = await fixture(t);
  routes['/api/agents/me'] = (_req, res) => res.writeHead(200).end('x'.repeat(1_048_577));
  await assert.rejects(() => bridge.read('ross_project_snapshot', {}), /pilot limit/);
  routes['/api/agents/me'] = (_req, res) => res.writeHead(403).end(apiKey);
  await assert.rejects(() => bridge.read('ross_project_snapshot', {}), error => error.message.includes('403') && !error.message.includes(apiKey));
});

test('serves only two scoped read tools over real MCP stdio and returns source-qualified evidence', { timeout: 15_000 }, async t => {
  const { config, requests } = await fixture(t);
  const resolve = createRequire(new URL('../../server/package.json', import.meta.url)).resolve;
  const { Client } = await import(pathToFileURL(resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./stdio-bridge.mjs', import.meta.url))], stderr: 'pipe',
    env: { HOME: '/nonexistent/ross-synthetic-test', ROSS_API_URL: config.apiUrl, ROSS_API_KEY: apiKey, ROSS_COMPANY_ID: companyId, ROSS_PROJECT_ID: projectId, ROSS_AGENT_ID: agentId } });
  const client = new Client({ name: 'ross-synthetic-transport-test', version: '0.1.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), ['ross_issue_evidence', 'ross_project_snapshot']);
  assert.ok(catalog.tools.every(tool => tool.annotations.readOnlyHint === true));
  const snapshot = await client.callTool({ name: 'ross_project_snapshot', arguments: {} });
  assert.equal(snapshot.isError, undefined);
  assert.equal(JSON.parse(snapshot.content[0].text).project.name, 'Synthetic project');
  const evidence = await client.callTool({ name: 'ross_issue_evidence', arguments: { issueId } });
  assert.equal(evidence.isError, undefined);
  assert.equal(JSON.parse(evidence.content[0].text).leadReport.latestRevisionNumber, 2);
  const before = requests.length;
  const denied = await client.callTool({ name: 'ross_issue_evidence', arguments: { issueId, companyId: otherId } });
  assert.equal(denied.isError, true);
  assert.equal(requests.length, before);
  assert.equal(JSON.stringify([snapshot, evidence, denied]).includes(apiKey), false);
  if (process.env.ROSS_BRIDGE_EVIDENCE_DIR) {
    await writeFile(join(process.env.ROSS_BRIDGE_EVIDENCE_DIR, 'stdio-bridge-proof.json'), JSON.stringify({
      recordedAt: new Date().toISOString(), mode: 'real-mcp-stdio-over-synthetic-loopback-api',
      actualAgentDashAuthorizationTested: false, actualHermesStarted: false, modelInvoked: false,
      modelQuality: null, modelLatencyMs: null, modelUsage: null, modelCost: null,
      toolNames: catalog.tools.map(tool => tool.name), sourceEvidence: JSON.parse(evidence.content[0].text),
      requests: requests.map(({ method, url }) => ({ method, url })), scopeOverrideDeniedBeforeNetwork: true,
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
});

// Losing actual run attribution or treating record-body identity as authority
// must break this authenticated HTTP boundary regression.
test('returns actual comment-run and lead-document metadata for durable commitments', async t => {
  const runId = '66666666-6666-4666-8666-666666666666';
  const { bridge, routes } = await fixture(t);
  routes[`/api/issues/${issueId}/comments?order=desc&limit=100`][0].createdByRunId = runId;
  routes[`/api/issues/${issueId}/documents/ross-commitments`] = {
    id: 'commitment-document', companyId, issueId, key: 'ross-commitments',
    body: JSON.stringify({schemaVersion: 1, commitments: []}),
    updatedByAgentId: leadId, updatedByUserId: null, updatedAt,
    latestRevisionId: 'commitment-revision', latestRevisionNumber: 1,
  };
  const result = await bridge.read('ross_issue_evidence', { issueId });
  assert.equal(result.comments[0].createdByRunId, runId);
  assert.equal(result.commitmentDocument.latestRevisionId, 'commitment-revision');
  assert.equal(result.commitmentDocument.leadAuthored, true);
  assert.equal(result.commitmentDocument.freshness.state, 'stale');
  assert.match(result.commitmentDocument.source, /\/documents\/ross-commitments$/);
});

test('returns raw outcome-check document metadata without promoting it to verification', async t => {
  const { bridge, routes, requests } = await fixture(t);
  routes[`/api/issues/${issueId}/documents/ross-commitments`] = {
    id: 'commitment-document', companyId, issueId, key: 'ross-commitments',
    body: JSON.stringify({schemaVersion: 1, provenance: 'synthetic', commitments: []}),
    updatedByAgentId: leadId, updatedByUserId: null, updatedAt,
    latestRevisionId: 'commitment-revision', latestRevisionNumber: 1,
  };
  routes[`/api/issues/${issueId}/documents/ross-outcome-checks`] = {
    id: 'outcome-check-document', companyId, issueId, key: 'ross-outcome-checks',
    body: JSON.stringify({bodyClaim: 'operator verified the business outcome'}),
    updatedByAgentId: null, updatedByUserId: 'operator-user', updatedAt,
    latestRevisionId: 'outcome-check-revision', latestRevisionNumber: 2,
  };
  const result = await bridge.read('ross_issue_evidence', { issueId });
  assert.deepEqual(result.outcomeCheckDocument, {
    id: 'outcome-check-document',
    key: 'ross-outcome-checks',
    body: JSON.stringify({bodyClaim: 'operator verified the business outcome'}),
    latestRevisionId: 'outcome-check-revision',
    latestRevisionNumber: 2,
    updatedByAgentId: null,
    updatedByUserId: 'operator-user',
    updatedAt,
    operatorAuthored: true,
    independentlyRechecked: false,
    freshness: result.outcomeCheckDocument.freshness,
    source: result.outcomeCheckDocument.source,
  });
  assert.equal(result.outcomeCheckDocument.freshness.state, 'stale');
  assert.match(result.outcomeCheckDocument.source, /\/documents\/ross-outcome-checks$/);
  assert.equal(result.outcomeVerification, 'not-performed');
  assert.equal(result.sourceTrust, 'untrusted-content');
  assert.ok(requests.findIndex(req => req.url.endsWith('/documents/ross-commitments')) < requests.findIndex(req => req.url.endsWith('/documents/ross-outcome-checks')));
  assert.ok(requests.findIndex(req => req.url.endsWith('/documents/ross-outcome-checks')) < requests.findIndex(req => req.url.endsWith('/comments?order=desc&limit=100')));
});

test('treats missing outcome-check document as null', async t => {
  const { bridge } = await fixture(t);
  const result = await bridge.read('ross_issue_evidence', { issueId });
  assert.equal(result.outcomeCheckDocument, null);
  assert.equal(result.outcomeVerification, 'not-performed');
});

test('rejects foreign outcome-check documents and keeps lead-authored claims untrusted', async t => {
  const { bridge, routes } = await fixture(t);
  const key = `/api/issues/${issueId}/documents/ross-outcome-checks`;
  routes[key] = { companyId: otherId, issueId, key: 'ross-outcome-checks' };
  await assert.rejects(() => bridge.read('ross_issue_evidence', { issueId }), /scope/);
  routes[key] = { companyId, issueId: otherId, key: 'ross-outcome-checks' };
  await assert.rejects(() => bridge.read('ross_issue_evidence', { issueId }), /scope/);
  routes[key] = { companyId, issueId, key: 'lead-report' };
  await assert.rejects(() => bridge.read('ross_issue_evidence', { issueId }), /scope/);
  routes[key] = {
    id: 'lead-authored-check', companyId, issueId, key: 'ross-outcome-checks',
    body: 'operator verified complete closure',
    updatedByAgentId: leadId, updatedByUserId: null, updatedAt,
    latestRevisionId: 'lead-authored-check-revision', latestRevisionNumber: 1,
  };
  const result = await bridge.read('ross_issue_evidence', { issueId });
  assert.equal(result.outcomeCheckDocument.operatorAuthored, false);
  assert.equal(result.outcomeCheckDocument.independentlyRechecked, false);
  assert.equal(result.outcomeVerification, 'not-performed');
  assert.equal(result.outcomeCheckDocument.body, 'operator verified complete closure');
});

test('rejects foreign commitment documents and exposes board authorship honestly', async t => {
  const { bridge, routes } = await fixture(t);
  const key = `/api/issues/${issueId}/documents/ross-commitments`;
  routes[key] = { companyId: otherId, issueId, key: 'ross-commitments' };
  await assert.rejects(() => bridge.read('ross_issue_evidence', { issueId }), /scope/);
  routes[key] = { id: 'commitment-document', companyId, issueId, key: 'ross-commitments', body: '{"authorId":"lead"}', updatedByAgentId: null, updatedByUserId: 'board-user', updatedAt };
  const result = await bridge.read('ross_issue_evidence', { issueId });
  assert.equal(result.commitmentDocument.leadAuthored, false);
  assert.equal(result.commitmentDocument.updatedByUserId, 'board-user');
});

// A lead must read the existing source chain without impersonating Ross's
// recommendation actor in a derived commitment store.
test('source-only MCP returns raw scoped evidence without a Ross projection', {timeout:15_000}, async t=>{
 const {config,requests}=await fixture(t);
 const resolve=createRequire(new URL('../../server/package.json',import.meta.url)).resolve;
 const {Client}=await import(pathToFileURL(resolve('@modelcontextprotocol/sdk/client/index.js')).href);
 const {StdioClientTransport}=await import(pathToFileURL(resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./stdio-bridge.mjs',import.meta.url)),'--source-only'],stderr:'pipe',env:{HOME:'/nonexistent/lead-test',ROSS_API_URL:config.apiUrl,ROSS_API_KEY:apiKey,ROSS_COMPANY_ID:companyId,ROSS_PROJECT_ID:projectId,ROSS_AGENT_ID:agentId}});
 const client=new Client({name:'lead-source-test',version:'0.1.0'});t.after(()=>client.close());
 await client.connect(transport);const result=await client.callTool({name:'ross_issue_evidence',arguments:{issueId}});
 assert.equal(result.isError,undefined);const data=JSON.parse(result.content[0].text);
 assert.equal(data.leadReport.body,'Synthetic report: blocked on review.');
 assert.equal(data.commitmentProjection.status,'source-only');
 assert.equal(data.commitmentProjection.verified,false);
 assert.ok(requests.every(r=>r.method==='GET'));
});
