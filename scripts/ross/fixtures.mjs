// Development fixtures only. These are not Agent Dash reads or model outputs.
export const scope = Object.freeze({ companyId: 'fixture-company-a', projectId: 'fixture-project-a', leadId: 'fixture-lead-a', rossId: 'fixture-ross-a' });
export const at = '2026-09-29T18:00:00.000Z';
export const next = '2026-09-29T18:05:00.000Z';
const source = (ref) => ({ kind: 'fixture', ref, revision: '1' });
export const report = Object.freeze({ id: 'report-1', kind: 'lead_update', ...scope, authorId: scope.leadId, observedAt: at, source: source('fixture://company-a/lead-report/1'), body: 'Release smoke is failing; the release remains blocked.', reportedStatus: 'blocked', boardStatus: 'blocked' });
export const recommendation = Object.freeze({ id: 'recommendation-1', kind: 'recommendation', ...scope, authorId: scope.rossId, observedAt: next, source: source('fixture://company-a/ross/recommendation-1'), reportId: report.id, body: 'Prioritize reproducing the smoke failure before release. Ask the lead for an isolated rerun and its exit receipt; keep deployment blocked until verified.', checkpointAt: '2026-09-29T19:00:00.000Z' });
export const ack = Object.freeze({ id: 'ack-1', kind: 'acknowledgement', ...scope, authorId: scope.leadId, observedAt: next, source: source('fixture://company-a/comment/ack-1'), recommendationId: recommendation.id, decision: 'accepted' });
export const outcome = Object.freeze({ id: 'outcome-1', kind: 'outcome', ...scope, authorId: scope.leadId, observedAt: next, source: source('fixture://company-a/comment/outcome-1'), recommendationId: recommendation.id, body: 'The isolated rerun passed.', evidenceRef: 'fixture://company-a/smoke/receipt-1' });
export const verification = Object.freeze({ id: 'verify-1', kind: 'verification', ...scope, authorId: scope.rossId, observedAt: next, source: source('fixture://company-a/verification/1'), recommendationId: recommendation.id, outcomeId: outcome.id, evidenceRef: outcome.evidenceRef, result: 'pass' });
