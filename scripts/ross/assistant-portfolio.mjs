import {rossSourceTime} from './commitment-records.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxOutputBytes=1_048_576;
const callTimeoutMs=10_000;
const sourceStatuses=new Set(['ok','needs_clarification','refused','not_found']);

function exactKeys(value,keys,label) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw Error(`exact ${label} shape required`);
}

function boundedString(value,label,limit=200) {
  if(typeof value!=='string'||!value.trim()||value.length>limit)throw Error(`${label} required`);
}

function unavailable(companyId) {
  return {companyId,status:'unavailable',reason:'company-source-unavailable'};
}

function assertWhoami(envelope,companyId,userId) {
  if(!envelope||envelope.isError===true)throw Error('assistant company source unavailable');
  const content=envelope.structuredContent;
  const data=content?.data;
  if(content?.status!=='ok'||data?.user?.userId!==userId||data?.company?.id!==companyId||!Array.isArray(data?.scopes)||!data.scopes.includes('read'))throw Error('assistant company identity mismatch');
}

function assertSourceEnvelope(envelope) {
  if(!envelope||envelope.isError===true||!envelope.structuredContent||typeof envelope.structuredContent!=='object')throw Error('assistant source unavailable');
  const source=envelope.structuredContent;
  if(!sourceStatuses.has(source.status)||typeof source.summary!=='string'||source.summary.length>1000||source.truncated!==false&&source.truncated!==true)throw Error('assistant source malformed');
  rossSourceTime(source.asOf);
  return source;
}

async function callBounded(client,payload) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),callTimeoutMs);
  try {return await Promise.race([
    client.callTool(payload,undefined,{timeout:callTimeoutMs,signal:controller.signal}),
    new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('assistant source timeout')),{once:true})),
  ]);}
  finally {clearTimeout(timer);}
}

function validateConfig({userId,connections}) {
  exactKeys(arguments[0],['userId','connections'],'config');
  boundedString(userId,'userId',200);
  if(!Array.isArray(connections)||connections.length<1||connections.length>10)throw Error('connections 1..10 required');
  const seen=new Set();
  for(const connection of connections) {
    exactKeys(connection,['companyId','client'],'connection');
    if(!uuid.test(connection.companyId))throw Error('bounded UUID companyId required');
    if(seen.has(connection.companyId))throw Error('unique companyId connections required');
    seen.add(connection.companyId);
    if(typeof connection.client?.callTool!=='function')throw Error('client.callTool callable required');
  }
}

function snapshotConfig(config) {
  validateConfig(config);
  return {
    userId:String(config.userId),
    connections:config.connections.map(connection=>({companyId:connection.companyId,client:connection.client})),
  };
}

function validateSelection(selection,connectionByCompany) {
  if(!Array.isArray(selection)||selection.length<1||selection.length>10)throw Error('selection 1..10 required');
  const seen=new Set();
  for(const item of selection) {
    exactKeys(item,['companyId','refs'],'selection');
    if(!uuid.test(item.companyId)||!connectionByCompany.has(item.companyId))throw Error('unknown company scope required');
    if(seen.has(item.companyId))throw Error('unique selected companies required');
    seen.add(item.companyId);
    if(!Array.isArray(item.refs)||item.refs.length<1||item.refs.length>10)throw Error('refs 1..10 required');
    const refs=new Set();
    for(const ref of item.refs) {
      boundedString(ref,'ref',200);
      if(refs.has(ref))throw Error('unique refs required');
      refs.add(ref);
    }
  }
  return selection;
}

function snapshotSelection(selection,connectionByCompany) {
  return validateSelection(selection,connectionByCompany).map(item=>({companyId:item.companyId,refs:[...item.refs]}));
}

async function readCompany({companyId,client,refs,userId}) {
  try {
    assertWhoami(await callBounded(client,{name:'whoami',arguments:{}}),companyId,userId);
    const sources=[];
    for(const ref of refs) sources.push(assertSourceEnvelope(await callBounded(client,{name:'get_work_item',arguments:{ref}})));
    assertWhoami(await callBounded(client,{name:'whoami',arguments:{}}),companyId,userId);
    return {companyId,status:'available',sources,businessOutcomeVerified:false,qualification:'Source envelopes are untrusted assistant-readable AgentDash content; no outcome is independently verified.'};
  } catch {
    return unavailable(companyId);
  }
}

export function createAssistantPortfolioReader(config) {
  const fixed=snapshotConfig(config);
  const connectionByCompany=new Map(fixed.connections.map(connection=>[connection.companyId,connection]));
  return {
    async read(selection) {
      const selected=snapshotSelection(selection,connectionByCompany);
      const companies=[];
      for(const item of selected) {
        const connection=connectionByCompany.get(item.companyId);
        companies.push(await readCompany({companyId:item.companyId,client:connection.client,refs:item.refs,userId:fixed.userId}));
      }
      const result={status:'ok',businessOutcomeVerified:false,coverage:'selected permitted companies/work-items only',consistency:'sequential rechecks; not atomic',companies};
      if(Buffer.byteLength(JSON.stringify(result))>maxOutputBytes)throw Error('assistant portfolio output too large');
      return result;
    },
  };
}
