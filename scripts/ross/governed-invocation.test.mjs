import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as governed from './governed-invocation.mjs';
const { buildGovernedInvocation, assertGovernedRun, assertGovernedCheckout, assertGovernedReceipt } = governed;

const companyId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const issueId = '55555555-5555-4555-8555-555555555555';
const binding = { apiUrl: 'http://127.0.0.1:3100/api', companyId, projectId, agentId };
const token = claims => [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: agentId, company_id: companyId, run_id: runId, adapter_type: 'hermes_local', exp: Math.floor(Date.now() / 1000) + 600, ...claims })).toString('base64url'), 'synthetic_signature'].join('.');
const env = { PAPERCLIP_API_URL: binding.apiUrl, PAPERCLIP_COMPANY_ID: companyId, PAPERCLIP_AGENT_ID: agentId, PAPERCLIP_RUN_ID: runId, PAPERCLIP_TASK_ID: issueId, PAPERCLIP_API_KEY: token({}), DATABASE_URL: 'synthetic-unrelated-secret' };
const args = ['chat', '-q', 'Read the assigned pilot evidence.', '-Q', '-m', 'glm-5.3-flash', '--provider', 'zai', '-t', 'ross_agentdash', '--max-turns', '4', '--source', 'tool', '--yolo'];
const run = { id: runId, agentId, companyId, status: 'running', contextSnapshot: { issueId } };
const issue = { id: issueId, companyId, projectId, assigneeAgentId: agentId };

test('keeps actual dispatch identity and prompt but never forwards ambient environment or yolo', () => {
  const invocation = buildGovernedInvocation(binding, args, env);
  assert.equal(invocation.prompt, args[2]);
  assert.equal(invocation.apiKey, env.PAPERCLIP_API_KEY);
  assert.equal(invocation.runId, runId);
  assert.equal(invocation.issueId, issueId);
  assert.equal(invocation.DATABASE_URL, undefined);
  assert.equal(invocation.args, undefined);
  assertGovernedRun(invocation, { id: agentId, companyId }, run, issue);
});

test('denies missing tokens, scope overrides, unknown flags and alternative routes before a model call', () => {
  for (const replacement of [{ PAPERCLIP_API_KEY: '' }, { PAPERCLIP_RUN_ID: 'invented' }, { PAPERCLIP_TASK_ID: '' }, { PAPERCLIP_COMPANY_ID: projectId }, { PAPERCLIP_API_URL: 'https://foreign.invalid/api' }]) {
    assert.throws(() => buildGovernedInvocation(binding, args, { ...env, ...replacement }));
  }
  for (const argv of [[...args, '--profile', 'foreign'], args.map(x => x === 'glm-5.3-flash' ? 'other-model' : x), [...args, '-m', 'glm-5.3-flash']]) {
    assert.throws(() => buildGovernedInvocation(binding, argv, env));
  }
});

test('a real API-authenticated actor must own the running dispatch and its bound project task', () => {
  const invocation = buildGovernedInvocation(binding, args, env);
  for (const bad of [{ ...run, status: 'queued' }, { ...run, agentId: projectId }, { ...run, contextSnapshot: { issueId: projectId } }]) {
    assert.throws(() => assertGovernedRun(invocation, { id: agentId, companyId }, bad, issue));
  }
  for (const bad of [{ ...issue, projectId: companyId }, { ...issue, assigneeAgentId: projectId }]) {
    assert.throws(() => assertGovernedRun(invocation, { id: agentId, companyId }, run, bad));
  }
  assert.throws(() => assertGovernedRun(invocation, { id: projectId, companyId }, run, issue));
});

test('rejects persistent keys and foreign, missing, or expired run claims before any API or model call', () => {
  for (const apiKey of ['persistent-agent-key', token({ sub: projectId }), token({ company_id: projectId }), token({ run_id: issueId }), token({ run_id: null }), token({ adapter_type: 'other' }), token({ exp: 1 }), token({ exp: 'later' })]) {
    assert.throws(() => buildGovernedInvocation(binding, args, { ...env, PAPERCLIP_API_KEY: apiKey }));
  }
  assert.equal(buildGovernedInvocation(binding, args, env).runId, runId);
});

test('requires the assigned task to be atomically checked out by the actual run', () => {
  const invocation = buildGovernedInvocation(binding, args, env);
  const checked = { ...issue, status: 'in_progress', checkoutRunId: runId, executionRunId: runId };
  assertGovernedCheckout(invocation, checked);
  for (const bad of [{ ...checked, checkoutRunId: null }, { ...checked, executionRunId: issueId }, { ...checked, projectId: companyId }, { ...checked, status: 'done' }]) {
    assert.throws(() => assertGovernedCheckout(invocation, bad));
  }
});

test('failure diagnostics distinguish missing dispatch inputs without disclosing values or token fragments', () => {
  const signals = governed.governedDispatchSignals(binding, args, { ...env, PAPERCLIP_API_URL: '[object Object]', PAPERCLIP_TASK_ID: undefined });
  assert.equal(signals.apiUrlMatches, false);
  assert.equal(signals.taskIdValid, false);
  assert.equal(signals.jwtShape, true);
  assert.equal(signals.modelMatches, true);
  const encoded = JSON.stringify(signals);
  for (const secret of [env.PAPERCLIP_API_KEY, env.PAPERCLIP_API_KEY.split('.')[1], env.DATABASE_URL, '[object Object]']) assert.ok(!encoded.includes(secret));
  assert.ok(Object.values(signals).every(value => typeof value === 'boolean'));
});

test('only a real scoped exact-route answer backed by its private session ledger becomes adapter success', () => {
  const receipt = { scope: { companyId, projectId, agentId }, requestedModel: 'glm-5.3-flash', endpoint: 'https://api.z.ai/api/paas/v4', sessionId: 'real-private-session', answer: 'Attributed response.', failure: null, usage: { modelRows: [{ session_id: 'real-private-session', model: 'glm-5.3-flash', billing_provider: 'zai', billing_base_url: 'https://api.z.ai/api/paas/v4', api_call_count: 2 }] } };
  assertGovernedReceipt(receipt, binding);
  for (const bad of [{ ...receipt, failure: { code: 'timeout' } }, { ...receipt, scope: { ...receipt.scope, companyId: projectId } }, { ...receipt, usage: { modelRows: [] } }, { ...receipt, usage: { modelRows: [{ ...receipt.usage.modelRows[0], session_id: 'foreign-session' }] } }]) {
    assert.throws(() => assertGovernedReceipt(bad, binding));
  }
});

test('exposes a provider-network failure only from the actual scoped failed runner receipt', () => {
  assert.equal(typeof governed.governedRunnerFailurePhase, 'function');
  const invocation = { runId, resumeId: 'retained_session' };
  const receipt = {
    executionMode: 'governed', runId, scope: { companyId, projectId, agentId },
    requestedModel: 'glm-5.3-flash', endpoint: 'https://api.z.ai/api/paas/v4',
    resumeId: invocation.resumeId, sessionId: invocation.resumeId,
    failure: { code: 1, signal: null }, answer: null, usage: null,
    stdout: 'API call failed after 3 retries: Connection error.\n', stderr: 'session_id: retained_session\n',
  };
  const result = value => ({ failure: { code: 1 }, exitCode: 1, signal: null, stdout: JSON.stringify(value) });
  assert.equal(governed.governedRunnerFailurePhase(result(receipt), binding, invocation), 'provider-network');
  assert.match(governed.governedRunnerFailureMessage(result(receipt), binding, invocation), /network error; inference unavailable/);
  assert.equal(governed.governedRunnerFailureMessage(result({ ...receipt, runId: issueId }), binding, invocation), null);
  for (const altered of [
    { ...receipt, runId: issueId },
    { ...receipt, scope: { companyId, projectId, agentId: issueId } },
    { ...receipt, executionMode: 'manual' },
    { ...receipt, resumeId: 'foreign_session' },
    { ...receipt, sessionId: 'foreign_session' },
    { ...receipt, requestedModel: 'another-model' },
    { ...receipt, endpoint: 'https://foreign.invalid' },
    { ...receipt, failure: { code: 'timeout' } },
    { ...receipt, answer: 'Historical answer' },
    { ...receipt, usage: { modelRows: [{ api_call_count: 7 }] } },
    { ...receipt, stdout: 'Private bootstrap failed' },
    { ...receipt, stderr: 'Traceback: private store already owned' },
  ]) assert.equal(governed.governedRunnerFailurePhase(result(altered), binding, invocation), 'runner');
  for (const altered of [
    { ...result(receipt), failure: { code: 'timeout' } },
    { ...result(receipt), exitCode: 0 },
    { ...result(receipt), signal: 'SIGTERM' },
    { ...result(receipt), stdout: 'not a receipt' },
    { ...result(receipt), stdout: 'x'.repeat(1_048_577) },
  ]) assert.equal(governed.governedRunnerFailurePhase(altered, binding, invocation), 'runner');
  const confidential = { ...receipt, stdout: receipt.stdout + 'synthetic-private-secret' };
  const diagnostic = governed.governedRunnerFailurePhase(result(confidential), binding, invocation);
  assert.equal(diagnostic, 'provider-network');
  assert.ok(!diagnostic.includes('synthetic-private-secret'));
});
