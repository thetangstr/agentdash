import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGovernedInvocation } from './governed-invocation.mjs';
import { parseCommitmentDocument } from './commitment-records.mjs';
import { publishGovernedLeadAcknowledgment } from './lead-acknowledgment.mjs';

const companyId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const leadAgentId = '33333333-3333-4333-8333-333333333333';
const rossAgentId = '44444444-4444-4444-8444-444444444444';
const runId = '55555555-5555-4555-8555-555555555555';
const ownIssueId = '66666666-6666-4666-8666-666666666666';
const recommendationIssueId = '77777777-7777-4777-8777-777777777777';
const recommendationCommentId = '88888888-8888-4888-8888-888888888888';
const recommendationRunId = '99999999-9999-4999-8999-999999999999';
const acknowledgmentCommentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const documentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const baseRevisionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const nextRevisionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const apiUrl = 'http://127.0.0.1:3100/api';
const recommendationBody = 'Ross recommends reviewing the assistant candidate with explicit source checks.';
const checkpointAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const pastCheckpointAt = new Date(Date.now() - 60 * 1000).toISOString();
const lateCheckpointAt = new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString();

const token = claims => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: leadAgentId, company_id: companyId, run_id: runId, adapter_type: 'hermes_local', exp: Math.floor(Date.now() / 1000) + 600, ...claims })).toString('base64url'),
  'synthetic_signature',
].join('.');

const binding = {
  apiUrl,
  companyId,
  projectId,
  agentId: leadAgentId,
  role: 'lead',
  acknowledgment: {
    commitmentId: 'review-assistant-candidate',
    rossAgentId,
    recommendation: { issueId: recommendationIssueId, commentId: recommendationCommentId, runId: recommendationRunId },
  },
};
const args = ['chat', '-q', 'Acknowledge Ross recommendation.', '-Q', '-m', 'glm-5.3-flash', '--provider', 'zai', '-t', 'ross_agentdash', '--max-turns', '4', '--source', 'tool'];
const env = { PAPERCLIP_API_URL: apiUrl, PAPERCLIP_COMPANY_ID: companyId, PAPERCLIP_AGENT_ID: leadAgentId, PAPERCLIP_RUN_ID: runId, PAPERCLIP_TASK_ID: ownIssueId, PAPERCLIP_API_KEY: token({}) };
const invocation = buildGovernedInvocation(binding, args, env);

function modelDecision(overrides = {}) {
  return {
    schemaVersion: 1,
    decision: 'accepted',
    title: 'Review assistant candidate',
    reason: 'The candidate should be reviewed with sourced acceptance criteria.',
    checkpoint: 'Lead accepted review of the assistant candidate.',
    checkpointAt,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  const sessionId = overrides.sessionId ?? '20260101_120000_fixt01_full';
  return {
    scope: { companyId, projectId, agentId: leadAgentId },
    executionMode: 'governed',
    runId,
    requestedModel: 'glm-5.3-flash',
    endpoint: 'https://api.z.ai/api/paas/v4',
    sessionId,
    answer: JSON.stringify(modelDecision(overrides.answerOverrides)),
    failure: null,
    usage: { modelRows: [{ session_id: sessionId, model: 'glm-5.3-flash', billing_provider: 'zai', billing_base_url: 'https://api.z.ai/api/paas/v4', api_call_count: 2 }] },
    ...overrides.receiptOverrides,
  };
}

function commitmentDocument(records) {
  return JSON.stringify({
    schemaVersion: 1,
    provenance: 'lead-authored Ross commitments',
    commitments: records,
  });
}

function priorCommitment() {
  return {
    id: 'existing-commitment',
    title: 'Existing commitment',
    decision: 'challenged',
    checkpoint: 'Prior checkpoint remains unchanged.',
    checkpointAt: '2026-09-29T12:00:00.000Z',
    recommendation: { issueId: recommendationIssueId, commentId: recommendationCommentId, runId: recommendationRunId },
    acknowledgment: { issueId: ownIssueId, commentId: acknowledgmentCommentId },
    reportedDelivery: null,
    verification: { status: 'not-performed' },
  };
}

function appendedCommitment(overrides = {}) {
  const decision = modelDecision();
  return {
    id: 'review-assistant-candidate',
    title: decision.title,
    decision: decision.decision,
    checkpoint: decision.checkpoint,
    checkpointAt: decision.checkpointAt,
    recommendation: binding.acknowledgment.recommendation,
    acknowledgment: { issueId: ownIssueId, commentId: acknowledgmentCommentId },
    reportedDelivery: null,
    verification: { status: 'not-performed' },
    ...overrides,
  };
}

function state(overrides = {}) {
  const commitments = overrides.commitments ?? [priorCommitment()];
  const currentDocument = {
    id: documentId,
    companyId,
    issueId: ownIssueId,
    key: 'ross-commitments',
    body: commitmentDocument(commitments),
    latestRevisionId: baseRevisionId,
    latestRevisionNumber: 4,
    updatedByAgentId: leadAgentId,
    updatedByUserId: null,
  };
  return {
    actor: { id: leadAgentId, companyId },
    rossActor: { id: rossAgentId, companyId },
    project: { id: projectId, companyId, leadAgentId },
    run: { id: runId, agentId: leadAgentId, companyId, status: 'running', contextSnapshot: { issueId: ownIssueId } },
    ownIssue: { id: ownIssueId, companyId, projectId, assigneeAgentId: leadAgentId, status: 'in_progress', checkoutRunId: runId, executionRunId: runId },
    recommendationIssue: { id: recommendationIssueId, companyId, projectId, assigneeAgentId: rossAgentId, status: 'in_review' },
    recommendationRun: { id: recommendationRunId, companyId, agentId: rossAgentId, status: 'succeeded', contextSnapshot: { issueId: recommendationIssueId }, resultJson: { result: recommendationBody } },
    recommendationComment: { id: recommendationCommentId, companyId, issueId: recommendationIssueId, authorAgentId: rossAgentId, authorUserId: null, createdByRunId: recommendationRunId, body: recommendationBody },
    currentDocument,
    nextDocument: { ...currentDocument, latestRevisionId: nextRevisionId, latestRevisionNumber: overrides.missingDocument ? 1 : 5 },
    newComment: { id: acknowledgmentCommentId, companyId, issueId: ownIssueId, authorAgentId: leadAgentId, authorUserId: null, createdByRunId: runId, body: null },
    ...overrides,
  };
}

function fakeRequest(data = state(), options = {}) {
  const calls = [];
  let documentMissing = Boolean(options.missingDocument);
  const request = async (path, body, method) => {
    calls.push({ path, body: body ?? null, method: method ?? (body ? 'POST' : 'GET') });
    if (options.failPost && path === `/issues/${ownIssueId}/comments` && (method ?? 'POST') === 'POST') throw new Error('comment post refused');
    if (options.failPut && path === `/issues/${ownIssueId}/documents/ross-commitments` && method === 'PUT') throw new Error('document put refused');
    if (path === '/agents/me') return data.actor;
    if (path === `/agents/${rossAgentId}` || path === `/companies/${companyId}/agents/${rossAgentId}`) return data.rossActor;
    if (path === `/projects/${projectId}`) return data.project;
    if (path === `/heartbeat-runs/${runId}`) return data.run;
    if (path === `/heartbeat-runs/${recommendationRunId}`) return data.recommendationRun;
    if (path === `/issues/${ownIssueId}`) return data.ownIssue;
    if (path === `/issues/${recommendationIssueId}`) return data.recommendationIssue;
    if (path === `/issues/${recommendationIssueId}/comments/${recommendationCommentId}`) return data.recommendationComment;
    if (path === `/issues/${ownIssueId}/documents/ross-commitments` && (method ?? 'GET') === 'GET') {
      if (options.documentReadError && !calls.some(call => call.method === 'PUT')) {
        const error = new Error('safe document read refusal');
        error.statusCode = options.documentReadError;
        throw error;
      }
      if (documentMissing && !calls.some(call => call.method === 'PUT')) {
        const error = new Error('safe not found');
        error.statusCode = 404;
        throw error;
      }
      if (options.editedReadback && calls.some(call => call.method === 'PUT')) return { ...data.nextDocument, body: 'edited body' };
      return calls.some(call => call.method === 'PUT') ? data.nextDocument : data.currentDocument;
    }
    if (path === `/issues/${ownIssueId}/comments` && (method ?? 'POST') === 'POST') {
      if (options.expectedCommentDecision) {
        assert.deepEqual(JSON.parse(body.body), options.expectedCommentDecision);
      } else if (body.body !== receipt().answer) {
        throw new Error('non-exact model acknowledgment body');
      }
      data.newComment = { ...data.newComment, body: body.body };
      return data.newComment;
    }
    if (path === `/issues/${ownIssueId}/comments/${acknowledgmentCommentId}`) return data.newComment;
    if (path === `/issues/${ownIssueId}/documents/ross-commitments` && method === 'PUT') {
      if (options.failCAS) throw new Error('document CAS refused');
      if (body.baseRevisionId !== (documentMissing ? null : data.currentDocument.latestRevisionId)) throw new Error('bad base revision');
      documentMissing = false;
      data.nextDocument = { ...data.nextDocument, body: body.body };
      return data.nextDocument;
    }
    throw new Error(`unexpected request ${method ?? 'GET'} ${path}`);
  };
  return { request, calls, data };
}

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ross-lead-ack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('publishes exact governed model JSON as a lead acknowledgment and appends one commitment', async t => {
  const dir = await workspace(t);
  const fx = fakeRequest();
  const publication = await publishGovernedLeadAcknowledgment({ binding, invocation, receipt: receipt(), request: fx.request, workspace: dir });
  assert.deepEqual(publication, { commitmentId: 'review-assistant-candidate', decision: 'accepted', acknowledgmentCommentId, revisionId: nextRevisionId, revisionNumber: 5, runId });
  const posted = fx.calls.find(call => call.path === `/issues/${ownIssueId}/comments` && call.method === 'POST');
  assert.equal(posted.body.body, receipt().answer);
  assert.deepEqual(JSON.parse(posted.body.body), modelDecision());
  const put = fx.calls.find(call => call.path === `/issues/${ownIssueId}/documents/ross-commitments` && call.method === 'PUT');
  assert.equal(put.body.baseRevisionId, baseRevisionId);
  const next = JSON.parse(put.body.body);
  assert.deepEqual(next.commitments[0], priorCommitment());
  assert.deepEqual(next.commitments[1], appendedCommitment());
  assert.equal(JSON.parse(await readFile(join(dir, 'lead-acknowledgment-intent-' + runId + '.json'), 'utf8')).commitmentId, 'review-assistant-candidate');
  assert.equal(JSON.parse(await readFile(join(dir, 'lead-acknowledgment-publication-' + runId + '.json'), 'utf8')).acknowledgmentCommentId, acknowledgmentCommentId);
});

test('preserves decoded multiline and literal backslash acknowledgment JSON through API-safe wire encoding', async t => {
  const dir = await workspace(t);
  const decision = modelDecision({
    title: 'Review assistant candidate with line\nbreak and slash \\',
    reason: 'Line one\nLine two\rLiteral backslash \\ stays decoded.',
    checkpoint: 'Checkpoint contains newline\ncarriage\rbackslash \\.',
  });
  const unsafeReceipt = receipt({ receiptOverrides: { answer: JSON.stringify(decision) } });
  const prior = priorCommitment();
  const priorWithEscapes = {
    ...prior,
    title: 'Existing line\ncarriage\rslash \\ retained',
    checkpoint: 'Prior checkpoint keeps newline\ncarriage\rand literal backslash \\.',
  };
  const fx = fakeRequest(state({ commitments: [priorWithEscapes] }), { expectedCommentDecision: decision });
  const publication = await publishGovernedLeadAcknowledgment({ binding, invocation, receipt: unsafeReceipt, request: fx.request, workspace: dir });
  assert.deepEqual(publication, { commitmentId: 'review-assistant-candidate', decision: 'accepted', acknowledgmentCommentId, revisionId: nextRevisionId, revisionNumber: 5, runId });

  const posted = fx.calls.find(call => call.path === `/issues/${ownIssueId}/comments` && call.method === 'POST');
  assert.notEqual(posted.body.body, unsafeReceipt.answer);
  assert.deepEqual(JSON.parse(posted.body.body), decision);
  assert.equal(fx.data.newComment.body, posted.body.body);

  const put = fx.calls.find(call => call.path === `/issues/${ownIssueId}/documents/ross-commitments` && call.method === 'PUT');
  assert.doesNotThrow(() => parseCommitmentDocument(put.body.body));
  const next = JSON.parse(put.body.body);
  assert.deepEqual(next.commitments[0], priorWithEscapes);
  assert.deepEqual(next.commitments[1], appendedCommitment({
    title: decision.title,
    checkpoint: decision.checkpoint,
    checkpointAt: decision.checkpointAt,
  }));

  const source = JSON.parse(await readFile(join(dir, 'lead-acknowledgment-source-' + runId + '.json'), 'utf8'));
  assert.equal(source.answerEncoding, 'JSON-equivalent-API-safe-encoding');
  assert.equal(source.comment.body, posted.body.body);
  assert.deepEqual(JSON.parse(source.comment.body), decision);
});

test('creates the first commitments document only after the model acknowledgment when the document is missing', async t => {
  const dir = await workspace(t);
  const fx = fakeRequest(state({ missingDocument: true }), { missingDocument: true });
  const publication = await publishGovernedLeadAcknowledgment({ binding, invocation, receipt: receipt(), request: fx.request, workspace: dir });
  assert.deepEqual(publication, { commitmentId: 'review-assistant-candidate', decision: 'accepted', acknowledgmentCommentId, revisionId: nextRevisionId, revisionNumber: 1, runId });
  const postIndex = fx.calls.findIndex(call => call.path === `/issues/${ownIssueId}/comments` && call.method === 'POST');
  const putIndex = fx.calls.findIndex(call => call.path === `/issues/${ownIssueId}/documents/ross-commitments` && call.method === 'PUT');
  assert.ok(postIndex >= 0 && putIndex > postIndex);
  assert.equal(fx.calls[postIndex].body.body, receipt().answer);
  assert.equal(fx.calls[putIndex].body.baseRevisionId, null);
  assert.doesNotThrow(() => parseCommitmentDocument(fx.calls[putIndex].body.body));
  const body = JSON.parse(fx.calls[putIndex].body.body);
  assert.equal(body.schemaVersion, 1);
  assert.equal(typeof body.provenance, 'string');
  assert.ok(body.provenance.trim());
  assert.ok(body.provenance.length <= 4000);
  assert.deepEqual(body.commitments, [appendedCommitment()]);
  assert.equal(fx.data.nextDocument.latestRevisionId, nextRevisionId);
  assert.equal(fx.data.nextDocument.latestRevisionNumber, 1);
  assert.equal(fx.data.nextDocument.updatedByAgentId, leadAgentId);
  assert.equal(fx.data.nextDocument.companyId, companyId);
  assert.equal(fx.data.nextDocument.issueId, ownIssueId);
});

test('denies non-404 document read failures before posting an acknowledgment', async t => {
  for (const statusCode of [403, 500]) {
    const fx = fakeRequest(state(), { documentReadError: statusCode });
    const dir = await workspace(t);
    await assert.rejects(
      () => publishGovernedLeadAcknowledgment({ binding, invocation, receipt: receipt(), request: fx.request, workspace: dir }),
      /document|read|refusal|denied|status|commitments/i,
    );
    assert.equal(fx.calls.some(call => call.method === 'POST' || call.method === 'PUT'), false);
  }
});

test('rejects malformed model decisions and unauthorized source state before mutations', async t => {
  for (const [badReceipt, mutate] of [
    [receipt({ answerOverrides: { decision: 'maybe' } }), data => data],
    [{ ...receipt(), answer: JSON.stringify({ ...modelDecision(), unexpected: true }) }, data => data],
    [receipt({ answerOverrides: { checkpointAt: pastCheckpointAt } }), data => data],
    [receipt({ answerOverrides: { checkpointAt: lateCheckpointAt } }), data => data],
    [receipt({ receiptOverrides: { executionMode: 'manual' } }), data => data],
    [receipt({ receiptOverrides: { endpoint: 'https://api.z.ai/api/coding/paas/v4' } }), data => data],
    [receipt({ receiptOverrides: { runId: rossAgentId } }), data => data],
    [receipt(), data => { data.project.leadAgentId = rossAgentId; }],
    [receipt(), data => { data.actor.id = rossAgentId; }],
    [receipt(), data => { data.ownIssue.checkoutRunId = rossAgentId; }],
    [receipt(), data => { data.recommendationIssue.projectId = companyId; }],
    [receipt(), data => { data.recommendationRun.status = 'failed'; }],
    [receipt(), data => { data.recommendationComment.body = 'edited'; }],
  ]) {
    const fx = fakeRequest(state(), {});
    mutate(fx.data);
    const dir = await workspace(t);
    await assert.rejects(
      () => publishGovernedLeadAcknowledgment({ binding, invocation, receipt: badReceipt, request: fx.request, workspace: dir }),
      /decision|schema|unknown|governed|route|lead|checkout|project|run|recommendation|answer|scope/i,
    );
    assert.equal(fx.calls.some(call => call.method === 'POST' || call.method === 'PUT'), false);
  }
});

test('refuses duplicate commitment or duplicate run before another write', async t => {
  const existing = appendedCommitment();
  const duplicateCommitment = fakeRequest(state({ commitments: [priorCommitment(), existing] }));
  const duplicateDir = await workspace(t);
  await assert.rejects(
    () => publishGovernedLeadAcknowledgment({ binding, invocation, receipt: receipt(), request: duplicateCommitment.request, workspace: duplicateDir }),
    /duplicate|existing|commitment/i,
  );
  assert.equal(duplicateCommitment.calls.some(call => call.method === 'POST' || call.method === 'PUT'), false);
  const dir = await workspace(t);
  const first = fakeRequest();
  await publishGovernedLeadAcknowledgment({ binding, invocation, receipt: receipt(), request: first.request, workspace: dir });
  const second = fakeRequest();
  await assert.rejects(
    () => publishGovernedLeadAcknowledgment({ binding, invocation, receipt: receipt(), request: second.request, workspace: dir }),
    /duplicate|intent|run|exists/i,
  );
  assert.equal(second.calls.some(call => call.method === 'POST' || call.method === 'PUT'), false);
});

test('does not retry ambiguous comment post, document put, CAS, or readback failures', async t => {
  for (const [fx, pattern] of [
    [fakeRequest(state(), { failPost: true }), /comment|post|refused/i],
    [fakeRequest(state(), { failPut: true }), /document|put|refused/i],
    [fakeRequest(state(), { failCAS: true }), /CAS|revision|refused/i],
    [fakeRequest(state(), { editedReadback: true }), /readback|body|revision|scope/i],
  ]) {
    const dir = await workspace(t);
    await assert.rejects(
      () => publishGovernedLeadAcknowledgment({ binding, invocation, receipt: receipt(), request: fx.request, workspace: dir }),
      pattern,
    );
    assert.equal(fx.calls.filter(call => call.method === 'POST').length <= 1, true);
    assert.equal(fx.calls.filter(call => call.method === 'PUT').length <= 1, true);
  }
});
