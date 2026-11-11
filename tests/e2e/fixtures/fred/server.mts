// Test-only source server entry: fail closed before any database can be opened.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { paperclipConfigSchema } from "../../../../packages/shared/src/config-schema.js";
import { loadConfig } from "../../../../server/src/config.js";
assert.equal(process.env.FRED_FIXTURE_ENABLED,"true");
assert.ok(process.env.HOME?.includes("fred-"));
assert.equal(fs.realpathSync(process.cwd()),fs.realpathSync(process.env.HOME!),"Never load an existing checkout's .env");
assert.equal(process.env.DATABASE_URL,undefined);
assert.equal(process.env.DATABASE_MIGRATION_URL,undefined);
const configPath=process.env.PAPERCLIP_CONFIG!;
const parsed=paperclipConfigSchema.parse(JSON.parse(fs.readFileSync(configPath,"utf8")));
const loaded=loadConfig();
assert.equal(parsed.database.embeddedPostgresDataDir,path.join(process.env.HOME!,"pg"));
assert.equal(loaded.embeddedPostgresDataDir,parsed.database.embeddedPostgresDataDir);
assert.equal(loaded.embeddedPostgresPort,Number(process.env.FRED_FIXTURE_DB_PORT));
assert.equal(loaded.port,Number(process.env.NATIVE_SERVER_PORT));
assert.equal(loaded.databaseUrl,undefined);
assert.equal(loaded.databaseMode,"embedded-postgres");
assert.equal(loaded.deploymentMode,"local_trusted");
assert.equal(loaded.host,"127.0.0.1");
assert.deepEqual(Object.keys(process.env).filter(key=>/^(ANTHROPIC|OPENAI|MINIMAX|GEMINI|GOOGLE|AWS|AZURE|SENTRY|RESEND|SLACK|STRIPE).*(KEY|TOKEN|SECRET|CREDENTIAL)/i.test(key)&&process.env[key]),[]);
fs.writeFileSync(path.join(process.env.FRED_FIXTURE_EVIDENCE_DIR!,"config-guard.json"),JSON.stringify({status:"passed",configPath,dataDir:loaded.embeddedPostgresDataDir,dbPort:loaded.embeddedPostgresPort,port:loaded.port,home:process.env.HOME,cwd:process.cwd(),providerSecretKeys:[],databaseUrl:"unset",checkedAt:new Date().toISOString()},null,2));
if(process.env.FRED_FIXTURE_REUSE==="true") {
 const marker=JSON.parse(fs.readFileSync(path.join(process.env.HOME!,"fred-fixture-owned.json"),"utf8"));
 assert.equal(marker.homeRealpath,fs.realpathSync(process.env.HOME!));assert.equal(marker.uid,process.getuid());
 assert.equal(marker.dbPort,loaded.embeddedPostgresPort);assert.equal(fs.statSync(loaded.embeddedPostgresDataDir).uid,process.getuid());
 assert.ok(!fs.existsSync(path.join(loaded.embeddedPostgresDataDir,"postmaster.pid")));
 const requireDb=createRequire(new URL("../../../../packages/db/package.json",import.meta.url));
 const {default:EmbeddedPostgres}=await import(pathToFileURL(requireDb.resolve("embedded-postgres")).href);
 const pg=new EmbeddedPostgres({databaseDir:loaded.embeddedPostgresDataDir,user:"paperclip",password:"paperclip",port:loaded.embeddedPostgresPort,persistent:true});
 await pg.start();
 try {
  const {default:postgres}=await import(pathToFileURL(requireDb.resolve("postgres")).href);
  const sql=postgres("postgres://paperclip:paperclip@127.0.0.1:"+loaded.embeddedPostgresPort+"/paperclip",{max:1});
  try {
   const location=await sql.unsafe("show data_directory");assert.equal(fs.realpathSync(location[0].data_directory),fs.realpathSync(loaded.embeddedPostgresDataDir));
   const companies=await sql.unsafe("select id from companies");assert.ok(companies.every(row=>marker.companyIds.includes(row.id)),"Unexpected company in reused fixture");
   const runs=await sql.unsafe("select id,company_id,status from heartbeat_runs");
   assert.ok(runs.every(row=>marker.companyIds.includes(row.company_id)&&["succeeded","failed","timed_out","cancelled","interrupted"].includes(row.status)),"Prior fixture work must be terminal before reuse");
   fs.writeFileSync(path.join(process.env.FRED_FIXTURE_EVIDENCE_DIR!,"reuse-preflight.json"),JSON.stringify({status:"passed",homeRealpath:marker.homeRealpath,uid:marker.uid,dbPort:loaded.embeddedPostgresPort,priorCompanyIds:companies.map(row=>row.id),priorRuns:runs,checkedAt:new Date().toISOString(),allocationClass:"existing-synthetic-cluster"},null,2));
  } finally {await sql.end();}
 } catch(error) {await pg.stop();throw error;}
}
const {startServer}=await import("../../../../server/src/index.js");
await startServer();
