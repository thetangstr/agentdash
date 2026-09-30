import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createState, applyEvent, monicaRead, restoreState } from './rehearsal.mjs';

// Mutations these tests must catch: wrong author/company accepted, ack treated as
// completion, unsupported outcome closed, duplicate replay, or source age hidden.
import { scope, at, next, report, recommendation, ack, outcome, verification } from './fixtures.mjs';
const caller = { companyId: scope.companyId };
const apply = (state, event, actor = caller) => applyEvent(state, event, actor);
export function through(events) { return events.reduce((state, event) => apply(state, event), createState(scope)); }
const read = (state, asOf = next, actor = caller) => monicaRead(state, actor, asOf, 60 * 60_000);

test('missing report is unavailable, never model memory', () => {
  const result = read(createState(scope));
  assert.equal(result.mode, 'offline-fixture');
  assert.equal(result.freshness, 'missing');
  assert.equal(result.leadUpdate, null);
  assert.equal(result.commitmentStatus, 'none');
});
test('fresh source read carries company, author, revision, and observation age', () => {
  const result = read(through([report]));
  assert.equal(result.companyId, scope.companyId);
  assert.equal(result.freshness, 'fresh');
  assert.equal(result.leadUpdate.authorId, scope.leadId);
  assert.equal(result.leadUpdate.ageMinutes, 5);
  assert.deepEqual(result.leadUpdate.source, report.source);
  assert.equal(result.leadUpdate.observedAt, at);
  assert.equal(result.leadUpdate.body, report.body);
});
test('recommendation and lead acknowledgement remain separate from completion', () => {
  assert.equal(read(through([report, recommendation])).commitmentStatus, 'recommended');
  const result = read(through([report, recommendation, ack]));
  assert.equal(result.commitmentStatus, 'acknowledged');
  assert.equal(result.recommendation.body, recommendation.body);
  assert.equal(result.recommendation.checkpointAt, recommendation.checkpointAt);
  assert.equal(result.verified, false);
});
test('lead completion claim requires matching Ross evidence before closure', () => {
  const state = through([report, recommendation, ack, outcome]);
  assert.equal(read(state).commitmentStatus, 'outcome_reported');
  assert.equal(read(state).verified, false);
  assert.throws(() => apply(state, { ...verification, evidenceRef: 'fixture://company-a/unrelated' }), /evidence/i);
  assert.throws(() => apply(state, { ...verification, outcomeId: 'unrelated' }), /outcome/i);
  const result = read(apply(state, verification));
  assert.equal(result.commitmentStatus, 'evidence_checked');
  assert.equal(result.verified, true);
  assert.equal(result.evidenceRef, outcome.evidenceRef);
  assert.equal(result.leadUpdate.reportedStatus, 'blocked'); // original report is not rewritten
});
test('failed evidence does not close a commitment', () => {
  const result = read(through([report, recommendation, ack, outcome, { ...verification, result: 'fail' }]));
  assert.equal(result.verified, false);
  assert.equal(result.commitmentStatus, 'outcome_reported');
});
test('deduplicates identical delivery, rejects conflicting duplicate, preserves input', () => {
  const state = through([report, recommendation, ack]);
  const before = JSON.stringify(state);
  assert.deepEqual(apply(state, ack), state);
  assert.equal(JSON.stringify(state), before);
  assert.throws(() => apply(state, { ...ack, decision: 'challenged' }), /duplicate/i);
  const completed = apply(state, outcome);
  assert.equal(JSON.stringify(state), before);
  assert.notDeepEqual(completed, state);
});
test('restart revalidates history and preserves open acknowledgement without duplicate work', () => {
  const state = through([report, recommendation, ack]);
  const restarted = restoreState(JSON.parse(JSON.stringify(state)), scope);
  assert.deepEqual(read(restarted), read(state));
  assert.deepEqual(apply(restarted, ack), restarted);
  assert.equal(read(restarted).verified, false);
  assert.throws(() => restoreState({ ...state, schemaVersion: 999 }, scope), /version/i);
  assert.throws(() => restoreState(state, { ...scope, companyId: 'fixture-company-b' }), /scope|company/i);
});
test('rejects caller, event, or Monica recipient from another company', () => {
  const state = through([report]);
  assert.throws(() => apply(state, recommendation, { companyId: 'fixture-company-b' }), /company|scope/i);
  assert.throws(() => apply(state, { ...recommendation, companyId: 'fixture-company-b' }), /company|scope/i);
  assert.throws(() => read(state, next, { companyId: 'fixture-company-b' }), /company|scope/i);
  assert.throws(() => apply(state, { ...recommendation, projectId: 'fixture-project-b' }), /project|scope/i);
});
test('requires accountable authors and attributable source for every receipt', () => {
  assert.throws(() => apply(createState(scope), { ...report, authorId: scope.rossId }), /author/i);
  assert.throws(() => apply(createState(scope), { ...report, source: null }), /source/i);
  assert.throws(() => apply(createState(scope), { ...report, source: { ...report.source, kind: 'live' } }), /fixture/i);
  const state = through([report, recommendation]);
  assert.throws(() => apply(state, { ...ack, authorId: 'unrelated-lead' }), /author/i);
});
test('stale, future, and malformed observations cannot appear current', () => {
  assert.equal(read(through([report]), '2026-09-29T20:00:00.000Z').freshness, 'stale');
  assert.throws(() => read(through([report]), '2026-09-29T17:00:00.000Z'), /time|future/i);
  assert.throws(() => apply(createState(scope), { ...report, observedAt: 'invalid' }), /time/i);
  // Keep the deadline valid so this case isolates report freshness.
  assert.throws(() => apply(through([report]), {
    ...recommendation, observedAt: '2026-09-29T20:00:00.000Z', checkpointAt: '2026-09-29T21:00:00.000Z',
  }), /stale/i);
});
test('preserves a board/report disagreement and refuses to recommend through it', () => {
  const state = through([{ ...report, reportedStatus: 'done', boardStatus: 'blocked' }]);
  const result = read(state);
  assert.equal(result.freshness, 'disputed');
  assert.equal(result.leadUpdate.reportedStatus, 'done');
  assert.equal(result.leadUpdate.boardStatus, 'blocked');
  assert.throws(() => apply(state, recommendation), /disputed|conflict/i);
});
test('unaccepted or missing recommendations cannot acquire a completed outcome', () => {
  assert.throws(() => apply(through([report]), ack), /recommendation/i);
  assert.throws(() => apply(through([report, recommendation]), outcome), /acknowledg/i);
  assert.throws(() => apply(through([report, recommendation, { ...ack, decision: 'challenged' }]), outcome), /acknowledg/i);
});
test('rejects unknown and consequential events without executing anything', () => {
  assert.throws(() => apply(through([report]), { ...recommendation, kind: 'deploy' }), /kind|unsupported/i);
});
test('a corrected report retains history and cannot borrow the previous report reference', () => {
  const correction = { ...report, id: 'report-2', observedAt: next, source: { ...report.source, revision: '2' }, body: 'The lead corrected the report: release smoke is still blocked.' };
  const state = through([report, correction]);
  assert.equal(read(state).leadUpdate.body, correction.body);
  assert.equal(state.events[0].body, report.body);
  assert.throws(() => apply(state, recommendation), /report/i);
  assert.throws(() => apply(state, { ...recommendation, reportId: correction.id, observedAt: at }), /time|order/i);
});
test('rejects invalid acknowledgement decisions and backward receipt times', () => {
  const state = through([report, recommendation]);
  assert.throws(() => apply(state, { ...ack, decision: 'completed' }), /decision/i);
  assert.throws(() => apply(state, { ...ack, observedAt: at }), /time|order/i);
});
test('returned source records and caller-owned event objects cannot rewrite history', () => {
  const event = structuredClone(report);
  const state = apply(createState(scope), event);
  event.source.ref = 'fixture://wrong';
  const result = read(state);
  result.leadUpdate.source.ref = 'fixture://also-wrong';
  assert.equal(read(state).leadUpdate.source.ref, report.source.ref);
});
const receipts = [report, recommendation, ack, outcome, verification];
for (let index = 0; index < receipts.length; index++) {
  const event = receipts[index];
  const prior = () => through(receipts.slice(0, index));
  test(`${event.kind}: requires fixture provenance and the accountable author`, () => {
    assert.throws(() => apply(prior(), { ...event, source: null }), /source/i);
    assert.throws(() => apply(prior(), { ...event, source: { ...event.source, kind: 'live' } }), /fixture/i);
    assert.throws(() => apply(prior(), { ...event, authorId: 'unrelated-author' }), /author/i);
    const wrongRole = event.authorId === scope.leadId ? scope.rossId : scope.leadId;
    assert.throws(() => apply(prior(), { ...event, authorId: wrongRole }), /author/i);
  });
  test(`${event.kind}: rejects company/project/caller mismatch and conflicting duplicates`, () => {
    assert.throws(() => apply(prior(), { ...event, companyId: 'fixture-company-b' }), /company|scope/i);
    assert.throws(() => apply(prior(), { ...event, projectId: 'fixture-project-b' }), /project|scope/i);
    assert.throws(() => apply(prior(), event, { companyId: 'fixture-company-b' }), /company|scope/i);
    const state = apply(prior(), event);
    assert.deepEqual(apply(state, structuredClone(event)), state);
    assert.throws(() => apply(state, { ...event, source: { ...event.source, ref: 'fixture://conflicting-duplicate' } }), /duplicate/i);
  });
}
test('a later lead challenge supersedes acceptance before an outcome is reported', () => {
  const challenge = { ...ack, id: 'ack-challenge', decision: 'challenged' };
  const state = through([report, recommendation, ack, challenge]);
  assert.equal(read(state).commitmentStatus, 'recommended');
  assert.equal(read(state).verified, false);
  assert.throws(() => apply(state, outcome), /acknowledg/i);
});
test('returned states cannot change the scope or events of earlier checkpoints', () => {
  const prior = through([report]);
  const later = apply(prior, recommendation);
  try { later.scope.companyId = 'fixture-company-b'; } catch {}
  try { later.events[0].body = 'rewritten report'; } catch {}
  assert.equal(prior.scope.companyId, scope.companyId);
  assert.equal(prior.events[0].body, report.body);
});
test('a corrected report cannot present the older recommendation as current advice', () => {
  const correction = { ...report, id: 'report-2', observedAt: next, source: { ...report.source, revision: '2' }, body: 'Corrected lead report: the original reproduction hypothesis was wrong.' };
  const state = through([report, recommendation, ack, correction]);
  const result = read(state);
  assert.equal(result.leadUpdate.body, correction.body);
  assert.equal(result.recommendation, null);
  assert.equal(result.commitmentStatus, 'none');
  assert.equal(result.verified, false);
  assert.equal(state.events[2].decision, 'accepted'); // outstanding history remains retained
});
test('required report, recommendation, and outcome content cannot be omitted', () => {
  const malformed = [
    [[], report, 'body'], [[], report, 'reportedStatus'], [[], report, 'boardStatus'],
    [[report], recommendation, 'body'], [[report], recommendation, 'checkpointAt'],
    [[report, recommendation, ack], outcome, 'body'],
  ];
  for (const [prior, event, field] of malformed) {
    for (const value of [undefined, '', 123]) {
      assert.throws(() => apply(through(prior), { ...event, [field]: value }), /body|status|checkpoint|content|time/i);
    }
  }
  assert.throws(() => apply(through([report]), { ...recommendation, checkpointAt: 'not-a-time' }), /checkpoint|time/i);
  assert.throws(() => apply(through([report]), { ...recommendation, checkpointAt: at }), /checkpoint|time/i);
});
