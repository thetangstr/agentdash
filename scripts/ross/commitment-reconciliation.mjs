import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdir, lstat, realpath, readFile, writeFile, open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {createRossBridge} from './scoped-bridge.mjs';
import {parseCommitmentDocument,rossSourceTime} from './commitment-records.mjs';

const canonical = value => JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a,b) => canonical(a)===canonical(b);
async function privatePath(storePath,binding) {
  if(typeof storePath!=='string'||!storePath.trim())throw Error('explicit private store path required');
  const parent=dirname(resolve(storePath));await mkdir(parent,{recursive:true,mode:0o700});
  const checkFile=async(path,directory=false)=>{
    const stat=await lstat(path);
    if(stat.isSymbolicLink()||stat.uid!==process.getuid()|| (stat.mode&0o077)!==0 || (directory?!stat.isDirectory():!stat.isFile()))throw Error('owner-private store required');
    return stat;
  };
  await checkFile(parent,true);
  const path=join(await realpath(parent),basename(storePath));
  const marker=path+'.ross-scope.json';
  let markerExists=true;try {await checkFile(marker);}catch(e){if(e.code!=='ENOENT')throw e;markerExists=false;}
  for(const suffix of ['-wal','-shm']) {
    try {await lstat(path+suffix);throw Error('rollback store WAL/SHM sidecar refused');}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  try {
    await checkFile(path+'-journal');
    // A bound private rollback journal is SQLite's normal crash-recovery input.
    // Never adopt an orphan from an unknown store on first use.
    if(!markerExists)try {await checkFile(marker);markerExists=true;}catch(e){if(e.code==='ENOENT')throw Error('unbound rollback journal refused');throw e;}
  }catch(e){if(e.code!=='ENOENT')throw e;}
  if(!markerExists) {
    try {
      await lstat(path);
      // Another cooperating initializer may have created both since ENOENT.
      try {await checkFile(marker);markerExists=true;}catch(e){if(e.code==='ENOENT')throw Error('unowned existing database refused');throw e;}
    }catch(e){if(e.code!=='ENOENT')throw e;}
    if(!markerExists)try {await writeFile(marker,canonical({schemaVersion:1,binding})+'\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  }
  await checkFile(marker);
  if(!same(JSON.parse(await readFile(marker,'utf8')),{schemaVersion:1,binding}))throw Error('store scope/origin binding mismatch');
  const fd=await open(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  try {
    const header=Buffer.alloc(100);const {bytesRead}=await fd.read(header,0,100,0);
    if(bytesRead>=20&&(header[18]===2||header[19]===2))throw Error('existing WAL-mode store refused');
  }finally {await fd.close();}
  await checkFile(path);
  return path;
}
function validateBatch(batch,binding) {
  if(!same(batch.scope,binding)||!Array.isArray(batch.records)||!Array.isArray(batch.sources))throw Error('stored batch scope/schema mismatch');
  const decoded=batch.document?parseCommitmentDocument(batch.document.body):{commitments:[]};
  if(batch.records.length!==decoded.commitments.length||batch.records.some((r,i)=>!same(r.commitment,decoded.commitments[i])||!Array.isArray(r.issues)))throw Error('stored commitment content mismatch');
  if(batch.document&&(batch.document.updatedByAgentId!==binding.leadId||batch.document.updatedByUserId||batch.document.companyId!==binding.companyId||batch.document.issueId!==binding.issueId))throw Error('stored document author/scope mismatch');
  for(const s of batch.sources)if(typeof s.key!=='string'||!s.payload||s.payload.companyId!==binding.companyId)throw Error('stored source scope mismatch');
}
function project(batches,asOf) {
  const entries=new Map();let latestDocument=null;
  for(const row of batches) {
    const batch=JSON.parse(row.payload);latestDocument=batch.document;
    const current=new Set(batch.records.map(r=>r.commitment.id));
    for(const [id,prior] of entries)if(!current.has(id))entries.set(id,{...prior,omitted:true,issues:['omitted_from_current_document']});
    for(const record of batch.records) {
      const c=record.commitment;const prior=entries.get(c.id);
      if(prior&&!same(prior.recommendation,c.recommendation))throw Error('commitment recommendation identity changed');
      const history=[...(prior?.history??[]),{batchId:row.id,documentRevision:batch.document?.latestRevisionId??null,decision:c.decision,reportedDelivery:c.reportedDelivery,issues:record.issues}];
      entries.set(c.id,{...c,issues:record.issues,omitted:false,history});
    }
  }
  return [...entries.values()].map(c=>({
    ...c,state:c.issues.length?'unresolved':c.decision==='challenged'?'challenged':c.reportedDelivery?'reported_delivery':'accepted',verified:false,
    acceptanceBasis:'lead-authored typed decision; linked acknowledgment prose not independently interpreted',
    overdue:c.checkpointAt?rossSourceTime(c.checkpointAt)<Date.parse(asOf):null,
    freshness:latestDocument?{state:Date.parse(asOf)-rossSourceTime(latestDocument.updatedAt)>3_600_000?'stale':'current',updatedAt:latestDocument.updatedAt}:{state:'missing',updatedAt:null},
  }));
}

// No arbitrary append or unauthenticated cached-read entry point is exported.
export async function reconcileRossCommitments(config) {
  const {storePath,issueId,apiKey,...bindingConfig}=config;
  const batch=await createRossBridge({...bindingConfig,apiKey}).collectCommitments(issueId);
  const binding=batch.scope;const path=await privatePath(storePath,binding);
  const db=new DatabaseSync(path);
  let transaction=false;
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    db.exec('BEGIN IMMEDIATE');transaction=true;
    db.exec('CREATE TABLE IF NOT EXISTS ross_meta (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ross_sources (key TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ross_batches (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL, observed_at TEXT NOT NULL);');
    const meta=db.prepare('SELECT binding FROM ross_meta WHERE id=1').get();
    if(meta&&!same(JSON.parse(meta.binding),binding))throw Error('database scope binding mismatch');
    if(!meta)db.prepare('INSERT INTO ross_meta(id,binding) VALUES(1,?)').run(canonical(binding));
    const prior=db.prepare('SELECT id,hash,payload FROM ross_batches ORDER BY id').all();
    if(prior.length>=1000)throw Error('bounded pilot batch limit reached');
    for(const row of prior){const parsed=JSON.parse(row.payload);if(digest(parsed)!==row.hash)throw Error('stored batch integrity mismatch');validateBatch(parsed,binding);}
    for(const row of db.prepare('SELECT key,hash,payload FROM ross_sources').all())if(digest(JSON.parse(row.payload))!==row.hash)throw Error('stored source integrity mismatch');
    const {observedAt,...payload}=batch;validateBatch(payload,binding);
    const highestRevision=prior.map(r=>JSON.parse(r.payload).document).filter(d=>d&&d.id===batch.document?.id).reduce((max,d)=>Math.max(max,d.latestRevisionNumber),0);
    if(batch.document&&batch.document.latestRevisionNumber<highestRevision)throw Error('commitment document revision regression');
    for(const s of payload.sources) {
      const hash=digest(s.payload);const old=db.prepare('SELECT hash FROM ross_sources WHERE key=?').get(s.key);
      if(old&&old.hash!==hash)throw Error('immutable source version conflict');
      if(!old)db.prepare('INSERT INTO ross_sources(key,hash,payload) VALUES(?,?,?)').run(s.key,hash,canonical(s.payload));
    }
    // Only consecutive identical observations are redelivery. A -> missing -> A
    // must retain the recovery transition even though its content hash repeats.
    const hash=digest(payload);const old=prior.at(-1)?.hash===hash?prior.at(-1):null;
    if(!old)db.prepare('INSERT INTO ross_batches(hash,payload,observed_at) VALUES(?,?,?)').run(hash,canonical(payload),observedAt);
    const all=db.prepare('SELECT id,hash,payload FROM ross_batches ORDER BY id').all();
    const commitments=project(all,observedAt);
    const sourceCount=db.prepare('SELECT count(*) AS n FROM ross_sources').get().n;
    db.exec('COMMIT');transaction=false;
    return {scope:binding,observedAt,consistency:batch.consistency,verified:false,commitments,batchCount:all.length,sourceCount,deduplicated:Boolean(old),storePath:path};
  } finally {if(transaction)db.exec('ROLLBACK');db.close();}
}
