import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPilotContractForRole, assertPilotConfigurationText } from './pilot-contract.mjs';
import { buildGovernedInvocation, governedDispatchSignals, assertGovernedRun, assertGovernedCheckout, assertGovernedReceipt, governedRunnerFailureMessage, createGovernedRequest } from './governed-invocation.mjs';
import { runOwnedProcess } from './owned-process.mjs';
import { publishGovernedLeadReport } from './lead-report.mjs';
import { publishGovernedLeadAcknowledgment } from './lead-acknowledgment.mjs';
import { publishGovernedRossReview } from './ross-review.mjs';

// A generated private executable calls this with one fixed binding path.
// No shared registry/install is changed. The outer vendor still supplies an
// ambient environment; only named dispatch fields reach the isolated runner.
export async function runGovernedCli(bindingPath, { diagnosticOnly = false } = {}) {
  let phase = 'setup';
  let dispatchSignals;
  let failureMessage;
  try {
    const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
    const workspace = join(binding.privateStateDir, 'ross-runtime');
    const contract = buildPilotContractForRole({ apiUrl: binding.apiUrl, companyId: binding.companyId, projectId: binding.projectId, agentId: binding.agentId, workspace }, binding.role ?? 'ross');
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--version') {
      phase = 'version';
      assertPilotConfigurationText(await readFile(join(contract.environment.HERMES_HOME,'config.yaml'),'utf8'),contract);
      // Truthful actual CLI version, without keys or network, for static checks.
      const result = await runOwnedProcess('/usr/bin/sandbox-exec', ['-f', join(workspace, 'version.sb'), contract.catalogCommand.executable, ...contract.catalogCommand.args.slice(0, 3), '--version'], { cwd: workspace, env: contract.environment, timeoutMs: 8_000, graceMs: 500 });
      if (result.failure) throw new Error('version probe failed');
      process.stdout.write(result.stdout);
      return;
    }
    phase = 'invocation';
    dispatchSignals = governedDispatchSignals(binding, args, process.env);
    if (diagnosticOnly) {
      // A separately generated private diagnostic executable stops here even
      // when inputs match. It never authenticates, checks out, or infers.
      process.stderr.write('Ross diagnostic-only input checks: ' + JSON.stringify(dispatchSignals) + '\n');
      let accepted = false, reason = 'malformed dispatch';
      try { buildGovernedInvocation(binding, args, process.env); accepted = true; reason = 'accepted'; }
      catch (error) {
        const safe = new Set(['governed chat required', 'unexpected adapter arguments', 'adapter argument value required', 'fixed pilot route and limits required', 'bounded prompt required', 'exact session required', 'matching actual dispatch identity required', 'run JWT required', 'matching unexpired run JWT required']);
        if (safe.has(error.message)) reason = error.message;
      }
      process.stderr.write('Ross diagnostic-only guard result: ' + JSON.stringify({ accepted, reason }) + '\n');
      phase = 'diagnostic';
      throw new Error('diagnostic-only invocation');
    }
    const invocation = buildGovernedInvocation(binding, args, process.env);
    const request = createGovernedRequest(invocation);
    phase = 'actor';
    const actor = await request('/agents/me');
    phase = 'run';
    const run = await request('/heartbeat-runs/' + invocation.runId);
    phase = 'issue';
    const issue = await request('/issues/' + invocation.issueId);
    phase = 'ownership';
    assertGovernedRun(invocation, actor, run, issue);
    phase = 'checkout';
    // One existing governed mutation belongs to the harness, never the model.
    // A 409 or any other denial stops this invocation without a retry.
    const checked = await request('/issues/' + invocation.issueId + '/checkout', { agentId: invocation.scope.agentId, expectedStatuses: ['todo', 'in_progress'] });
    assertGovernedCheckout(invocation, checked);
    const queryPath = join(workspace, 'governed-query-' + invocation.runId + '.txt');
    const answerContract = binding.role === 'lead' && binding.acknowledgment
      ? '\n\nThis is one designated-lead acknowledgment. Freshly read your issue and the referenced Ross issue, one MCP call at a time. Decide accepted or challenged using the actual recommendation, not remembered text. Return only the exact six-field JSON decision requested in the mandate. No code fences or Markdown report. Current runtime UTC: ' + new Date().toISOString() + '. A proposed checkpoint must be future and within48 hours. The runtime records your exact acknowledgment and one unverified commitment; do not attempt writes or claim completion.\n'
      : binding.role === 'lead'
      ? '\n\nYou are the designated project lead. Read the project and existing lead issue evidence, one MCP call at a time. Return a fresh Markdown lead report in at most 350 words, with source links, actual observation times, changed evidence, open commitments and one question/recommendation for Ross. Preserve disagreement and distinguish reported claims from independently verified outcomes. The runtime will publish this exact final report with your actual lead/run attribution. Do not attempt tool writes or task closure.\n'
      : '\n\nThis bounded pilot exposes only two read tools. Request one local MCP call at a time. Give sourced shadow advice in at most 180 words, using full source URLs and exact tool observation times. The runtime will preserve your exact answer as a versioned ross-review document with actual author/run attribution; a comment may contain only a preview. Do not attempt writes, claim task completion, or claim unattended hosting. An acknowledgment is not completion.\n';
    await writeFile(queryPath, invocation.prompt + answerContract, { mode: 0o600, flag: 'wx' });
    phase = 'runner';
    const runnerEnv = { PATH: '/usr/bin:/bin', HOME: contract.environment.HOME, PAPERCLIP_API_KEY: invocation.apiKey, PAPERCLIP_RUN_ID: invocation.runId };
    // The inner runner escalates after 2 seconds; leave it 5 seconds to clean its own group
    // before killing the outer group. The adapter must allow a longer grace.
    const result = await runOwnedProcess(process.execPath, [fileURLToPath(new URL('./run-pilot.mjs', import.meta.url)), bindingPath, queryPath, invocation.resumeId ?? '', '--governed'], { cwd: workspace, env: runnerEnv, timeoutMs: 170_000, graceMs: 5_000 });
    if (result.failure) {
      failureMessage = governedRunnerFailureMessage(result, binding, invocation);
      throw new Error('isolated runner failed');
    }
    phase = 'receipt';
    const receipt = JSON.parse(result.stdout);
    assertGovernedReceipt(receipt, binding);
    let answer=receipt.answer;
    if (binding.role === 'lead' && binding.acknowledgment) {
      phase = 'lead-acknowledgment';
      const publication=await publishGovernedLeadAcknowledgment({binding,invocation,receipt,request,workspace});
      // The exact model JSON already has its own attributed comment. Keep the
      // normal heartbeat comment a qualified receipt rather than a duplicate.
      answer='Lead decision '+publication.decision+' recorded in '+binding.apiUrl+'/issues/'+invocation.issueId+'/comments/'+publication.acknowledgmentCommentId+'. Commitment '+publication.commitmentId+' appended to revision '+publication.revisionNumber+'; outcome verification not performed. No task closure or recurring activation.';
    } else if (binding.role === 'lead') {
      phase = 'lead-publication';
      await publishGovernedLeadReport({ binding, invocation, receipt, request, workspace });
    } else {
      phase = 'ross-publication';
      await publishGovernedRossReview({ binding, invocation, receipt, request, workspace });
    }
    // Only a checked real private session is exposed to the existing parser.
    // Registry metering must subsequently report this exact private ledger.
    process.stdout.write(answer + '\n\nsession_id: ' + receipt.sessionId + '\n');
  } catch {
    // Neither raw credential-bearing env nor upstream response/error bodies are
    // emitted. No session ID on failure, so no manufactured recovery evidence.
    process.stderr.write(failureMessage ?? ('Ross governed invocation failed at ' + phase + '; inspect private operator receipts.\n'));
    if (phase === 'invocation' && dispatchSignals) process.stderr.write('Ross dispatch input checks: ' + JSON.stringify(dispatchSignals) + '\n');
    process.exitCode = 1;
  }
}
