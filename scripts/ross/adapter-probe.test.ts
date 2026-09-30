import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { getServerAdapter } from '../../server/src/adapters/registry.js';
import { classifyAgentRunFailure } from '../../server/src/services/agent-run-failure-classifier.js';
import { governedRunnerFailureMessage } from './governed-invocation.mjs';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true });
});

test('actual adapter parses the sanitized failed-run diagnostic as an unavailable network without a response or new session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ross-provider-failure-offline-'));
  temporaryDirectories.push(directory);
  const binding = { companyId: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', agentId: '33333333-3333-4333-8333-333333333333' };
  const invocation = { runId: '44444444-4444-4444-8444-444444444444', resumeId: 'retained_private_session' };
  const receipt = { executionMode: 'governed', runId: invocation.runId, scope: binding, requestedModel: 'glm-5.3-flash', endpoint: 'https://api.z.ai/api/paas/v4', resumeId: invocation.resumeId, sessionId: invocation.resumeId, answer: null, usage: null, failure: { code: 1, signal: null }, stdout: 'API call failed after 3 retries: Connection error.\n', stderr: 'session_id: retained_private_session\nsynthetic-private-secret' };
  const message = governedRunnerFailureMessage({ failure: { code: 1 }, exitCode: 1, signal: null, stdout: JSON.stringify(receipt) }, binding, invocation);
  expect(message).toBeTruthy();
  const command = join(directory, 'failed-hermes.cjs');
  await writeFile(command, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(message)});process.exitCode=1;\n`, { mode: 0o700 });
  const previousManaged = process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
  process.env.AGENTDASH_HERMES_MANAGED_PROFILES = 'false';
  try {
    const adapter = getServerAdapter('hermes_local');
    const config = { hermesCommand: command, cwd: directory, model: 'glm-5.3-flash', provider: 'zai', toolsets: 'ross_fixture', maxTurnsPerRun: 4, timeoutSec: 10, graceSec: 1, persistSession: true, promptTemplate: 'Offline failed-receipt transport; no provider call.', env: { HERMES_HOME: join(directory, 'profiles', 'ross-fixture') } };
    const result = await adapter.execute({ runId: invocation.runId, agent: { id: binding.agentId, companyId: binding.companyId, name: 'Ross failure fixture', adapterType: 'hermes_local', adapterConfig: config }, config, context: {}, runtime: { sessionParams: { sessionId: invocation.resumeId } }, authToken: 'synthetic-token-not-a-real-key', onLog: async () => {}, onMeta: async () => {}, onSpawn: async () => {} } as never);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('inference unavailable');
    expect(result.summary).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
    expect(result.errorMessage).not.toContain('synthetic-private-secret');
    expect(result.errorMessage).not.toContain(invocation.resumeId);
    const classification = classifyAgentRunFailure({ outcome: 'failed', adapterType: 'hermes_local', errorMessage: result.errorMessage, errorCode: 'adapter_failed' });
    expect(classification?.category).toBe('network_unreachable');
  } finally {
    if (previousManaged === undefined) delete process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
    else process.env.AGENTDASH_HERMES_MANAGED_PROFILES = previousManaged;
  }
});

test('actual Hermes adapter transmits exact model, standard pin, bounded tools and recovered session to a fake CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ross-adapter-offline-'));
  temporaryDirectories.push(directory);
  const command = join(directory, 'fake-hermes.cjs');
  const capturePath = join(directory, 'capture.json');
  await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
// Named harmless probes only; never dump the process environment or keys.
fs.writeFileSync(process.env.ROSS_CAPTURE_PATH, JSON.stringify({
  argv: process.argv.slice(2), endpoint: process.env.GLM_BASE_URL,
  hermesHome: process.env.HERMES_HOME, companyId: process.env.PAPERCLIP_COMPANY_ID,
  agentId: process.env.PAPERCLIP_AGENT_ID, runId: process.env.PAPERCLIP_RUN_ID,
  ambientSentinel: process.env.ROSS_AMBIENT_SENTINEL
}));
process.stdout.write('Offline fake response; no model called.\\nsession_id: ross-fixture-session\\n');
`, { mode: 0o700 });
  await chmod(command, 0o700);
  const previous = process.env.ROSS_AMBIENT_SENTINEL;
  const previousManaged = process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
  process.env.ROSS_AMBIENT_SENTINEL = 'harmless-parent-value';
  process.env.AGENTDASH_HERMES_MANAGED_PROFILES = 'false';
  try {
    const adapter = getServerAdapter('hermes_local');
    const config = {
      hermesCommand: command, cwd: directory, model: 'glm-5.3-flash', provider: 'zai',
      toolsets: 'ross_fixture', maxTurnsPerRun: 4, timeoutSec: 10, graceSec: 1,
      persistSession: true, promptTemplate: 'Offline fixture for {{companyId}}: return shadow advice only.',
      env: { ROSS_CAPTURE_PATH: capturePath, GLM_BASE_URL: 'https://api.z.ai/api/paas/v4', HERMES_HOME: join(directory, 'profiles', 'ross-fixture') },
    };
    const result = await adapter.execute({
      runId: 'fixture-run',
      agent: { id: 'fixture-ross', companyId: 'fixture-company-a', name: 'Ross fixture', adapterType: 'hermes_local', adapterConfig: config },
      config, context: {}, runtime: { sessionParams: { sessionId: 'ross-prior-fixture-session' } },
      authToken: 'fixture-token-not-a-real-key', onLog: async () => {}, onMeta: async () => {}, onSpawn: async () => {},
    } as never);
    const capture = JSON.parse(await readFile(capturePath, 'utf8'));
    const args: string[] = capture.argv;
    const values = (...flags: string[]) => args.flatMap((arg, index) => {
      if (flags.includes(arg)) return [args[index + 1]];
      const assigned = flags.find((flag) => arg.startsWith(`${flag}=`));
      return assigned ? [arg.slice(assigned.length + 1)] : [];
    });
    // Assert every occurrence, including aliases and --flag=value overrides.
    expect(values('-m', '--model')).toEqual(['glm-5.3-flash']);
    expect(values('--provider')).toEqual(['zai']);
    expect(values('-t', '--toolsets')).toEqual(['ross_fixture']);
    expect(values('--max-turns')).toEqual(['4']);
    expect(values('-r', '--resume')).toEqual(['ross-prior-fixture-session']);
    expect(args).toContain('--yolo'); // observed seam; not an authorization guarantee
    expect(capture.endpoint).toBe('https://api.z.ai/api/paas/v4');
    expect(capture.hermesHome).toBe(config.env.HERMES_HOME);
    expect(capture.companyId).toBe('fixture-company-a');
    expect(capture.agentId).toBe('fixture-ross');
    expect(capture.runId).toBe('fixture-run');
    // This passing observation proves a LIVE BLOCKER, not safe environment isolation.
    expect(capture.ambientSentinel).toBe('harmless-parent-value');
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe('glm-5.3-flash');
    expect(result.sessionParams?.sessionId).toBe('ross-fixture-session');
    expect(result.summary).toContain('no model called');
  } finally {
    if (previous === undefined) delete process.env.ROSS_AMBIENT_SENTINEL;
    else process.env.ROSS_AMBIENT_SENTINEL = previous;
    if (previousManaged === undefined) delete process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
    else process.env.AGENTDASH_HERMES_MANAGED_PROFILES = previousManaged;
  }
});
