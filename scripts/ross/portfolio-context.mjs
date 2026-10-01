// Private user-bound portfolio context preparation. Composes the existing
// separately scoped reader envelopes (createAssistantPortfolioReader) into an
// ephemeral per-user view. The combined context is untrusted evidence bound to
// the user, never a company memory, document or session, and never authority.
// Nothing here persists, calls a model, or reaches a provider.
import {isRossUuid, rossSourceTime} from './commitment-records.mjs';
import {REPORT_SOURCE_FRESHNESS_MS} from './reporting-contract.mjs';

const maxOutputBytes = 1_048_576;
const sourceStatuses = new Set(['ok', 'needs_clarification', 'refused', 'not_found']);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw Error(`exact ${label} shape required`);
}

function boundedString(value, label, limit = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw Error(`${label} required`);
}

function sourceConsistent(source, companyId, observedAtMs) {
  // Evidence whose envelope claims a different company or a future/invalid
  // timestamp cannot enter the combined context.
  if (!source || typeof source !== 'object' || !sourceStatuses.has(source.status)) return false;
  try { if (rossSourceTime(source.asOf) > observedAtMs) return false; }
  catch { return false; }
  if (source.data && typeof source.data === 'object' && source.data.companyId !== undefined && source.data.companyId !== companyId) return false;
  return true;
}

function freshness(asOf, observedAtMs) {
  let age;
  try { age = observedAtMs - rossSourceTime(asOf); }
  catch { return {state: 'unknown', freshnessMs: REPORT_SOURCE_FRESHNESS_MS}; }
  if (!Number.isFinite(age)) return {state: 'unknown', freshnessMs: REPORT_SOURCE_FRESHNESS_MS};
  return {state: age < 0 ? 'future' : age > REPORT_SOURCE_FRESHNESS_MS ? 'stale' : 'current', ageMs: age, freshnessMs: REPORT_SOURCE_FRESHNESS_MS};
}

// reader: the existing assistant portfolio reader ({read(selection)}). Its own
// per-company whoami pre/post checks remain in force; revalidateGrant is an
// additional current-grant recheck at assembly time and is required — there is
// no default-permit.
export function createPortfolioContextAssembler({userId, reader, revalidateGrant}) {
  exactKeys(arguments[0], ['userId', 'reader', 'revalidateGrant'], 'assembler config');
  boundedString(userId, 'userId');
  if (typeof reader?.read !== 'function') throw Error('reader.read callable required');
  if (typeof revalidateGrant !== 'function') throw Error('revalidateGrant callable required');
  const fixedUserId = String(userId);
  return {
    async assemble(input) {
      exactKeys(input, ['requestId', 'selection', 'observedAt'], 'assemble input');
      boundedString(input.requestId, 'requestId');
      const observedAtMs = rossSourceTime(input.observedAt);
      const result = await reader.read(input.selection.map(item => ({companyId: item.companyId, refs: [...item.refs]})));
      if (!result || !Array.isArray(result.companies)) throw Error('portfolio reader result malformed');
      const selectedIds = new Set(input.selection.map(item => item.companyId));
      const companies = [];
      const excluded = [];
      for (const row of result.companies) {
        if (!isRossUuid(row.companyId) || !selectedIds.has(row.companyId)) {
          excluded.push({companyId: typeof row?.companyId === 'string' ? row.companyId : null, reason: 'not-in-selection'});
          continue;
        }
        if (row.status !== 'available' || !Array.isArray(row.sources)) {
          excluded.push({companyId: row.companyId, reason: row.reason ?? 'company-source-unavailable'});
          continue;
        }
        let grantCurrent = false;
        try { grantCurrent = (await revalidateGrant(row.companyId, fixedUserId)) === true; }
        catch { grantCurrent = false; }
        if (!grantCurrent) {
          excluded.push({companyId: row.companyId, reason: 'grant-revoked-or-unchanged-unproven'});
          continue;
        }
        if (!row.sources.every(source => sourceConsistent(source, row.companyId, observedAtMs))) {
          excluded.push({companyId: row.companyId, reason: 'source-consistency-failed'});
          continue;
        }
        companies.push({
          companyId: row.companyId,
          status: 'available',
          sources: row.sources.map(source => ({...source, freshness: freshness(source.asOf, observedAtMs)})),
          qualification: 'untrusted assistant-readable source envelopes; no outcome verified',
        });
      }
      const context = {
        schemaVersion: 1,
        requestId: input.requestId.trim(),
        binding: {kind: 'user', userId: fixedUserId, companyBound: false},
        observedAt: new Date(observedAtMs).toISOString(),
        companies,
        excluded,
        consistency: 'sequential rechecks; not atomic',
        permissionAuthority: false,
        companyMemory: false,
        synthesis: 'none',
        persistence: 'ephemeral-no-store',
      };
      if (Buffer.byteLength(JSON.stringify(context)) > maxOutputBytes) throw Error('portfolio context output too large');
      return context;
    },
  };
}

// Readiness descriptor only. No runner contract means not-ready — this lane
// never makes a direct provider/model call. Even a present contract only means
// the route is described; every actual GLM turn still requires a native
// approved governed run receipt, and cost stays unknown until one exists.
export function portfolioInferenceReadiness(runnerContract) {
  const base = {
    grantsAuthority: false,
    perTurnRequirement: 'each actual GLM turn requires a native approved governed budget/run receipt',
    cost: 'unknown-until-governed-receipt',
  };
  if (runnerContract === undefined || runnerContract === null) {
    return {...base, status: 'not-ready', reason: 'inference-runner-contract-absent'};
  }
  try {
    exactKeys(runnerContract, ['kind', 'model', 'budget', 'approval'], 'runner contract');
    if (runnerContract.kind !== 'governed-inference') throw Error('kind');
    exactKeys(runnerContract.model, ['name', 'provider', 'endpoint'], 'runner model');
    for (const key of ['name', 'provider', 'endpoint']) boundedString(runnerContract.model[key], `model.${key}`);
    exactKeys(runnerContract.budget, ['maxRunSeconds', 'maxTokensPerRun', 'maxUsdPerRun'], 'runner budget');
    if (!Number.isInteger(runnerContract.budget.maxRunSeconds) || runnerContract.budget.maxRunSeconds < 1) throw Error('budget');
    if (!Number.isInteger(runnerContract.budget.maxTokensPerRun) || runnerContract.budget.maxTokensPerRun < 1) throw Error('budget');
    if (typeof runnerContract.budget.maxUsdPerRun !== 'number' || !Number.isFinite(runnerContract.budget.maxUsdPerRun) || runnerContract.budget.maxUsdPerRun <= 0) throw Error('budget');
    exactKeys(runnerContract.approval, ['reference', 'decidedBy', 'decidedAt'], 'runner approval');
    boundedString(runnerContract.approval.reference, 'approval reference');
    boundedString(runnerContract.approval.decidedBy, 'approval decider');
    rossSourceTime(runnerContract.approval.decidedAt);
  } catch {
    return {...base, status: 'not-ready', reason: 'inference-runner-contract-invalid'};
  }
  return {...base, status: 'contract-present-not-dispatched', model: {...runnerContract.model}, approvalVerification: 'not-performed'};
}
