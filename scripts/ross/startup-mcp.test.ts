import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { buildRossNoNetworkStartupProfile } from './startup-profile.js';

const execute = promisify(execFile);

// Actual installed Hermes negotiates with actual Node MCP. Catalog only.
test.runIf(process.env.ROSS_HERMES_MCP_PROBE === '1')('Hermes discovers exactly two Ross read tools with networking denied, and rejects an unresolved credential', async () => {
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
  const before = await metadata();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ross-hermes-mcp-')));
  try {
    const home = join(root, 'home');
    const binding = { apiUrl: 'https://example.invalid/api', companyId: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', agentId: '33333333-3333-4333-8333-333333333333', workspace: root };
    const contractModule = new URL('./pilot-contract.mjs', import.meta.url).href;
    const { stdout: contractText } = await execute(process.execPath, ['--input-type=module', '-e', `import { buildRossPilotContract } from ${JSON.stringify(contractModule)}; process.stdout.write(JSON.stringify(buildRossPilotContract(${JSON.stringify(binding)})));`], { env: { HOME: home, PATH: '/usr/bin:/bin' }, timeout: 5_000 });
    const contract = JSON.parse(contractText) as { config: object; environment: Record<string, string>; catalogCommand: { executable: string; args: string[] } };
    for (const path of [contract.environment.HERMES_HOME, contract.environment.HERMES_MANAGED_DIR, contract.environment.TMPDIR]) await mkdir(path, { recursive: true });
    // JSON is valid YAML. This generated file contains a reference, no key value.
    await writeFile(join(contract.environment.HERMES_HOME, 'config.yaml'), JSON.stringify(contract.config), { mode: 0o600, flag: 'wx' });
    const python = contract.catalogCommand.executable;
    const pythonRoot = dirname(dirname(await readlink(python)));
    const profile = buildRossNoNetworkStartupProfile({ homeDir: homedir(), workspaceDir: root, syntheticHomeDir: home, readOnlyPaths: [installed, pythonRoot], execPaths: [python, process.execPath], egress: 'loopback' });
    const profilePath = join(root, 'catalog.sb');
    await writeFile(profilePath, profile, { mode: 0o600, flag: 'wx' });
    const syntheticKey = 'ross-catalog-synthetic-not-a-credential';
    const probe = async (withBinding: boolean) => {
      const { stdout, stderr } = await execute('/usr/bin/sandbox-exec', ['-f', profilePath, python, ...contract.catalogCommand.args], { cwd: root, env: { ...contract.environment, ...(withBinding ? { ROSS_AGENT_API_KEY: syntheticKey } : {}) }, timeout: 20_000, maxBuffer: 1_048_576 });
      expect(stdout + stderr).not.toContain(syntheticKey);
      return { stdout: stdout.replace(/\x1b\[[0-9;]*m/g, ''), stderr };
    };
    const connected = await probe(true);
    // CLI catches connection failures and still exits zero: inspect the result.
    expect(connected.stdout).toContain('Connected');
    expect(connected.stdout).toContain('Tools discovered: 2');
    expect(connected.stdout).toContain('ross_project_snapshot');
    expect(connected.stdout).toContain('ross_issue_evidence');
    expect(connected.stdout).not.toContain('Connection failed');
    const unbound = await probe(false);
    expect(unbound.stdout).not.toContain('Connected');
    expect(unbound.stdout).not.toContain('Tools discovered:');
    expect(unbound.stdout).toContain('Connection failed');
    expect(await metadata()).toEqual(before);
    if (process.env.ROSS_MCP_EVIDENCE_DIR) {
      await writeFile(join(process.env.ROSS_MCP_EVIDENCE_DIR, 'hermes-mcp-proof.json'), JSON.stringify({ recordedAt: new Date().toISOString(), mode: 'installed-hermes-to-node-catalog-only', connected: true, discoveredTools: ['ross_project_snapshot', 'ross_issue_evidence'], unresolvedSecretRejected: true, networkDenied: true, modelInvoked: false, realCompanyAccessTested: false, installedDotenvMetadataUnchanged: true, sourcePins: pins, environmentNames: Object.keys(contract.environment), stdoutSha256: createHash('sha256').update(connected.stdout).digest('hex'), limits: ['catalog only; no tool call or provider', 'not full filesystem/Mach isolation', 'generated contract grants no access'] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await writeFile(join(process.env.ROSS_MCP_EVIDENCE_DIR, 'catalog-profile.sb'), profile, { mode: 0o600, flag: 'wx' });
      await writeFile(join(process.env.ROSS_MCP_EVIDENCE_DIR, 'private-config-template.json'), JSON.stringify(contract.config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
