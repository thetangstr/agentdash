import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import * as governed from './governed-invocation.mjs';

test('actual governed HTTP preserves PUT for publication and POST for checkout with run authentication',async t=>{
 const seen=[];
 const server=createServer(async(req,res)=>{let body='';for await(const bytes of req)body+=bytes;seen.push({method:req.method,path:req.url,authorization:req.headers.authorization,runId:req.headers['x-paperclip-run-id'],body:body?JSON.parse(body):null});res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const invocation={apiUrl:`http://127.0.0.1:${server.address().port}/api`,apiKey:'synthetic-governed-JWT',runId:'actual-synthetic-run'};
 const request=governed.createGovernedRequest(invocation);
 await request('/agents/me');await request('/issues/task/checkout',{agentId:'lead'});await request('/issues/task/documents/lead-report',{format:'markdown',body:'exact report',baseRevisionId:'prior'},'PUT');
 assert.deepEqual(seen.map(row=>[row.method,row.path]),[['GET','/api/agents/me'],['POST','/api/issues/task/checkout'],['PUT','/api/issues/task/documents/lead-report']]);
 assert.ok(seen.every(row=>row.authorization==='Bearer synthetic-governed-JWT'&&row.runId===invocation.runId));
 assert.equal(seen[2].body.body,'exact report');
});

test('HTTP denial exposes only a safe status so missing documents cannot be confused with revoked access',async t=>{
 const server=createServer((req,res)=>res.writeHead(404,{'Content-Type':'application/json'}).end(JSON.stringify({error:'private upstream body must remain hidden'})));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=governed.createGovernedRequest({apiUrl:`http://127.0.0.1:${server.address().port}/api`,apiKey:'synthetic',runId:'synthetic'});
 await assert.rejects(()=>request('/issues/task/documents/ross-commitments'),error=>error.statusCode===404&&error.message==='dispatch verification denied'&&!String(error).includes('private upstream body'));
});
