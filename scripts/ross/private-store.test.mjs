import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesAgentRoot } from './local-paths.mjs';
import { fileURLToPath } from 'node:url';
import { runOwnedProcess } from './owned-process.mjs';
const source = fileURLToPath(new URL('./private-store-bootstrap.py', import.meta.url));
const python = join(hermesAgentRoot(), 'venv/bin/python');
const scope = { companyId:'11111111-1111-4111-8111-111111111111', projectId:'22222222-2222-4222-8222-222222222222', agentId:'33333333-3333-4333-8333-333333333333' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'ross-store-lock-'));
  const workspace=join(root,'ross-runtime'), home=join(workspace,'home/.hermes/profiles/ross-pilot');
  await mkdir(home,{recursive:true});
  const binding=join(root,'binding.json');
  await writeFile(binding,JSON.stringify({...scope,privateStateDir:root}));
  await writeFile(join(workspace,'scope.json'),JSON.stringify(scope));
  await writeFile(join(workspace,'store-provenance.json'),JSON.stringify({version:1,scope,journalMode:'delete',freshStore:true}));
  await writeFile(join(home,'config.yaml'),JSON.stringify({database:{journal_mode:'delete'}}));
  return {root,workspace,home,binding};
}
const load = `import importlib.util; s=importlib.util.spec_from_file_location('ross_store',${JSON.stringify(source)}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m);`;
async function invoke(f,tail='print("LOCKED",flush=True)') {
  return runOwnedProcess(python,['-I','-B','-c',load+`m.own_private_store(${JSON.stringify(f.binding)});`+tail],{cwd:f.root,env:{PATH:'/usr/bin:/bin',HOME:f.root,HERMES_HOME:f.home,PYTHON_DOTENV_DISABLED:'1',PYTHONDONTWRITEBYTECODE:'1'},timeoutMs:3000,graceMs:100});
}
test('kernel ownership rejects a second writer and permits reuse only after the prior owner exits',async()=>{
  const f=await fixture(); let holder;
  try {
    holder=spawn(python,['-I','-B','-c',load+`m.own_private_store(${JSON.stringify(f.binding)});print('LOCKED',flush=True);import time;time.sleep(20)`],{cwd:f.root,env:{PATH:'/usr/bin:/bin',HOME:f.root,HERMES_HOME:f.home,PYTHON_DOTENV_DISABLED:'1',PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe'],detached:true});
    await new Promise((resolve,reject)=>{holder.stdout.once('data',resolve);holder.once('exit',()=>reject(new Error('holder exited before lock')));});
    const denied=await invoke(f);
    assert.notEqual(denied.exitCode,0);assert.match(denied.stderr,/private store already owned/);
    const closed=new Promise(resolve=>holder.once('close',resolve)); holder.kill('SIGTERM');await closed;
    const allowed=await invoke(f);assert.equal(allowed.failure,null);assert.match(allowed.stdout,/LOCKED/);
  } finally {if(holder?.exitCode===null){try{process.kill(-holder.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}}await rm(f.root,{recursive:true,force:true});}
});
test('rejects mismatched scope, missing provenance, WAL sidecars and a WAL header without opening Hermes',async()=>{
  const f=await fixture();
  try {
    await writeFile(join(f.workspace,'scope.json'),JSON.stringify({...scope,companyId:scope.agentId}));
    assert.match((await invoke(f)).stderr,/private store scope mismatch/);
    await writeFile(join(f.workspace,'scope.json'),JSON.stringify(scope));
    const provenance=await readFile(join(f.workspace,'store-provenance.json'));
    await rm(join(f.workspace,'store-provenance.json'));
    assert.notEqual((await invoke(f)).exitCode,0);
    await writeFile(join(f.workspace,'store-provenance.json'),provenance);
    await writeFile(join(f.home,'state.db-wal'),'disposable fixture');
    assert.match((await invoke(f)).stderr,/private rollback store required/);
    await rm(join(f.home,'state.db-wal'));
    const header=Buffer.alloc(100);header.write('SQLite format 3\0');header[18]=2;header[19]=2;
    await writeFile(join(f.home,'state.db'),header);
    assert.match((await invoke(f)).stderr,/private rollback store required/);
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('private native guard refuses an owned deleted WAL without inspecting any foreign descriptors', async () => {
  const f=await fixture();
  try {
    const code=`m.install_private_orphan_scan();import hermes_state_dbfile as g;import os
lib=g._darwin_libproc()
class OwnOnly:
 def proc_pidinfo(self,pid,*a):
  assert pid==os.getpid();return lib.proc_pidinfo(pid,*a)
 def proc_pidfdinfo(self,pid,*a):
  assert pid==os.getpid();return lib.proc_pidfdinfo(pid,*a)
 def proc_listpids(self,*a):raise AssertionError('global enumeration forbidden')
g._DARWIN_LIBPROC=OwnOnly()
from hermes_state import DeletedWalGenerationError
base=os.path.join(os.environ['HERMES_HOME'],'disposable-probe.db');fd=os.open(base+'-wal',os.O_CREAT|os.O_RDWR,0o600);os.unlink(base+'-wal')
try:
 try:g.refuse_deleted_wal_generation(base)
 except DeletedWalGenerationError:print('OWNED_ORPHAN_DENIED',flush=True)
 else:raise AssertionError('native orphan refusal was lost')
finally:os.close(fd)
`;
    const result=await invoke(f,code);
    assert.equal(result.failure,null,result.stderr);assert.match(result.stdout,/OWNED_ORPHAN_DENIED/);
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('writer ownership survives the launcher exit until the actual interpreter exits', async () => {
  const f=await fixture(); let owner;
  try {
    const worker=load+`m.own_private_store(${JSON.stringify(f.binding)});import time;time.sleep(20)`;
    const launcher=`import subprocess,os,json,time
p=subprocess.Popen([${JSON.stringify(python)},'-I','-B','-c',${JSON.stringify(worker)}],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
for _ in range(200):
 if os.path.exists(${JSON.stringify(join(f.workspace,'private-store-owner.json'))}):break
 time.sleep(.01)
else:raise RuntimeError('owner did not acquire lock')
print(p.pid,flush=True)
`;
    const result=await runOwnedProcess(python,['-I','-B','-c',launcher],{cwd:f.root,env:{PATH:'/usr/bin:/bin',HOME:f.root,HERMES_HOME:f.home,PYTHON_DOTENV_DISABLED:'1'},timeoutMs:3000,graceMs:100});
    assert.equal(result.failure,null,result.stderr);
    owner=Number(result.stdout.trim()); assert.ok(Number.isInteger(owner)&&owner>0);
    const metadata=JSON.parse(await readFile(join(f.workspace,'private-store-owner.json'),'utf8'));
    assert.equal(metadata.pid,owner);assert.equal(metadata.group,owner);
    assert.match((await invoke(f)).stderr,/private store already owned/);
  } finally {
    if(owner){try{process.kill(-owner,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}}
    await rm(f.root,{recursive:true,force:true});
  }
});

test('actual private SessionDB writes and reopens in rollback mode with no WAL sidecars', async () => {
  const f=await fixture();
  try {
    const prepare=`import sys;sys.path.insert(0,${JSON.stringify(hermesAgentRoot())});m.install_private_orphan_scan();from hermes_state import SessionDB;from pathlib import Path;db=SessionDB(Path(${JSON.stringify(join(f.home,'state.db'))}));`;
    const first=await invoke(f,prepare+`db.create_session('ross-private-fixture','tool',model='glm-5.3-flash');assert db._conn.execute('PRAGMA journal_mode').fetchone()[0]=='delete';db.close();print('WROTE_DELETE',flush=True)`);
    assert.equal(first.failure,null,first.stderr);assert.match(first.stdout,/WROTE_DELETE/);
    const second=await invoke(f,prepare+`assert db.get_session('ross-private-fixture')['model']=='glm-5.3-flash';assert db._conn.execute('PRAGMA journal_mode').fetchone()[0]=='delete';db.close();print('REOPENED_DELETE',flush=True)`);
    assert.equal(second.failure,null,second.stderr);assert.match(second.stdout,/REOPENED_DELETE/);
    assert.deepEqual([...((await readFile(join(f.home,'state.db'))).subarray(18,20))],[1,1]);
    for(const suffix of ['-wal','-shm'])await assert.rejects(readFile(join(f.home,'state.db'+suffix)),{code:'ENOENT'});
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('resume watermark is produced under ownership and rejects a query outside the private workspace', async () => {
  const f=await fixture();
  try {
    const query=join(f.workspace,'query-fixture.txt');await writeFile(query,'fixture');
    const tail=`import sys;sys.path.insert(0,${JSON.stringify(hermesAgentRoot())});m.install_private_orphan_scan();from hermes_state import SessionDB;from pathlib import Path;db=SessionDB(Path(${JSON.stringify(join(f.home,'state.db'))}));db.create_session('ross-resume-fixture','tool');db.append_message('ross-resume-fixture','user','earlier evidence');db.close();m.snapshot_resume(Path(${JSON.stringify(f.home)}),['chat','--resume','ross-resume-fixture','--query-file',${JSON.stringify(query)}]);print('SNAPSHOT',flush=True)`;
    const result=await invoke(f,tail);assert.equal(result.failure,null,result.stderr);
    const snapshot=JSON.parse(await readFile(query+'.resume.json','utf8'));assert.equal(snapshot.resumeId,'ross-resume-fixture');assert.ok(snapshot.lastMessageId>0);
    const foreign=join(f.root,'foreign-query.txt');await writeFile(foreign,'fixture');
    assert.match((await invoke(f,`from pathlib import Path;m.snapshot_resume(Path(${JSON.stringify(f.home)}),['chat','--resume','ross-resume-fixture','--query-file',${JSON.stringify(foreign)}])`)).stderr,/private resume query required/);
  } finally {await rm(f.root,{recursive:true,force:true});}
});
