import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGovernedInvocation } from './governed-invocation.mjs';
import { publishGovernedLeadReport } from './lead-report.mjs';

const companyId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const issueId = '55555555-5555-4555-8555-555555555555';
const documentId = '66666666-6666-4666-8666-666666666666';
const baseRevisionId = '77777777-7777-4777-8777-777777777777';
const nextRevisionId = '88888888-8888-4888-8888-888888888888';
const apiUrl = 'http://127.0.0.1:3100/api';
const answer = '# Ross lead report\n\nEvidence-backed report; no task closure or approval.';

const token = claims => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: agentId, company_id: companyId, run_id: runId, adapter_type: 'hermes_local', exp: Math.floor(Date.now() / 1000) + 600, ...claims })).toString('base64url'),
  'synthetic_signature',
].join('.');

const binding = { apiUrl, companyId, projectId, agentId };
const args = ['chat', '-q', 'Publish the governed lead report.', '-Q', '-m', 'glm-5.3-flash', '--provider', 'zai', '-t', 'ross_agentdash', '--max-turns', '4', '--source', 'tool'];
const env = { PAPERCLIP_API_URL: apiUrl, PAPERCLIP_COMPANY_ID: companyId, PAPERCLIP_AGENT_ID: agentId, PAPERCLIP_RUN_ID: runId, PAPERCLIP_TASK_ID: issueId, PAPERCLIP_API_KEY: token({}) };
const invocation = buildGovernedInvocation(binding, args, env);
const receipt = {
  scope: { companyId, projectId, agentId },
  executionMode: 'governed',
  runId,
  requestedModel: 'glm-5.3-flash',
  endpoint: 'https://api.z.ai/api/paas/v4',
  sessionId: '20260101_120000_fixt01_full',
  answer,
  failure: null,
  usage: { modelRows: [{ session_id: '20260101_120000_fixt01_full', model: 'glm-5.3-flash', billing_provider: 'zai', billing_base_url: 'https://api.z.ai/api/paas/v4', api_call_count: 2 }] },
};

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'ross-lead-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function rows() {
  return {
    actor: { id: agentId, companyId },
    project: { id: projectId, companyId, leadAgentId: agentId },
    run: { id: runId, agentId, companyId, status: 'running', contextSnapshot: { issueId } },
    issue: { id: issueId, companyId, projectId, assigneeAgentId: agentId, status: 'in_progress', checkoutRunId: runId, executionRunId: runId },
    existing: { id: documentId, companyId, issueId, key: 'lead-report', body: 'prior report', latestRevisionId: baseRevisionId, latestRevisionNumber: 3, updatedByAgentId: agentId, updatedByUserId: null },
    published: { id: documentId, companyId, issueId, key: 'lead-report', body: answer, latestRevisionId: nextRevisionId, latestRevisionNumber: 4, updatedByAgentId: agentId, updatedByUserId: null },
  };
}

function fakeRequest(data = rows(), options = {}) {
  const calls = [];
  const request = async (path, body, method) => {
    calls.push({ path, body: body ?? null, method: method ?? (body ? 'POST' : 'GET') });
    if (options.failOnPut && path === `/issues/${issueId}/documents/lead-report` && (method ?? 'GET') === 'PUT') throw new Error('dispatch verification denied');
    if (path === '/agents/me') return data.actor;
    if (path === `/projects/${projectId}`) return data.project;
    if (path === `/heartbeat-runs/${runId}`) return data.run;
    if (path === `/issues/${issueId}`) return data.issue;
    if (path === `/issues/${issueId}/documents/lead-report` && (method ?? 'GET') === 'GET') {
      if (options.editedReadback && calls.some(call => call.method === 'PUT')) return { ...data.published, body: 'edited after publish' };
      return calls.some(call => call.method === 'PUT') ? data.published : data.existing;
    }
    if (path === `/issues/${issueId}/documents/lead-report` && method === 'PUT') {
      if (body.baseRevisionId !== data.existing.latestRevisionId) throw new Error('bad base revision');
      if (body.body !== answer || body.format !== 'markdown') throw new Error('bad report body');
      return data.published;
    }
    throw new Error(`unexpected request ${method ?? 'GET'} ${path}`);
  };
  return { request, calls };
}

test('publishes the exact governed answer as the project lead report and records private receipt', async t => {
  const dir = await workspace(t);
  const { request, calls } = fakeRequest();
  const publication = await publishGovernedLeadReport({ binding, invocation, receipt, request, workspace: dir });
  assert.deepEqual(publication, {
    issueId,
    documentId,
    revisionId: nextRevisionId,
    revisionNumber: 4,
    bodySha256: createHash('sha256').update(answer).digest('hex'),
    runId,
    source: apiUrl + `/issues/${issueId}/documents/lead-report`,
  });
  assert.deepEqual(calls.map(call => [call.method, call.path]), [
    ['GET', '/agents/me'],
    ['GET', `/projects/${projectId}`],
    ['GET', `/heartbeat-runs/${runId}`],
    ['GET', `/issues/${issueId}`],
    ['GET', `/issues/${issueId}/documents/lead-report`],
    ['PUT', `/issues/${issueId}/documents/lead-report`],
    ['GET', `/issues/${issueId}/documents/lead-report`],
  ]);
  assert.deepEqual(calls.find(call => call.method === 'PUT').body, { format: 'markdown', body: answer, baseRevisionId });
  const intent = JSON.parse(await readFile(join(dir, 'lead-report-intent-' + runId + '.json'), 'utf8'));
  assert.equal(intent.runId, runId);
  assert.equal(intent.issueId, issueId);
  assert.equal(intent.bodySha256, publication.bodySha256);
  const stored = JSON.parse(await readFile(join(dir, 'lead-report-publication-' + runId + '.json'), 'utf8'));
  assert.deepEqual(stored.publication, publication);
});

test('refuses a second publication attempt for the same run before another PUT', async t => {
  const dir = await workspace(t);
  const first = fakeRequest();
  await publishGovernedLeadReport({ binding, invocation, receipt, request: first.request, workspace: dir });
  const second = fakeRequest();
  await assert.rejects(
    () => publishGovernedLeadReport({ binding, invocation, receipt, request: second.request, workspace: dir }),
    /publication|intent|run|duplicate|exists/i,
  );
  assert.equal(second.calls.some(call => call.method === 'PUT'), false);
});

test('rejects project, checkout, receipt route and session mismatches before writing', async t => {
  for (const [mutateRows, badReceipt] of [
    [data => { data.project.leadAgentId = documentId; }, receipt],
    [data => { data.issue.checkoutRunId = documentId; }, receipt],
    [data => data, { ...receipt, executionMode: 'manual' }],
    [data => data, { ...receipt, runId: documentId }],
    [data => data, { ...receipt, sessionId: 'foreign_session', usage: { modelRows: [{ ...receipt.usage.modelRows[0], session_id: 'foreign_session' }] } }],
    [data => data, { ...receipt, endpoint: 'https://api.z.ai/api/coding/paas/v4' }],
  ]) {
    const dir = await workspace(t);
    const data = rows();
    mutateRows(data);
    const { request, calls } = fakeRequest(data);
    await assert.rejects(
      () => publishGovernedLeadReport({ binding, invocation, receipt: badReceipt, request, workspace: dir }),
      /lead|checkout|scoped|route|session|receipt|ledger/i,
    );
    assert.equal(calls.some(call => call.method === 'PUT'), false);
  }
});

test('rejects CAS refusal and edited readback without retrying an ambiguous PUT', async t => {
  const cas = fakeRequest(rows(), { failOnPut: true });
  const casWorkspace = await workspace(t);
  await assert.rejects(
    () => publishGovernedLeadReport({ binding, invocation, receipt, request: cas.request, workspace: casWorkspace }),
    /denied|publish|PUT|lead-report/i,
  );
  assert.equal(cas.calls.filter(call => call.method === 'PUT').length, 1);
  const edited = fakeRequest(rows(), { editedReadback: true });
  const editedWorkspace = await workspace(t);
  await assert.rejects(
    () => publishGovernedLeadReport({ binding, invocation, receipt, request: edited.request, workspace: editedWorkspace }),
    /readback|body|revision|scope/i,
  );
  assert.equal(edited.calls.filter(call => call.method === 'PUT').length, 1);
});
