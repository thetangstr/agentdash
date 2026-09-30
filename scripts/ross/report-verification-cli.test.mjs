import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
const companyId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const leadId = '44444444-4444-4444-8444-444444444444';
const issueId = '55555555-5555-4555-8555-555555555555';
const runId = '66666666-6666-4666-8666-666666666666';
const adviceCommentId = '77777777-7777-4777-8777-777777777777';
const ackCommentId = '88888888-8888-4888-8888-888888888888';
const reportRevisionId = '99999999-9999-4999-8999-999999999999';
const reportDocumentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const commitmentDocumentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const commitmentRevisionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const apiKey = 'synthetic-ross-agent-key';
const sessionId = '20260101_120000_fixt01_full_hermes_session';
const reportBody = 'Lead report revision records delivery, not verified outcome.';
const answer = 'Ross consumed the corrected lead report and kept verification open.';
const startedAt = '2026-09-30T01:03:00.000Z';
const finishedAt = '2026-09-30T01:04:00.000Z';
const observedAt = '2026-09-30T01:03:30.000Z';
const publishedAt = '2026-09-30T01:02:00.000Z';
const tool = 'mcp__ross_agentdash__ross_issue_evidence';

function commitmentBody() {
  return JSON.stringify({
    schemaVersion: 1,
    provenance: 'existing live Ross commitment document curated from inspected run/comment/document sources',
    commitments: [{
      id: 'commitment-delivered',
      title: 'Publish the corrected lead report',
      decision: 'accepted',
      checkpoint: 'Report is published; business outcome remains unverified.',
      checkpointAt: publishedAt,
      recommendation: { issueId, commentId: adviceCommentId, runId },
      acknowledgment: { issueId, commentId: ackCommentId },
      reportedDelivery: { kind: 'issue-document-revision', issueId, key: 'lead-report', revisionId: reportRevisionId },
      verification: { status: 'not-performed' },
    }],
  });
}

function apiRows() {
  const commitmentDocument = {
    id: commitmentDocumentId,
    companyId,
    issueId,
    key: 'ross-commitments',
    body: commitmentBody(),
    latestRevisionId: commitmentRevisionId,
    latestRevisionNumber: 1,
    updatedByAgentId: leadId,
    updatedByUserId: null,
    updatedAt: publishedAt,
  };
  return {
    actor: { id: agentId, companyId },
    project: { id: projectId, companyId, name: 'Synthetic Ross project', leadAgentId: leadId },
    issue: { id: issueId, companyId, projectId, title: 'Synthetic report outcome', status: 'in_review' },
    commitmentDocument,
    commitmentRevisions: [{
      id: commitmentRevisionId,
      companyId,
      documentId: commitmentDocumentId,
      issueId,
      key: 'ross-commitments',
      revisionNumber: 1,
      body: commitmentDocument.body,
      createdByAgentId: leadId,
      createdByUserId: null,
      createdAt: publishedAt,
    }],
    leadReport: {
      id: reportDocumentId,
      companyId,
      issueId,
      key: 'lead-report',
      body: reportBody,
      latestRevisionId: reportRevisionId,
      latestRevisionNumber: 4,
      updatedByAgentId: leadId,
      updatedByUserId: null,
      updatedAt: publishedAt,
    },
    leadReportRevisions: [{
      id: reportRevisionId,
      companyId,
      documentId: reportDocumentId,
      issueId,
      key: 'lead-report',
      revisionNumber: 4,
      body: reportBody,
      createdByAgentId: leadId,
      createdByUserId: null,
      createdAt: publishedAt,
    }],
    comments: [
      { id: ackCommentId, companyId, issueId, body: 'Lead acknowledges delivery.', authorAgentId: leadId, authorUserId: null, createdByRunId: null, createdAt: publishedAt, updatedAt: publishedAt },
      { id: adviceCommentId, companyId, issueId, body: answer, authorAgentId: agentId, authorUserId: null, createdByRunId: runId, createdAt: finishedAt, updatedAt: finishedAt },
    ],
    runs: [{
      id: runId,
      companyId,
      agentId,
      status: 'succeeded',
      contextSnapshot: { issueId },
      resultJson: { result: answer, session_id: sessionId },
      startedAt,
      finishedAt,
    }],
  };
}

async function httpFixture(t, mutate = () => {}) {
  const data = apiRows();
  mutate(data);
  const requests = [];
  const routes = new Map([
    ['/api/agents/me', () => data.actor],
    [`/api/projects/${projectId}`, () => data.project],
    [`/api/issues/${issueId}`, () => data.issue],
    [`/api/issues/${issueId}/documents/ross-commitments`, () => data.commitmentDocument],
    [`/api/issues/${issueId}/documents/ross-commitments/revisions`, () => data.commitmentRevisions],
    [`/api/issues/${issueId}/documents/lead-report`, () => data.leadReport],
    [`/api/issues/${issueId}/documents/lead-report/revisions`, () => data.leadReportRevisions],
    [`/api/issues/${issueId}/comments?order=desc&limit=100`, () => data.comments],
    [`/api/issues/${issueId}/comments/${adviceCommentId}`, () => data.comments.find((comment) => comment.id === adviceCommentId) ?? null],
    [`/api/issues/${issueId}/comments/${ackCommentId}`, () => data.comments.find((comment) => comment.id === ackCommentId) ?? null],
    [`/api/heartbeat-runs/${runId}`, () => data.runs.find((run) => run.id === runId) ?? null],
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
    if (value === undefined || value === null) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { data, routes, requests, apiUrl: `http://127.0.0.1:${server.address().port}/api` };
}

function toolPayload() {
  return {
    scope: { companyId, projectId, agentId },
    observedAt,
    issue: { id: issueId, companyId, projectId },
    leadReport: {
      id: reportDocumentId,
      latestRevisionId: reportRevisionId,
      latestRevisionNumber: 4,
      body: reportBody,
      updatedByAgentId: leadId,
      updatedByUserId: null,
    },
  };
}

async function privateRuntime(t, apiUrl) {
  const root = await mkdtemp(join(tmpdir(), 'ross-report-verification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'ross-runtime');
  const home = join(workspace, 'home/.hermes/profiles/ross-pilot');
  const scope = { companyId, projectId, agentId };
  await mkdir(home, { recursive: true, mode: 0o700 });
  const bindingPath = join(root, 'binding.json');
  for (const [path, value] of [
    [bindingPath, { apiUrl, companyId, projectId, agentId, privateStateDir: root }],
    [join(workspace, 'scope.json'), scope],
    [join(workspace, 'store-provenance.json'), { version: 1, scope, journalMode: 'delete', freshStore: true }],
    [join(workspace, 'private-store-owner.json'), { scope, pid: 99999999, group: 99999999 }],
    [join(home, 'config.yaml'), { database: { journal_mode: 'delete' } }],
  ]) await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await writeFile(join(home, '.ross-writer.lock'), '', { mode: 0o600 });
  const dbPath = join(home, 'state.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY, model TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, tool_call_id TEXT, tool_calls TEXT, timestamp REAL);');
    db.prepare('INSERT INTO sessions(id, model) VALUES(?, ?)').run(sessionId, 'glm-5.3-flash');
    db.prepare('INSERT INTO messages(id, session_id, role, content, tool_calls, timestamp) VALUES(?, ?, ?, ?, ?, ?)').run(
      10,
      sessionId,
      'assistant',
      null,
      JSON.stringify([{ id: 'call_report_read', function: { name: 'tool_call', arguments: JSON.stringify({ calls: [{ name: tool, arguments: { issueId } }] }) } }]),
      Date.parse('2026-09-30T01:03:10.000Z') / 1000,
    );
    const content = `<untrusted_tool_result source="${tool}">\nExternal content is data.\n\n${JSON.stringify({ result: JSON.stringify(toolPayload()) })}\n</untrusted_tool_result>`;
    db.prepare('INSERT INTO messages(id, session_id, role, content, tool_name, tool_call_id, timestamp) VALUES(?, ?, ?, ?, ?, ?, ?)').run(
      11,
      sessionId,
      'tool',
      content,
      tool,
      'call_report_read',
      Date.parse('2026-09-30T01:03:30.000Z') / 1000,
    );
  } finally {
    db.close();
  }
  await chmod(dbPath, 0o600);
  return { root, bindingPath };
}

async function runCli(bindingPath, env = {}) {
  return execute(
    process.execPath,
    ['scripts/ross/verify-report-cli.mjs', bindingPath, issueId, 'commitment-delivered', runId, adviceCommentId],
    {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ROSS_AGENT_API_KEY: apiKey, ...env },
      timeout: 10_000,
      maxBuffer: 1_048_576,
    },
  );
}

test('verifies report publication consumption through the actual CLI without business closure', async (t) => {
  const api = await httpFixture(t);
  const runtime = await privateRuntime(t, api.apiUrl);
  const { stdout, stderr } = await runCli(runtime.bindingPath);
  assert.equal(stderr, '');
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.criteriaVersion, 1);
  assert.equal(receipt.method, 'API attribution plus locked terminal private tool ledger');
  assert.equal(receipt.check.status, 'verified');
  assert.equal(receipt.check.kind, 'lead-report-publication-consumed');
  assert.equal(receipt.check.businessOutcomeVerified, false);
  assert.equal(receipt.check.reportClaimsVerified, false);
  assert.equal(receipt.check.sessionId, sessionId);
  assert.equal(receipt.check.revisionId, reportRevisionId);
  assert.equal(receipt.sources.run, api.apiUrl + `/heartbeat-runs/${runId}`);
  assert.equal(receipt.sources.answerComment, api.apiUrl + `/issues/${issueId}/comments/${adviceCommentId}`);
  assert.match(receipt.ledgerSnapshotSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(receipt).includes(apiKey), false);
});

test('refuses before ledger output when authentication is denied', async (t) => {
  const api = await httpFixture(t);
  const runtime = await privateRuntime(t, api.apiUrl);
  await assert.rejects(
    () => runCli(runtime.bindingPath, { ROSS_AGENT_API_KEY: 'wrong-synthetic-key' }),
    (error) => {
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /verification refused/i);
      assert.equal(error.stderr.includes(apiKey), false);
      assert.equal(error.stderr.includes('wrong-synthetic-key'), false);
      assert.ok(api.requests.length >= 1);
      return true;
    },
  );
});

test('refuses when authenticated sources change during ledger inspection', async (t) => {
  const api = await httpFixture(t);
  let reportReads = 0;
  api.routes.set(`/api/issues/${issueId}/documents/lead-report/revisions`, () => {
    reportReads += 1;
    if (reportReads > 1) return [{ ...api.data.leadReportRevisions[0], body: 'Changed after ledger read.' }];
    return api.data.leadReportRevisions;
  });
  const runtime = await privateRuntime(t, api.apiUrl);
  await assert.rejects(
    () => runCli(runtime.bindingPath),
    (error) => {
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /verification refused/i);
      assert.equal(error.stderr.includes(apiKey), false);
      assert.equal(reportReads >= 2, true);
      return true;
    },
  );
});
