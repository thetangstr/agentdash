#!/usr/bin/env node
// Offline owner workflow + normal claude_local execution. Never a live-model/client benchmark.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { EXPECTED_REPORT, REPORT_KEY, FIRST_USE_QUESTION } from "../tests/e2e/fixtures/fred/contract.mjs";
import { assertFixtureStorage } from "../tests/e2e/fixtures/fred/storage-guard.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const args=process.argv.slice(2);
const option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const port=Number(option("--port","3491"));
const dbPort=Number(option("--db-port","23491"));
assert.ok(port>=3400&&port<=4999&&dbPort>=23000&&dbPort<=29999,"Isolated fixture port ranges required");
const scratchRoot=option("--scratch-root",process.env.TMPDIR);
const evidenceArg=option("--evidence-dir",null);
const reuseHome=option("--reuse-home",null);
if(args.includes("--describe")) {
  console.log(JSON.stringify({base:"http://127.0.0.1:"+port,dbPort,uiMode:"actual source UI",database:"new synthetic embedded PostgreSQL",provider:"deterministic executable under normal claude_local adapter; no actual Claude client/model",cases:["correct","wrong","approval","missing","unverified"],noStartOnPageOrSetup:true,requiresExplicitScratch:true}));
  process.exit(0);
}
assert.ok(scratchRoot&&evidenceArg,"Provide registered external --scratch-root and retained --evidence-dir");
assert.ok(fs.existsSync(scratchRoot),"Scratch root must already exist; do not recreate a disconnected storage link");
const disk=fs.statfsSync(scratchRoot);
const freeGiB=Number(disk.bavail)*Number(disk.bsize)/1024**3;
assert.ok(freeGiB>=(reuseHome?30.10:30.35),reuseHome?"At least30.10GiB free required for explicitly owned existing-cluster reuse":"At least30.35GiB free required before allocating the one fixture cluster");
const evidence=path.resolve(evidenceArg);
fs.mkdirSync(evidence,{recursive:true,mode:0o700});
const hash=value=>createHash("sha256").update(value).digest("hex");
const write=(name,value)=>fs.writeFileSync(path.join(evidence,name),JSON.stringify(value,null,2)+"\n",{mode:0o600});
const startedAt=new Date().toISOString();
const storageSamples=[];
const checkStorage=()=>{
 const current=fs.statfsSync(scratchRoot);
 const freeBytes=Number(current.bavail)*Number(current.bsize);
 storageSamples.push({at:new Date().toISOString(),freeBytes,freeGiB:freeBytes/1024**3});
 write("storage-receipts.json",storageSamples);
 assertFixtureStorage({initialFreeBytes:freeGiB*1024**3,freeBytes,reused:Boolean(reuseHome)});
};
const sourceFiles=["scripts/fred-runtime.mjs","tests/e2e/fixtures/fred/server.mts","tests/e2e/fixtures/fred/claude.mjs","tests/e2e/fixtures/fred/contract.mjs","tests/e2e/fixtures/fred/rubric.json","tests/e2e/fixtures/fred/network-fence.mjs","tests/e2e/fixtures/native-evaluation/network-fence.mjs","server/src/services/fred.ts","server/src/routes/fred.ts","ui/src/pages/Fred.tsx","packages/shared/src/fred.ts"];
const sourceManifest=()=>{
 const changed=execFileSync("git",["diff","--name-only","ef629a00478e0ee2b7271734a140114081089bbc"],{cwd:root,encoding:"utf8"}).trim().split("\n");
 const untracked=execFileSync("git",["ls-files","--others","--exclude-standard"],{cwd:root,encoding:"utf8"}).trim().split("\n");
 return [...new Set([...sourceFiles,...changed,...untracked])].filter(file=>file&&fs.existsSync(path.join(root,file))&&fs.statSync(path.join(root,file)).isFile()).sort().map(file=>({file,sha256:hash(fs.readFileSync(path.join(root,file)))}));
};
const initialSources=sourceManifest();
write("source-manifest-start.json",{capturedAt:startedAt,files:initialSources,freeGiB,allocationClass:reuseHome?"exact-owned-synthetic-cluster-reuse":"fresh-synthetic-cluster",actualTargetClient:"not exercised",humanCalibration:"pending"});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function portFree(value) { const socket=net.createServer();await new Promise((resolve,reject)=>socket.once("error",reject).listen(value,"127.0.0.1",resolve));await new Promise(resolve=>socket.close(resolve)); }
for(const value of [port,dbPort,port+10000]) await portFree(value);
const home=reuseHome?path.resolve(reuseHome):fs.mkdtempSync(path.join(path.resolve(scratchRoot),"fred-"));
const markerPath=path.join(home,"fred-fixture-owned.json");
if(reuseHome) {
 const marker=JSON.parse(fs.readFileSync(markerPath,"utf8"));
 const actual=fs.realpathSync(home),scratch=fs.realpathSync(scratchRoot);
 assert.ok(actual.startsWith(scratch+path.sep)&&path.basename(actual).startsWith("fred-"));
 assert.equal(marker.kind,"fred-runtime-fixture/1");assert.equal(marker.homeRealpath,actual);
 assert.equal(marker.uid,process.getuid());assert.equal(fs.statSync(home).uid,process.getuid());assert.equal(fs.statSync(home).mode&0o077,0);
 assert.equal(marker.dbPort,dbPort);assert.ok(Array.isArray(marker.companyIds));
 const oldConfig=JSON.parse(fs.readFileSync(path.join(home,"config.json"),"utf8"));
 assert.equal(oldConfig.database.mode,"embedded-postgres");assert.equal(oldConfig.database.connectionString,undefined);
 assert.deepEqual(oldConfig.server,{deploymentMode:"local_trusted",exposure:"private",bind:"loopback",host:"127.0.0.1",port,serveUi:true});
 assert.equal(oldConfig.storage.provider,"local_disk");assert.equal(oldConfig.storage.localDisk.baseDir,path.join(home,"storage"));
 assert.equal(oldConfig.secrets.provider,"local_encrypted");assert.equal(oldConfig.secrets.localEncrypted.keyFilePath,path.join(home,"key"));
 assert.equal(oldConfig.database.embeddedPostgresPort,dbPort);assert.equal(fs.realpathSync(oldConfig.database.embeddedPostgresDataDir),fs.realpathSync(path.join(home,"pg")));
 assert.equal(fs.statSync(path.join(home,"config.json")).mode&0o077,0);
 assert.ok(!fs.existsSync(path.join(home,"pg/postmaster.pid")),"Prior owned PostgreSQL must be stopped");
 fs.copyFileSync(path.join(home,"config.json"),path.join(evidence,"prior-private-config.json"));
} else fs.writeFileSync(markerPath,JSON.stringify({kind:"fred-runtime-fixture/1",homeRealpath:fs.realpathSync(home),uid:process.getuid(),dbPort,companyIds:[],createdAt:startedAt}),{mode:0o600});
const bin=path.join(home,"bin");fs.mkdirSync(bin,{recursive:true});
const link=(target,file)=>{if(fs.existsSync(file))assert.equal(fs.realpathSync(file),fs.realpathSync(target));else fs.symlinkSync(target,file);};
link(process.execPath,path.join(bin,"node"));
const denied=path.join(bin,"deny-provider");
fs.writeFileSync(denied,'#!/bin/sh\nprintf "%s\\n" "Provider executable disabled by Fred fixture" >&2\nexit 97\n',{mode:0o700});
for(const name of ["claude","codex","hermes","gemini","opencode","pi","cursor","agent","acpx","openclaw","curl","wget"]) link(denied,path.join(bin,name));
const config=path.join(home,"config.json");
fs.writeFileSync(config,JSON.stringify({$meta:{version:1,updatedAt:startedAt,source:"onboard"},database:{mode:"embedded-postgres",embeddedPostgresDataDir:path.join(home,"pg"),embeddedPostgresPort:dbPort,backup:{enabled:false}},logging:{mode:"file",logDir:path.join(home,"logs")},server:{deploymentMode:"local_trusted",exposure:"private",bind:"loopback",host:"127.0.0.1",port,serveUi:true},telemetry:{enabled:false},secrets:{provider:"local_encrypted",strictMode:false,localEncrypted:{keyFilePath:path.join(home,"key")}},storage:{provider:"local_disk",localDisk:{baseDir:path.join(home,"storage")}}}),{mode:0o600});
const fence=path.join(root,"tests/e2e/fixtures/fred/network-fence.mjs");
const env={
 HOME:home,PATH:bin+":/usr/bin:/bin:/usr/sbin:/sbin",TMPDIR:home,LANG:"en_US.UTF-8",TERM:"dumb",
 PAPERCLIP_HOME:path.join(home,"p"),PAPERCLIP_INSTANCE_ID:"fred",PAPERCLIP_CONFIG:config,PORT:String(port),
 PAPERCLIP_DEPLOYMENT_MODE:"local_trusted",PAPERCLIP_DEPLOYMENT_EXPOSURE:"private",PAPERCLIP_BIND:"loopback",
 PAPERCLIP_UI_DEV_MIDDLEWARE:"true",SERVE_UI:"true",PAPERCLIP_E2E_SKIP_LLM:"true",PAPERCLIP_TELEMETRY_DISABLED:"1",DO_NOT_TRACK:"1",
 PAPERCLIP_DB_BACKUP_ENABLED:"false",HEARTBEAT_SCHEDULER_ENABLED:"false",RUN_HEALER_ENABLED:"false",
 AGENTDASH_EVALUATION_INGEST_ENABLED:"false",AGENTDASH_EVALUATION_SNAPSHOT_ENABLED:"false",AGENTDASH_DIGEST_ENABLED:"false",
 AGENTDASH_BILLING_DISABLED:"true",AGENTDASH_RATE_LIMIT_DISABLED:"true",AGENTDASH_ADAPTER_ENV_BYPASS:"true",
 AGENTDASH_ALLOW_MULTI_COMPANY:"true",AGENTDASH_DEFAULT_ADAPTER:"claude_local",
 AGENTDASH_CODEX_COMMAND:denied,AGENTDASH_HERMES_COMMAND:denied,
 PAPERCLIP_MIGRATION_PROMPT:"never",PAPERCLIP_MIGRATION_AUTO_APPLY:"true",
 NATIVE_SERVER_PORT:String(port),FRED_FIXTURE_DB_PORT:String(dbPort),NATIVE_EVIDENCE_DIR:evidence,FRED_FIXTURE_EVIDENCE_DIR:evidence,FRED_FIXTURE_ENABLED:"true",
 NODE_OPTIONS:"--import="+fence,
 PAPERCLIP_AGENT_JWT_SECRET:randomBytes(32).toString("hex"),
 ...(reuseHome?{FRED_FIXTURE_REUSE:"true"}:{}),
};
const tsx=path.join(root,"node_modules/tsx/dist/cli.mjs");
const log=fs.openSync(path.join(evidence,"server.log"),"a",0o600);
const entry=path.join(root,"tests/e2e/fixtures/fred/server.mts");
const server=spawn(process.execPath,[tsx,entry],{cwd:home,env,stdio:["ignore",log,log],detached:true});
const base="http://127.0.0.1:"+port;
write("server.json",{pid:server.pid,base,home,config,startedAt,command:[process.execPath,tsx,entry],environmentKeys:Object.keys(env),environmentHash:hash(JSON.stringify(env)),fixtureOwner:"local-board (scripted simulation, not human review)",providerCommands:"fail-fast shims",networkPolicy:"Node TCP/fetch loopback only; not a full host sandbox",databaseDataDir:path.join(home,"pg"),dbPort});
let browser,success=false;
const consoleErrors=[],blockedBrowserRequests=[],uiActions=[],raw=[];
const sanitize=value=>Array.isArray(value)?value.map(sanitize):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).filter(([key])=>!/^(env|apiKey|token|accessToken|refreshToken|secret|authorization)$/i.test(key)).map(([key,val])=>[key,sanitize(val)])):value;
try {
 let healthy=false;
 for(let i=0;i<180;i++) { checkStorage();if(server.exitCode!==null)throw Error("Server exited "+server.exitCode);try{const res=await fetch(base+"/api/health");if(res.ok){healthy=true;break;}}catch{} await wait(1000); }
 assert.ok(healthy,"Isolated source server did not become healthy");
 if(args.includes("--start-only")) { success=true;write("fixture-location.json",{base,home,pid:server.pid,owner:"local-board (automated)",auth:"local_trusted, no credential"});console.log(JSON.stringify({base,evidence,home,pid:server.pid}));server.unref();process.exit(0); }
 const executable=option("--browser",null);
 browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.route("**/*",route=>{const url=new URL(route.request().url());if(url.hostname==="127.0.0.1")return route.continue();blockedBrowserRequests.push({host:url.hostname,path:url.pathname});return route.abort();});
 const page=await context.newPage();page.on("pageerror",error=>consoleErrors.push(String(error)));
 write("browser.json",{version:browser.version(),executablePath:executable??chromium.executablePath()});
 async function api(method,url,body,expected=[200,201]) {
  checkStorage();
  const response=await context.request.fetch(base+"/api"+url,{method,...(body?{data:body}:{})});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  raw.push({at:new Date().toISOString(),method,url,status:response.status(),response:sanitize(data)});
  write("owner-api-receipts.json",raw);
  assert.ok(expected.includes(response.status()),method+" "+url+": "+response.status()+" "+text.slice(0,500));
  return data;
 }
 async function uiAction(label,action) { checkStorage();const from=new Date().toISOString();await action();uiActions.push({label,startedAt:from,finishedAt:new Date().toISOString()});write("browser-action-receipts.json",uiActions);checkStorage(); }
 const runsFor=async(agentId,issueId)=>{const all=await api("GET","/companies/"+companyId+"/heartbeat-runs?agentId="+agentId+"&limit=100");return all.filter(row=>row.contextSnapshot?.issueId===issueId||row.contextSnapshot?.taskId===issueId);};
 const terminal=run=>["succeeded","failed","timed_out","cancelled"].includes(run.status);
 async function finishedRuns(agentId,issueId,count) {let observed=[];for(let i=0;i<120;i++){observed=await runsFor(agentId,issueId);assert.ok(observed.length<=count,"Unexpected duplicate execution");if(observed.length===count&&observed.every(terminal))return observed;await wait(500);}throw Error("Expected "+count+" terminal runs: "+JSON.stringify(observed));}

 await page.goto(base+"/company-create"+(reuseHome?"?another=1":""));
 await uiAction("Name synthetic company",()=>page.getByLabel("Workspace name").fill("Synthetic Fred proof "+Date.now()));
 await uiAction("Create synthetic company",()=>page.getByRole("button",{name:"Continue",exact:true}).click());
 await page.waitForURL(/\/setup\?companyId=/,{timeout:30000});
 const companyId=new URL(page.url()).searchParams.get("companyId");
 const company=await api("GET","/companies/"+companyId);
 const marker=JSON.parse(fs.readFileSync(markerPath,"utf8"));
 if(!marker.companyIds.includes(companyId)){marker.companyIds.push(companyId);fs.writeFileSync(markerPath,JSON.stringify(marker),{mode:0o600});}
 await api("PUT","/companies/"+companyId+"/workforce/brief",{expectedRevision:0,sources:[{id:"fred-source-1",label:"Shared synthetic company brief",content:"Synthetic company provides internal client-brief preparation. Only approved company information may be used. No outreach, new access, purchases or private customer records are authorized."}],facts:[{key:"offer",value:"Internal client-brief preparation",sourceReference:"fred-source-1"}]});
 await page.goto(base+"/"+company.issuePrefix+"/company/fred");
 await page.getByRole("heading",{name:"Meet Fred",exact:true}).waitFor();
 await uiAction("Choose Claude Code fixture runtime",()=>page.getByLabel("Fred runtime",{exact:true}).selectOption("claude_local"));
 await uiAction("Set explicit model budget",()=>page.getByLabel("Monthly model budget in dollars",{exact:true}).fill("10"));
 await uiAction("Consent to company-shared Fred setup",()=>page.getByLabel("Share Fred’s brief and discovery thread with this company",{exact:true}).check());
 await uiAction("Set up Fred without starting work",()=>page.getByRole("button",{name:"Set up Fred",exact:true}).click());
 await page.getByRole("heading",{name:"Ready for discovery",exact:true}).waitFor({timeout:30000});
 let workspace=await api("GET","/companies/"+companyId+"/fred");
 assert.equal(workspace.registration.state,"ready");assert.equal(workspace.issue.status,"backlog");assert.equal(workspace.latestRun,null);
 const agentId=workspace.agent.id,mainIssue=workspace.issue,registrationId=workspace.registration.id;
 if(workspace.agent.status==="pending_approval") {
  const approvals=await api("GET","/companies/"+companyId+"/approvals?status=pending");
  const hire=approvals.find(row=>row.type==="hire_agent"&&row.payload?.agentId===agentId);
  assert.ok(hire,"Governed Fred setup must retain its native approval");
  await api("POST","/approvals/"+hire.id+"/approve",{decisionNote:"Scripted local fixture approval for Fred setup, not a human calibration label"});
 }
 const initial=await api("GET","/agents/"+agentId);
 assert.equal(initial.adapterConfig.dangerouslySkipPermissions,false);
 assert.equal(initial.runtimeConfig.heartbeat.enabled,false);
 assert.equal(initial.runtimeConfig.heartbeat.wakeOnDemand,false);
 const command=path.join(root,"tests/e2e/fixtures/fred/claude.mjs");
 await api("PATCH","/agents/"+agentId,{adapterConfig:{...initial.adapterConfig,command,cwd:home,timeoutSec:60,model:"deterministic-fred-fixture",env:{HOME:home,PATH:env.PATH,PAPERCLIP_E2E_SKIP_LLM:"true",PAPERCLIP_TELEMETRY_DISABLED:"1",FRED_FIXTURE_ENABLED:"true",NATIVE_SERVER_PORT:String(port),NATIVE_EVIDENCE_DIR:evidence,FRED_FIXTURE_EVIDENCE_DIR:evidence,NODE_OPTIONS:env.NODE_OPTIONS}}});
 const configured=await api("GET","/agents/"+agentId);
 const instructionPath=configured.adapterConfig.instructionsFilePath;
 assert.ok(instructionPath&&fs.realpathSync(instructionPath).startsWith(fs.realpathSync(home)+path.sep));
 const materialized=()=>{const value=fs.readFileSync(instructionPath,"utf8");assert.ok(value.startsWith("# Fred — AgentDash FDE\n"),"Fred's managed mandate must remain present");return{file:instructionPath,sha256:hash(value),bytes:Buffer.byteLength(value)};};
 const initialInstructions=materialized();write("materialized-instructions.json",{beforeProfile:initialInstructions});
 const profileBase="/companies/"+companyId+"/agents/"+agentId+"/profile";
 const draft=await api("POST",profileBase+"/revisions",{});
 const criterion={kind:"record",record:"document.sha256:"+REPORT_KEY+":"+hash(EXPECTED_REPORT)};
 const responsibility=(key,checks)=>({key,title:key,outcome:"A source-backed adoption recommendation",stakeholders:[],obligation:{kind:"assigned"},deliverable:{what:"An internal recommendation with approved sources and unknowns",destination:"Saved native discovery report"},escalation:{when:"Approval or proof is missing"},performance:{criteria:checks.map((check,index)=>({id:key+"-"+index,text:"Observable persisted proof",source:"human",check})),coverage:[],outcomeLinks:[],expectedHumanSteps:[],judges:{automated:[]}}});
 const body={...draft.body,responsibilities:[responsibility("adoption-proof",[criterion]),responsibility("adoption-pending",[criterion,{kind:"record",record:"unsupported.external-quality"}])]};
 const saveResponse=await context.request.patch(base+"/api"+profileBase+"/revisions/"+draft.id,{headers:{"If-Match":draft.bodyHash},data:{body,provenance:{"/responsibilities":{state:"owner_confirmed"}}}});
 assert.ok(saveResponse.ok(),await saveResponse.text());const savedProfile=await saveResponse.json();
 raw.push({at:new Date().toISOString(),method:"PATCH",url:profileBase+"/revisions/"+draft.id,status:saveResponse.status(),response:sanitize(savedProfile),origin:"scripted synthetic owner rubric setup"});write("owner-api-receipts.json",raw);
 const proposal=await api("POST",profileBase+"/revisions/"+draft.id+"/propose",{});
 await api("POST","/approvals/"+proposal.approvalId+"/approve",{decisionNote:"Automated local fixture approval, not genuine human calibration"});
 let applied;
 for(let i=0;i<40;i++){applied=await api("GET",profileBase);if(applied.active?.id===draft.id)break;await wait(250);}
 assert.equal(applied.active?.id,draft.id);
 const afterProfileInstructions=materialized();
 write("materialized-instructions.json",{beforeProfile:initialInstructions,afterProfile:afterProfileInstructions});
 await api("POST","/companies/"+companyId+"/issues/"+mainIssue.id+"/responsibility",{agentId,responsibilityKey:"adoption-proof"});
 assert.equal((await api("GET","/companies/"+companyId+"/heartbeat-runs?agentId="+agentId+"&limit=100")).length,0,"Setup, profiles and page views must not dispatch");

 await page.reload();await page.getByRole("heading",{name:"Adoption brief",exact:true}).waitFor();
 await uiAction("Set customer goal",()=>page.getByLabel("Customer goal",{exact:true}).fill("Reduce client-brief preparation effort"));
 await uiAction("Choose one useful job",()=>page.getByLabel("First useful job",{exact:true}).fill("fred-case:correct\nDraft one sourced internal client brief"));
 await uiAction("Define acceptance criteria",()=>page.getByLabel("Success criteria",{exact:true}).fill("Cite the approved company source.\nList unresolved questions and next owner decision.\nDo not claim owner acceptance or ROI."));
 await uiAction("Set outcome observation window",()=>page.getByLabel("When to check the outcome",{exact:true}).fill("After the first recommendation is used"));
 await uiAction("Define boundaries",()=>page.getByLabel("Boundaries and approvals",{exact:true}).fill("Internal recommendation only. No outreach, purchases or new access."));
 await uiAction("Confirm shared adoption brief",()=>page.getByLabel("Confirm this adoption brief is company-shared",{exact:true}).check());
 await uiAction("Save versioned adoption brief",()=>page.getByRole("button",{name:"Save adoption brief",exact:true}).click());
 await page.getByText("Saved revision 1",{exact:true}).waitFor();
 workspace=await api("GET","/companies/"+companyId+"/fred");
 assert.equal(workspace.brief.revision,1);assert.ok(workspace.brief.documentRevisionId);assert.equal(workspace.brief.baseline,"");assert.equal(workspace.latestRun,null);
 await page.screenshot({path:path.join(evidence,"01-fred-before-start.png"),fullPage:true});
 await uiAction("Explicitly start discovery",()=>page.getByRole("button",{name:"Start discovery",exact:true}).click());
 let interaction;
 for(let i=0;i<120;i++){const values=await api("GET","/issues/"+mainIssue.id+"/interactions");interaction=values.find(row=>row.kind==="ask_user_questions");if(interaction)break;await wait(500);}
 assert.ok(interaction,"Native owner question required");
 await finishedRuns(agentId,mainIssue.id,1);
 await page.goto(base+"/"+company.issuePrefix+"/issues/"+mainIssue.identifier);
 await page.getByRole("textbox",{name:FIRST_USE_QUESTION,exact:true}).waitFor({timeout:30000});
 await page.screenshot({path:path.join(evidence,"02-native-question.png"),fullPage:true});
 await uiAction("Answer native first-use question",()=>page.getByRole("textbox",{name:FIRST_USE_QUESTION,exact:true}).fill("Use the brief in the next internal planning review."));
 await uiAction("Submit native owner answer",()=>page.getByRole("button",{name:"Save first-use decision",exact:true}).click());
 const correctRuns=await finishedRuns(agentId,mainIssue.id,2);
 assert.ok(correctRuns.every(row=>row.status==="succeeded"));
 const cases=[{scenario:"correct",issueId:mainIssue.id,identifier:mainIssue.identifier,runIds:correctRuns.map(row=>row.id),observed:await api("GET","/issues/"+mainIssue.id)}];
 assert.equal((await api("GET","/issues/"+mainIssue.id+"/documents/"+REPORT_KEY)).body,EXPECTED_REPORT);
 await page.screenshot({path:path.join(evidence,"03-discovery-report.png"),fullPage:true});
 for(const scenario of ["wrong","approval","missing","unverified"]) {
  const issue=await api("POST","/companies/"+companyId+"/issues",{title:"Fred fixture "+scenario,description:"fred-case:"+scenario+"\nIsolated deterministic FDE case; no external action is authorized.",status:"backlog"});
  await api("POST","/companies/"+companyId+"/issues/"+issue.id+"/responsibility",{agentId,responsibilityKey:scenario==="unverified"?"adoption-pending":"adoption-proof"});
  if(scenario==="missing")await api("PATCH","/agents/"+agentId,{runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:false,intervalSec:0}}});
  await api("PATCH","/issues/"+issue.id,{status:"todo",assigneeAgentId:agentId});
  const runs=scenario==="missing"?await runsFor(agentId,issue.id):await finishedRuns(agentId,issue.id,1);
  if(scenario==="missing")assert.equal(runs.length,0);else assert.ok(runs.every(row=>row.status==="succeeded"),JSON.stringify(runs));
  const observed=await api("GET","/issues/"+issue.id);
  const documents=await api("GET","/issues/"+issue.id+"/documents");
  cases.push({scenario,issueId:issue.id,identifier:issue.identifier,runIds:runs.map(row=>row.id),observed,documents});
  await page.goto(base+"/"+company.issuePrefix+"/issues/"+issue.identifier);
  await page.getByTestId("issue-detail-tabs").waitFor();
  await page.screenshot({path:path.join(evidence,"case-"+scenario+".png"),fullPage:true});
  if(scenario==="missing")await api("PATCH","/agents/"+agentId,{runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true,intervalSec:0}}});
 }
 const rubricBytes=fs.readFileSync(path.join(root,"tests/e2e/fixtures/fred/rubric.json"));
 const rubric=JSON.parse(rubricBytes);
 const evaluationBase="/companies/"+companyId+"/evaluation/agents/"+agentId;
 await api("POST","/companies/"+companyId+"/evaluation/ingest/run?backfill=true",{});
 const snapshot=await api("POST",evaluationBase+"/snapshot",{});
 const card=await api("GET",evaluationBase);
 const caseRows=await api("GET",evaluationBase+"/cases?limit=500");
 assert.equal(snapshot.verify.status,"agree");
 assert.equal(card.card.formulaVersion,rubric.formulaVersion);
 assert.deepEqual(card.card.worker.acceptance.body.facts.automatedAcceptance,rubric.automatedAcceptance);
 const obligations=card.card.worker.obligations.body.responsibilities;
 assert.equal(obligations.reduce((sum,row)=>sum+row.owed,0),rubric.owed);
 const runtime=fs.readFileSync(path.join(evidence,"runtime-receipts.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
 for(const item of cases) {
  const expected=rubric.cases[item.scenario];
  assert.equal(item.observed.status,expected.issueStatus);
  assert.equal(item.runIds.length,expected.runs);
  const obligation=caseRows.rows.find(row=>row.section==="obligations"&&row.item?.id===item.issueId);
  const accepted=caseRows.rows.find(row=>row.fact==="automated"&&row.item?.id===item.issueId);
  assert.equal(obligation?.state,expected.obligation);
  assert.equal(accepted?.state??null,expected.automatedAcceptance);
  for(const runId of item.runIds){const receipt=runtime.find(row=>row.runId===runId);assert.ok(receipt&&!receipt.error);assert.ok(receipt.receipts.some(row=>row.path.endsWith("/snapshot")&&row.status===403));}
  if(item.scenario==="approval"){const receipt=runtime.find(row=>row.runId===item.runIds[0]);const pending=receipt.receipts.find(row=>row.method==="POST"&&row.path.endsWith("/approvals"));assert.equal(pending.response.status,"pending");assert.ok(receipt.receipts.some(row=>row.path.endsWith("/approve")&&row.status===403));assert.equal((await api("GET","/approvals/"+pending.response.id)).status,"pending");}
  item.expected=expected;
 }
 const first=runtime.find(row=>row.issueId===mainIssue.id&&row.phase==="question"),continued=runtime.find(row=>row.issueId===mainIssue.id&&row.phase==="continued");
 assert.ok(first&&continued);assert.ok(first.receipts.some(row=>row.method==="PUT"&&row.path.endsWith("/memory")));
 assert.match(continued.receipts.find(row=>row.method==="GET"&&row.path.endsWith("/memory")).response.memory.content,/fred-fixture-continuity-v1/);
 await page.goto(base+"/"+company.issuePrefix+"/company/fred");await page.getByRole("heading",{name:"Adoption brief",exact:true}).waitFor();
 await page.screenshot({path:path.join(evidence,"04-fred-final.png"),fullPage:true});
 write("native-evaluation.json",{snapshot,card,caseRows,rubric,rubricHash:hash(rubricBytes)});
 write("fixture-location.json",{base,companyId,agentId,registrationId,mainIssueId:mainIssue.id,prefix:company.issuePrefix,fredUrl:base+"/"+company.issuePrefix+"/company/fred",owner:"local-board (scripted fixture)",auth:"local_trusted; no credential",home,pid:server.pid,dbPort,issues:cases.map(row=>({scenario:row.scenario,url:base+"/"+company.issuePrefix+"/issues/"+row.identifier}))});
 const finalSources=sourceManifest();
 write("materialized-instructions.json",{beforeProfile:initialInstructions,afterProfile:afterProfileInstructions,afterRuns:materialized()});
 write("source-manifest-end.json",{capturedAt:new Date().toISOString(),files:finalSources,unchanged:JSON.stringify(initialSources)===JSON.stringify(finalSources)});
 write("result.json",{status:"completed",cases,sourceUnchanged:JSON.stringify(initialSources)===JSON.stringify(finalSources),profileRevisionId:draft.id,profileBodyHash:savedProfile.bodyHash,adapterConfigHash:hash(JSON.stringify(configured.adapterConfig)),rubricVersion:rubric.version,rubricHash:hash(rubricBytes),startedAt,finishedAt:new Date().toISOString(),measuredElapsedMs:Date.now()-Date.parse(startedAt),measuredScriptedUiActions:uiActions.length,measuredOwnerApiMutations:raw.filter(row=>row.method!=="GET").length,overlap:"UI and API counts overlap; do not sum",humanCorrectionEffort:"unavailable",humanCalibration:"pending",actualTargetClient:"not exercised",actualModelQuality:"not measured",realCustomerAcceptance:"not exercised",businessOutcome:"unmeasured",fixtureProviderCalls:0,providerCost:"scripted usage0, not a provider bill",consoleErrors,blockedBrowserRequests,containment:"Fresh HOME, no inherited provider secrets, provider command shims and Node TCP/fetch loopback fence; not an arbitrary-code host sandbox"});
 checkStorage();success=true;console.log(JSON.stringify({status:"completed",base,evidence,fredUrl:base+"/"+company.issuePrefix+"/company/fred"}));
} catch(error) {
 write("failure.json",{status:"failed",at:new Date().toISOString(),error:String(error),stack:error instanceof Error?error.stack:undefined,sourceManifest:sourceManifest(),consoleErrors,uiActionCount:uiActions.length});
 throw error;
} finally {
 await browser?.close();
 if(args.includes("--keep-server")&&success)server.unref();
 else {try{process.kill(-server.pid,"SIGTERM");}catch{}}
}
