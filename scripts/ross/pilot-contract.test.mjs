import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRossPilotContract } from './pilot-contract.mjs';

const binding = {
  apiUrl: 'https://example.invalid/api',
  companyId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  agentId: '33333333-3333-4333-8333-333333333333',
  workspace: '/private/tmp/ross-synthetic-contract',
};

test('builds one scoped read-only stdio binding with a secret reference and disabled server-initiated model calls', () => {
  const result = buildRossPilotContract(binding);
  assert.deepEqual(Object.keys(result.config.mcp_servers), ['ross_agentdash']);
  const server = result.config.mcp_servers.ross_agentdash;
  assert.equal(server.env.ROSS_COMPANY_ID, binding.companyId);
  assert.equal(server.env.ROSS_PROJECT_ID, binding.projectId);
  assert.equal(server.env.ROSS_AGENT_ID, binding.agentId);
  assert.equal(server.env.ROSS_API_KEY, '${ROSS_AGENT_API_KEY}');
  assert.deepEqual(server.tools.include, ['ross_project_snapshot', 'ross_issue_evidence']);
  assert.equal(server.tools.prompts, false);
  assert.equal(server.tools.resources, false);
  assert.equal(server.sampling.enabled, false);
  assert.equal(server.elicitation.enabled, false);
  assert.equal(result.config.auxiliary.background_review.enabled, false);
  assert.equal(result.config.compression.enabled, false);
  assert.equal(server.command, process.execPath);
  assert.match(server.args[0], /\/scripts\/ross\/stdio-bridge\.mjs$/);
  assert.equal(server.env.ZAI_API_KEY, undefined);
  assert.equal(server.url, undefined);
  assert.equal(server.auth, undefined);
});

test('builds exact model chat with a private query file, bounded turns/time and isolated source state', () => {
  const result = buildRossPilotContract(binding);
  assert.deepEqual(result.config.model, { default: 'glm-5.3-flash', provider: 'zai', base_url: 'https://api.z.ai/api/paas/v4' });
  assert.deepEqual(result.inferenceCommand.args.slice(-19), ['chat', '--query-file', '/private/tmp/ross-synthetic-contract/ross-query.txt', '--oneshot', '-Q', '-m', 'glm-5.3-flash', '--provider', 'zai', '-t', 'ross_agentdash', '--max-turns', '4', '--run-budget', '120', '--source', 'tool', '--ignore-rules', '--no-restore-cwd']);
  assert.deepEqual(result.config.fallback_providers, []);
  assert.equal(result.environment.GLM_BASE_URL, 'https://api.z.ai/api/paas/v4');
  assert.equal(result.environment.HERMES_HOME, '/private/tmp/ross-synthetic-contract/home/.hermes/profiles/ross-pilot');
  assert.equal(result.environment.HERMES_MANAGED_DIR, '/private/tmp/ross-synthetic-contract/managed-empty');
  assert.equal(result.environment.PYTHON_DOTENV_DISABLED, '1');
  assert.equal(result.environment.ZAI_API_KEY, undefined);
  assert.equal(result.environment.ROSS_AGENT_API_KEY, undefined);
  assert.equal(result.activation, 'not-performed');
  assert.equal(result.authority, 'not-granted-by-contract');
});

test('rejects missing/foreign-shape scope, insecure API origins and arbitrary extra configuration', () => {
  for (const input of [{ ...binding, companyId: '' }, { ...binding, projectId: '../outside' }, { ...binding, apiUrl: 'http://example.com/api' }, { ...binding, workspace: 'relative' }, { ...binding, apiKey: 'do-not-accept-secret-values' }, { ...binding, model: 'other-model' }]) {
    assert.throws(() => buildRossPilotContract(input));
  }
});

test('a fresh answer in a different session cannot satisfy requested recovery', async () => {
  const { rossSessionFailure } = await import('./pilot-contract.mjs');
  assert.deepEqual(rossSessionFailure('fresh-session-with-answer', 'existing-scoped-session'), {
    code: 'resume_session_mismatch', requestedSessionId: 'existing-scoped-session', returnedSessionId: 'fresh-session-with-answer',
  });
  assert.equal(rossSessionFailure('existing-scoped-session', 'existing-scoped-session'), null);
  assert.equal(rossSessionFailure('initial-session', undefined), null);
  assert.equal(rossSessionFailure(null, 'existing-scoped-session').code, 'missing_session_id');
});

test('lead contract reuses exact route and read scope without adopting Ross commitment state', async () => {
  const {buildPilotContractForRole}=await import('./pilot-contract.mjs');
  const lead=buildPilotContractForRole(binding,'lead');
  assert.equal(lead.config.model.default,'glm-5.3-flash');
  assert.deepEqual(lead.config.mcp_servers.ross_agentdash.args.slice(1),['--source-only']);
  assert.deepEqual(lead.config.mcp_servers.ross_agentdash.tools.include,['ross_project_snapshot','ross_issue_evidence']);
  assert.deepEqual(buildPilotContractForRole(binding),buildRossPilotContract(binding));
  assert.throws(()=>buildPilotContractForRole(binding,'arbitrary-role'));
});

test('keyless preflight rejects a sealed configuration prepared for another MCP executable', async () => {
  const {assertPilotConfigurationText}=await import('./pilot-contract.mjs');
  const contract=buildRossPilotContract(binding);
  const config={...contract.config,model:{...contract.config.model,key_env:'GLM_API_KEY'},database:{journal_mode:'delete'}};
  const text=JSON.stringify(config,null,2)+'\n';
  assert.doesNotThrow(()=>assertPilotConfigurationText(text,contract));
  config.mcp_servers.ross_agentdash.command='/different/preparation/node';
  assert.throws(()=>assertPilotConfigurationText(JSON.stringify(config,null,2)+'\n',buildRossPilotContract(binding)),/configuration/);
  assert.throws(()=>assertPilotConfigurationText('{}\n',buildRossPilotContract(binding)),/configuration/);
});
