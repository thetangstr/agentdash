import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildPilotContractForRole, rossSessionFailure } from './pilot-contract.mjs';
import { runOwnedProcess } from './owned-process.mjs';
import { homedir } from 'node:os';
import { hermesAgentRoot, hermesProviderEnvFile } from './local-paths.mjs';

// Explicit operator CLI for the authorized local pilot, never a background job.
const [bindingPath, queryFile, resumeId, executionMode] = process.argv.slice(2);
if (!bindingPath || !queryFile || (resumeId && !/^[\w-]+$/.test(resumeId)) || (executionMode && executionMode !== '--governed')) throw new Error('binding JSON, query file and optional exact session ID required');
const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
const workspace = join(await realpath(binding.privateStateDir), 'ross-runtime');
const contract = buildPilotContractForRole({ apiUrl: binding.apiUrl, companyId: binding.companyId, projectId: binding.projectId, agentId: binding.agentId, workspace }, binding.role ?? 'ross');
if (new URL(binding.apiUrl).hostname !== '127.0.0.1') throw new Error('this pilot runner requires the explicit local API');
for (const path of [workspace, contract.environment.HOME, contract.environment.HERMES_HOME, contract.environment.HERMES_MANAGED_DIR, contract.environment.TMPDIR]) await mkdir(path, { recursive: true, mode: 0o700 });
const sealPath = join(workspace, 'scope.json');
const scope = { companyId: binding.companyId, projectId: binding.projectId, agentId: binding.agentId };
try { if (JSON.stringify(JSON.parse(await readFile(sealPath, 'utf8'))) !== JSON.stringify(scope)) throw new Error('runtime scope change denied'); }
catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(sealPath, JSON.stringify(scope), { flag: 'wx', mode: 0o600 }); }
const provenance = JSON.parse(await readFile(join(workspace, 'store-provenance.json'), 'utf8'));
if (JSON.stringify(provenance) !== JSON.stringify({ version: 1, scope, journalMode: 'delete', freshStore: true })) throw new Error('fresh private rollback store provenance required');
const query = await readFile(queryFile, 'utf8');
if (!query.trim() || query.length > 40_000) throw new Error('bounded query required');
const apiKeys = executionMode === '--governed' ? null : JSON.parse(await readFile(join(binding.privateStateDir, 'agent-keys.json'), 'utf8'));
const providerFile = await readFile(hermesProviderEnvFile(), 'utf8');
const assignment = providerFile.match(/^\s*(?:export\s+)?GLM_API_KEY\s*=\s*([^\r\n]*)$/m);
const providerKey = assignment?.[1].trim().replace(/^(["'])(.*)\1$/, '$2');
const agentKey = executionMode === '--governed' ? process.env.PAPERCLIP_API_KEY : apiKeys.ROSS_AGENT_API_KEY;
if (!providerKey || !agentKey || /\s|\$\{/.test(providerKey + agentKey)) throw new Error('selected existing credentials unavailable');
const databasePath = join(contract.environment.HERMES_HOME, 'state.db');
let previousMessageId = 0;
const profileModule = pathToFileURL(join(binding.privateStateDir, 'compiled/scripts/ross/inference-profile.js')).href;
const { buildRossInferenceProfile } = await import(profileModule);
const python = contract.inferenceCommand.executable;
// Preserve the installed uv directory alias as in the proven startup harness.
const pythonRoot = dirname(dirname(await readlink(python)));
const profile = buildRossInferenceProfile({ homeDir: homedir(), workspaceDir: workspace, syntheticHomeDir: contract.environment.HOME, readOnlyPaths: [hermesAgentRoot(), pythonRoot], execPaths: [python, process.execPath], egress: 'loopback' }, Number(new URL(binding.apiUrl).port));
const profilePath = join(workspace, 'inference.sb');
const config = { ...contract.config, model: { ...contract.config.model, key_env: 'GLM_API_KEY' }, database: { journal_mode: 'delete' } };
const writeImmutable = async (path, value) => {
  try { await writeFile(path, value, { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; if (await readFile(path, 'utf8') !== value) throw new Error('immutable pilot configuration changed'); }
};
await writeImmutable(profilePath, profile);
await writeImmutable(join(contract.environment.HERMES_HOME, 'config.yaml'), JSON.stringify(config, null, 2) + '\n');
const isolatedQuery = join(workspace, 'query-' + randomUUID() + '.txt');
await writeFile(isolatedQuery, query, { mode: 0o600, flag: 'wx' });
const chatArgs = contract.inferenceCommand.args.slice(3);
chatArgs[chatArgs.indexOf('--query-file') + 1] = isolatedQuery;
const bootstrap = fileURLToPath(new URL('./private-store-bootstrap.py', import.meta.url));
const redact = value => value.replaceAll(providerKey, '[REDACTED]').replaceAll(agentKey, '[REDACTED]');
const started = Date.now();
let { stdout, stderr, failure } = await runOwnedProcess('/usr/bin/sandbox-exec', ['-f', profilePath, python, '-I', '-B', bootstrap, bindingPath, '--', ...chatArgs, ...(resumeId ? ['--resume', resumeId] : [])], {
  cwd: workspace, env: { ...contract.environment, GLM_API_KEY: providerKey, ROSS_AGENT_API_KEY: agentKey }, timeoutMs: 150_000, graceMs: 2_000,
});
stdout = redact(stdout); stderr = redact(stderr);
let storeOwner = null;
if (!failure) {
  storeOwner = JSON.parse(await readFile(join(workspace, 'private-store-owner.json'), 'utf8'));
  if (JSON.stringify(storeOwner.scope) !== JSON.stringify(scope) || !Number.isInteger(storeOwner.pid) || storeOwner.pid <= 0 || !Number.isInteger(storeOwner.group) || storeOwner.group <= 0) throw new Error('actual private owner required');
  for (const id of [storeOwner.pid, -storeOwner.group]) {
    try { process.kill(id, 0); failure = { code: 'private_owner_not_terminal' }; }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
const sessionId = stderr.match(/session_id:\s*([\w-]+)/)?.[1] ?? null;
failure ??= rossSessionFailure(sessionId, resumeId);
if (resumeId && !failure) {
  const snapshot = JSON.parse(await readFile(isolatedQuery + '.resume.json', 'utf8'));
  if (snapshot.resumeId !== resumeId || !Number.isSafeInteger(snapshot.lastMessageId) || snapshot.lastMessageId < 0) throw new Error('lock-held private resume snapshot required');
  previousMessageId = snapshot.lastMessageId;
}
const receipt = { executionMode: executionMode === '--governed' ? 'governed' : 'manual', runId: executionMode === '--governed' ? process.env.PAPERCLIP_RUN_ID : null, storeOwner, recordedAt: new Date().toISOString(), scope, requestedModel: 'glm-5.3-flash', endpoint: 'https://api.z.ai/api/paas/v4', elapsedMs: Date.now() - started, resumeId: resumeId ?? null, sessionId, stdout, stderr, answer: null, failure: failure ?? null, usage: null, querySha256: createHash('sha256').update(query).digest('hex'), profileSha256: createHash('sha256').update(profile).digest('hex'), limits: ['HTTPS permits all443 destinations; endpoint is client-pinned', 'not full filesystem/Mach isolation', 'bounded pilot; no unattended service or voice', 'cooperative private writer lock; no protection from unmanaged same-user store writers', 'installed ledger may omit forced-final-summary usage; cost unknown'] };
if (sessionId && !failure) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    receipt.usage = { session: database.prepare('SELECT id, model, tool_call_count FROM sessions WHERE id = ?').get(sessionId), modelRows: database.prepare('SELECT * FROM session_model_usage WHERE session_id = ?').all(sessionId), cumulativeOnResume: Boolean(resumeId) };
    receipt.answer = redact(database.prepare("SELECT content FROM messages WHERE session_id = ? AND id > ? AND role = 'assistant' AND tool_calls IS NULL AND content <> '' ORDER BY id DESC LIMIT 1").get(sessionId, previousMessageId)?.content ?? '');
  }
  finally { database.close(); }
}
const receiptPath = join(workspace, 'run-' + Date.now() + '.json');
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ receiptPath, ...receipt }, null, 2) + '\n');
if (failure || !sessionId || !receipt.answer?.trim()) process.exitCode = 1;
