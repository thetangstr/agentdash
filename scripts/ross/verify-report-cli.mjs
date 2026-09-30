import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRossBridge} from './scoped-bridge.mjs';
import {runOwnedProcess} from './owned-process.mjs';
import {verifyReportPublicationConsumed} from './report-outcome.mjs';
import {hermesAgentRoot} from './local-paths.mjs';

// Explicit operator CLI. No provider, writes, schedule or model tool is exposed.
try {
  const [bindingPath,issueId,commitmentId,runId,commentId,...extra]=process.argv.slice(2);
  if(!bindingPath||!issueId||!commitmentId||!runId||!commentId||extra.length)throw Error('explicit verification references required');
  const binding=JSON.parse(await readFile(bindingPath,'utf8'));
  const config={apiUrl:binding.apiUrl,apiKey:process.env.ROSS_AGENT_API_KEY,companyId:binding.companyId,projectId:binding.projectId,agentId:binding.agentId};
  const bridge=createRossBridge(config);
  const before=await bridge.collectReportOutcome(issueId,commitmentId,runId,commentId);
  const run=before.consumingRun,workspace=join(binding.privateStateDir,'ross-runtime');
  const read=await runOwnedProcess(join(hermesAgentRoot(),'venv/bin/python'),['-I','-B',fileURLToPath(new URL('./inspect-report-ledger.py',import.meta.url)),bindingPath,run.sessionId,String(Date.parse(run.startedAt)/1000),String(Date.parse(run.finishedAt)/1000)],{
    cwd:workspace,env:{PATH:'/usr/bin:/bin',HOME:join(workspace,'home')},timeoutMs:5000,graceMs:500,
  });
  if(read.exitCode!==0||read.failure)throw Error('locked terminal ledger inspection unavailable');
  const ledger=JSON.parse(read.stdout);
  if(ledger.schemaVersion!==1||ledger.sessionId!==run.sessionId||ledger.lockHeldDuringRead!==true||ledger.ownerTerminal!==true||['companyId','projectId','agentId'].some(key=>ledger.scope[key]!==config[key]))throw Error('private ledger scope mismatch');
  const after=await bridge.collectReportOutcome(issueId,commitmentId,runId,commentId);
  // No temporal union: a changed authority/source invalidates this attempt.
  if(JSON.stringify(before)!==JSON.stringify({...after,batch:{...after.batch,observedAt:before.batch.observedAt}}))throw Error('outcome sources changed during inspection');
  const revision=before.batch.sources.find(source=>source.key.startsWith('revision:')&&source.payload.id===before.commitment.reportedDelivery.revisionId)?.payload;
  const check=verifyReportPublicationConsumed({scope:before.batch.scope,commitment:before.commitment,revision,consumingRun:run,answerComment:before.answerComment,messages:ledger.messages});
  console.log(JSON.stringify({schemaVersion:1,criteriaVersion:1,verificationActor:'Codex operator / authenticated Ross source collector',observedAt:new Date().toISOString(),method:'API attribution plus locked terminal private tool ledger',consistency:'sequential-reads-with-post-inspection-recheck',
    check,sources:{commitmentDocument:before.batch.document.source,commitmentDocumentRevisionId:before.batch.document.latestRevisionId,publicationRevision:revision.source,run:run.source,answerComment:before.answerComment.source},
    ledgerSnapshotSha256:createHash('sha256').update(read.stdout).digest('hex'),authority:'No task closure, artifact approval, grant or independent business verification performed.'},null,2));
}catch {
  process.stderr.write('Ross report outcome verification refused; inspect explicit scope, source references and terminal private ledger.\n');
  process.exitCode=1;
}
