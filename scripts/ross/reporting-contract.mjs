// Validated company-owner reporting terms and their deterministic mapping to
// existing native routine/request boundaries (createRoutineSchema,
// createRoutineTriggerSchema, runRoutineSchema). This module is planning only:
// it schedules nothing, wakes nothing, calls no provider and grants no
// capability. Native activation requires an actual governed owner adoption
// through the board routine routes.
import {isRossUuid, rossSourceTime} from './commitment-records.mjs';

// One-hour source freshness is preserved independently of report cadence.
export const REPORT_SOURCE_FRESHNESS_MS = 3_600_000;
const maxOutputBytes = 1_048_576;
const limits = {eventTriggers: 4, events: 100, deliveries: 100, horizonDays: 14, eventObligations: 10};

const weekdayIndex = new Map([['sunday',0],['monday',1],['tuesday',2],['wednesday',3],['thursday',4],['friday',5],['saturday',6]]);
const workingWeekdays = new Set(['monday','tuesday','wednesday','thursday','friday']);
const coalescingPolicies = new Set(['coalesce_if_active','skip_if_active']);
const eventTriggerKinds = new Set(['api','webhook']);
const webhookSigningModes = new Set(['bearer','hmac_sha256','github_hmac','none']);
const escalationTargets = new Set(['board']);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw Error(`exact ${label} shape required`);
}

function boundedString(value, label, limit = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw Error(`${label} required`);
}

function positiveInteger(value, label, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw Error(`${label} required`);
}

function assertTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 100) throw Error('IANA timezone required');
  try { new Intl.DateTimeFormat('en-US', {timeZone}).format(new Date(0)); }
  catch { throw Error('IANA timezone required'); }
}

// ---- local-time <-> UTC helpers (no Temporal dependency) ----

function zonedParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short'}).formatToParts(new Date(ms));
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {year: Number(map.year), month: Number(map.month), day: Number(map.day), hour: Number(map.hour), minute: Number(map.minute), second: Number(map.second)};
}

function wallUtc(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function offsetAt(ms, timeZone) {
  return wallUtc(ms, timeZone) - ms;
}

// Resolve a local wall time to a UTC instant. Ambiguous times (fall-back fold)
// resolve to the earliest occurrence; nonexistent times (spring-forward gap)
// resolve forward by the transition delta.
export function zonedTimeToUtcMs(timeZone, year, month, day, hour, minute) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  const candidates = new Set();
  for (const probe of [target - 3_600_000, target, target + 3_600_000]) {
    const first = target - offsetAt(probe, timeZone);
    candidates.add(first);
    candidates.add(target - offsetAt(first, timeZone));
  }
  const valid = [...candidates].filter(t => wallUtc(t, timeZone) === target).sort((a, b) => a - b);
  if (valid.length) return valid[0];
  const after = [...candidates]
    .map(t => ({t, wall: wallUtc(t, timeZone)}))
    .filter(entry => entry.wall >= target)
    .sort((a, b) => a.wall - b.wall || a.t - b.t);
  if (after.length) return after[0].t;
  throw Error('unresolvable zoned wall time');
}

// ---- term validation ----

function parseLocalTime(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw Error('HH:MM local time required');
  return {hour: Number(value.slice(0, 2)), minute: Number(value.slice(3, 5))};
}

function validateWindows(windows) {
  if (!Array.isArray(windows) || windows.length !== 3) throw Error('exactly three review windows required');
  const ids = new Set();
  const instants = new Set();
  return windows.map(window => {
    exactKeys(window, ['id', 'weekdays', 'localTime'], 'review window');
    boundedString(window.id, 'window id', 40);
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(window.id)) throw Error('bounded window id required');
    if (ids.has(window.id)) throw Error('unique window ids required');
    ids.add(window.id);
    if (!Array.isArray(window.weekdays) || !window.weekdays.length || window.weekdays.length > 5) throw Error('window weekdays required');
    const weekdaySet = new Set();
    for (const day of window.weekdays) {
      if (typeof day !== 'string' || !workingWeekdays.has(day)) throw Error('working-day weekday required');
      if (weekdaySet.has(day)) throw Error('unique window weekdays required');
      weekdaySet.add(day);
    }
    const {hour, minute} = parseLocalTime(window.localTime);
    for (const day of weekdaySet) {
      const key = `${day}T${window.localTime}`;
      if (instants.has(key)) throw Error('overlapping review windows denied');
      instants.add(key);
    }
    return {
      id: window.id,
      weekdays: [...weekdaySet].sort(),
      weekdayNumbers: [...weekdaySet].map(day => weekdayIndex.get(day)).sort(),
      localTime: window.localTime,
      hour,
      minute,
    };
  });
}

function validateEventTriggers(triggers) {
  if (triggers === undefined) return [];
  if (!Array.isArray(triggers) || triggers.length > limits.eventTriggers) throw Error(`event triggers 0..${limits.eventTriggers} required`);
  const ids = new Set();
  return triggers.map(trigger => {
    exactKeys(trigger, ['id', 'kind', 'label', 'signingMode'], 'event trigger');
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(trigger.id)) throw Error('bounded event trigger id required');
    if (ids.has(trigger.id)) throw Error('unique event trigger ids required');
    ids.add(trigger.id);
    if (!eventTriggerKinds.has(trigger.kind)) throw Error('api or webhook event trigger required');
    boundedString(trigger.label, 'event trigger label', 120);
    if (trigger.kind === 'api' && trigger.signingMode !== null) throw Error('api event trigger takes no signing mode');
    if (trigger.kind === 'webhook' && !webhookSigningModes.has(trigger.signingMode)) throw Error('webhook signing mode required');
    return {id: trigger.id, kind: trigger.kind, label: trigger.label.trim(), signingMode: trigger.kind === 'webhook' ? trigger.signingMode : null};
  });
}

// The contract records owner-approved terms; it does not verify or grant them.
export function buildReportingContract(terms) {
  exactKeys(terms, ['schemaVersion', 'companyId', 'projectId', 'reporterAgentId', 'ownerApproval', 'timezone', 'reviewWindows', 'eventTriggers', 'dueWithinMinutes', 'coalescing', 'missedReport', 'budget'], 'reporting terms');
  if (terms.schemaVersion !== 1) throw Error('unsupported reporting terms schema');
  for (const key of ['companyId', 'projectId', 'reporterAgentId']) if (!isRossUuid(terms[key])) throw Error(`${key} UUID required`);
  assertTimeZone(terms.timezone);
  exactKeys(terms.ownerApproval, ['reference', 'decidedBy', 'decidedAt'], 'owner approval');
  boundedString(terms.ownerApproval.reference, 'owner approval reference');
  boundedString(terms.ownerApproval.decidedBy, 'owner approval decider');
  rossSourceTime(terms.ownerApproval.decidedAt);
  positiveInteger(terms.dueWithinMinutes, 'due checkpoint minutes', 1440);
  if (!coalescingPolicies.has(terms.coalescing)) throw Error('coalescing policy coalesce_if_active or skip_if_active required');
  exactKeys(terms.missedReport, ['escalateAfterMinutes', 'escalateTo'], 'missed-report escalation');
  positiveInteger(terms.missedReport.escalateAfterMinutes, 'escalation minutes', 10080);
  if (!escalationTargets.has(terms.missedReport.escalateTo)) throw Error('board escalation target required');
  exactKeys(terms.budget, ['maxRunsPerCheckpoint', 'maxRunSeconds', 'maxTokensPerRun', 'maxUsdPerWindow'], 'budget');
  positiveInteger(terms.budget.maxRunsPerCheckpoint, 'runs per checkpoint cap', 10);
  positiveInteger(terms.budget.maxRunSeconds, 'run seconds cap', 86400);
  positiveInteger(terms.budget.maxTokensPerRun, 'token cap', 10_000_000);
  if (typeof terms.budget.maxUsdPerWindow !== 'number' || !Number.isFinite(terms.budget.maxUsdPerWindow) || terms.budget.maxUsdPerWindow <= 0 || terms.budget.maxUsdPerWindow > 10000) throw Error('USD per window cap required');
  return {
    schemaVersion: 1,
    companyId: terms.companyId,
    projectId: terms.projectId,
    reporterAgentId: terms.reporterAgentId,
    ownerApproval: {
      reference: terms.ownerApproval.reference.trim(),
      decidedBy: terms.ownerApproval.decidedBy.trim(),
      decidedAt: terms.ownerApproval.decidedAt,
      verification: 'not-performed',
      grantsAuthority: false,
    },
    timezone: terms.timezone,
    reviewWindows: validateWindows(terms.reviewWindows),
    eventTriggers: validateEventTriggers(terms.eventTriggers),
    dueWithinMinutes: terms.dueWithinMinutes,
    coalescing: terms.coalescing,
    missedReport: {escalateAfterMinutes: terms.missedReport.escalateAfterMinutes, escalateTo: terms.missedReport.escalateTo},
    budget: {...terms.budget},
    sourceFreshnessMs: REPORT_SOURCE_FRESHNESS_MS,
  };
}

// ---- deterministic mapping to the native routine/request boundary ----

export function mapReportingContractToNative(contract) {
  const triggers = [
    ...contract.reviewWindows.map(window => ({
      kind: 'schedule',
      label: `ross-review-window:${window.id}`,
      enabled: true,
      cronExpression: `${window.minute} ${window.hour} * * ${window.weekdayNumbers.join(',')}`,
      timezone: contract.timezone,
    })),
    ...contract.eventTriggers.map(trigger => trigger.kind === 'api'
      ? {kind: 'api', label: `ross-event:${trigger.id}`, enabled: true}
      : {kind: 'webhook', label: `ross-event:${trigger.id}`, enabled: true, signingMode: trigger.signingMode, replayWindowSec: 300}),
  ];
  return {
    routine: {
      projectId: contract.projectId,
      goalId: null,
      parentIssueId: null,
      title: 'Ross reporting reviews',
      description: `Owner-approved reporting contract. Three working-day review windows in ${contract.timezone}; reports due within ${contract.dueWithinMinutes} minutes of each checkpoint; missed reports escalate to ${contract.missedReport.escalateTo} after ${contract.missedReport.escalateAfterMinutes} minutes. Source freshness stays at ${contract.sourceFreshnessMs / 60000} minutes regardless of cadence. Terms grant nothing by themselves.`,
      assigneeAgentId: contract.reporterAgentId,
      priority: 'medium',
      status: 'paused',
      concurrencyPolicy: contract.coalescing,
      catchUpPolicy: 'skip_missed',
      variables: [],
    },
    triggers,
    runRequestTemplate: {
      source: 'api',
      payload: {kind: 'ross-reporting-review', schemaVersion: 1},
      idempotencyKeyTemplate: 'ross-reporting:{companyId}:{checkpointId}',
    },
    readiness: {
      status: 'partial',
      grantsAuthority: false,
      activation: 'created-paused; a board actor with tasks:assign must activate the routine after governed owner adoption',
      supported: [
        'review windows as schedule triggers (cron in company timezone)',
        'event triggers as api/webhook routine triggers',
        'duplicate triggers coalesce via routine concurrencyPolicy',
        'missed catch-up runs skipped via catchUpPolicy skip_missed',
        'idempotent run requests via idempotencyKey',
      ],
      unsupported: [
        {term: 'due-checkpoint deadline', reason: 'routine triggers start runs; the native boundary has no per-checkpoint deadline construct', requiredHook: 'checkpoint evaluation job comparing routine_runs against dueAt'},
        {term: 'missed-report escalation', reason: 'nothing native detects an absent report or notifies the board', requiredHook: 'missed-checkpoint detector plus board notification route'},
        {term: 'run/time/token/budget caps', reason: 'not expressible on a routine payload', requiredHook: 'existing heartbeat budget/quota enforcement configured under governed owner adoption'},
        {term: 'working-day holiday calendar', reason: 'cron expresses weekdays only, not regional holidays', requiredHook: 'explicit holiday calendar in the scheduling hook'},
        {term: 'real wake or provider effect', reason: 'planning emits descriptors only', requiredHook: 'none here; activation is a separate governed act'},
      ],
    },
  };
}

// ---- checkpoint planning (descriptors only; no timer is created) ----

function parseIso(value, label) {
  const ms = rossSourceTime(value);
  if (ms === undefined) throw Error(`${label} required`);
  return ms;
}

function enumerateCheckpoints(contract, fromMs, toMs) {
  const out = [];
  const start = zonedParts(fromMs, contract.timezone);
  const end = zonedParts(toMs, contract.timezone);
  for (let dayMs = Date.UTC(start.year, start.month - 1, start.day); dayMs <= Date.UTC(end.year, end.month - 1, end.day); dayMs += 86_400_000) {
    const date = new Date(dayMs);
    const weekday = date.getUTCDay();
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    for (const window of contract.reviewWindows) {
      if (!window.weekdayNumbers.includes(weekday)) continue;
      const atMs = zonedTimeToUtcMs(contract.timezone, year, month, day, window.hour, window.minute);
      if (atMs < fromMs || atMs > toMs) continue;
      out.push({id: `window:${window.id}:${new Date(atMs).toISOString()}`, kind: 'window', windowId: window.id, atMs, dueAtMs: atMs + contract.dueWithinMinutes * 60_000});
    }
  }
  out.sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : 1));
  return out;
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length > limits.events) throw Error(`events 0..${limits.events} required`);
  const out = [];
  const seen = new Set();
  for (const event of events) {
    exactKeys(event, ['id', 'triggerId', 'at'], 'trigger event');
    boundedString(event.id, 'event id', 120);
    if (!contractTriggerIdOk(event.triggerId)) throw Error('event triggerId required');
    const atMs = parseIso(event.at, 'event time');
    const key = `${event.triggerId}:${event.id}`;
    if (seen.has(key)) {
      out.push({id: event.id, triggerId: event.triggerId, atMs, duplicate: true});
      continue;
    }
    seen.add(key);
    out.push({id: event.id, triggerId: event.triggerId, atMs, duplicate: false});
  }
  out.sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : 1));
  return out;
}

function contractTriggerIdOk(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
}

function validateDeliveries(deliveries) {
  if (!Array.isArray(deliveries) || deliveries.length > limits.deliveries) throw Error(`deliveries 0..${limits.deliveries} required`);
  return deliveries.map(delivery => {
    exactKeys(delivery, ['deliveredAt', 'sourceAsOf', 'ref'], 'delivery');
    const deliveredAtMs = parseIso(delivery.deliveredAt, 'delivery time');
    const sourceAsOfMs = parseIso(delivery.sourceAsOf, 'source time');
    if (delivery.ref !== null) boundedString(delivery.ref, 'delivery ref');
    return {deliveredAtMs, sourceAsOfMs, ref: delivery.ref};
  }).sort((a, b) => a.deliveredAtMs - b.deliveredAtMs);
}

// Cadence and freshness are separate verdicts: a report can meet the due
// checkpoint cadence while its source exceeds the one-hour freshness bound.
export function assessReportTiming({dueAtMs, deliveredAtMs, sourceAsOfMs, observedAtMs, sourceFreshnessMs = REPORT_SOURCE_FRESHNESS_MS}) {
  const cadence = deliveredAtMs === null ? 'undelivered' : deliveredAtMs <= dueAtMs ? 'within-cadence' : 'late';
  const freshnessAge = observedAtMs - sourceAsOfMs;
  const sourceFreshness = !Number.isFinite(freshnessAge) ? 'unknown' : freshnessAge < 0 ? 'future' : freshnessAge <= sourceFreshnessMs ? 'current' : 'stale';
  return {cadence, sourceFreshness, sourceFreshnessMs, relabeled: false};
}

export function planReportingCycle(contract, input) {
  exactKeys(input, ['now', 'events', 'deliveries', 'horizonDays'], 'planning input');
  const nowMs = parseIso(input.now, 'now');
  const horizonDays = input.horizonDays ?? 7;
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > limits.horizonDays) throw Error(`horizonDays 1..${limits.horizonDays} required`);
  const events = validateEvents(input.events ?? []);
  const deliveries = validateDeliveries(input.deliveries ?? []);
  const horizonMs = horizonDays * 86_400_000;
  const obligations = enumerateCheckpoints(contract, nowMs - horizonMs, nowMs + horizonMs);
  const dueMs = contract.dueWithinMinutes * 60_000;
  let eventObligationCount = 0;
  const eventLedger = [];
  const uncoalesced = [];
  for (const event of events) {
    if (event.duplicate) {
      eventLedger.push({...event, at: new Date(event.atMs).toISOString(), attachedTo: null, coalesced: true, note: 'duplicate event id coalesced'});
      continue;
    }
    if (!contract.eventTriggers.some(trigger => trigger.id === event.triggerId)) {
      uncoalesced.push({id: event.id, triggerId: event.triggerId, at: new Date(event.atMs).toISOString(), reason: 'unknown-trigger'});
      continue;
    }
    const host = obligations.find(ob => ob.atMs <= event.atMs && event.atMs <= ob.dueAtMs);
    if (host) {
      host.eventCount = (host.eventCount ?? 0) + 1;
      eventLedger.push({...event, at: new Date(event.atMs).toISOString(), attachedTo: host.id, coalesced: host.eventCount > 1});
      continue;
    }
    if (eventObligationCount >= limits.eventObligations) {
      uncoalesced.push({id: event.id, triggerId: event.triggerId, at: new Date(event.atMs).toISOString(), reason: 'event-obligation-limit'});
      continue;
    }
    eventObligationCount += 1;
    const obligation = {id: `event:${event.triggerId}:${event.id}`, kind: 'event', windowId: null, atMs: event.atMs, dueAtMs: event.atMs + dueMs, eventCount: 1};
    obligations.push(obligation);
    eventLedger.push({...event, at: new Date(event.atMs).toISOString(), attachedTo: obligation.id, coalesced: false});
  }
  obligations.sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : 1));
  // A delivery satisfies the latest unmet obligation at or before it; earlier
  // missed checkpoints stay missed rather than being retro-covered.
  const deliveredObligations = new Map();
  for (const delivery of deliveries) {
    let host = null;
    for (const obligation of obligations) {
      if (obligation.atMs <= delivery.deliveredAtMs && !deliveredObligations.has(obligation.id)) host = obligation;
    }
    if (host) deliveredObligations.set(host.id, delivery);
  }
  const rows = [];
  for (const obligation of obligations) {
    const at = new Date(obligation.atMs).toISOString();
    const dueAt = new Date(obligation.dueAtMs).toISOString();
    const base = {id: obligation.id, kind: obligation.kind, windowId: obligation.windowId, at, dueAt, triggerEventCount: obligation.eventCount ?? 0};
    const delivery = deliveredObligations.get(obligation.id);
    if (delivery) {
      rows.push({...base, status: delivery.deliveredAtMs <= obligation.dueAtMs ? 'delivered' : 'delivered-late',
        delivery: {deliveredAt: new Date(delivery.deliveredAtMs).toISOString(), sourceAsOf: new Date(delivery.sourceAsOfMs).toISOString(), ref: delivery.ref,
          timing: assessReportTiming({dueAtMs: obligation.dueAtMs, deliveredAtMs: delivery.deliveredAtMs, sourceAsOfMs: delivery.sourceAsOfMs, observedAtMs: nowMs, sourceFreshnessMs: contract.sourceFreshnessMs})}});
      continue;
    }
    if (nowMs < obligation.atMs) {
      rows.push({...base, status: 'upcoming'});
      continue;
    }
    const request = {
      kind: 'native-routine-run-request',
      source: 'api',
      idempotencyKey: `ross-reporting:${contract.companyId}:${obligation.id}`,
      payload: {kind: 'ross-reporting-review', schemaVersion: 1, checkpointId: obligation.id, windowId: obligation.windowId, dueAt},
      grantsAuthority: false,
      requiresGovernedDispatch: true,
      budgetCaps: {...contract.budget},
    };
    if (nowMs <= obligation.dueAtMs) {
      rows.push({...base, status: 'open', plannedRequest: request});
      continue;
    }
    const escalateAtMs = obligation.dueAtMs + contract.missedReport.escalateAfterMinutes * 60_000;
    rows.push({...base, status: 'missed', plannedRequest: request,
      escalation: {
        to: contract.missedReport.escalateTo,
        status: nowMs >= escalateAtMs ? 'required' : 'pending',
        at: new Date(escalateAtMs).toISOString(),
        hook: 'native-missed-checkpoint-detector-absent',
        grantsAuthority: false,
      }});
  }
  const result = {
    schemaVersion: 1,
    evaluatedAt: new Date(nowMs).toISOString(),
    timezone: contract.timezone,
    horizonDays,
    obligations: rows,
    eventLedger,
    uncoalescedEvents: uncoalesced,
    unmatchedDeliveries: deliveries.filter(delivery => ![...deliveredObligations.values()].includes(delivery))
      .map(delivery => ({deliveredAt: new Date(delivery.deliveredAtMs).toISOString(), sourceAsOf: new Date(delivery.sourceAsOfMs).toISOString(), ref: delivery.ref})),
    grantsAuthority: false,
    note: 'planning descriptors only; no wake, schedule, request or provider effect',
  };
  if (Buffer.byteLength(JSON.stringify(result)) > maxOutputBytes) throw Error('reporting plan output too large');
  return result;
}
