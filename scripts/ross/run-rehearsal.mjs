import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createState, applyEvent, monicaRead, restoreState } from './rehearsal.mjs';
import { scope, next, report, recommendation, ack, outcome, verification } from './fixtures.mjs';

// No provider, Hermes CLI, Agent Dash API, audio, or live company is used here.
const started = performance.now();
// Optional existing artifact root; mkdtemp always creates a new directory.
const artifacts = await mkdtemp(join(process.argv[2] ?? tmpdir(), 'ross-offline-rehearsal-'));
const caller = { companyId: scope.companyId };
let state = createState(scope);
const receipts = [];
const record = (event) => {
  state = applyEvent(state, event, caller);
  receipts.push({ eventId: event.id, source: event.source, status: monicaRead(state, caller, next, 60 * 60_000).commitmentStatus });
};
record(report);
record(recommendation);
record(ack);
assert.equal(monicaRead(state, caller, next, 60 * 60_000).verified, false);
const restartPath = join(artifacts, 'acknowledged-state.json');
await writeFile(restartPath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
state = restoreState(JSON.parse(await readFile(restartPath, 'utf8')), scope);
assert.equal(monicaRead(state, caller, next, 60 * 60_000).commitmentStatus, 'acknowledged');
const countBefore = state.events.length;
state = applyEvent(state, ack, caller);
assert.equal(state.events.length, countBefore);
record(outcome);
assert.equal(monicaRead(state, caller, next, 60 * 60_000).verified, false);
// This is fixture verification of fixture evidence. It cannot verify a release.
record(verification);
const monica = monicaRead(state, caller, next, 60 * 60_000);
assert.equal(monica.commitmentStatus, 'evidence_checked');
assert.throws(() => monicaRead(state, { companyId: 'fixture-company-b' }, next, 60 * 60_000), /company|scope/i);
const statePath = join(artifacts, 'final-state.json');
const stateJson = JSON.stringify(state, null, 2) + '\n';
await writeFile(statePath, stateJson, { mode: 0o600, flag: 'wx' });
const evidence = {
  mode: 'offline-fixture', recordedAt: new Date().toISOString(), scenarioAsOf: next,
  modelRoute: 'none; human-authored synthetic recommendation', modelCalls: 0,
  observedModelUsage: null, textInferenceLatencyMs: null, audioMeasured: false,
  localRehearsalDurationMs: Math.round((performance.now() - started) * 100) / 100,
  companyId: scope.companyId, receipts, restartPath, statePath,
  stateSha256: createHash('sha256').update(stateJson).digest('hex'),
  restartRestoredAcknowledgement: true, duplicateAcknowledgementCreatedWork: false,
  crossCompanyReadDenied: true, controlPlaneWrites: 0,
  monicaFacingRead: monica,
  qualification: 'All company records, advice, acknowledgement, and completion evidence are synthetic. No real lead/model/Monica conversation or Agent Dash enforcement is proven.',
};
const evidencePath = join(artifacts, 'evidence.json');
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ evidencePath, ...evidence }, null, 2));
