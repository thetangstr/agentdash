import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const resolve=createRequire(new URL('../../server/package.json',import.meta.url)).resolve;
const workspace=await mkdtemp(join(tmpdir(),'ross-assistant-auth-'));
// No live credentials, database URL, SSO/email, provider, edge or claim config.
const env=Object.fromEntries(['TMPDIR','LANG','TZ'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
env.PATH='/usr/bin:/bin';
Object.assign(env,{NODE_ENV:'test',PAPERCLIP_HOME:workspace,PAPERCLIP_INSTANCE_ID:'ross-isolated-auth-test',BETTER_AUTH_SECRET:randomBytes(32).toString('hex'),AGENTDASH_BILLING_DISABLED:'true',ROSS_ISOLATED_AUTH_TEST:'1',ROSS_AUTH_CERT_DIR:workspace,ROSS_AUTH_CACHE_DIR:join(workspace,'vitest-cache'),NODE_EXTRA_CA_CERTS:join(workspace,'cert.pem')});
try {
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-keyout',join(workspace,'key.pem'),'-out',join(workspace,'cert.pem'),'-days','1','-nodes','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{env,stdio:'pipe'});
 const child=spawn(process.execPath,[resolve('vitest/vitest.mjs'),'run','--config','scripts/ross/assistant-auth-vitest.config.ts'],{cwd:fileURLToPath(new URL('../..',import.meta.url)),env,stdio:'inherit'});
 const code=await new Promise((fulfil,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>signal?reject(Error('isolated test process interrupted')):fulfil(code));});
 process.exitCode=code??1;
}finally {await rm(workspace,{recursive:true,force:true});}
