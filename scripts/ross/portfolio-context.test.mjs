import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantPortfolioReader} from './assistant-portfolio.mjs';
import {createPortfolioContextAssembler, portfolioInferenceReadiness} from './portfolio-context.mjs';

const userId = 'user-portfolio-1';
const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const companyC = '33333333-3333-4333-8333-333333333333';

function whoami(companyId, user = userId) {
  return {isError: false, structuredContent: {status: 'ok', data: {user: {userId: user}, company: {id: companyId}, scopes: ['read']}}};
}

function item(companyId, ref, extra = {}, asOf = '2026-09-30T09:00:00.000Z') {
  return {
    isError: false,
    structuredContent: {
      status: 'ok',
      asOf,
      summary: 'Work item ' + ref,
      data: {ref, companyId, title: 'Review ' + ref, ...extra},
      truncated: false,
    },
  };
}

function client(script) {
  const calls = [];
  return {
    calls,
    async callTool(input) {
      calls.push(input);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function assembler(clients, revalidate) {
  const reader = createAssistantPortfolioReader({userId, connections: clients});
  return createPortfolioContextAssembler({userId, reader, revalidateGrant: revalidate ?? (async () => true)});
}

const observedAt = '2026-09-30T12:00:00.000Z';

test('assembles a private user-bound context from selected scoped envelopes only', async () => {
  const a = client([whoami(companyA), item(companyA, 'A-1'), whoami(companyA)]);
  const b = client([whoami(companyB), item(companyB, 'B-7'), whoami(companyB)]);
  const rechecked = [];
  const asm = assembler([{companyId: companyA, client: a}, {companyId: companyB, client: b}], async (company, user) => {
    rechecked.push([company, user]);
    return true;
  });
  const context = await asm.assemble({requestId: 'req-1', observedAt, selection: [{companyId: companyA, refs: ['A-1']}, {companyId: companyB, refs: ['B-7']}]});
  assert.deepEqual(rechecked, [[companyA, userId], [companyB, userId]]);
  assert.equal(context.binding.kind, 'user');
  assert.equal(context.binding.userId, userId);
  assert.equal(context.binding.companyBound, false);
  assert.equal(context.companyMemory, false);
  assert.equal(context.permissionAuthority, false);
  assert.equal(context.persistence, 'ephemeral-no-store');
  assert.equal(context.synthesis, 'none');
  assert.deepEqual(context.companies.map(row => row.companyId), [companyA, companyB]);
  assert.equal(context.companies[0].sources[0].freshness.state, 'stale');
  assert.equal(context.excluded.length, 0);
});

test('revoking company A drops only A while B stays usable; mid-read revocation is caught too', async () => {
  const a = client([whoami(companyA), item(companyA, 'A-1'), whoami(companyA)]);
  const revokedPost = client([whoami(companyB), item(companyB, 'B-7'), whoami(companyB, 'other-user')]);
  const c = client([whoami(companyC), item(companyC, 'C-1'), whoami(companyC)]);
  const asm = assembler([{companyId: companyA, client: a}, {companyId: companyB, client: revokedPost}, {companyId: companyC, client: c}],
    async company => company !== companyA);
  const context = await asm.assemble({requestId: 'req-2', observedAt, selection: [
    {companyId: companyA, refs: ['A-1']},
    {companyId: companyB, refs: ['B-7']},
    {companyId: companyC, refs: ['C-1']},
  ]});
  assert.deepEqual(context.companies.map(row => row.companyId), [companyC]);
  assert.deepEqual(context.excluded, [
    {companyId: companyA, reason: 'grant-revoked-or-unchanged-unproven'},
    {companyId: companyB, reason: 'company-source-unavailable'},
  ]);
  assert.equal(JSON.stringify(context).includes('A-1'), false);
  assert.equal(JSON.stringify(context).includes('B-7'), false);
});

test('drops a company whose envelope claims a foreign company id or bad timestamp', async () => {
  const contaminated = client([whoami(companyA), item(companyB, 'B-leak'), whoami(companyA)]);
  const future = client([whoami(companyB), item(companyB, 'B-1', {}, '2026-10-01T00:00:00.000Z'), whoami(companyB)]);
  const ok = client([whoami(companyC), item(companyC, 'C-1'), whoami(companyC)]);
  const asm = assembler([{companyId: companyA, client: contaminated}, {companyId: companyB, client: future}, {companyId: companyC, client: ok}]);
  const context = await asm.assemble({requestId: 'req-3', observedAt, selection: [
    {companyId: companyA, refs: ['A-1']},
    {companyId: companyB, refs: ['B-1']},
    {companyId: companyC, refs: ['C-1']},
  ]});
  assert.deepEqual(context.companies.map(row => row.companyId), [companyC]);
  assert.deepEqual(context.excluded, [
    {companyId: companyA, reason: 'source-consistency-failed'},
    {companyId: companyB, reason: 'source-consistency-failed'},
  ]);
});

test('denies cross-user and unknown-company selection without leaking another scope', async () => {
  const a = client([]);
  const asm = assembler([{companyId: companyA, client: a}]);
  await assert.rejects(() => asm.assemble({requestId: 'req-4', observedAt, selection: [{companyId: companyB, refs: ['B-1']}]}), /unknown|scope|company/i);
  assert.equal(a.calls.length, 0);
});

test('requires exact identity inputs and a current-grant recheck hook', async () => {
  const reader = createAssistantPortfolioReader({userId, connections: [{companyId: companyA, client: client([])}]});
  assert.throws(() => createPortfolioContextAssembler({userId, reader}), /exact|shape|revalidateGrant/i);
  assert.throws(() => createPortfolioContextAssembler({userId, reader, revalidateGrant: async () => true, extra: 1}), /exact|shape/i);
  assert.throws(() => createPortfolioContextAssembler({userId: '', reader, revalidateGrant: async () => true}), /userId/i);
  const asm = createPortfolioContextAssembler({userId, reader, revalidateGrant: async () => true});
  await assert.rejects(() => asm.assemble({requestId: 'req-5', observedAt, selection: 'nope'}));
  await assert.rejects(() => asm.assemble({requestId: 'req-5', observedAt: 'bad', selection: []}));
});

test('inference readiness stays not-ready without a runner contract and never fabricates approval', () => {
  const absent = portfolioInferenceReadiness();
  assert.equal(absent.status, 'not-ready');
  assert.equal(absent.reason, 'inference-runner-contract-absent');
  assert.equal(absent.grantsAuthority, false);
  assert.equal(absent.cost, 'unknown-until-governed-receipt');
  for (const bad of [
    {kind: 'direct-call'},
    {kind: 'governed-inference', model: {name: 'glm-5.3-flash', provider: 'zai', endpoint: 'https://api.z.ai/api/paas/v4'}, budget: {maxRunSeconds: 120, maxTokensPerRun: 200000}, approval: {reference: 'x', decidedBy: 'y', decidedAt: '2026-09-30T00:00:00.000Z'}},
    {kind: 'governed-inference', model: {name: 'glm-5.3-flash', provider: 'zai', endpoint: 'https://api.z.ai/api/paas/v4'}, budget: {maxRunSeconds: 120, maxTokensPerRun: 200000, maxUsdPerRun: 0}, approval: {reference: 'x', decidedBy: 'y', decidedAt: '2026-09-30T00:00:00.000Z'}},
    {kind: 'governed-inference', model: {name: 'glm-5.3-flash', provider: 'zai', endpoint: 'https://api.z.ai/api/paas/v4'}, budget: {maxRunSeconds: 120, maxTokensPerRun: 200000, maxUsdPerRun: 1}, approval: {reference: 'x', decidedBy: 'y', decidedAt: 'soon'}},
  ]) {
    assert.equal(portfolioInferenceReadiness(bad).status, 'not-ready');
  }
  const ready = portfolioInferenceReadiness({
    kind: 'governed-inference',
    model: {name: 'glm-5.3-flash', provider: 'zai', endpoint: 'https://api.z.ai/api/paas/v4'},
    budget: {maxRunSeconds: 120, maxTokensPerRun: 200000, maxUsdPerRun: 2},
    approval: {reference: 'approval:AGE-55', decidedBy: 'company-owner-1', decidedAt: '2026-09-29T18:00:00.000Z'},
  });
  assert.equal(ready.status, 'contract-present-not-dispatched');
  assert.equal(ready.grantsAuthority, false);
  assert.equal(ready.approvalVerification, 'not-performed');
  assert.equal(ready.cost, 'unknown-until-governed-receipt');
});
