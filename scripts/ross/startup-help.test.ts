import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { buildRossNoNetworkStartupProfile } from './startup-profile.js';

// Explicit opt-in: actual installed CLI help, never chat/inference/environment probe.
test.runIf(process.env.ROSS_HERMES_HELP_PROBE === '1')('installed Hermes prints help under proven no-network startup restrictions', async () => {
  const installed = process.env.ROSS_HERMES_AGENT_ROOT || join(homedir(), '.hermes', 'hermes-agent');
  const pins = {
    'hermes_cli/main.py': 'd21135792593599715c194999a97621cb86b09180b19e51db58d1910f1bdabf3',
    'hermes_cli/env_loader.py': '4bdeccecea814299627f0e1a4fb54f9e93ba48a01f35b966337f7ad9a826f798',
    'hermes_cli/managed_scope.py': '1ef50ab8787f4a1c9fb3cbe562de426eb9b58a4bb16fe3960427921cd22773b6',
    'hermes_cli/_early_recovery.py': 'f0c89340550893dd185d1ecdfceebfe3b4509b780d455f609784f42b128b083c',
    'venv/bin/hermes': 'eab3219894429cf55ae96aed8d3eb57e0565f7e3f41832183ff347618d18082a',
  };
  for (const [path, pin] of Object.entries(pins)) expect(createHash('sha256').update(await readFile(join(installed, path))).digest('hex'), 'review startup source drift').toBe(pin);
  const metadata = async () => { const value = await stat(join(installed, '.env')); return { ino: value.ino, size: value.size, mtimeMs: value.mtimeMs }; };
  const before = await metadata(); // Metadata only; never read/hash credential contents.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ross-hermes-help-')));
  try {
    const home = join(root, 'home');
    const hermesHome = join(home, '.hermes/profiles/ross-startup');
    const managed = join(root, 'managed-empty');
    const temporary = join(root, 'tmp');
    for (const path of [hermesHome, managed, temporary]) await mkdir(path, { recursive: true });
    const python = join(installed, 'venv/bin/python');
    const pythonRoot = dirname(dirname(await readlink(python)));
    const profile = buildRossNoNetworkStartupProfile({ homeDir: homedir(), workspaceDir: root, syntheticHomeDir: home,
      readOnlyPaths: [installed, pythonRoot], execPaths: [python], egress: 'loopback' });
    const profilePath = join(root, 'startup.sb');
    await writeFile(profilePath, profile, { mode: 0o600, flag: 'wx' });
    const environment = { HOME: home, HERMES_HOME: hermesHome, HERMES_MANAGED_DIR: managed, TMPDIR: temporary,
      PATH: '/usr/bin:/bin', PYTHON_DOTENV_DISABLED: '1', PYTHONDONTWRITEBYTECODE: '1', TERM: 'dumb' };
    const { stdout, stderr } = await promisify(execFile)('/usr/bin/sandbox-exec', ['-f', profilePath, python, '-I', '-B', join(installed, 'venv/bin/hermes'), '--help'],
      { cwd: root, env: environment, timeout: 20_000, maxBuffer: 1_048_576 });
    expect(stdout).toContain('usage: hermes');
    expect(stdout).toContain('--help');
    expect(await metadata()).toEqual(before);
    if (process.env.ROSS_STARTUP_EVIDENCE_DIR) {
      await writeFile(join(process.env.ROSS_STARTUP_EVIDENCE_DIR, 'hermes-help-proof.json'), JSON.stringify({
        recordedAt: new Date().toISOString(), mode: 'installed-hermes-help-only', exitCode: 0, modelInvoked: false,
        providerAccessTested: false, realCompanyAccessTested: false, helpPrinted: true,
        installedDotenvMetadataUnchanged: true, sourcePins: pins, environmentNames: Object.keys(environment),
        stdoutSha256: createHash('sha256').update(stdout).digest('hex'), stderrSha256: createHash('sha256').update(stderr).digest('hex'),
        limits: ['not full filesystem isolation', 'Mach/IPC not fully confined', 'source/interpreter roots readable except configured dotenv targets', 'no model/company loop'],
      }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await writeFile(join(process.env.ROSS_STARTUP_EVIDENCE_DIR, 'startup-profile.sb'), profile, { mode: 0o600, flag: 'wx' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
