import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { reconcileRossCommitments } from './commitment-reconciliation.mjs';
import { createRossBridge } from './scoped-bridge.mjs';

const execute = promisify(execFile);
const companyId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const leadId = '44444444-4444-4444-8444-444444444444';
const issueId = '55555555-5555-4555-8555-555555555555';
const rossRunId = '66666666-6666-4666-8666-666666666666';
const acceptedCommentId = '77777777-7777-4777-8777-777777777777';
const ackCommentId = '88888888-8888-4888-8888-888888888888';
const reportRevisionId = '99999999-9999-4999-8999-999999999999';
const commitmentDocumentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const commitmentRevisionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const apiKey = 'synthetic-ross-agent-key';
const now = '2026-09-30T01:02:03.000Z';
const acceptedAdvice = 'Accepted recommendation: keep the fresh lead report separate from verified outcome.';
const acceptedAcknowledgment = 'Lead accepts the recommendation and will keep outcome verification open.';

const baseScope = { apiKey, companyId, projectId, agentId, issueId };

function commitment(overrides = {}) {
  return {
    id: 'commitment-accepted',
    title: 'Keep report delivery distinct from verified outcome',
    decision: 'accepted',
    checkpoint: 'Ross checkpoint: report delivery is acknowledged; outcome verification remains open.',
    checkpointAt: now,
    recommendation: { issueId, commentId: acceptedCommentId, runId: rossRunId },
    acknowledgment: { issueId, commentId: ackCommentId },
    reportedDelivery: null,
    verification: { status: 'not-performed' },
    ...overrides,
  };
}

function commitmentBody(commitments = [commitment()], extra = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    provenance: 'existing live Ross commitment document curated from inspected run/comment/document sources',
    commitments,
    ...extra,
  });
}

function rows() {
  const currentCommitmentDocument = {
    id: commitmentDocumentId,
    companyId,
    issueId,
    key: 'ross-commitments',
    body: commitmentBody(),
    latestRevisionId: commitmentRevisionId,
    latestRevisionNumber: 1,
    updatedByAgentId: leadId,
    updatedByUserId: null,
    updatedAt: now,
  };
  const comments = [
    {
      id: ackCommentId,
      companyId,
      issueId,
      body: acceptedAcknowledgment,
      authorAgentId: leadId,
      authorUserId: null,
      createdByRunId: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: acceptedCommentId,
      companyId,
      issueId,
      body: acceptedAdvice,
      authorAgentId: agentId,
      authorUserId: null,
      createdByRunId: rossRunId,
      createdAt: now,
      updatedAt: now,
    },
  ];
  return {
    actor: { id: agentId, companyId },
    project: { id: projectId, companyId, name: 'Synthetic Ross project', leadAgentId: leadId, updatedAt: now },
    issue: { id: issueId, companyId, projectId, title: 'Synthetic commitment task', status: 'in_review', updatedAt: now },
    currentCommitmentDocument,
    commitmentRevisions: [{
      id: commitmentRevisionId,
      companyId,
      documentId: commitmentDocumentId,
      issueId,
      key: 'ross-commitments',
      revisionNumber: 1,
      body: currentCommitmentDocument.body,
      createdByAgentId: leadId,
      createdByUserId: null,
      createdAt: now,
    }],
    leadReport: {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      companyId,
      issueId,
      key: 'lead-report',
      body: 'Lead report revision records delivery, not verified outcome.',
      latestRevisionId: reportRevisionId,
      latestRevisionNumber: 4,
      updatedByAgentId: leadId,
      updatedByUserId: null,
      updatedAt: now,
    },
    leadReportRevisions: [{
      id: reportRevisionId,
      companyId,
      documentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      issueId,
      key: 'lead-report',
      revisionNumber: 4,
      body: 'Lead report revision records delivery, not verified outcome.',
      createdByAgentId: leadId,
      createdByUserId: null,
      createdAt: now,
    }],
    comments,
    runs: [{
      id: rossRunId,
      companyId,
      agentId,
      status: 'succeeded',
      contextSnapshot: { issueId },
      resultJson: { result: acceptedAdvice, session_id: '20260101_120000_fixt01_full_hermes_session' },
      startedAt: now,
      finishedAt: now,
    }],
  };
}

async function fixture(t, mutate = () => {}) {
  const data = rows();
  mutate(data);
  const requests = [];
  const routes = new Map([
    ['/api/agents/me', () => data.actor],
    [`/api/projects/${projectId}`, () => data.project],
    [`/api/issues/${issueId}`, () => data.issue],
    [`/api/issues/${issueId}/documents/ross-commitments`, () => data.currentCommitmentDocument],
    [`/api/issues/${issueId}/documents/ross-commitments/revisions`, () => data.commitmentRevisions],
    [`/api/issues/${issueId}/documents/lead-report`, () => data.leadReport],
    [`/api/issues/${issueId}/documents/lead-report/revisions`, () => data.leadReportRevisions],
    [`/api/issues/${issueId}/comments?order=desc&limit=100`, () => data.comments],
    [`/api/issues/${issueId}/comments/${acceptedCommentId}`, () => data.comments.find((comment) => comment.id === acceptedCommentId) ?? null],
    [`/api/issues/${issueId}/comments/${ackCommentId}`, () => data.comments.find((comment) => comment.id === ackCommentId) ?? null],
    [`/api/issues/${issueId}/runs?limit=100&offset=0`, () => data.runs],
    [`/api/heartbeat-runs/${rossRunId}`, () => data.runs.find((run) => run.id === rossRunId) ?? null],
  ]);
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (req.method !== 'GET' || req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'forbidden', secret: apiKey }));
      return;
    }
    const handler = routes.get(req.url);
    const value = typeof handler === 'function' ? handler(req, res) : undefined;
    if (res.writableEnded) return;
    if (value === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing' }));
      return;
    }
    if (value === null) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { data, routes, requests, apiUrl: `http://127.0.0.1:${server.address().port}/api` };
}

async function mcpClientForRossStdio(t, { apiUrl, workspace, hermesHome }) {
  const resolve = createRequire(new URL('../../server/package.json', import.meta.url)).resolve;
  const { Client } = await import(pathToFileURL(resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  const env = {
    HOME: join(workspace, 'home'),
    ROSS_API_URL: apiUrl,
    ROSS_API_KEY: apiKey,
    ROSS_COMPANY_ID: companyId,
    ROSS_PROJECT_ID: projectId,
    ROSS_AGENT_ID: agentId,
  };
  if (hermesHome !== undefined) env.HERMES_HOME = hermesHome;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./stdio-bridge.mjs', import.meta.url))],
    cwd: workspace,
    stderr: 'pipe',
    env,
  });
  const client = new Client({ name: 'ross-commitment-projection-test', version: '0.1.0' });
  t.after(() => client.close().catch(() => {}));
  return { client, transport };
}

async function writeWorkspaceMarkers(workspace, scope = { companyId, projectId, agentId }) {
  await writeFile(join(workspace, 'scope.json'), JSON.stringify(scope), { mode: 0o600 });
  await writeFile(join(workspace, 'store-provenance.json'), JSON.stringify({
    version: 1,
    scope,
    journalMode: 'delete',
    freshStore: true,
  }), { mode: 0o600 });
}

async function tempStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ross-commitments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'private.sqlite');
}

async function reconcile(t, mutate) {
  const storePath = await tempStore(t);
  const api = await fixture(t, mutate);
  const result = await reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope });
  return { ...api, storePath, result };
}

async function collectReportOutcome(t, mutate, overrides = {}) {
  const api = await fixture(t, (data) => {
    data.currentCommitmentDocument.body = commitmentBody([
      commitment({
        id: 'commitment-delivered',
        reportedDelivery: { kind: 'issue-document-revision', issueId, key: 'lead-report', revisionId: reportRevisionId },
      }),
    ]);
    data.commitmentRevisions[0].body = data.currentCommitmentDocument.body;
    mutate?.(data);
  });
  const bridge = createRossBridge({ apiUrl: api.apiUrl, apiKey, companyId, projectId, agentId });
  const result = await bridge.collectReportOutcome(
    overrides.issueId ?? issueId,
    overrides.commitmentId ?? 'commitment-delivered',
    overrides.runId ?? rossRunId,
    overrides.commentId ?? acceptedCommentId,
  );
  return { ...api, result };
}

function storedBatchCount(storePath) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    return db.prepare('select count(*) as count from ross_batches').get().count;
  } finally {
    db.close();
  }
}

function storedBatchCountOrZero(storePath) {
  try {
    return storedBatchCount(storePath);
  } catch (error) {
    if (/no such table|unable to open/i.test(error.message)) return 0;
    throw error;
  }
}

function storedSourceCount(storePath) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    return db.prepare('select count(*) as count from ross_sources').get().count;
  } finally {
    db.close();
  }
}

function storedSourcePayload(storePath, key) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const row = db.prepare('select payload from ross_sources where key=?').get(key);
    return row ? JSON.parse(row.payload) : null;
  } finally {
    db.close();
  }
}

function withWritableStore(storePath, action) {
  const db = new DatabaseSync(storePath);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('reconciles one accepted commitment from exact recommendation and acknowledgment sources', async (t) => {
  const { result, requests, storePath, apiUrl } = await reconcile(t);
  assert.equal(result.batchCount, 1);
  assert.equal(result.sourceCount >= 5, true);
  assert.equal(result.deduplicated, false);
  assert.deepEqual(result.scope, { apiUrl, companyId, projectId, issueId, agentId, leadId });
  assert.equal(result.commitments.length, 1);
  assert.equal(result.commitments[0].id, 'commitment-accepted');
  assert.equal(result.commitments[0].title, 'Keep report delivery distinct from verified outcome');
  assert.equal(result.commitments[0].decision, 'accepted');
  assert.equal(result.commitments[0].state, 'accepted');
  assert.equal(result.commitments[0].verified, false);
  assert.deepEqual(result.commitments[0].issues, []);
  assert.equal(result.commitments[0].omitted, false);
  assert.equal(result.commitments[0].recommendation.commentId, acceptedCommentId);
  assert.equal(result.commitments[0].recommendation.runId, rossRunId);
  assert.equal(result.commitments[0].acknowledgment.commentId, ackCommentId);
  assert.equal(storedBatchCount(storePath), 1);
  assert.equal(requests[0].url, '/api/agents/me');
  assert.equal(requests[1].url, `/api/projects/${projectId}`);
  assert.equal(requests[2].url, `/api/issues/${issueId}`);
  assert.ok(requests.some((request) => request.url === `/api/issues/${issueId}/comments/${acceptedCommentId}`));
  assert.ok(requests.some((request) => request.url === `/api/issues/${issueId}/comments/${ackCommentId}`));
  assert.ok(requests.every((request) => request.method === 'GET'));
});

test('reports delivery only when the linked lead-report revision exists', async (t) => {
  const { result } = await reconcile(t, (data) => {
    data.currentCommitmentDocument.body = commitmentBody([
      commitment({
        id: 'commitment-delivered',
        reportedDelivery: { kind: 'issue-document-revision', issueId, key: 'lead-report', revisionId: reportRevisionId },
      }),
    ]);
    data.commitmentRevisions[0].body = data.currentCommitmentDocument.body;
  });
  assert.equal(result.commitments[0].state, 'reported_delivery');
  assert.equal(result.commitments[0].verified, false);
  assert.deepEqual(result.commitments[0].issues, []);
});

test('collects a same-project reported-delivery outcome with exact run, session and answer comment attribution', async (t) => {
  const { result } = await collectReportOutcome(t);
  assert.equal(result.batch.scope.companyId, companyId);
  assert.equal(result.batch.scope.projectId, projectId);
  assert.equal(result.batch.scope.issueId, issueId);
  assert.equal(result.commitment.id, 'commitment-delivered');
  assert.deepEqual(result.commitment.reportedDelivery, { kind: 'issue-document-revision', issueId, key: 'lead-report', revisionId: reportRevisionId });
  assert.deepEqual(result.consumingRun, {
    id: rossRunId,
    companyId,
    agentId,
    issueId,
    status: 'succeeded',
    startedAt: now,
    finishedAt: now,
    sessionId: '20260101_120000_fixt01_full_hermes_session',
    answer: acceptedAdvice,
    source: result.batch.scope.apiUrl + `/heartbeat-runs/${rossRunId}`,
  });
  assert.deepEqual(result.answerComment, {
    id: acceptedCommentId,
    companyId,
    issueId,
    authorAgentId: agentId,
    authorUserId: null,
    createdByRunId: rossRunId,
    body: acceptedAdvice,
    source: result.batch.scope.apiUrl + `/issues/${issueId}/comments/${acceptedCommentId}`,
  });
});

test('rejects reported-delivery outcome collection when run or comment attribution is forged', async (t) => {
  await assert.rejects(
    () => collectReportOutcome(t, (data) => { data.runs[0].contextSnapshot.issueId = '19191919-1919-4191-8191-191919191919'; }),
    /run|issue|scope|attribution/i,
  );
  await assert.rejects(
    () => collectReportOutcome(t, (data) => { data.comments.find((comment) => comment.id === acceptedCommentId).createdByRunId = ackCommentId; }),
    /comment|run|attribution/i,
  );
  await assert.rejects(
    () => collectReportOutcome(t, (data) => { data.comments.find((comment) => comment.id === acceptedCommentId).body = 'Edited answer.'; }),
    /answer|result|comment|changed/i,
  );
});

test('rejects reported-delivery outcome collection when full Hermes session is unavailable', async (t) => {
  await assert.rejects(
    () => collectReportOutcome(t, (data) => { delete data.runs[0].resultJson.session_id; }),
    /session/i,
  );
});

test('rejects reported-delivery outcome collection after final access revocation', async (t) => {
  const api = await fixture(t, (data) => {
    data.currentCommitmentDocument.body = commitmentBody([
      commitment({
        id: 'commitment-delivered',
        reportedDelivery: { kind: 'issue-document-revision', issueId, key: 'lead-report', revisionId: reportRevisionId },
      }),
    ]);
    data.commitmentRevisions[0].body = data.currentCommitmentDocument.body;
  });
  let actorReads = 0;
  api.routes.set('/api/agents/me', (_req, res) => {
    actorReads += 1;
    if (actorReads <= 2) return api.data.actor;
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'revoked', secret: apiKey }));
    return undefined;
  });
  const bridge = createRossBridge({ apiUrl: api.apiUrl, apiKey, companyId, projectId, agentId });
  await assert.rejects(
    () => bridge.collectReportOutcome(issueId, 'commitment-delivered', rossRunId, acceptedCommentId),
    (error) => /403|refused|auth/i.test(error.message) && !error.message.includes(apiKey),
  );
  assert.equal(actorReads >= 3, true);
});

test('marks a missing optional linked source unresolved instead of rejecting the batch', async (t) => {
  const { result } = await reconcile(t, (data) => {
    data.comments = data.comments.filter((comment) => comment.id !== ackCommentId);
  });
  assert.equal(result.commitments[0].state, 'unresolved');
  assert.equal(result.commitments[0].verified, false);
  assert.ok(result.commitments[0].issues.includes('acknowledgment_source_missing'));
});

test('rejects strict JSON schema violations before appending a batch', async (t) => {
  for (const body of [
    '{not-json',
    commitmentBody([commitment()], { unexpected: true }),
    commitmentBody([{ ...commitment(), extra: true }]),
    commitmentBody([commitment(), commitment()]),
    commitmentBody([{ ...commitment(), verification: { status: 'verified' } }]),
  ]) {
    const storePath = await tempStore(t);
    const { apiUrl } = await fixture(t, (data) => {
      data.currentCommitmentDocument.body = body;
      data.commitmentRevisions[0].body = body;
    });
    await assert.rejects(
      () => reconcileRossCommitments({ apiUrl, storePath, ...baseScope }),
      /schema|json|duplicate|unknown|verification/i,
    );
  }
});

test('rolls back a rejected document body without appending a partial batch over the prior store', async (t) => {
  const storePath = await tempStore(t);
  const api = await fixture(t);
  await reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope });
  api.data.currentCommitmentDocument.latestRevisionId = '13131313-1313-4131-8131-131313131313';
  api.data.currentCommitmentDocument.latestRevisionNumber = 2;
  api.data.currentCommitmentDocument.body = commitmentBody([{ ...commitment(), verification: { status: 'verified' } }]);
  api.data.commitmentRevisions.unshift({
    ...api.data.commitmentRevisions[0],
    id: api.data.currentCommitmentDocument.latestRevisionId,
    revisionNumber: 2,
    body: api.data.currentCommitmentDocument.body,
  });
  await assert.rejects(
    () => reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope }),
    /schema|verification/i,
  );
  assert.equal(storedBatchCount(storePath), 1);
});

test('rejects foreign scope and forged attribution sources', async (t) => {
  for (const mutate of [
    (data) => { data.currentCommitmentDocument.companyId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; },
    (data) => { data.comments.find((comment) => comment.id === ackCommentId).authorAgentId = agentId; },
    (data) => { data.runs[0].agentId = leadId; },
    (data) => { data.runs[0].contextSnapshot.issueId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; },
  ]) {
    const storePath = await tempStore(t);
    const { apiUrl } = await fixture(t, mutate);
    await assert.rejects(
      () => reconcileRossCommitments({ apiUrl, storePath, ...baseScope }),
      /scope|author|attribution|run/i,
    );
  }
});

test('marks edited Ross advice unresolved when the comment no longer matches the run result', async (t) => {
  const { result } = await reconcile(t, (data) => {
    data.comments.find((comment) => comment.id === acceptedCommentId).body = 'Edited after run completion.';
    data.comments.find((comment) => comment.id === acceptedCommentId).updatedAt = '2026-09-30T02:03:04.000Z';
  });
  assert.equal(result.commitments[0].state, 'unresolved');
  assert.ok(result.commitments[0].issues.includes('advice_content_changed'));
  assert.equal(result.commitments[0].verified, false);
});

test('rejects same-revision source payload changes and preserves the original source snapshot', async (t) => {
  const storePath = await tempStore(t);
  const api = await fixture(t);
  await reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope });
  const sourceCount = storedSourceCount(storePath);
  const documentSourceKey = `document:${commitmentDocumentId}:${commitmentRevisionId}`;
  const originalDocumentSource = storedSourcePayload(storePath, documentSourceKey);
  assert.equal(originalDocumentSource.body, commitmentBody());
  const changedBody = commitmentBody([commitment({ checkpoint: 'Same revision, changed payload should be refused.' })]);
  api.data.currentCommitmentDocument.body = changedBody;
  api.data.commitmentRevisions[0].body = changedBody;
  await assert.rejects(
    () => reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope }),
    /immutable source version conflict/i,
  );
  assert.equal(storedBatchCount(storePath), 1);
  assert.equal(storedSourceCount(storePath), sourceCount);
  assert.deepEqual(storedSourcePayload(storePath, documentSourceKey), originalDocumentSource);
});

test('redelivers the same immutable evidence without appending a duplicate batch', async (t) => {
  const storePath = await tempStore(t);
  const { apiUrl } = await fixture(t);
  const first = await reconcileRossCommitments({ apiUrl, storePath, ...baseScope });
  const second = await reconcileRossCommitments({ apiUrl, storePath, ...baseScope });
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.batchCount, 1);
  assert.equal(storedBatchCount(storePath), 1);
});

test('concurrent identical reconciliations leave one append-only batch', async (t) => {
  const storePath = await tempStore(t);
  const { apiUrl } = await fixture(t);
  const results = await Promise.all([
    reconcileRossCommitments({ apiUrl, storePath, ...baseScope }),
    reconcileRossCommitments({ apiUrl, storePath, ...baseScope }),
  ]);
  assert.equal(results.every((result) => result.commitments[0]?.state === 'accepted'), true);
  assert.equal(storedBatchCount(storePath), 1);
});

test('appends restored evidence after an intervening unresolved batch', async (t) => {
  const storePath = await tempStore(t);
  const api = await fixture(t);
  const first = await reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope });
  assert.equal(first.commitments[0].state, 'accepted');
  const acknowledged = api.data.comments.find((comment) => comment.id === ackCommentId);
  api.data.comments = api.data.comments.filter((comment) => comment.id !== ackCommentId);
  const missing = await reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope });
  assert.equal(missing.commitments[0].state, 'unresolved');
  assert.ok(missing.commitments[0].issues.includes('acknowledgment_source_missing'));
  api.data.comments.unshift(acknowledged);
  const restored = await reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope });
  assert.equal(restored.deduplicated, false);
  assert.equal(restored.batchCount, 3);
  assert.equal(restored.commitments[0].state, 'accepted');
  assert.deepEqual(restored.commitments[0].issues, []);
  assert.equal(storedBatchCount(storePath), 3);
});

test('redelivers the same immutable evidence from a fresh node process without appending a duplicate batch', async (t) => {
  const storePath = await tempStore(t);
  const { apiUrl } = await fixture(t);
  await reconcileRossCommitments({ apiUrl, storePath, ...baseScope });
  const moduleUrl = new URL('./commitment-reconciliation.mjs', import.meta.url).href;
  const code = `
    import { reconcileRossCommitments } from ${JSON.stringify(moduleUrl)};
    const result = await reconcileRossCommitments(${JSON.stringify({ apiUrl, storePath, ...baseScope })});
    process.stdout.write(JSON.stringify({ deduplicated: result.deduplicated, batchCount: result.batchCount, state: result.commitments[0]?.state }));
  `;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', code], { timeout: 10_000 });
  assert.deepEqual(JSON.parse(stdout), { deduplicated: true, batchCount: 1, state: 'accepted' });
  assert.equal(storedBatchCount(storePath), 1);
});

test('refuses orphan WAL or SHM sidecars before creating an unbound store', async (t) => {
  for (const suffix of ['-wal', '-shm']) {
    const storePath = await tempStore(t);
    const { apiUrl } = await fixture(t);
    await writeFile(storePath + suffix, 'orphan sidecar', { mode: 0o600 });
    await assert.rejects(
      () => reconcileRossCommitments({ apiUrl, storePath, ...baseScope }),
      /sidecar|wal|shm|unowned|existing|refused/i,
    );
    assert.equal(await fileExists(storePath), false);
  }
});

test('refuses an unbound rollback journal before creating a store', async (t) => {
  const storePath = await tempStore(t);
  const { apiUrl } = await fixture(t);
  await writeFile(storePath + '-journal', 'orphan rollback journal', { mode: 0o600 });
  await assert.rejects(
    () => reconcileRossCommitments({ apiUrl, storePath, ...baseScope }),
    /journal|sidecar|unowned|existing|refused/i,
  );
  assert.equal(await fileExists(storePath), false);
});

test('allows an owner-private rollback journal beside an already bound store', async (t) => {
  const storePath = await tempStore(t);
  const { apiUrl } = await fixture(t);
  await reconcileRossCommitments({ apiUrl, storePath, ...baseScope });
  await writeFile(storePath + '-journal', 'synthetic crash rollback marker', { mode: 0o600 });
  const result = await reconcileRossCommitments({ apiUrl, storePath, ...baseScope });
  assert.equal(result.deduplicated, true);
  assert.equal(result.batchCount, 1);
});

test('recovers a bound store after a child dies with a hot rollback journal', async (t) => {
  const storePath = await tempStore(t);
  const { apiUrl } = await fixture(t);
  await reconcileRossCommitments({ apiUrl, storePath, ...baseScope });
  const batchCount = storedBatchCount(storePath);
  const sourceCount = storedSourceCount(storePath);
  const crashPayload = 'x'.repeat(256 * 1024);
  const code = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(storePath)});
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=1; BEGIN IMMEDIATE;');
    db.prepare('UPDATE ross_meta SET binding = binding || ? WHERE id=1').run(${JSON.stringify(crashPayload)});
    const insert = db.prepare('INSERT INTO ross_sources(key,hash,payload) VALUES(?,?,?)');
    for (let index = 0; index < 40; index += 1) insert.run('crash:' + index, 'not-a-real-hash', JSON.stringify({companyId:${JSON.stringify(companyId)}, blob:${JSON.stringify(crashPayload)}}));
    process.stdout.write('ready\\n', () => process.kill(process.pid, 'SIGKILL'));
  `;
  await assert.rejects(
    execute(process.execPath, ['--input-type=module', '-e', code], { timeout: 10_000 }),
    (error) => error.signal === 'SIGKILL' && String(error.stdout).includes('ready'),
  );
  assert.equal(await fileExists(storePath + '-journal'), true);
  const result = await reconcileRossCommitments({ apiUrl, storePath, ...baseScope });
  assert.equal(result.deduplicated, true);
  assert.equal(result.batchCount, batchCount);
  assert.equal(storedBatchCount(storePath), batchCount);
  assert.equal(storedSourceCount(storePath), sourceCount);
});

test('refuses an unknown existing SQLite database without modifying it', async (t) => {
  const storePath = await tempStore(t);
  withWritableStore(storePath, (db) => {
    db.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sentinel(value) VALUES('preserve-me');");
  });
  const before = withWritableStore(storePath, (db) => db.prepare('SELECT value FROM sentinel WHERE id=1').get().value);
  const { apiUrl } = await fixture(t);
  await assert.rejects(
    () => reconcileRossCommitments({ apiUrl, storePath, ...baseScope }),
    /unowned existing database refused|binding|scope/i,
  );
  const after = withWritableStore(storePath, (db) => db.prepare('SELECT value FROM sentinel WHERE id=1').get().value);
  assert.equal(after, before);
});

test('retains omitted prior commitments as unresolved append-only records', async (t) => {
  const storePath = await tempStore(t);
  const api = await fixture(t);
  await reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope });
  api.data.currentCommitmentDocument.latestRevisionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  api.data.currentCommitmentDocument.latestRevisionNumber = 2;
  api.data.currentCommitmentDocument.body = commitmentBody([]);
  api.data.commitmentRevisions.unshift({
    ...api.data.commitmentRevisions[0],
    id: api.data.currentCommitmentDocument.latestRevisionId,
    revisionNumber: 2,
    body: api.data.currentCommitmentDocument.body,
  });
  const result = await reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope });
  assert.equal(result.commitments[0].id, 'commitment-accepted');
  assert.equal(result.commitments[0].state, 'unresolved');
  assert.equal(result.commitments[0].omitted, true);
  assert.ok(result.commitments[0].issues.includes('omitted_from_current_document'));
});

test('rejects a changed current revision after source collection without appending a batch', async (t) => {
  const storePath = await tempStore(t);
  let currentDocumentReads = 0;
  const api = await fixture(t);
  api.routes.set(`/api/issues/${issueId}/documents/ross-commitments`, () => {
    currentDocumentReads += 1;
    if (currentDocumentReads === 1) return api.data.currentCommitmentDocument;
    return {
      ...api.data.currentCommitmentDocument,
      latestRevisionId: '12121212-1212-4121-8121-121212121212',
      latestRevisionNumber: 2,
    };
  });
  await assert.rejects(async () => {
    const result = await reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope });
    return result;
  }, /revision|changed|conflict/i);
  assert.equal(storedBatchCountOrZero(storePath), 0);
});

test('rejects a lower current document revision than the stored commitment view', async (t) => {
  const storePath = await tempStore(t);
  const api = await fixture(t, (data) => {
    data.currentCommitmentDocument.latestRevisionId = '17171717-1717-4171-8171-171717171717';
    data.currentCommitmentDocument.latestRevisionNumber = 2;
    data.currentCommitmentDocument.body = commitmentBody([commitment({ checkpoint: 'Stored newer revision.' })]);
    data.commitmentRevisions.unshift({
      ...data.commitmentRevisions[0],
      id: data.currentCommitmentDocument.latestRevisionId,
      revisionNumber: 2,
      body: data.currentCommitmentDocument.body,
    });
  });
  await reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope });
  api.data.currentCommitmentDocument.latestRevisionId = commitmentRevisionId;
  api.data.currentCommitmentDocument.latestRevisionNumber = 1;
  api.data.currentCommitmentDocument.body = commitmentBody();
  await assert.rejects(
    () => reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope }),
    /revision|lower|stale|conflict/i,
  );
  assert.equal(storedBatchCount(storePath), 1);
});

test('rejects actor revocation during final collection recheck before store initialization', async (t) => {
  const storePath = await tempStore(t);
  const api = await fixture(t);
  let actorReads = 0;
  api.routes.set('/api/agents/me', (_req, res) => {
    actorReads += 1;
    if (actorReads === 1) return api.data.actor;
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'revoked', secret: apiKey }));
    return undefined;
  });
  await assert.rejects(
    () => reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope }),
    (error) => /403|refused|auth/i.test(error.message) && !error.message.includes(apiKey),
  );
  assert.equal(actorReads >= 2, true);
  assert.equal(storedBatchCountOrZero(storePath), 0);
});

test('rejects future commitment document timestamps before appending a batch', async (t) => {
  const storePath = await tempStore(t);
  const { apiUrl } = await fixture(t, (data) => {
    data.currentCommitmentDocument.updatedAt = '2999-01-01T00:00:00.000Z';
  });
  await assert.rejects(
    () => reconcileRossCommitments({ apiUrl, storePath, ...baseScope }),
    /future document timestamp|future source timestamp/i,
  );
  assert.equal(storedBatchCountOrZero(storePath), 0);
});

test('rolls back source writes when a new batch insert aborts', async (t) => {
  const storePath = await tempStore(t);
  const api = await fixture(t);
  await reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope });
  const sourceCount = storedSourceCount(storePath);
  withWritableStore(storePath, (db) => {
    db.exec("CREATE TRIGGER ross_test_abort_batch BEFORE INSERT ON ross_batches BEGIN SELECT RAISE(ABORT, 'test batch abort'); END;");
  });
  api.data.currentCommitmentDocument.latestRevisionId = '18181818-1818-4181-8181-181818181818';
  api.data.currentCommitmentDocument.latestRevisionNumber = 2;
  api.data.currentCommitmentDocument.body = commitmentBody([commitment({ checkpoint: 'New batch should abort after source writes.' })]);
  api.data.commitmentRevisions.unshift({
    ...api.data.commitmentRevisions[0],
    id: api.data.currentCommitmentDocument.latestRevisionId,
    revisionNumber: 2,
    body: api.data.currentCommitmentDocument.body,
  });
  await assert.rejects(
    () => reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope }),
    /test batch abort/i,
  );
  assert.equal(storedBatchCount(storePath), 1);
  assert.equal(storedSourceCount(storePath), sourceCount);
});

test('does not return cached commitments when current authentication is denied', async (t) => {
  const storePath = await tempStore(t);
  const api = await fixture(t);
  await reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope });
  api.routes.set('/api/agents/me', (_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'forbidden', secret: apiKey }));
  });
  await assert.rejects(
    () => reconcileRossCommitments({ apiUrl: api.apiUrl, storePath, ...baseScope }),
    (error) => /403|refused|auth/i.test(error.message) && !error.message.includes(apiKey),
  );
});

test('records private store binding and refuses reuse across origin or scope', async (t) => {
  const storePath = await tempStore(t);
  const first = await fixture(t);
  await reconcileRossCommitments({ apiUrl: first.apiUrl, storePath, ...baseScope });
  const second = await fixture(t);
  await assert.rejects(
    () => reconcileRossCommitments({ apiUrl: second.apiUrl, storePath, ...baseScope }),
    /binding|origin|scope/i,
  );
  await assert.rejects(
    () => reconcileRossCommitments({ apiUrl: first.apiUrl, storePath, ...baseScope, projectId: '34343434-3434-4343-8343-343434343434' }),
    /binding|origin|scope|read refused \(404\)/i,
  );
});

test('serves commitment projection through real MCP stdio issue evidence reads', { timeout: 15_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'ross-stdio-workspace-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const { apiUrl, requests } = await fixture(t);
  const { client, transport } = await mcpClientForRossStdio(t, {
    apiUrl,
    workspace,
    hermesHome: join(workspace, 'home/.hermes/profiles/ross-pilot'),
  });
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), ['ross_issue_evidence', 'ross_project_snapshot']);
  const first = await client.callTool({ name: 'ross_issue_evidence', arguments: { issueId } });
  assert.equal(first.isError, undefined);
  const evidence = JSON.parse(first.content[0].text);
  assert.equal(evidence.commitmentProjection.batchCount, 1);
  assert.equal(evidence.commitmentProjection.deduplicated, false);
  assert.equal(evidence.commitmentProjection.commitments[0].id, 'commitment-accepted');
  assert.equal(evidence.commitmentProjection.commitments[0].state, 'accepted');
  assert.equal(evidence.commitmentProjection.commitments[0].verified, false);
  const second = await client.callTool({ name: 'ross_issue_evidence', arguments: { issueId } });
  assert.equal(second.isError, undefined);
  const repeated = JSON.parse(second.content[0].text);
  assert.equal(repeated.commitmentProjection.batchCount, 1);
  assert.equal(repeated.commitmentProjection.deduplicated, true);
  const beforeDenied = requests.length;
  const denied = await client.callTool({ name: 'ross_issue_evidence', arguments: { issueId, projectId: '34343434-3434-4343-8343-343434343434' } });
  assert.equal(denied.isError, true);
  assert.equal(requests.length, beforeDenied);
});

test('refuses mismatched private runtime profile before any stdio HTTP read', { timeout: 15_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'ross-stdio-bad-profile-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const { apiUrl, requests } = await fixture(t);
  const { client, transport } = await mcpClientForRossStdio(t, {
    apiUrl,
    workspace,
    hermesHome: join(workspace, 'home/.hermes/profiles/foreign'),
  });
  await assert.rejects(
    () => client.connect(transport),
    /closed|startup|connection|stdio|transport|failed/i,
  );
  assert.equal(requests.length, 0);
});

test('serves commitment projection from cwd markers when HERMES_HOME is unset', { timeout: 15_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'ross-stdio-marker-workspace-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceMarkers(workspace);
  const { apiUrl } = await fixture(t);
  const { client, transport } = await mcpClientForRossStdio(t, { apiUrl, workspace, hermesHome: undefined });
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), ['ross_issue_evidence', 'ross_project_snapshot']);
  const first = await client.callTool({ name: 'ross_issue_evidence', arguments: { issueId } });
  assert.equal(first.isError, undefined);
  const evidence = JSON.parse(first.content[0].text);
  assert.equal(evidence.commitmentProjection.batchCount, 1);
  assert.equal(evidence.commitmentProjection.deduplicated, false);
  assert.equal(evidence.commitmentProjection.commitments[0].id, 'commitment-accepted');
  assert.equal(evidence.commitmentProjection.commitments[0].state, 'accepted');
  assert.equal(evidence.commitmentProjection.commitments[0].verified, false);
  const second = await client.callTool({ name: 'ross_issue_evidence', arguments: { issueId } });
  const repeated = JSON.parse(second.content[0].text);
  assert.equal(repeated.commitmentProjection.batchCount, 1);
  assert.equal(repeated.commitmentProjection.deduplicated, true);
});

test('refuses foreign cwd markers before any stdio HTTP read', { timeout: 15_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'ross-stdio-foreign-marker-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceMarkers(workspace, { companyId: agentId, projectId, agentId });
  const { apiUrl, requests } = await fixture(t);
  const { client, transport } = await mcpClientForRossStdio(t, { apiUrl, workspace, hermesHome: undefined });
  await assert.rejects(
    () => client.connect(transport),
    /closed|startup|connection|stdio|transport|failed/i,
  );
  assert.equal(requests.length, 0);
});

test('serves scoped issue evidence with unavailable projection when HERMES_HOME is unset', { timeout: 15_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'ross-stdio-no-profile-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const { apiUrl, requests } = await fixture(t);
  const { client, transport } = await mcpClientForRossStdio(t, { apiUrl, workspace, hermesHome: undefined });
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), ['ross_issue_evidence', 'ross_project_snapshot']);
  const result = await client.callTool({ name: 'ross_issue_evidence', arguments: { issueId } });
  assert.equal(result.isError, undefined);
  const evidence = JSON.parse(result.content[0].text);
  assert.equal(evidence.issue.id, issueId);
  assert.equal(evidence.commitmentDocument.latestRevisionId, commitmentRevisionId);
  assert.deepEqual(evidence.commitmentProjection, {
    status: 'unavailable',
    reason: 'private runtime not configured',
    verified: false,
  });
  assert.ok(requests.some((request) => request.url === `/api/issues/${issueId}/documents/ross-commitments`));
});
