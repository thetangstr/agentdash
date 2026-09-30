import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { draftHermesEnvironmentPatch, REVIEWED_EXECUTE_SHA256 } from './draft-environment-patch.js';

const execFileAsync = promisify(execFile);
const checkout = fileURLToPath(new URL('../..', import.meta.url));
const reviewed = {
  vendor: {
    'package.json': 'a99b629faca46827f7049c60af5f3282672350960d8c7fb67039af1bd1f036dc',
    'dist/server/execute.js': REVIEWED_EXECUTE_SHA256,
    'dist/server/detect-model.js': '6479d667d6404abd187fd79ef50227c4c976e4bacd5c23d127da9e1daa479223',
    'dist/shared/constants.js': 'be6da31702c4be603b980e51956b29f586117a0c65458d104b693779aded3995',
  },
  utils: {
    'package.json': '6764dda046fe6d4fa31d1dcf87d118cbce37f80c175d922fe46244068b8ae021',
    'dist/server-utils.js': 'f0d1f7cf877c6fa7a714cb843880642dd0525c192902a5b764b67ed3a36e0810',
    'dist/ssh.js': 'fcf85cce37d5a34af70bc8c5f54a3b6c9cade8f3c06587c6d7cd413d98a459d5',
    'dist/seatbelt.js': 'bfebd127106e3e73be521ba0fdce0fe9648a086d920b6dea01cd5cc4f393a40f',
    'dist/command-redaction.js': '75b696768bb0990a9a2440b90e11a4a97c2dcd62e2dd67260c65301bc0548eab',
  },
};
const snapshots: Record<string, Buffer> = {};
const deniedAmbientNames = [
  'ROSS_AMBIENT_SENTINEL', 'DATABASE_URL', 'BETTER_AUTH_SECRET',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'API_KEY',
];
const fakeExecutableMarker = 'ross-offline-fake-cli-v1';
const captures: { variant: string; explicit: boolean; result: unknown; observed: { fakeExecutableMarker: string } }[] = [];
let scratch: string;
let source: string;
let candidate: ReturnType<typeof draftHermesEnvironmentPatch>;

beforeAll(async () => {
  // Snapshot and verify the complete copied import graph before executing it.
  const roots = {
    vendor: join(checkout, 'server/node_modules/hermes-paperclip-adapter'),
    utils: join(checkout, 'packages/adapter-utils'),
  };
  // The isolated checkout has no built utils; reuse source bytes from the
  // existing install, then run against copies rather than shared dependencies.
  roots.utils = await realpath(join(checkout, 'server/node_modules/@paperclipai/adapter-utils'));
  for (const [group, hashes] of Object.entries(reviewed)) {
    for (const [relative, hash] of Object.entries(hashes)) {
      const body = await readFile(join(roots[group as keyof typeof roots], relative));
      expect(createHash('sha256').update(body).digest('hex'), 'review source drift before executing').toBe(hash);
      snapshots[group + '/' + relative] = body;
    }
  }
  source = snapshots['vendor/dist/server/execute.js'].toString('utf8');
  candidate = draftHermesEnvironmentPatch(source);
  scratch = await mkdtemp(join(tmpdir(), 'ross-copied-adapter-'));
  for (const [group, hashes] of Object.entries(reviewed)) {
    const destinations = group === 'vendor' ? ['baseline', 'candidate'] : ['utils'];
    for (const destination of destinations) {
      for (const relative of Object.keys(hashes)) {
        const target = join(scratch, destination, relative);
        await mkdir(dirname(target), { recursive: true });
        const body = destination === 'candidate' && relative === 'dist/server/execute.js'
          ? candidate.source : snapshots[group + '/' + relative];
        await writeFile(target, body, { flag: 'wx', mode: 0o600 });
      }
    }
  }
  for (const variant of ['baseline', 'candidate']) {
    await mkdir(join(scratch, variant, 'node_modules/@paperclipai'), { recursive: true });
    await symlink(join(scratch, 'utils'), join(scratch, variant, 'node_modules/@paperclipai/adapter-utils'));
  }
  await mkdir(join(scratch, 'home/profiles/ross-fixture'), { recursive: true });
  const fake = [
    '#!' + process.execPath,
    "const fs = require('node:fs');",
    'const names = ' + JSON.stringify([...deniedAmbientNames, 'ZAI_API_KEY', 'HERMES_CUSTOM_LMSTUDIO_API_KEY']) + ';',
    "fs.writeFileSync(process.env.ROSS_CAPTURE_PATH, JSON.stringify({fakeExecutableMarker:'ross-offline-fake-cli-v1',argv:process.argv.slice(2),present:Object.fromEntries(names.map(name=>[name,Object.hasOwn(process.env,name)])),explicitZaiBinding:process.env.ZAI_API_KEY==='synthetic-explicit-binding',endpoint:process.env.GLM_BASE_URL,home:process.env.HERMES_HOME,companyId:process.env.PAPERCLIP_COMPANY_ID,agentId:process.env.PAPERCLIP_AGENT_ID,runId:process.env.PAPERCLIP_RUN_ID,taskId:process.env.PAPERCLIP_TASK_ID,explicitApiToken:process.env.PAPERCLIP_API_KEY==='fixture-token',pathPresent:Boolean(process.env.PATH)}));",
    "process.stdout.write('Offline fake response; no model called.\\nsession_id: ross-isolated-fixture\\n');",
  ].join('\n');
  await writeFile(join(scratch, 'fake-hermes.cjs'), fake, { flag: 'wx', mode: 0o700 });
  await chmod(join(scratch, 'fake-hermes.cjs'), 0o700);
  const runner = [
    "import {pathToFileURL} from 'node:url';",
    "import {join} from 'node:path';",
    "const [root,variant,capture,explicit] = process.argv.slice(2);",
    "const {execute} = await import(pathToFileURL(join(root,variant,'dist/server/execute.js')).href);",
    "const env = {ROSS_CAPTURE_PATH:capture,GLM_BASE_URL:'https://api.z.ai/api/paas/v4',HERMES_HOME:join(root,'home/profiles/ross-fixture'),PAPERCLIP_API_KEY:'fixture-token'};",
    "if (explicit === 'yes') env.ZAI_API_KEY='synthetic-explicit-binding';",
    "const config = {hermesCommand:join(root,'fake-hermes.cjs'),cwd:root,model:'glm-5.3-flash',provider:'zai',toolsets:'ross_fixture',maxTurnsPerRun:4,timeoutSec:10,graceSec:1,persistSession:true,promptTemplate:'Offline synthetic fixture only.',env};",
    "const result = await execute({runId:'fixture-run',agent:{id:'fixture-ross',companyId:'fixture-company-a',adapterConfig:config},config:{taskId:'fixture-task'},context:{},runtime:{sessionParams:{sessionId:'fixture-prior-session'}},onLog:async()=>{},onMeta:async()=>{},onSpawn:async()=>{}});",
    "console.log(JSON.stringify({exitCode:result.exitCode,model:result.model,sessionId:result.sessionParams?.sessionId}));",
  ].join('\n');
  await writeFile(join(scratch, 'runner.mjs'), runner, { flag: 'wx', mode: 0o600 });
});

afterAll(async () => {
  if (process.env.ROSS_ISOLATION_EVIDENCE_DIR && candidate) {
    const label = process.env.ROSS_ISOLATION_EVIDENCE_LABEL ?? 'run';
    if (!/^[a-z0-9-]+$/.test(label)) throw new Error('invalid evidence label');
    await writeFile(join(process.env.ROSS_ISOLATION_EVIDENCE_DIR, 'execute-candidate-' + label + '.js'), candidate.source, { mode: 0o600 });
    await writeFile(join(process.env.ROSS_ISOLATION_EVIDENCE_DIR, 'environment-proof-' + label + '.json'), JSON.stringify({
      recordedAt: new Date().toISOString(), mode: 'offline-copied-adapter',
      sourceSha256: candidate.sourceSha256, candidateSha256: candidate.candidateSha256,
      reviewedSourceHashes: reviewed, captures,
      fakeExecutableInvoked: captures.length > 0 && captures.every((item) => item.observed.fakeExecutableMarker === fakeExecutableMarker),
      realHermesExecutableInvoked: false, providerCalls: 0,
      providerCallEvidence: 'No provider call path exercised by the reviewed explicit-provider/fake-executable harness; this is not network metering.',
      qualification: 'Synthetic child environment and fake executable only. Existing shared inheritance policy still permits HOME and HERMES_*; Hermes dotenv/profile isolation and real company authorization are not proven.',
    }, null, 2) + '\n', { mode: 0o600 });
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function executeVariant(variant: string, explicit = false) {
  const capture = join(scratch, variant + (explicit ? '-explicit' : '') + '.json');
  // Construct the parent from scratch. Never pass the test process's secrets.
  const env = {
    PATH: dirname(process.execPath) + ':/usr/bin:/bin',
    HOME: join(scratch, 'home'), TMPDIR: scratch,
    PAPERCLIP_RUNTIME_API_URL: 'http://fixture.invalid',
    ...Object.fromEntries(deniedAmbientNames.map((name) => [name, 'synthetic-parent-probe'])),
    ZAI_API_KEY: 'synthetic-ambient-key',
    HERMES_CUSTOM_LMSTUDIO_API_KEY: 'synthetic-prefix-policy-value',
  };
  const { stdout } = await execFileAsync(process.execPath,
    [join(scratch, 'runner.mjs'), scratch, variant, capture, explicit ? 'yes' : 'no'],
    { env, cwd: scratch, timeout: 20_000, maxBuffer: 128 * 1024 });
  const result = JSON.parse(stdout);
  const observed = JSON.parse(await readFile(capture, 'utf8'));
  captures.push({ variant, explicit, result, observed });
  expect(observed.fakeExecutableMarker).toBe(fakeExecutableMarker);
  expect(result.exitCode).toBe(0);
  return observed;
}

test('copied adapter correction removes unrestricted ambient secrets at the real spawn boundary', async () => {
  const baseline = await executeVariant('baseline');
  const corrected = await executeVariant('candidate');
  for (const key of [...deniedAmbientNames, 'ZAI_API_KEY']) {
    expect(baseline.present[key], key + ' was present before correction').toBe(true);
    expect(corrected.present[key], key + ' must be absent after correction').toBe(false);
  }
  // Preserve and disclose the existing policy's incomplete isolation boundary.
  expect(corrected.present.HERMES_CUSTOM_LMSTUDIO_API_KEY).toBe(true);
});

test('copied correction retains explicit bindings, exact GLM route and scoped runtime context', async () => {
  const observed = await executeVariant('candidate', true);
  expect(observed.explicitZaiBinding).toBe(true);
  for (const key of deniedAmbientNames) expect(observed.present[key], key).toBe(false);
  expect(observed.present.ZAI_API_KEY).toBe(true);
  expect(observed.explicitApiToken).toBe(true);
  expect(observed.pathPresent).toBe(true);
  expect(observed.endpoint).toBe('https://api.z.ai/api/paas/v4');
  expect(observed.home).toBe(join(scratch, 'home/profiles/ross-fixture'));
  expect([observed.companyId, observed.agentId, observed.runId, observed.taskId])
    .toEqual(['fixture-company-a', 'fixture-ross', 'fixture-run', 'fixture-task']);
  const args: string[] = observed.argv;
  const values = (...flags: string[]) => args.flatMap((arg, index) => {
    if (flags.includes(arg)) return [args[index + 1]];
    const flag = flags.find((item) => arg.startsWith(item + '='));
    return flag ? [arg.slice(flag.length + 1)] : [];
  });
  expect(values('-m', '--model')).toEqual(['glm-5.3-flash']);
  expect(values('--provider')).toEqual(['zai']);
  expect(values('-t', '--toolsets')).toEqual(['ross_fixture']);
  expect(values('--max-turns')).toEqual(['4']);
  expect(values('-r', '--resume')).toEqual(['fixture-prior-session']);
  expect(args).toContain('--yolo'); // unchanged observed behavior, still a live limitation
});

test('draft rejects unreviewed source drift before a candidate can be loaded', () => {
  expect(() => draftHermesEnvironmentPatch(source + '\n// source drift\n')).toThrow(/source|hash|review|drift/i);
});

test('draft cannot silently reapply itself to an already changed source', () => {
  expect(candidate.candidateSha256).not.toBe(candidate.sourceSha256);
  expect(() => draftHermesEnvironmentPatch(candidate.source)).toThrow(/source|hash|review|drift/i);
});
