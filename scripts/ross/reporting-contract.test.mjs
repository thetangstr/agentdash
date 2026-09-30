import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildReportingContract, mapReportingContractToNative, planReportingCycle, assessReportTiming, zonedTimeToUtcMs, REPORT_SOURCE_FRESHNESS_MS} from './reporting-contract.mjs';

const companyId = '11111111-1111-4111-8111-111111111111';
const projectId = '44444444-4444-4444-8444-444444444444';
const reporterAgentId = '55555555-5555-4555-8555-555555555555';

function terms(extra = {}) {
  return {
    schemaVersion: 1,
    companyId,
    projectId,
    reporterAgentId,
    ownerApproval: {reference: 'approval:AGE-101', decidedBy: 'company-owner-1', decidedAt: '2026-09-29T18:00:00.000Z'},
    timezone: 'America/New_York',
    reviewWindows: [
      {id: 'morning', weekdays: ['monday', 'wednesday', 'friday'], localTime: '09:00'},
      {id: 'midday', weekdays: ['tuesday'], localTime: '13:00'},
      {id: 'close', weekdays: ['thursday'], localTime: '16:00'},
    ],
    eventTriggers: [
      {id: 'board-request', kind: 'api', label: 'Board asks for a review', signingMode: null},
      {id: 'deploy-hook', kind: 'webhook', label: 'Deploy events', signingMode: 'hmac_sha256'},
    ],
    dueWithinMinutes: 240,
    coalescing: 'coalesce_if_active',
    missedReport: {escalateAfterMinutes: 60, escalateTo: 'board'},
    budget: {maxRunsPerCheckpoint: 1, maxRunSeconds: 120, maxTokensPerRun: 200_000, maxUsdPerWindow: 2.5},
    ...extra,
  };
}

function plan(contract, input) {
  return planReportingCycle(contract, {horizonDays: 7, events: [], deliveries: [], ...input});
}

test('rejects malformed reporting terms strictly before any mapping or planning', () => {
  assert.throws(() => buildReportingContract({...terms(), extra: true}), /exact|shape/i);
  assert.throws(() => buildReportingContract({...terms(), schemaVersion: 2}), /schema/i);
  assert.throws(() => buildReportingContract({...terms(), companyId: 'not-a-uuid'}), /uuid/i);
  assert.throws(() => buildReportingContract({...terms(), timezone: 'Mars/Olympus_Mons'}), /timezone/i);
  assert.throws(() => buildReportingContract({...terms(), reviewWindows: terms().reviewWindows.slice(0, 2)}), /three/i);
  assert.throws(() => buildReportingContract({...terms(), reviewWindows: [...terms().reviewWindows, {id: 'x', weekdays: ['friday'], localTime: '17:00'}]}), /three/i);
  assert.throws(() => buildReportingContract({...terms(), reviewWindows: [
    {id: 'a', weekdays: ['saturday'], localTime: '09:00'},
    {id: 'b', weekdays: ['tuesday'], localTime: '13:00'},
    {id: 'c', weekdays: ['thursday'], localTime: '16:00'},
  ]}), /working/i);
  assert.throws(() => buildReportingContract({...terms(), reviewWindows: [
    {id: 'a', weekdays: ['monday'], localTime: '09:00'},
    {id: 'b', weekdays: ['monday'], localTime: '09:00'},
    {id: 'c', weekdays: ['thursday'], localTime: '16:00'},
  ]}), /overlap|unique/i);
  assert.throws(() => buildReportingContract({...terms(), dueWithinMinutes: 0}), /due|minutes/i);
  assert.throws(() => buildReportingContract({...terms(), coalescing: 'always_enqueue'}), /coalesc/i);
  assert.throws(() => buildReportingContract({...terms(), missedReport: {escalateAfterMinutes: 30, escalateTo: 'anyone'}}), /escalation|board/i);
  assert.throws(() => buildReportingContract({...terms(), budget: {maxRunsPerCheckpoint: 1, maxRunSeconds: 120, maxTokensPerRun: 100}}), /exact|shape|budget/i);
  assert.throws(() => buildReportingContract({...terms(), budget: {...terms().budget, maxUsdPerWindow: 'unknown'}}), /usd/i);
  assert.throws(() => buildReportingContract({...terms(), eventTriggers: [{id: 'a', kind: 'carrier-pigeon', label: 'x', signingMode: null}]}), /api|webhook/i);
  assert.throws(() => buildReportingContract({...terms(), eventTriggers: [{id: 'a', kind: 'webhook', label: 'x', signingMode: null}]}), /signing/i);
  assert.throws(() => buildReportingContract({...terms(), eventTriggers: [{id: 'a', kind: 'api', label: 'x', signingMode: 'bearer'}]}), /signing/i);
  assert.throws(() => buildReportingContract({...terms(), eventTriggers: [1, 2, 3, 4, 5].map(i => ({id: `e${i}`, kind: 'api', label: `e${i}`, signingMode: null}))}), /event triggers/i);
});

test('maps contract deterministically onto native routine, trigger and run-request boundaries', () => {
  const contract = buildReportingContract(terms());
  const first = mapReportingContractToNative(contract);
  const second = mapReportingContractToNative(contract);
  assert.deepEqual(first, second);
  assert.equal(first.routine.status, 'paused');
  assert.equal(first.routine.assigneeAgentId, reporterAgentId);
  assert.equal(first.routine.projectId, projectId);
  assert.equal(first.routine.concurrencyPolicy, 'coalesce_if_active');
  assert.equal(first.routine.catchUpPolicy, 'skip_missed');
  const schedule = first.triggers.filter(trigger => trigger.kind === 'schedule');
  assert.deepEqual(schedule.map(trigger => trigger.cronExpression), ['0 9 * * 1,3,5', '0 13 * * 2', '0 16 * * 4']);
  assert.ok(schedule.every(trigger => trigger.timezone === 'America/New_York' && trigger.enabled === true));
  assert.deepEqual(first.triggers.filter(trigger => trigger.kind !== 'schedule'), [
    {kind: 'api', label: 'ross-event:board-request', enabled: true},
    {kind: 'webhook', label: 'ross-event:deploy-hook', enabled: true, signingMode: 'hmac_sha256', replayWindowSec: 300},
  ]);
  assert.equal(first.runRequestTemplate.source, 'api');
  assert.equal(first.runRequestTemplate.idempotencyKeyTemplate, 'ross-reporting:{companyId}:{checkpointId}');
  assert.equal(first.readiness.status, 'partial');
  assert.equal(first.readiness.grantsAuthority, false);
  const unsupported = first.readiness.unsupported.map(entry => entry.term);
  assert.ok(unsupported.includes('missed-report escalation'));
  assert.ok(unsupported.includes('run/time/token/budget caps'));
  assert.ok(unsupported.includes('due-checkpoint deadline'));
});

test('resolves wall-clock windows correctly across DST spring-forward and fall-back', () => {
  // Same 09:00 wall time, different UTC instants across the US transition.
  assert.equal(zonedTimeToUtcMs('America/New_York', 2026, 3, 2, 9, 0), Date.UTC(2026, 2, 2, 14, 0));
  assert.equal(zonedTimeToUtcMs('America/New_York', 2026, 3, 9, 9, 0), Date.UTC(2026, 2, 9, 13, 0));
  // Nonexistent 02:30 on spring-forward resolves forward by the gap delta to 03:30 EDT.
  assert.equal(zonedTimeToUtcMs('America/New_York', 2026, 3, 8, 2, 30), Date.UTC(2026, 2, 8, 7, 30));
  // Ambiguous 01:30 on fall-back resolves to the earliest occurrence (EDT).
  assert.equal(zonedTimeToUtcMs('America/New_York', 2026, 11, 1, 1, 30), Date.UTC(2026, 10, 1, 5, 30));
  // London fold also resolves to the earliest occurrence (BST).
  assert.equal(zonedTimeToUtcMs('Europe/London', 2026, 10, 25, 1, 30), Date.UTC(2026, 9, 25, 0, 30));
});

test('enumerates only working-day checkpoints and keeps cadence deadlines in company time', () => {
  const contract = buildReportingContract(terms());
  const result = plan(contract, {now: '2026-09-30T15:00:00.000Z'});
  assert.equal(result.obligations.length, 10);
  const days = result.obligations.map(ob => new Date(ob.at).getUTCDay());
  assert.ok(days.every(day => day >= 1 && day <= 5));
  assert.deepEqual(result.obligations.filter(ob => ob.windowId === 'morning').map(ob => ob.at),
    ['2026-09-25T13:00:00.000Z', '2026-09-28T13:00:00.000Z', '2026-09-30T13:00:00.000Z', '2026-10-02T13:00:00.000Z', '2026-10-05T13:00:00.000Z', '2026-10-07T13:00:00.000Z']);
  assert.deepEqual(result.obligations.map(ob => ob.status).sort(),
    ['missed', 'missed', 'missed', 'missed', 'open', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
  const open = result.obligations.find(ob => ob.status === 'open');
  assert.equal(open.id, `window:morning:2026-09-30T13:00:00.000Z`);
  assert.equal(open.dueAt, '2026-09-30T17:00:00.000Z');
  assert.equal(open.plannedRequest.idempotencyKey, `ross-reporting:${companyId}:window:morning:2026-09-30T13:00:00.000Z`);
  assert.equal(open.plannedRequest.source, 'api');
  assert.equal(open.plannedRequest.grantsAuthority, false);
  assert.equal(open.plannedRequest.requiresGovernedDispatch, true);
  assert.deepEqual(open.plannedRequest.budgetCaps, contract.budget);
});

test('marks undelivered past-due checkpoints missed with honest escalation timing', () => {
  const contract = buildReportingContract(terms());
  const result = plan(contract, {now: '2026-09-30T15:00:00.000Z'});
  const missed = result.obligations.filter(ob => ob.status === 'missed');
  assert.equal(missed.length, 4);
  assert.ok(missed.every(ob => ob.escalation.to === 'board' && ob.escalation.status === 'required' && ob.escalation.grantsAuthority === false));
  assert.ok(missed.every(ob => ob.escalation.hook === 'native-missed-checkpoint-detector-absent'));
  // Between dueAt and dueAt+escalateAfterMinutes the escalation stays pending.
  const early = plan(contract, {now: '2026-09-29T21:30:00.000Z'});
  const midday = early.obligations.find(ob => ob.id === 'window:midday:2026-09-29T17:00:00.000Z');
  assert.equal(midday.status, 'missed');
  assert.equal(midday.escalation.status, 'pending');
  assert.equal(midday.escalation.at, '2026-09-29T22:00:00.000Z');
});

test('coalesces duplicate and clustered trigger events into one planned request per obligation', () => {
  const contract = buildReportingContract(terms());
  const result = plan(contract, {
    now: '2026-09-30T23:30:00.000Z',
    events: [
      {id: 'e1', triggerId: 'board-request', at: '2026-09-30T14:00:00.000Z'},
      {id: 'e1', triggerId: 'board-request', at: '2026-09-30T14:00:00.000Z'},
      {id: 'e2', triggerId: 'board-request', at: '2026-09-30T14:30:00.000Z'},
      {id: 'e3', triggerId: 'board-request', at: '2026-09-30T22:00:00.000Z'},
      {id: 'e4', triggerId: 'board-request', at: '2026-09-30T22:30:00.000Z'},
      {id: 'x9', triggerId: 'undeclared', at: '2026-09-30T23:00:00.000Z'},
    ],
  });
  const windowObligation = result.obligations.find(ob => ob.id === 'window:morning:2026-09-30T13:00:00.000Z');
  assert.equal(windowObligation.status, 'missed');
  assert.equal(windowObligation.triggerEventCount, 2);
  const requests = result.obligations.filter(ob => ob.plannedRequest).map(ob => ob.plannedRequest.idempotencyKey);
  assert.deepEqual([...new Set(requests)].sort(), requests.slice().sort());
  const eventObligation = result.obligations.find(ob => ob.id === 'event:board-request:e3');
  assert.equal(eventObligation.status, 'open');
  assert.equal(eventObligation.dueAt, '2026-10-01T02:00:00.000Z');
  assert.equal(eventObligation.triggerEventCount, 2);
  assert.deepEqual(result.uncoalescedEvents, [{id: 'x9', triggerId: 'undeclared', at: '2026-09-30T23:00:00.000Z', reason: 'unknown-trigger'}]);
  const duplicate = result.eventLedger.filter(entry => entry.id === 'e1');
  assert.equal(duplicate.length, 2);
  assert.equal(duplicate[1].coalesced, true);
  const clustered = result.eventLedger.find(entry => entry.id === 'e4');
  assert.equal(clustered.attachedTo, 'event:board-request:e3');
  assert.equal(clustered.coalesced, true);
});

test('preserves one-hour source freshness independently of the four-hour due cadence', () => {
  const contract = buildReportingContract(terms());
  const result = plan(contract, {
    now: '2026-09-30T15:00:00.000Z',
    deliveries: [{deliveredAt: '2026-09-29T18:00:00.000Z', sourceAsOf: '2026-09-29T16:30:00.000Z', ref: 'lead-report'}],
  });
  const midday = result.obligations.find(ob => ob.id === 'window:midday:2026-09-29T17:00:00.000Z');
  assert.equal(midday.status, 'delivered');
  assert.equal(midday.delivery.timing.cadence, 'within-cadence');
  assert.equal(midday.delivery.timing.sourceFreshness, 'stale');
  assert.equal(midday.delivery.timing.sourceFreshnessMs, REPORT_SOURCE_FRESHNESS_MS);
  assert.equal(midday.delivery.timing.relabeled, false);
  const direct = assessReportTiming({dueAtMs: Date.parse('2026-09-29T21:00:00.000Z'), deliveredAtMs: Date.parse('2026-09-29T20:00:00.000Z'), sourceAsOfMs: Date.parse('2026-09-29T19:30:00.000Z'), observedAtMs: Date.parse('2026-09-29T20:10:00.000Z')});
  assert.equal(direct.cadence, 'within-cadence');
  assert.equal(direct.sourceFreshness, 'current');
});

test('late and unmatched deliveries are reported honestly instead of rewritten', () => {
  const contract = buildReportingContract(terms());
  const result = plan(contract, {
    now: '2026-09-30T15:00:00.000Z',
    deliveries: [
      {deliveredAt: '2026-09-29T22:30:00.000Z', sourceAsOf: '2026-09-29T22:00:00.000Z', ref: 'late-report'},
      {deliveredAt: '2026-09-20T10:00:00.000Z', sourceAsOf: '2026-09-20T09:00:00.000Z', ref: 'orphan'},
    ],
  });
  const midday = result.obligations.find(ob => ob.id === 'window:midday:2026-09-29T17:00:00.000Z');
  assert.equal(midday.status, 'delivered-late');
  assert.equal(midday.delivery.timing.cadence, 'late');
  assert.deepEqual(result.unmatchedDeliveries, [{deliveredAt: '2026-09-20T10:00:00.000Z', sourceAsOf: '2026-09-20T09:00:00.000Z', ref: 'orphan'}]);
});

test('planning output grants no authority and validates its own inputs', () => {
  const contract = buildReportingContract(terms());
  const result = plan(contract, {now: '2026-09-30T15:00:00.000Z'});
  assert.equal(result.grantsAuthority, false);
  assert.equal(result.note.includes('no wake'), true);
  assert.throws(() => plan(contract, {now: 'not-a-time'}), /time|required/i);
  assert.throws(() => plan(contract, {now: '2026-09-30T15:00:00.000Z', horizonDays: 0}), /horizonDays/i);
  assert.throws(() => plan(contract, {now: '2026-09-30T15:00:00.000Z', events: [{id: 'e', triggerId: 'bad id!', at: '2026-09-30T14:00:00.000Z'}]}), /triggerId/i);
  assert.throws(() => plan(contract, {now: '2026-09-30T15:00:00.000Z', deliveries: [{deliveredAt: '2026-09-29T18:00:00.000Z', sourceAsOf: 'junk', ref: null}]}), /source|time/i);
  assert.throws(() => planReportingCycle(contract, {now: '2026-09-30T15:00:00.000Z', events: [], deliveries: [], horizonDays: 7, extra: true}), /exact|shape/i);
});
