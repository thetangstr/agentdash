import {readFile} from 'node:fs/promises';
import {reconcileRossCommitments} from './commitment-reconciliation.mjs';
const [bindingPath,storePath,issueId,...extra]=process.argv.slice(2);
if(!bindingPath||!storePath||!issueId||extra.length)throw Error('binding JSON, private store and issue UUID required');
const binding=JSON.parse(await readFile(bindingPath,'utf8'));
const result=await reconcileRossCommitments({apiUrl:binding.apiUrl,companyId:binding.companyId,projectId:binding.projectId,agentId:binding.agentId,apiKey:process.env.ROSS_AGENT_API_KEY,storePath,issueId});
process.stdout.write(JSON.stringify(result,null,2)+'\n');
