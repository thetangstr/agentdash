import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hermesAgentRoot} from './local-paths.mjs';
import {fileURLToPath} from 'node:url';
import {runOwnedProcess} from './owned-process.mjs';
const python=join(hermesAgentRoot(),'venv/bin/python');
const script=fileURLToPath(new URL('./inspect-report-ledger.py',import.meta.url));
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'ross-outcome-ledger-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=join(root,'ross-runtime'),home=join(workspace,'home/.hermes/profiles/ross-pilot');await mkdir(home,{recursive:true,mode:0o700});
  const scope={companyId:'11111111-1111-4111-8111-111111111111',projectId:'22222222-2222-4222-8222-222222222222',agentId:'33333333-3333-4333-8333-333333333333'};
  const binding=join(root,'binding.json');
  for(const [path,value] of [[binding,{...scope,privateStateDir:root}],[join(workspace,'scope.json'),scope],[join(workspace,'store-provenance.json'),{version:1,scope,journalMode:'delete',freshStore:true}],[join(workspace,'private-store-owner.json'),{scope,pid:99999999,group:99999999}],[join(home,'config.yaml'),{database:{journal_mode:'delete'}}]])await writeFile(path,JSON.stringify(value),{mode:0o600});
  await writeFile(join(home,'.ross-writer.lock'),'',{mode:0o600});
  const path=join(home,'state.db'),db=new DatabaseSync(path);
  db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,model TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_name TEXT,tool_call_id TEXT,tool_calls TEXT,timestamp REAL);');
  db.prepare('INSERT INTO sessions VALUES(?,?)').run('selected_session','glm-5.3-flash');
  for(const [session,time] of [['selected_session',10],['selected_session',20],['other_session',20],['selected_session',40]])db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run(session,'tool','bounded evidence',time);
  db.close();await chmod(path,0o600);
  return {root,workspace,home,binding,scope};
}
const invoke=f=>runOwnedProcess(python,['-I','-B',script,f.binding,'selected_session','15','30'],{cwd:f.root,env:{PATH:'/usr/bin:/bin',HOME:f.root},timeoutMs:3000,graceMs:100});
test('reads only the selected successful-run interval under the actual private writer lock',async t=>{
  const f=await fixture(t),before=await readFile(join(f.workspace,'private-store-owner.json')),result=await invoke(f);
  assert.equal(result.exitCode,0,result.stderr);
  const data=JSON.parse(result.stdout);assert.equal(data.lockHeldDuringRead,true);assert.equal(data.ownerTerminal,true);assert.deepEqual(data.scope,f.scope);
  assert.deepEqual(data.messages.map(m=>m.timestamp),[20]);assert.equal(data.messages[0].session_id,'selected_session');
  assert.deepEqual(await readFile(join(f.workspace,'private-store-owner.json')),before,'inspection must preserve writer provenance');
});
test('refuses a live recorded owner without reading its ledger',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'private-store-owner.json'),JSON.stringify({scope:f.scope,pid:process.pid,group:process.pid}));
  const result=await invoke(f);assert.notEqual(result.exitCode,0);assert.match(result.stderr,/owner|terminal|active/);assert.equal(result.stdout,'');
});
test('refuses an independently held writer lock',async t=>{
  const f=await fixture(t),code="import fcntl,sys,time;f=open(sys.argv[1],'r');fcntl.flock(f,fcntl.LOCK_EX);print('LOCKED',flush=True);time.sleep(10)";
  const child=spawn(python,['-I','-B','-c',code,join(f.home,'.ross-writer.lock')],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);});
    const result=await invoke(f);assert.notEqual(result.exitCode,0);assert.match(result.stderr,/owned|lock|active/);assert.equal(result.stdout,'');
  } finally {child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));}
});
test('refuses foreign scope and rollback-store sidecars',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'scope.json'),JSON.stringify({...f.scope,agentId:f.scope.companyId}));
  assert.notEqual((await invoke(f)).exitCode,0);
  await writeFile(join(f.workspace,'scope.json'),JSON.stringify(f.scope));await writeFile(join(f.home,'state.db-wal'),'orphan');
  const result=await invoke(f);assert.notEqual(result.exitCode,0);assert.match(result.stderr,/rollback|WAL|store/);assert.equal(result.stdout,'');
});
test('refuses oversized selected content before materializing it in Python memory',async t=>{
  const f=await fixture(t),db=new DatabaseSync(join(f.home,'state.db'));
  db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run('selected_session','tool','x'.repeat(5_000_000),20);db.close();
  const code="import importlib.util,sys,tracemalloc,json;spec=importlib.util.spec_from_file_location('reader',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);tracemalloc.start()\ntry:m.inspect(sys.argv[2],'selected_session',15,30)\nexcept RuntimeError:print(json.dumps({'refused':True,'peakBytes':tracemalloc.get_traced_memory()[1]}))\nelse:raise RuntimeError('oversized read allowed')";
  const result=await runOwnedProcess(python,['-I','-B','-c',code,script,f.binding],{cwd:f.root,env:{PATH:'/usr/bin:/bin',HOME:f.root},timeoutMs:3000,graceMs:100});
  assert.equal(result.exitCode,0,result.stderr);const observation=JSON.parse(result.stdout);
  assert.equal(observation.refused,true);assert.ok(observation.peakBytes<2_000_000,`oversized row materialized: peak ${observation.peakBytes}`);
  const cli=await invoke(f);assert.notEqual(cli.exitCode,0);assert.equal(cli.stdout,'');
});
