#!/usr/bin/env node
// A deterministic executable beneath the real claude_local adapter.
// Real HTTP/tool/memory/approval calls; no actual Claude client or model inference.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { EXPECTED_REPORT, WRONG_REPORT, REPORT_KEY, FIRST_USE_QUESTION, MEMORY_TEXT } from "./contract.mjs";
const env = process.env;
assert.equal(env.PAPERCLIP_E2E_SKIP_LLM, "true");
assert.equal(env.PAPERCLIP_TELEMETRY_DISABLED, "1");
assert.equal(env.FRED_FIXTURE_ENABLED, "true");
assert.ok(env.HOME?.includes("fred-"), "Isolated fixture HOME required");
assert.deepEqual(Object.keys(env).filter(key => /^(ANTHROPIC|OPENAI|MINIMAX|GEMINI|GOOGLE|AWS|AZURE|SENTRY|RESEND|SLACK|STRIPE).*(KEY|TOKEN|SECRET|CREDENTIAL)/i.test(key) && env[key]), []);
assert.ok(env.PAPERCLIP_API_KEY && env.PAPERCLIP_RUN_ID && env.PAPERCLIP_TASK_ID && env.PAPERCLIP_AGENT_ID);
assert.ok(!env.PAPERCLIP_AGENT_JWT_SECRET,"Server signing secret must not be passed to the agent");
const base = new URL(env.PAPERCLIP_API_URL);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));
assert.equal(base.port, env.NATIVE_SERVER_PORT);
const identity = { companyId: env.PAPERCLIP_COMPANY_ID, agentId: env.PAPERCLIP_AGENT_ID, issueId: env.PAPERCLIP_TASK_ID, runId: env.PAPERCLIP_RUN_ID };
const startedAt = new Date().toISOString();
const receipts = [];
const session = randomUUID();
const sanitize = value => Array.isArray(value) ? value.map(sanitize) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !/^(env|apiKey|token|accessToken|refreshToken|secret|authorization)$/i.test(key)).map(([key,val]) => [key,sanitize(val)])) : value;
async function api(method, pathname, body, expected = [200,201]) {
  const toolId = randomUUID();
  console.log(JSON.stringify({ type:"assistant",session_id:session,message:{ role:"assistant",content:[{type:"tool_use",id:toolId,name:"agentdash_http",input:{method,path:pathname}}] } }));
  const response = await fetch(new URL("/api"+pathname,base), { method, headers:{ Authorization:"Bearer "+env.PAPERCLIP_API_KEY,"X-Paperclip-Run-Id":identity.runId,"Content-Type":"application/json" },...(body ? {body:JSON.stringify(body)} : {}) });
  const text = await response.text(); let value;
  try { value=JSON.parse(text); } catch { value=text; }
  const recorded = pathname==="/agents/me" ? {id:value.id,companyId:value.companyId,role:value.role} : sanitize(value);
  receipts.push({at:new Date().toISOString(),method,path:pathname,status:response.status,response:recorded});
  console.log(JSON.stringify({type:"user",session_id:session,message:{role:"user",content:[{type:"tool_result",tool_use_id:toolId,content:JSON.stringify({status:response.status,recorded})}]}}));
  assert.ok(expected.includes(response.status),method+" "+pathname+": "+response.status+" "+text.slice(0,350));
  return value;
}
let scenario, phase;
try {
  // Drain the adapter prompt, record its digest rather than claiming it is a model trace.
  let stdin=""; for await(const chunk of process.stdin) stdin+=chunk;
  const promptSha256=createHash("sha256").update(stdin).digest("hex");
  const me=await api("GET","/agents/me");
  assert.equal(me.id,identity.agentId);assert.equal(me.companyId,identity.companyId);
  const issue=await api("GET","/issues/"+identity.issueId);
  assert.equal(issue.assigneeAgentId,identity.agentId);assert.equal(issue.executionRunId,identity.runId);
  scenario=/fred-case:([a-z-]+)/.exec(issue.description??"")?.[1];
  assert.ok(["correct","wrong","approval","unverified"].includes(scenario),"Only explicit synthetic Fred cases may run");
  await api("POST","/issues/"+identity.issueId+"/checkout",{agentId:identity.agentId,expectedStatuses:["todo","in_progress"]});
  const memoryPath="/companies/"+identity.companyId+"/agents/"+identity.agentId+"/memory";
  const memory=await api("GET",memoryPath);
  if (!memory.memory) await api("PUT",memoryPath,{content:MEMORY_TEXT,expectedVersion:null});
  else assert.match(memory.memory.content,/fred-fixture-continuity-v1/);
  // An actual run-authenticated refusal, not a label asserting least privilege.
  await api("POST","/companies/"+identity.companyId+"/evaluation/agents/"+identity.agentId+"/snapshot",{},[403]);
  if(scenario==="correct") {
    const brief=await api("GET","/companies/"+identity.companyId+"/workforce/brief");
    assert.equal(brief.revision,1);assert.equal(brief.sources[0].id,"fred-source-1");
    const ownerBrief=await api("GET","/issues/"+identity.issueId+"/documents/fred-adoption-brief");
    assert.match(ownerBrief.body,/Reduce client-brief preparation effort/);
    const interactions=await api("GET","/issues/"+identity.issueId+"/interactions");
    const firstUse=interactions.find(row=>row.kind==="ask_user_questions" && row.payload?.questions?.some(question=>question.id==="first-use"));
    if(!firstUse) {
      phase="question";
      await api("POST","/issues/"+identity.issueId+"/interactions",{kind:"ask_user_questions",idempotencyKey:"fred-first-use:"+identity.issueId,sourceRunId:identity.runId,title:"One decision for the first useful job",continuationPolicy:"wake_assignee",payload:{version:1,submitLabel:"Save first-use decision",questions:[{id:"first-use",prompt:FIRST_USE_QUESTION,selectionMode:"text",required:true,options:[]}]}});
      await api("POST","/issues/"+identity.issueId+"/comments",{body:"I checked the approved company source and saved context. One first-use decision is still needed; no deliverable or business outcome is accepted yet."});
    } else {
      phase="continued";
      assert.equal(firstUse.status,"answered");
      assert.ok(firstUse.result?.answers?.some(answer=>answer.questionId==="first-use"&&answer.text?.includes("internal planning review")));
      assert.match(memory.memory?.content??"",/fred-fixture-continuity-v1/,"Continuation must read prior persistent memory");
      await api("PUT","/issues/"+identity.issueId+"/documents/"+REPORT_KEY,{title:"Source-backed adoption recommendation",format:"markdown",body:EXPECTED_REPORT});
      const saved=await api("GET","/issues/"+identity.issueId+"/documents/"+REPORT_KEY);
      assert.equal(saved.body,EXPECTED_REPORT);assert.ok(saved.latestRevisionId);
      await api("POST","/issues/"+identity.issueId+"/work-products",{type:"document",provider:"native",title:"Fred adoption recommendation",status:"ready_for_review",reviewState:"needs_board_review",isPrimary:true,metadata:{documentKey:REPORT_KEY}});
      await api("PATCH","/issues/"+identity.issueId,{status:"done",comment:"The internal adoption recommendation is saved with sources and unknowns. Owner acceptance and business outcomes remain pending."});
    }
  } else if(scenario==="approval") {
    phase="blocked";
    const approval=await api("POST","/companies/"+identity.companyId+"/approvals",{type:"request_board_approval",issueIds:[identity.issueId],payload:{title:"Synthetic outbound action needs owner authority",reason:"No downstream action will execute in this fixture."}});
    await api("POST","/approvals/"+approval.id+"/approve",{decisionNote:"Agent self-approval must be refused"},[403]);
    await api("PATCH","/issues/"+identity.issueId,{status:"blocked",comment:"Owner approval is pending. The downstream action was not executed."});
  } else {
    phase="reported";
    await api("PUT","/issues/"+identity.issueId+"/documents/"+REPORT_KEY,{title:"Adoption recommendation",format:"markdown",body:scenario==="wrong"?WRONG_REPORT:EXPECTED_REPORT});
    await api("GET","/issues/"+identity.issueId+"/documents/"+REPORT_KEY);
    await api("PATCH","/issues/"+identity.issueId,{status:"done",comment:"DONE. All work is excellent and every requirement is satisfied."});
  }
  appendFileSync(env.FRED_FIXTURE_EVIDENCE_DIR+"/runtime-receipts.jsonl",JSON.stringify({...identity,scenario,phase,startedAt,finishedAt:new Date().toISOString(),promptSha256,promptBytes:Buffer.byteLength(stdin),fixtureExecutable:import.meta.url,providerCalls:0,receipts})+"\n");
  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:session,result:phase==="question"?"One owner decision is pending.":scenario==="wrong"?"DONE. Everything is excellent and ready for acceptance.":"The saved work and receipts are available; acceptance is separate.",usage:{input_tokens:0,output_tokens:0},total_cost_usd:0}));
} catch(error) {
  appendFileSync(env.FRED_FIXTURE_EVIDENCE_DIR+"/runtime-receipts.jsonl",JSON.stringify({...identity,scenario,phase,startedAt,finishedAt:new Date().toISOString(),error:String(error),receipts})+"\n");
  console.error(String(error));process.exitCode=1;
}
