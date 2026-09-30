// Offline fixture projection for the Ross local rehearsal.
//
// This module is a pure, deterministic projection over synthetic fixture
// events. It performs no API, network, file, process, or provider calls and
// never represents fixture content as live Agent Dash or company facts.
// Identity, provenance, author accountability, reference order, and time are
// validated on every append; a restored state is re-validated by replay.

import { isDeepStrictEqual } from 'node:util';

const SCHEMA_VERSION = 1;
const FRESHNESS_MS = 60 * 60_000;
const KINDS = new Set([
  'lead_update', 'recommendation', 'acknowledgement', 'outcome', 'verification',
]);
// Accountable author per kind: reports/ack/outcome are the lead's, advice and
// evidence checks are Ross's. Nothing else may author a receipt.
const AUTHOR = {
  lead_update: 'leadId',
  acknowledgement: 'leadId',
  outcome: 'leadId',
  recommendation: 'rossId',
  verification: 'rossId',
};
const DECISIONS = new Set(['accepted', 'challenged']);

const fail = (message) => { throw new Error(message); };
const clone = (value) => JSON.parse(JSON.stringify(value));
const parseTime = (value, what = 'time') => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) fail(`invalid ${what}: expected an ISO timestamp`);
  return ms;
};

function validateScope(scope) {
  if (!scope || typeof scope !== 'object') fail('a scoped fixture company is required');
  const copy = {};
  for (const key of ['companyId', 'projectId', 'leadId', 'rossId']) {
    if (typeof scope[key] !== 'string' || !scope[key]) {
      fail(`scope ${key} is required`);
    }
    copy[key] = scope[key];
  }
  return copy;
}

function assertState(state) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION) {
    fail('unsupported state schema version');
  }
  if (!Array.isArray(state.events)) fail('state events must be an append-only array');
  validateScope(state.scope);
}

function validateSource(source) {
  if (!source || typeof source !== 'object') {
    fail('event needs an attributable source');
  }
  if (source.kind !== 'fixture') {
    fail('source provenance must be fixture, never live');
  }
  if (typeof source.ref !== 'string' || !source.ref) fail('source ref is required');
  if (source.revision == null || source.revision === '') {
    fail('source revision is required');
  }
}

function findLast(events, kind, match = () => true) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind === kind && match(event)) return event;
  }
  return null;
}

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

function checkSemantics(state, event, observedAt) {
  const events = state.events;
  switch (event.kind) {
    case 'lead_update':
      // A report is stored verbatim; disagreement is surfaced at read time,
      // never rewritten to imply an updated company status.
      if (!nonEmpty(event.body)) fail('lead report needs a body');
      if (!nonEmpty(event.reportedStatus) || !nonEmpty(event.boardStatus)) {
        fail('lead report needs reportedStatus and boardStatus values');
      }
      return;
    case 'recommendation': {
      const report = findLast(events, 'lead_update');
      // Advice must attach to the CURRENT report — an older id means the
      // recommendation was made against a superseded observation.
      if (!report || event.reportId !== report.id) {
        fail('recommendation must reference the current lead report');
      }
      if (report.reportedStatus !== report.boardStatus) {
        fail('cannot recommend through a disputed/conflicting report');
      }
      const reportAt = parseTime(report.observedAt);
      if (observedAt - reportAt > FRESHNESS_MS) {
        fail('recommendation report is stale');
      }
      if (!nonEmpty(event.body)) fail('recommendation needs a body');
      const checkpointAt = parseTime(event.checkpointAt, 'checkpoint time');
      if (checkpointAt <= observedAt) {
        fail('checkpointAt must be after the recommendation time');
      }
      return;
    }
    case 'acknowledgement': {
      if (!DECISIONS.has(event.decision)) {
        fail(`unsupported acknowledgement decision ${event.decision}`);
      }
      const rec = findLast(
        events, 'recommendation', (e) => e.id === event.recommendationId,
      );
      if (!rec) {
        fail('acknowledgement needs an existing recommendation');
      }
      return;
    }
    case 'outcome': {
      if (!nonEmpty(event.body)) fail('outcome needs a body');
      const rec = findLast(
        events, 'recommendation', (e) => e.id === event.recommendationId,
      );
      if (!rec) {
        fail('outcome needs an existing recommendation');
      }
      // A superseded report retires the recommendation chain with it — an
      // outcome cannot complete advice issued against an older report.
      const current = findLast(events, 'lead_update');
      if (!current || rec.reportId !== current.id) {
        fail('outcome needs a recommendation on the current report');
      }
      // The LATEST acknowledgement governs: a challenged decision issued after
      // an acceptance revokes the basis for an outcome, not just adds noise.
      const ack = findLast(
        events, 'acknowledgement', (e) => e.recommendationId === rec.id,
      );
      if (!ack || ack.decision !== 'accepted') {
        fail('outcome requires an accepted acknowledgement');
      }
      if (typeof event.evidenceRef !== 'string' || !event.evidenceRef) {
        fail('outcome needs an evidence reference');
      }
      return;
    }
    case 'verification': {
      const rec = findLast(
        events, 'recommendation', (e) => e.id === event.recommendationId,
      );
      if (!rec) {
        fail('verification must reference an existing recommendation');
      }
      const current = findLast(events, 'lead_update');
      if (!current || rec.reportId !== current.id) {
        fail('verification needs a recommendation on the current report');
      }
      const outcome = findLast(
        events, 'outcome', (e) => e.id === event.outcomeId,
      );
      if (!outcome || outcome.recommendationId !== rec.id) {
        fail('verification must reference the outcome of its recommendation');
      }
      if (event.evidenceRef !== outcome.evidenceRef) {
        fail('verification evidence reference does not match the outcome evidence');
      }
      if (event.result !== 'pass' && event.result !== 'fail') {
        fail('unsupported verification result');
      }
      return;
    }
    default:
      return;
  }
}

export function createState(scope) {
  return {
    schemaVersion: SCHEMA_VERSION,
    scope: validateScope(scope),
    events: [],
  };
}

export function applyEvent(state, event, caller) {
  assertState(state);
  if (!caller || caller.companyId !== state.scope.companyId) {
    fail(`caller company is outside the ${state.scope.companyId} scope`);
  }
  if (!event || typeof event !== 'object') fail('event must be an object');
  if (typeof event.id !== 'string' || !event.id) fail('event id is required');
  for (const key of ['companyId', 'projectId', 'leadId', 'rossId']) {
    if (event[key] !== state.scope[key]) {
      fail(`event ${key} is outside the company scope`);
    }
  }
  const copy = clone(event);
  const existing = state.events.find((e) => e.id === copy.id);
  if (existing) {
    // Identical redelivery is idempotent; a conflicting id is rejected so the
    // append-only history can never be silently rewritten.
    if (isDeepStrictEqual(existing, copy)) return state;
    fail(`duplicate event id ${copy.id} carries conflicting content`);
  }
  validateSource(copy.source);
  const observedAt = parseTime(copy.observedAt, 'observedAt');
  const previous = state.events[state.events.length - 1];
  if (previous && observedAt < parseTime(previous.observedAt)) {
    fail('event time order violation: observedAt precedes the prior event');
  }
  if (!KINDS.has(copy.kind)) fail(`unsupported event kind ${copy.kind}`);
  const authorKey = AUTHOR[copy.kind];
  if (copy.authorId !== state.scope[authorKey]) {
    fail(`event author must be the scoped ${authorKey === 'leadId' ? 'lead' : 'Ross'}`);
  }
  checkSemantics(state, copy, observedAt);
  // Clone the whole checkpoint: no shared scope or event objects between this
  // state and any earlier one, so mutating a returned state or a caller-held
  // event can never rewrite an earlier checkpoint.
  return {
    schemaVersion: SCHEMA_VERSION,
    scope: clone(state.scope),
    events: clone([...state.events, copy]),
  };
}

export function monicaRead(state, caller, asOf, maxAgeMs = FRESHNESS_MS) {
  assertState(state);
  if (!caller || caller.companyId !== state.scope.companyId) {
    fail(`Monica read is outside the ${state.scope.companyId} company scope`);
  }
  const atMs = parseTime(asOf, 'read time');
  if (typeof maxAgeMs !== 'number' || !(maxAgeMs > 0)) {
    fail('maxAgeMs must be a positive number');
  }
  const lastObserved = state.events.reduce(
    (max, e) => Math.max(max, parseTime(e.observedAt)), -Infinity,
  );
  if (lastObserved > atMs) {
    fail('read time precedes fixture observations; future events cannot be read as current');
  }
  const result = {
    mode: 'offline-fixture',
    companyId: state.scope.companyId,
    freshness: 'missing',
    leadUpdate: null,
    recommendation: null,
    commitmentStatus: 'none',
    verified: false,
    evidenceRef: null,
    disputed: false,
  };
  const report = findLast(state.events, 'lead_update');
  if (report) {
    const ageMs = atMs - parseTime(report.observedAt);
    result.leadUpdate = {
      authorId: report.authorId,
      observedAt: report.observedAt,
      ageMinutes: Math.round(ageMs / 60_000),
      source: clone(report.source),
      body: report.body,
      reportedStatus: report.reportedStatus,
      boardStatus: report.boardStatus,
    };
    result.disputed = report.reportedStatus !== report.boardStatus;
    result.freshness = result.disputed
      ? 'disputed'
      : (ageMs > maxAgeMs ? 'stale' : 'fresh');
  }
  const recommendation = findLast(state.events, 'recommendation');
  // A corrected report supersedes the recommendation chain built on the old
  // one — the read must not present retired advice as current.
  const chainIsCurrent = recommendation !== null
    && report !== null
    && recommendation.reportId === report.id;
  if (chainIsCurrent) {
    result.recommendation = {
      body: recommendation.body,
      checkpointAt: recommendation.checkpointAt,
    };
    // Latest acknowledgement governs acceptance — a challenged decision after
    // an earlier acceptance reads as recommended, never acknowledged.
    const acknowledgement = findLast(
      state.events,
      'acknowledgement',
      (e) => e.recommendationId === recommendation.id,
    );
    const accepted = acknowledgement !== null
      && acknowledgement.decision === 'accepted';
    const outcome = findLast(
      state.events, 'outcome', (e) => e.recommendationId === recommendation.id,
    );
    if (!accepted) {
      result.commitmentStatus = 'recommended';
    } else if (!outcome) {
      result.commitmentStatus = 'acknowledged';
    } else {
      const verification = findLast(
        state.events, 'verification', (e) => e.outcomeId === outcome.id,
      );
      if (verification
          && verification.result === 'pass'
          && verification.evidenceRef === outcome.evidenceRef) {
        result.commitmentStatus = 'evidence_checked';
        result.verified = true;
        result.evidenceRef = outcome.evidenceRef;
      } else {
        result.commitmentStatus = 'outcome_reported';
      }
    }
  }
  return result;
}

export function restoreState(serialized, expectedScope) {
  const scope = validateScope(expectedScope);
  if (!serialized || typeof serialized !== 'object') {
    fail('serialized state must be an object');
  }
  if (serialized.schemaVersion !== SCHEMA_VERSION) {
    fail(`unsupported schema version ${serialized.schemaVersion}`);
  }
  const storedScope = validateScope(serialized.scope);
  for (const key of ['companyId', 'projectId', 'leadId', 'rossId']) {
    if (storedScope[key] !== scope[key]) {
      fail('serialized scope does not match the expected company scope');
    }
  }
  if (!Array.isArray(serialized.events)) {
    fail('serialized events must be an append-only array');
  }
  // Replay every stored event through the same validation path so a tampered
  // or stale history cannot be smuggled back in by a restart.
  let state = createState(scope);
  for (const event of serialized.events) {
    state = applyEvent(state, event, { companyId: scope.companyId });
  }
  return state;
}
