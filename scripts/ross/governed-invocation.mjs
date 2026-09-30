const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Failure-only operator metadata: no environment, prompt, claims or key values.
export function governedDispatchSignals(binding, args, env) {
  const value = flag => args[args.indexOf(flag) + 1];
  return {
    chatMode: args[0] === 'chat', modelMatches: value('-m') === 'glm-5.3-flash', providerMatches: value('--provider') === 'zai',
    toolsMatch: value('-t') === 'ross_agentdash', turnsMatch: value('--max-turns') === '4', sourceMatches: value('--source') === 'tool',
    apiUrlMatches: env.PAPERCLIP_API_URL === binding.apiUrl, apiUrlCorruptEnvelope: env.PAPERCLIP_API_URL === '[object Object]',
    companyMatches: env.PAPERCLIP_COMPANY_ID === binding.companyId, agentMatches: env.PAPERCLIP_AGENT_ID === binding.agentId,
    runIdValid: uuid.test(env.PAPERCLIP_RUN_ID ?? ''), taskIdValid: uuid.test(env.PAPERCLIP_TASK_ID ?? ''),
    bearerPresent: Boolean(env.PAPERCLIP_API_KEY), jwtShape: typeof env.PAPERCLIP_API_KEY === 'string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(env.PAPERCLIP_API_KEY),
  };
}

export function buildGovernedInvocation(binding, args, env) {
  if (args[0] !== 'chat') throw new Error('governed chat required');
  const values = {};
  const flags = new Set(['-Q', '--yolo']);
  const fields = new Set(['-q', '-m', '--provider', '-t', '--max-turns', '--source', '--resume']);
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if ((!fields.has(key) && !flags.has(key)) || Object.hasOwn(values, key)) throw new Error('unexpected adapter arguments');
    values[key] = flags.has(key) ? true : args[++i];
    if (!values[key]) throw new Error('adapter argument value required');
  }
  if (values['-m'] !== 'glm-5.3-flash' || values['--provider'] !== 'zai' || values['-t'] !== 'ross_agentdash' || values['--max-turns'] !== '4' || values['--source'] !== 'tool') throw new Error('fixed pilot route and limits required');
  if (typeof values['-q'] !== 'string' || values['-q'].length > 40_000) throw new Error('bounded prompt required');
  if (values['--resume'] && !/^[\w-]+$/.test(values['--resume'])) throw new Error('exact session required');
  if (env.PAPERCLIP_API_URL !== binding.apiUrl || env.PAPERCLIP_COMPANY_ID !== binding.companyId || env.PAPERCLIP_AGENT_ID !== binding.agentId || !env.PAPERCLIP_API_KEY || !uuid.test(env.PAPERCLIP_RUN_ID ?? '') || !uuid.test(env.PAPERCLIP_TASK_ID ?? '')) throw new Error('matching actual dispatch identity required');
  // Claim checks bind the credential to this dispatch; authenticated API reads
  // below verify the signature. Never accept a persistent company-agent key.
  const parts = env.PAPERCLIP_API_KEY.split('.');
  if (env.PAPERCLIP_API_KEY.length > 8192 || parts.length !== 3 || parts.some(part => !/^[\w-]+$/.test(part))) throw new Error('run JWT required');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (header?.alg !== 'HS256' || claims?.sub !== binding.agentId || claims.company_id !== binding.companyId || claims.run_id !== env.PAPERCLIP_RUN_ID || claims.adapter_type !== 'hermes_local' || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) throw new Error('matching unexpired run JWT required');
  return { scope: { companyId: binding.companyId, projectId: binding.projectId, agentId: binding.agentId }, apiUrl: binding.apiUrl, apiKey: env.PAPERCLIP_API_KEY, runId: env.PAPERCLIP_RUN_ID, issueId: env.PAPERCLIP_TASK_ID, prompt: values['-q'], resumeId: values['--resume'] ?? null };
}

export function assertGovernedRun(invocation, actor, run, issue) {
  const { companyId, projectId, agentId } = invocation.scope;
  if (actor.id !== agentId || actor.companyId !== companyId || run.id !== invocation.runId || run.agentId !== agentId || run.companyId !== companyId || run.status !== 'running' || run.contextSnapshot?.issueId !== invocation.issueId || issue.id !== invocation.issueId || issue.companyId !== companyId || issue.projectId !== projectId || issue.assigneeAgentId !== agentId) throw new Error('authenticated running dispatch must own the bound task');
}

export function assertGovernedCheckout(invocation, issue) {
  const { companyId, projectId, agentId } = invocation.scope;
  if (issue.id !== invocation.issueId || issue.companyId !== companyId || issue.projectId !== projectId || issue.assigneeAgentId !== agentId || issue.status !== 'in_progress' || issue.checkoutRunId !== invocation.runId || issue.executionRunId !== invocation.runId) throw new Error('actual run must own the atomic task checkout');
}

export function assertGovernedReceipt(receipt, binding) {
  const rows = receipt.usage?.modelRows;
  if (receipt.failure || !receipt.answer?.trim() || !receipt.sessionId || receipt.requestedModel !== 'glm-5.3-flash' || receipt.endpoint !== 'https://api.z.ai/api/paas/v4' || ['companyId', 'projectId', 'agentId'].some(key => receipt.scope?.[key] !== binding[key]) || !Array.isArray(rows) || !rows.length || rows.some(row => row.session_id !== receipt.sessionId || row.model !== 'glm-5.3-flash' || row.billing_provider !== 'zai' || row.billing_base_url !== receipt.endpoint || row.api_call_count <= 0)) throw new Error('scoped real answer and exact private ledger required');
}

// Diagnose an actual failed inner invocation without forwarding its private
// text. This changes only the operator error; it cannot qualify an answer,
// grant a fallback, publish a review, or manufacture successful usage.
export function governedRunnerFailurePhase(result, binding, invocation) {
  if (result.failure?.code !== 1 || result.exitCode !== 1 || result.signal || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 1_048_576) return 'runner';
  let receipt;
  try { receipt = JSON.parse(result.stdout); }
  catch { return 'runner'; }
  if (!receipt || receipt.executionMode !== 'governed' || receipt.runId !== invocation.runId || receipt.requestedModel !== 'glm-5.3-flash' || receipt.endpoint !== 'https://api.z.ai/api/paas/v4' || ['companyId', 'projectId', 'agentId'].some(key => receipt.scope?.[key] !== binding[key])) return 'runner';
  if (receipt.failure?.code !== 1 || receipt.failure.signal || receipt.answer !== null || receipt.usage !== null || receipt.resumeId !== (invocation.resumeId ?? null) || (invocation.resumeId && receipt.sessionId !== invocation.resumeId)) return 'runner';
  if (typeof receipt.stdout !== 'string' || typeof receipt.stderr !== 'string' || /Traceback|private.*(?:required|mismatch|owned)|bootstrap.*failed/i.test(receipt.stderr)) return 'runner';
  return receipt.stdout.split(/\r?\n/).includes('API call failed after 3 retries: Connection error.') ? 'provider-network' : 'runner';
}

export function governedRunnerFailureMessage(result, binding, invocation) {
  return governedRunnerFailurePhase(result, binding, invocation) === 'provider-network'
    ? 'Ross GLM provider network error; inference unavailable. No new answer was published; prior sourced records remain historical.\n'
    : null;
}

// Harness-owned HTTP, not a model tool. Document CAS needs PUT; checkout
// remains POST. Never disclose upstream bodies or credential-bearing errors.
export function createGovernedRequest(invocation) {
  return async (path, body, method) => {
    const response = await fetch(invocation.apiUrl + path, { method: method ?? (body ? 'POST' : 'GET'), headers: { Authorization: 'Bearer ' + invocation.apiKey, 'X-Paperclip-Run-Id': invocation.runId, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      const error=new Error('dispatch verification denied');
      error.statusCode=response.status;
      throw error;
    }
    const content = await response.text();
    if (Buffer.byteLength(content) > 1_048_576) throw new Error('dispatch response too large');
    return JSON.parse(content);
  };
}
